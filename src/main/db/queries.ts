import type { DatabaseSync } from 'node:sqlite'
import type {
  CategoryInfo,
  DatasetStats,
  DatasetSummary,
  PerfEntry,
  PlaceRef,
  TopPlace,
  ViewportQuery,
  ViewportWaypoint,
  YearCount
} from '../../shared/types'
import { colorForCategory } from '../../shared/categories'
import { resolveDetail, type ResolvedDetail } from '../../shared/displayDetail'
import { RAIL_SNAP_TYPES, ROAD_TUNNEL_TYPES } from '../rail/snapRail'
import { prepareEffectivePoints } from './editStore'
import { clusterByProximity } from './placeCluster'

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
    SELECT id, lat, lon, ts_ms AS tsMs, name, place_id AS placeId
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
  const merged = collapseVisitsToPlaces(db, q, all)
  if (limit <= 0) return { waypoints: [], totalCount: merged.length }
  if (merged.length <= limit) return { waypoints: merged, totalCount: merged.length }
  return { waypoints: thinWaypoints(merged, q, limit), totalCount: merged.length }
}

/** Names of user-merged places, by id (small table; loaded once per query). */
function loadPlaceNames(db: DatabaseSync): Map<number, string> {
  const rows = db.prepare('SELECT id, name FROM places').all() as Array<{ id: number; name: string }>
  return new Map(rows.map((r) => [r.id, r.name]))
}

/** Time-range clause for the place loaders (undated visits pass through). */
const WAYPOINT_TIME_CLAUSE =
  '(? IS NULL OR ts_ms IS NULL OR ts_ms >= ?) AND (? IS NULL OR ts_ms IS NULL OR ts_ms <= ?)'

const waypointTimeParams = (q: ViewportQuery): Array<number | null> => [
  q.startTsMs, q.startTsMs, q.endTsMs, q.endTsMs
]

/** All in-date-range visits for the given merged places, grouped by place_id. */
function fullMembersByPlaceId(
  db: DatabaseSync,
  q: ViewportQuery,
  placeIds: number[]
): Map<number, ViewportWaypoint[]> {
  const out = new Map<number, ViewportWaypoint[]>()
  if (placeIds.length === 0) return out
  const rows = db.prepare(`
    SELECT id, lat, lon, ts_ms AS tsMs, name, place_id AS placeId
    FROM waypoints
    WHERE place_id IN (${placeIds.map(() => '?').join(',')}) AND ${WAYPOINT_TIME_CLAUSE}
  `).all(...placeIds, ...waypointTimeParams(q)) as unknown as ViewportWaypoint[]
  for (const w of rows) {
    const g = out.get(w.placeId!)
    if (g) g.push(w)
    else out.set(w.placeId!, [w])
  }
  return out
}

/** All in-date-range un-merged visits of the given names, grouped by name. */
function fullMembersByName(
  db: DatabaseSync,
  q: ViewportQuery,
  names: string[]
): Map<string, ViewportWaypoint[]> {
  const out = new Map<string, ViewportWaypoint[]>()
  if (names.length === 0) return out
  const rows = db.prepare(`
    SELECT id, lat, lon, ts_ms AS tsMs, name, place_id AS placeId
    FROM waypoints
    WHERE place_id IS NULL AND name IN (${names.map(() => '?').join(',')}) AND ${WAYPOINT_TIME_CLAUSE}
  `).all(...names, ...waypointTimeParams(q)) as unknown as ViewportWaypoint[]
  for (const w of rows) {
    const g = out.get(w.name!)
    if (g) g.push(w)
    else out.set(w.name!, [w])
  }
  return out
}

/**
 * Collapse raw visits into the pins the map draws. Two passes:
 *
 * 1. Visits with an explicit `place_id` group by it — a user-merged place,
 *    shown as one pin with the chosen name regardless of distance or per-visit
 *    names.
 * 2. The rest cluster the way Arc data demands: a well-visited place is
 *    hundreds of GPS-jittered same-name dots, so same-name visits within a
 *    radius merge to their mean. Per spatial cluster, not global per name, so
 *    a chain ("Starbucks" in two cities) keeps separate pins. Unnamed visits
 *    pass through as-is.
 *
 * A pin is positioned from its place's **full** membership (every in-date-range
 * visit, not just those in the current viewport), so it stays put as the user
 * zooms/pans instead of drifting toward whichever subset is on screen — the
 * same clustering `resolvePlace` recovers on a click, so display == clicks ==
 * stats. Only the *in-view* set decides which pins to show: a place appears
 * once at least one of its visits is on screen. Each pin keeps the most recent
 * member's id/timestamp as its identity. (The persistent counterpart that
 * *creates* place_id groups is placeStore.mergePlaces; this only renders it.)
 */
function collapseVisitsToPlaces(
  db: DatabaseSync,
  q: ViewportQuery,
  all: ViewportWaypoint[]
): ViewportWaypoint[] {
  const merged: ViewportWaypoint[] = []
  const inViewPlaceIds = new Set<number>()
  const inViewNames = new Set<string>()
  const inViewNamedIds = new Set<number>()
  for (const w of all) {
    if (w.placeId != null) inViewPlaceIds.add(w.placeId)
    else if (w.name) {
      inViewNames.add(w.name)
      inViewNamedIds.add(w.id)
    } else merged.push(w) // unnamed, un-merged: its own pin
  }

  if (inViewPlaceIds.size > 0) {
    const placeNames = loadPlaceNames(db)
    for (const [placeId, members] of fullMembersByPlaceId(db, q, [...inViewPlaceIds])) {
      if (members.length > 0) {
        merged.push(reduceCluster(members, { placeId, name: placeNames.get(placeId) ?? null }))
      }
    }
  }
  if (inViewNames.size > 0) {
    for (const members of fullMembersByName(db, q, [...inViewNames]).values()) {
      for (const cluster of clusterByProximity(members)) {
        // Show the cluster only if one of its visits is actually on screen.
        if (cluster.some((m) => inViewNamedIds.has(m.id))) {
          merged.push(reduceCluster(cluster, { placeId: null, name: null }))
        }
      }
    }
  }
  return merged
}

