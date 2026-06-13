import type { DatabaseSync } from 'node:sqlite'
import type {
  CategoryInfo,
  DatasetSummary,
  PerfEntry,
  ViewportQuery,
  ViewportWaypoint
} from '../../shared/types'
import { colorForCategory } from '../../shared/categories'
import { resolveDetail, type ResolvedDetail } from '../../shared/displayDetail'
import { RAIL_SNAP_TYPES, ROAD_TUNNEL_TYPES } from '../rail/snapRail'
import { prepareEffectivePoints } from './editStore'

export interface ViewportSegmentRow {
  id: number
  type: string
  /** Segment start time; drives year coloring. Null = undated. */
  start_ts_ms: number | null
  point_count: number
  coords: Uint8Array
  /** 1 when coords came from cached map-matched geometry (snap mode only). */
  _matched?: number
}

export interface ViewportLimits {
  /**
   * Hard cap on segments per query (safety valve). When it bites, segments
   * are kept biggest-geometry-first so the valve sheds point-dust, never
   * whole regions or eras — a multi-year archive is ~100k+ small segments,
   * and an arbitrary-prefix cut used to hide everything imported after it.
   */
  segments: number
  /** Soft cap on total points; overflow downsamples lines, never drops them. */
  points: number
}

export interface ViewportRowsResult {
  rows: ViewportSegmentRow[]
  truncated: boolean
  detail: ResolvedDetail
  downsampleStride: number
}

/**
 * Shared segment filter: bounds intersection + time-range overlap +
 * non-ignored categories. Segments without timestamps pass any time filter
 * (transparent rather than hidden).
 */
const VIEWPORT_WHERE = `
  s.max_lat >= ? AND s.min_lat <= ?
  AND s.max_lon >= ? AND s.min_lon <= ?
  AND (? IS NULL OR s.end_ts_ms IS NULL OR s.end_ts_ms >= ?)
  AND (? IS NULL OR s.start_ts_ms IS NULL OR s.start_ts_ms <= ?)
  AND s.type NOT IN (SELECT name FROM categories WHERE ignored = 1)
`

const viewportParams = (q: ViewportQuery): Array<number | null> => [
  q.minLat, q.maxLat,
  q.minLon, q.maxLon,
  q.startTsMs, q.startTsMs,
  q.endTsMs, q.endTsMs
]

/**
 * Viewport query honoring the user's detail mode within a point budget.
 *
 * Limiting philosophy: a route must never vanish just because the viewport
 * got busy. When a result would exceed `limits.points`, auto mode first steps
 * down to coarser precomputed levels; whatever detail ends up served, lines
 * are then thinned by a uniform vertex stride (endpoints kept) so every
 * segment stays on the map, just lighter. Pinned modes ('low'…'all') keep
 * their level and rely on stride thinning alone.
 */
export function queryViewportSegments(
  db: DatabaseSync,
  q: ViewportQuery,
  limits: ViewportLimits
): ViewportRowsResult {
  // Each snap toggle swaps cached matched geometry in for its own type group:
  // rail rides under snapRail, road (tunnel-bridged) trips under snapRoad.
  const snapTypes: string[] = []
  if (q.snapRail) snapTypes.push(...RAIL_SNAP_TYPES)
  if (q.snapRoad) snapTypes.push(...ROAD_TUNNEL_TYPES)
  let detail = resolveDetail(q.detailMode, q.zoom)
  if ((q.detailMode ?? 'auto') === 'auto' && typeof detail === 'number') {
    while (detail > 0 && countDisplayPoints(db, q, detail, snapTypes) > limits.points) detail--
  }

  const { rows, truncated } =
    detail === 'raw'
      ? rawRows(db, q, limits.segments)
      : displayRows(db, q, detail, limits.segments, snapTypes)

  const total = rows.reduce((sum, r) => sum + r.point_count, 0)
  const stride = total > limits.points ? Math.ceil(total / limits.points) : 1
  if (stride > 1) {
    for (const row of rows) decimateRow(row, stride)
  }
  return { rows, truncated, detail, downsampleStride: stride }
}

