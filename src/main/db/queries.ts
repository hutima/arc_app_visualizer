import type { DatabaseSync } from 'node:sqlite'
import type {
  CategoryInfo,
  DatasetSummary,
  PerfEntry,
  ViewportQuery,
  ViewportWaypoint
} from '../../shared/types'
import { resolveDetail, type ResolvedDetail } from '../../shared/displayDetail'

export interface ViewportSegmentRow {
  id: number
  type: string
  point_count: number
  coords: Uint8Array
}

export interface ViewportLimits {
  /** Hard cap on segments per query — an extreme safety valve, rarely hit. */
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
  let detail = resolveDetail(q.detailMode, q.zoom)
  if ((q.detailMode ?? 'auto') === 'auto' && typeof detail === 'number') {
    while (detail > 0 && countDisplayPoints(db, q, detail) > limits.points) detail--
  }

  const { rows, truncated } =
    detail === 'raw'
      ? rawRows(db, q, limits.segments)
      : displayRows(db, q, detail, limits.segments)

  const total = rows.reduce((sum, r) => sum + r.point_count, 0)
  const stride = total > limits.points ? Math.ceil(total / limits.points) : 1
  if (stride > 1) {
    for (const row of rows) decimateRow(row, stride)
  }
  return { rows, truncated, detail, downsampleStride: stride }
}

function countDisplayPoints(db: DatabaseSync, q: ViewportQuery, detail: number): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(d.point_count), 0) AS total
    FROM segments s
    JOIN display_geometries d ON d.segment_id = s.id AND d.detail = ?
    WHERE ${VIEWPORT_WHERE}
  `).get(detail, ...viewportParams(q)) as { total: number }
  return row.total
}

function displayRows(
  db: DatabaseSync,
  q: ViewportQuery,
  detail: number,
  segmentLimit: number
): { rows: ViewportSegmentRow[]; truncated: boolean } {
  const rows = db.prepare(`
    SELECT s.id, s.type, d.point_count, d.coords
    FROM segments s
    JOIN display_geometries d ON d.segment_id = s.id AND d.detail = ?
    WHERE ${VIEWPORT_WHERE}
    LIMIT ?
  `).all(detail, ...viewportParams(q), segmentLimit + 1) as unknown as ViewportSegmentRow[]
  const truncated = rows.length > segmentLimit
  if (truncated) rows.length = segmentLimit
  return { rows, truncated }
}

/**
 * 'All points' mode: rebuild each polyline from its clean raw points instead
 * of the precomputed simplifications. Heavier by design — only runs when the
 * user explicitly asks for raw detail.
 */
function rawRows(
  db: DatabaseSync,
  q: ViewportQuery,
  segmentLimit: number
): { rows: ViewportSegmentRow[]; truncated: boolean } {
  const segs = db.prepare(`
    SELECT s.id, s.type
    FROM segments s
    WHERE ${VIEWPORT_WHERE}
    LIMIT ?
  `).all(...viewportParams(q), segmentLimit + 1) as unknown as Array<{ id: number; type: string }>
  const truncated = segs.length > segmentLimit
  if (truncated) segs.length = segmentLimit

  const pointsStmt = db.prepare(`
    SELECT lon, lat FROM points
    WHERE segment_id = ? AND flags = 0 AND lat IS NOT NULL AND lon IS NOT NULL
    ORDER BY seq
  `)
  const rows: ViewportSegmentRow[] = []
  for (const seg of segs) {
    const pts = pointsStmt.all(seg.id) as unknown as Array<{ lon: number; lat: number }>
    if (pts.length < 2) continue // not drawable; same rule as import-time geometry
    const coords = new Float32Array(pts.length * 2)
    for (let i = 0; i < pts.length; i++) {
      coords[i * 2] = pts[i]!.lon
      coords[i * 2 + 1] = pts[i]!.lat
    }
    rows.push({
      id: seg.id,
      type: seg.type,
      point_count: pts.length,
      coords: new Uint8Array(coords.buffer)
    })
  }
  return { rows, truncated }
}

/** Thin a polyline to every `stride`-th vertex, always keeping both endpoints. */
function decimateRow(row: ViewportSegmentRow, stride: number): void {
  const n = row.point_count
  if (n <= 2) return
  // Blobs from SQLite are byte-aligned copies; realign for a Float32 view.
  const src =
    row.coords.byteOffset % 4 === 0
      ? new Float32Array(row.coords.buffer, row.coords.byteOffset, n * 2)
      : new Float32Array(row.coords.slice().buffer)
  const kept: number[] = []
  for (let i = 0; i < n - 1; i += stride) kept.push(i)
  kept.push(n - 1)
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
  /** Waypoints matching the viewport before any thinning. */
  totalCount: number
}

/**
 * Waypoints (place visits) for the viewport, within a budget.
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
  if (limit <= 0) return { waypoints: [], totalCount: all.length }
  if (all.length <= limit) return { waypoints: all, totalCount: all.length }
  return { waypoints: thinWaypoints(all, q, limit), totalCount: all.length }
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

export function getCategories(db: DatabaseSync): CategoryInfo[] {
  const rows = db.prepare(`
    SELECT c.name, c.color, c.visible, c.ignored,
           COALESCE(s.segment_count, 0) AS segmentCount,
           COALESCE(s.point_count, 0) AS pointCount
    FROM categories c
    LEFT JOIN (
      SELECT type, COUNT(*) AS segment_count, SUM(point_count) AS point_count
      FROM segments GROUP BY type
    ) s ON s.type = c.name
    ORDER BY c.ignored ASC, segmentCount DESC, c.name ASC
  `).all() as unknown as Array<{
    name: string
    color: string
    visible: number
    ignored: number
    segmentCount: number
    pointCount: number
  }>
  return rows.map((r) => ({
    name: r.name,
    color: r.color,
    visible: r.visible === 1,
    ignored: r.ignored === 1,
    segmentCount: r.segmentCount,
    pointCount: r.pointCount
  }))
}

export function setCategoryVisible(db: DatabaseSync, name: string, visible: boolean): void {
  db.prepare('UPDATE categories SET visible = ? WHERE name = ?').run(visible ? 1 : 0, name)
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
