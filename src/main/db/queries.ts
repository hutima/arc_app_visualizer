import type { DatabaseSync } from 'node:sqlite'
import type {
  CategoryInfo,
  DatasetSummary,
  PerfEntry,
  ViewportQuery,
  ViewportWaypoint
} from '../../shared/types'
import { detailForZoom } from '../../shared/displayDetail'

export interface ViewportSegmentRow {
  id: number
  type: string
  point_count: number
  coords: Uint8Array
}

export interface ViewportRowsResult {
  rows: ViewportSegmentRow[]
  truncated: boolean
  detail: number
}

/**
 * Viewport query: bounds intersection + time-range overlap + non-ignored
 * categories, returning the simplified geometry blob for the zoom-matched
 * detail level. Segments without timestamps pass any time filter (transparent
 * rather than hidden).
 */
export function queryViewportSegments(
  db: DatabaseSync,
  q: ViewportQuery,
  limit: number
): ViewportRowsResult {
  const detail = detailForZoom(q.zoom)
  const stmt = db.prepare(`
    SELECT s.id, s.type, d.point_count, d.coords
    FROM segments s
    JOIN display_geometries d ON d.segment_id = s.id AND d.detail = ?
    WHERE s.max_lat >= ? AND s.min_lat <= ?
      AND s.max_lon >= ? AND s.min_lon <= ?
      AND (? IS NULL OR s.end_ts_ms IS NULL OR s.end_ts_ms >= ?)
      AND (? IS NULL OR s.start_ts_ms IS NULL OR s.start_ts_ms <= ?)
      AND s.type NOT IN (SELECT name FROM categories WHERE ignored = 1)
    LIMIT ?
  `)
  const rows = stmt.all(
    detail,
    q.minLat, q.maxLat,
    q.minLon, q.maxLon,
    q.startTsMs, q.startTsMs,
    q.endTsMs, q.endTsMs,
    limit + 1
  ) as unknown as ViewportSegmentRow[]

  const truncated = rows.length > limit
  if (truncated) rows.length = limit
  return { rows, truncated, detail }
}

export function queryViewportWaypoints(
  db: DatabaseSync,
  q: ViewportQuery,
  limit: number
): ViewportWaypoint[] {
  const stmt = db.prepare(`
    SELECT id, lat, lon, ts_ms AS tsMs, name
    FROM waypoints
    WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
      AND (? IS NULL OR ts_ms IS NULL OR ts_ms >= ?)
      AND (? IS NULL OR ts_ms IS NULL OR ts_ms <= ?)
    LIMIT ?
  `)
  return stmt.all(
    q.minLat, q.maxLat,
    q.minLon, q.maxLon,
    q.startTsMs, q.startTsMs,
    q.endTsMs, q.endTsMs,
    limit
  ) as unknown as ViewportWaypoint[]
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