/**
 * Matched-geometry join for the enabled type groups. The type names are code
 * constants (RAIL_SNAP_TYPES / ROAD_TUNNEL_TYPES), never user input.
 */
const matchedJoin = (snapTypes: string[]): string =>
  snapTypes.length > 0
    ? `LEFT JOIN rail_matched_geom m ON m.segment_id = s.id AND m.detail = ?
       AND s.type IN (${snapTypes.map((t) => `'${t}'`).join(',')})`
    : ''

function countDisplayPoints(
  db: DatabaseSync,
  q: ViewportQuery,
  detail: number,
  snapTypes: string[]
): number {
  // Under a snap toggle, matched geometry (when present) decides a row's size.
  const snap = snapTypes.length > 0
  const sizeExpr = snap ? 'COALESCE(m.point_count, d.point_count)' : 'd.point_count'
  const params = snap
    ? [detail, detail, ...viewportParams(q)]
    : [detail, ...viewportParams(q)]
  const row = db.prepare(`
    SELECT COALESCE(SUM(${sizeExpr}), 0) AS total
    FROM segments s
    JOIN display_geometries d ON d.segment_id = s.id AND d.detail = ?
    ${matchedJoin(snapTypes)}
    WHERE ${VIEWPORT_WHERE}
  `).get(...params) as { total: number }
  return row.total
}

function displayRows(
  db: DatabaseSync,
  q: ViewportQuery,
  detail: number,
  segmentLimit: number,
  snapTypes: string[]
): { rows: ViewportSegmentRow[]; truncated: boolean } {
  // Snap toggles: prefer cached matched geometry per enabled segment type,
  // falling back to the normal display polyline; `_matched` flags swaps.
  const snap = snapTypes.length > 0
  const cols = snap
    ? `s.id, s.type, s.start_ts_ms,
       COALESCE(m.point_count, d.point_count) AS point_count,
       COALESCE(m.coords, d.coords) AS coords,
       (m.segment_id IS NOT NULL) AS _matched`
    : 's.id, s.type, s.start_ts_ms, d.point_count, d.coords'
  const join = matchedJoin(snapTypes)
  const params = snap
    ? [detail, detail, ...viewportParams(q), segmentLimit + 1]
    : [detail, ...viewportParams(q), segmentLimit + 1]
  const rows = db.prepare(`
    SELECT ${cols}
    FROM segments s
    JOIN display_geometries d ON d.segment_id = s.id AND d.detail = ?
    ${join}
    WHERE ${VIEWPORT_WHERE}
    ORDER BY d.point_count DESC, s.id ASC
    LIMIT ?
  `).all(...params) as unknown as ViewportSegmentRow[]
  const truncated = rows.length > segmentLimit
  if (truncated) rows.length = segmentLimit
  return { rows, truncated }
}

/**
 * 'All points' mode: rebuild each polyline from its clean raw points (with
 * any user track edits applied) instead of the precomputed simplifications.
 * Heavier by design — only runs when the user explicitly asks for raw detail.
 */
function rawRows(
  db: DatabaseSync,
  q: ViewportQuery,
  segmentLimit: number
): { rows: ViewportSegmentRow[]; truncated: boolean } {
  const segs = db.prepare(`
    SELECT s.id, s.type, s.start_ts_ms
    FROM segments s
    WHERE ${VIEWPORT_WHERE}
    ORDER BY s.clean_point_count DESC, s.id ASC
    LIMIT ?
  `).all(...viewportParams(q), segmentLimit + 1) as unknown as Array<{
    id: number
    type: string
    start_ts_ms: number | null
  }>
  const truncated = segs.length > segmentLimit
  if (truncated) segs.length = segmentLimit

  const effectivePoints = prepareEffectivePoints(db)
  const rows: ViewportSegmentRow[] = []
  for (const seg of segs) {
    const pts = effectivePoints(seg.id)
    if (pts.length < 2) continue // not drawable; same rule as import-time geometry
    const coords = new Float32Array(pts.length * 2)
    for (let i = 0; i < pts.length; i++) {
      coords[i * 2] = pts[i]!.lon
      coords[i * 2 + 1] = pts[i]!.lat
    }
    rows.push({
      id: seg.id,
      type: seg.type,
      start_ts_ms: seg.start_ts_ms,
      point_count: pts.length,
      coords: new Uint8Array(coords.buffer)
    })
  }
  return { rows, truncated }
}