/**
 * One pin from a cluster of visits: mean location, the most recent member's
 * identity (id/timestamp). `name`/`placeId` override the member-derived name
 * for user-merged places; otherwise the representative member's name is kept.
 */
function reduceCluster(
  members: ViewportWaypoint[],
  override: { placeId: number | null; name: string | null }
): ViewportWaypoint {
  let latSum = 0
  let lonSum = 0
  let rep = members[0]!
  for (const w of members) {
    latSum += w.lat
    lonSum += w.lon
    if (moreRecentVisit(w, rep)) rep = w
  }
  return {
    id: rep.id,
    lat: latSum / members.length,
    lon: lonSum / members.length,
    tsMs: rep.tsMs,
    name: override.placeId != null ? override.name : rep.name,
    placeId: override.placeId
  }
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

/**
 * Dataset-wide stats for the Stats tab's global summary. A handful of grouped
 * aggregates (cheap even on a multi-year archive); the heavier per-place
 * histograms live in placeStore and only run when a place is selected.
 */
export function getDatasetStats(db: DatabaseSync): DatasetStats {
  const base = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM imported_files WHERE status = 'imported') AS fileCount,
      (SELECT COUNT(*) FROM tracks) AS trackCount,
      (SELECT COUNT(*) FROM segments) AS segmentCount,
      (SELECT COALESCE(SUM(point_count), 0) FROM segments) AS pointCount,
      (SELECT COUNT(*) FROM waypoints) AS visitCount,
      (SELECT MIN(start_ts_ms) FROM segments) AS startTsMs,
      (SELECT MAX(end_ts_ms) FROM segments) AS endTsMs
  `).get() as {
    fileCount: number; trackCount: number; segmentCount: number; pointCount: number
    visitCount: number; startTsMs: number | null; endTsMs: number | null
  }

  // Distinct places ≈ merged places + un-merged name clusters + unnamed
  // singles. Name clusters are counted per name, not per spatial cluster — a
  // cheap approximation (a chain in two cities counts once) good enough for a
  // headline number.
  const places = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM places) AS merged,
      (SELECT COUNT(DISTINCT name) FROM waypoints
         WHERE place_id IS NULL AND name IS NOT NULL AND name <> '') AS named,
      (SELECT COUNT(*) FROM waypoints
         WHERE place_id IS NULL AND (name IS NULL OR name = '')) AS unnamed
  `).get() as { merged: number; named: number; unnamed: number }

  return {
    fileCount: base.fileCount,
    trackCount: base.trackCount,
    segmentCount: base.segmentCount,
    pointCount: base.pointCount,
    visitCount: base.visitCount,
    placeCount: places.merged + places.named + places.unnamed,
    startTsMs: base.startTsMs,
    endTsMs: base.endTsMs,
    segmentsByYear: yearCounts(db, 'segments', 'start_ts_ms'),
    visitsByYear: yearCounts(db, 'waypoints', 'ts_ms'),
    topPlaces: topVisitedPlaces(db, 12)
  }
}

/** Row counts grouped by UTC calendar year (matches the year-coloring rule). */
function yearCounts(db: DatabaseSync, table: 'segments' | 'waypoints', col: string): YearCount[] {
  return db.prepare(`
    SELECT CAST(strftime('%Y', ${col} / 1000, 'unixepoch') AS INTEGER) AS year,
           COUNT(*) AS count
    FROM ${table} WHERE ${col} IS NOT NULL
    GROUP BY year ORDER BY year
  `).all() as unknown as YearCount[]
}

/**
 * Most-visited places: merged places by place_id, plus un-merged places by
 * name. Each carries a ref so the UI can drill into its full stats; the coords
 * are an average hint (drill-in recomputes the exact cluster centroid).
 */
function topVisitedPlaces(db: DatabaseSync, limit: number): TopPlace[] {
  const mergedRows = db.prepare(`
    SELECT p.id AS placeId, p.name AS name, COUNT(w.id) AS cnt,
           AVG(w.lat) AS lat, AVG(w.lon) AS lon
    FROM places p JOIN waypoints w ON w.place_id = p.id
    GROUP BY p.id
  `).all() as Array<{ placeId: number; name: string; cnt: number; lat: number; lon: number }>
  const namedRows = db.prepare(`
    SELECT name, COUNT(*) AS cnt, AVG(lat) AS lat, AVG(lon) AS lon, MAX(id) AS repId
    FROM waypoints
    WHERE place_id IS NULL AND name IS NOT NULL AND name <> ''
    GROUP BY name
  `).all() as Array<{ name: string; cnt: number; lat: number; lon: number; repId: number }>

  const all: TopPlace[] = [
    ...mergedRows.map((r) => ({
      name: r.name, visitCount: r.cnt, lat: r.lat, lon: r.lon,
      ref: { placeId: r.placeId } as PlaceRef
    })),
    ...namedRows.map((r) => ({
      name: r.name, visitCount: r.cnt, lat: r.lat, lon: r.lon,
      ref: { waypointId: r.repId } as PlaceRef
    }))
  ]
  all.sort((a, b) => b.visitCount - a.visitCount || a.name.localeCompare(b.name))
  return all.slice(0, limit)
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