/**
 * Thin a polyline to every `stride`-th vertex, always keeping endpoints.
 * Matched geometry may contain NaN break sentinels (deliberate gaps); those
 * and each part's endpoints are always kept, or thinning would re-connect
 * parts the matcher intentionally separated.
 */
function decimateRow(row: ViewportSegmentRow, stride: number): void {
  const n = row.point_count
  if (n <= 2) return
  // Blobs from SQLite are byte-aligned copies; realign for a Float32 view.
  const src =
    row.coords.byteOffset % 4 === 0
      ? new Float32Array(row.coords.buffer, row.coords.byteOffset, n * 2)
      : new Float32Array(row.coords.slice().buffer)
  const kept: number[] = []
  const keepPart = (from: number, to: number): void => {
    for (let i = from; i < to - 1; i += stride) kept.push(i)
    if (to - 1 >= from) kept.push(to - 1)
  }
  let partStart = 0
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(src[i * 2]!)) {
      keepPart(partStart, i)
      kept.push(i) // the break itself
      partStart = i + 1
    }
  }
  keepPart(partStart, n)
  const out = new Float32Array(kept.length * 2)
  for (let i = 0; i < kept.length; i++) {
    out[i * 2] = src[kept[i]! * 2]!
    out[i * 2 + 1] = src[kept[i]! * 2 + 1]!
  }
  row.point_count = kept.length
  row.coords = new Uint8Array(out.buffer)
}

export interface ViewportWaypointsResult {
  waypoints: ViewportWaypoint[]
  /** Distinct places matching the viewport (same-name visits merged), before thinning. */
  totalCount: number
}

/**
 * Waypoints (place visits) for the viewport, within a budget.
 *
 * Pipeline: bounds/time filter → merge repeat visits of the same named place
 * into one averaged dot → if still over budget, thin spatially.
 *
 * Same philosophy as segment limiting: a visited area must never vanish just
 * because the viewport got busy. Arc weekly exports re-list the same places
 * every week, so multi-year datasets blow past any flat row cap; a bare LIMIT
 * with no ORDER BY served the first rows in import order and silently dropped
 * every region visited after the cap. Instead, when over budget, waypoints
 * snap to a world-anchored grid with one representative (the most recent
 * visit) per cell, coarsening the grid until the result fits.
 */
export function queryViewportWaypoints(
  db: DatabaseSync,
  q: ViewportQuery,
  limit: number
): ViewportWaypointsResult {
  const all = db.prepare(`
    SELECT id, lat, lon, ts_ms AS tsMs, name
    FROM waypoints
    WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
      AND (? IS NULL OR ts_ms IS NULL OR ts_ms >= ?)
      AND (? IS NULL OR ts_ms IS NULL OR ts_ms <= ?)
  `).all(
    q.minLat, q.maxLat,
    q.minLon, q.maxLon,
    q.startTsMs, q.startTsMs,
    q.endTsMs, q.endTsMs
  ) as unknown as ViewportWaypoint[]
  const merged = mergeSameNamePlaces(all)
  if (limit <= 0) return { waypoints: [], totalCount: merged.length }
  if (merged.length <= limit) return { waypoints: merged, totalCount: merged.length }
  return { waypoints: thinWaypoints(merged, q, limit), totalCount: merged.length }
}

/** Same-name visits within this radius of each other merge (~275 m). */
const PLACE_MERGE_RADIUS_DEG = 0.0025

interface PlaceCluster {
  latSum: number
  lonSum: number
  count: number
  /** Most recent member; supplies the merged dot's id/tsMs. */
  rep: ViewportWaypoint
}

/**
 * Arc exports one waypoint per stay, so a well-visited place is hundreds of
 * GPS-jittered dots. Merge same-name visits into a single dot at their mean
 * location. Merging is per spatial cluster, not global per name: chain
 * locations ("Starbucks" in two cities) keep separate dots instead of
 * averaging into a phantom between them. Unnamed visits pass through as-is.
 */
function mergeSameNamePlaces(all: ViewportWaypoint[]): ViewportWaypoint[] {
  const merged: ViewportWaypoint[] = []
  const clustersByName = new Map<string, PlaceCluster[]>()
  // id order ⇒ deterministic clustering regardless of scan order.
  for (const w of [...all].sort((a, b) => a.id - b.id)) {
    if (!w.name) {
      merged.push(w)
      continue
    }
    let clusters = clustersByName.get(w.name)
    if (!clusters) clustersByName.set(w.name, (clusters = []))
    const near = clusters.find((c) => {
      const dLat = w.lat - c.latSum / c.count
      const dLon = w.lon - c.lonSum / c.count
      return dLat * dLat + dLon * dLon <= PLACE_MERGE_RADIUS_DEG ** 2
    })
    if (near) {
      near.latSum += w.lat
      near.lonSum += w.lon
      near.count++
      if (moreRecentVisit(w, near.rep)) near.rep = w
    } else {
      clusters.push({ latSum: w.lat, lonSum: w.lon, count: 1, rep: w })
    }
  }
  for (const clusters of clustersByName.values()) {
    for (const c of clusters) {
      merged.push({
        id: c.rep.id,
        lat: c.latSum / c.count,
        lon: c.lonSum / c.count,
        tsMs: c.rep.tsMs,
        name: c.rep.name
      })
    }
  }
  return merged
}

/**
 * One waypoint per grid cell, coarsening until under budget. Cells are
 * power-of-two fractions of the world (not viewport-relative), so surviving
 * dots stay put while panning; within a cell the most recent visit wins
 * (ties to the lowest id) — deterministic across refreshes.
 */
function thinWaypoints(
  all: ViewportWaypoint[],
  q: ViewportQuery,
  limit: number
): ViewportWaypoint[] {
  const span = Math.max(q.maxLat - q.minLat, q.maxLon - q.minLon, 1e-9)
  // Finest grid worth trying: ~256 cells across the viewport.
  let k = Math.max(0, Math.floor(Math.log2((360 / span) * 256)))
  for (;;) {
    const cell = 360 / 2 ** k
    const best = new Map<string, ViewportWaypoint>()
    for (const w of all) {
      const key = `${Math.floor(w.lat / cell)}:${Math.floor(w.lon / cell)}`
      const cur = best.get(key)
      if (!cur || moreRecentVisit(w, cur)) best.set(key, w)
    }
    if (best.size <= limit || k === 0) return [...best.values()]
    k--
  }
}

function moreRecentVisit(a: ViewportWaypoint, b: ViewportWaypoint): boolean {
  const ta = a.tsMs ?? -Infinity
  const tb = b.tsMs ?? -Infinity
  if (ta !== tb) return ta > tb
  return a.id < b.id
}

/**
 * Sidebar/list order doubles as draw priority: first = top of the panel =
 * painted on top of other types. User-ordered rows (priority set) come
 * first; never-ordered ones follow by prominence, ignored ones last.
 */
export function getCategories(db: DatabaseSync): CategoryInfo[] {
  const rows = db.prepare(`
    SELECT c.name, c.color, c.visible, c.ignored, c.custom,
           COALESCE(s.segment_count, 0) AS segmentCount,
           COALESCE(s.point_count, 0) AS pointCount
    FROM categories c
    LEFT JOIN (
      SELECT type, COUNT(*) AS segment_count, SUM(point_count) AS point_count
      FROM segments GROUP BY type
    ) s ON s.type = c.name
    ORDER BY c.ignored ASC, (c.priority IS NULL) ASC, c.priority ASC,
             segmentCount DESC, c.name ASC
  `).all() as unknown as Array<{
    name: string
    color: string
    visible: number
    ignored: number
    custom: number
    segmentCount: number
    pointCount: number
  }>
  return rows.map((r) => ({
    name: r.name,
    color: r.color,
    visible: r.visible === 1,
    ignored: r.ignored === 1,
    custom: r.custom === 1,
    segmentCount: r.segmentCount,
    pointCount: r.pointCount
  }))
}

export function setCategoryVisible(db: DatabaseSync, name: string, visible: boolean): void {
  db.prepare('UPDATE categories SET visible = ? WHERE name = ?').run(visible ? 1 : 0, name)
}

/** Persist an explicit type order; index 0 = top of panel = drawn on top. */
export function setCategoryOrder(db: DatabaseSync, names: string[]): void {
  const stmt = db.prepare('UPDATE categories SET priority = ? WHERE name = ?')
  db.exec('BEGIN')
  try {
    names.forEach((name, i) => stmt.run(i, name))
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/**
 * User-picked category color; null reverts to the default (curated palette
 * or generated fallback) and re-enables automatic palette refreshes.
 */
export function setCategoryColor(db: DatabaseSync, name: string, color: string | null): void {
  if (color === null) {
    db.prepare('UPDATE categories SET color = ?, custom = 0 WHERE name = ?')
      .run(colorForCategory(name), name)
    return
  }
  if (!/^#[0-9a-f]{6}$/i.test(color)) return // only plain hex from the picker
  db.prepare('UPDATE categories SET color = ?, custom = 1 WHERE name = ?').run(color, name)
}

export function getSummary(db: DatabaseSync): DatasetSummary {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM imported_files WHERE status = 'imported') AS fileCount,
      (SELECT COUNT(*) FROM tracks) AS trackCount,
      (SELECT COUNT(*) FROM segments) AS segmentCount,
      (SELECT COALESCE(SUM(point_count), 0) FROM segments) AS pointCount,
      (SELECT COUNT(*) FROM waypoints) AS waypointCount,
      (SELECT MIN(start_ts_ms) FROM segments) AS startTsMs,
      (SELECT MAX(end_ts_ms) FROM segments) AS endTsMs
  `).get() as unknown as DatasetSummary
  return row
}

export function getDataBounds(db: DatabaseSync): {
  minLat: number; minLon: number; maxLat: number; maxLon: number
} | null {
  const row = db.prepare(`
    SELECT MIN(min_lat) AS minLat, MIN(min_lon) AS minLon,
           MAX(max_lat) AS maxLat, MAX(max_lon) AS maxLon
    FROM segments WHERE min_lat IS NOT NULL
  `).get() as { minLat: number | null; minLon: number | null; maxLat: number | null; maxLon: number | null } | undefined
  if (!row || row.minLat === null || row.minLon === null || row.maxLat === null || row.maxLon === null) {
    return null
  }
  return { minLat: row.minLat, minLon: row.minLon, maxLat: row.maxLat, maxLon: row.maxLon }
}

export function insertPerf(db: DatabaseSync, op: string, durationMs: number, detail?: string): void {
  db.prepare('INSERT INTO perf_log (at_ms, op, duration_ms, detail) VALUES (?, ?, ?, ?)').run(
    Date.now(), op, durationMs, detail ?? null
  )
}

export function getRecentPerf(db: DatabaseSync, limit: number): PerfEntry[] {
  return db.prepare(`
    SELECT at_ms AS atMs, op, duration_ms AS durationMs, detail
    FROM perf_log ORDER BY id DESC LIMIT ?
  `).all(limit) as unknown as PerfEntry[]
}
