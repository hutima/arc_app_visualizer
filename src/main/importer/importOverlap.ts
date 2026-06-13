/**
 * Date-overlap handling for imports.
 *
 * Arc re-exports overlap: a fresh weekly export can cover dates already in the
 * database, and since files dedupe by content hash (not dates), importing it
 * would duplicate those days. When the user opts in, we (1) scan the pending
 * files for the date ranges they share with existing data, and (2) before
 * importing, clear existing data within the user-chosen windows — per file, so
 * non-overlapping days survive — and recompute any file left partially empty.
 *
 * Deletion is by a track's start time (a trip belongs to the day it began) and
 * a visit's timestamp; undated rows (no BETWEEN match) are never touched.
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { parseGpx } from './parseGpx'
import { deleteSegmentData } from '../db/editStore'
import type {
  ImportOverlapAnalysis,
  ImportOverlapFile,
  OverwriteWindow
} from '../../shared/types'

/** Min/max timestamp across all of a GPX file's points and waypoints. */
export function fileDateSpan(path: string): { start: number | null; end: number | null } {
  const parsed = parseGpx(readFileSync(path, 'utf8'))
  let start: number | null = null
  let end: number | null = null
  const seen = (ts: number | null): void => {
    if (ts === null) return
    if (start === null || ts < start) start = ts
    if (end === null || ts > end) end = ts
  }
  for (const t of parsed.tracks) for (const seg of t.segments) for (const p of seg) seen(p.tsMs)
  for (const w of parsed.waypoints) seen(w.tsMs)
  return { start, end }
}

interface Agg {
  lo: number | null
  hi: number | null
  n: number
}

/**
 * For each file that has dates overlapping existing data, report the tightest
 * span of that existing data (the suggested overwrite window) and how much
 * sits in it. Unparseable or undated files are skipped (the import itself
 * reports parse failures). Heavy by design — it parses every file — so callers
 * only run it when the user has asked to overwrite.
 */
export function analyzeImportOverlap(db: DatabaseSync, files: string[]): ImportOverlapAnalysis {
  const segAgg = db.prepare(
    'SELECT MIN(start_ts_ms) AS lo, MAX(start_ts_ms) AS hi, COUNT(*) AS n FROM segments WHERE start_ts_ms BETWEEN ? AND ?'
  )
  const wpAgg = db.prepare(
    'SELECT MIN(ts_ms) AS lo, MAX(ts_ms) AS hi, COUNT(*) AS n FROM waypoints WHERE ts_ms BETWEEN ? AND ?'
  )
  const overlaps: ImportOverlapFile[] = []
  for (const path of files) {
    let span: { start: number | null; end: number | null }
    try {
      span = fileDateSpan(path)
    } catch {
      continue
    }
    if (span.start === null || span.end === null) continue
    const seg = segAgg.get(span.start, span.end) as unknown as Agg
    const wp = wpAgg.get(span.start, span.end) as unknown as Agg
    if (seg.n === 0 && wp.n === 0) continue // no existing data in this file's range
    const los = [seg.lo, wp.lo].filter((v): v is number => v != null)
    const his = [seg.hi, wp.hi].filter((v): v is number => v != null)
    overlaps.push({
      path,
      filename: basename(path),
      fileStartTsMs: span.start,
      fileEndTsMs: span.end,
      overlapStartTsMs: Math.min(...los),
      overlapEndTsMs: Math.max(...his),
      overlapSegmentCount: seg.n,
      overlapVisitCount: wp.n
    })
  }
  return { totalFiles: files.length, overlaps }
}

/**
 * Clear existing data within each window, then repair the files it touched.
 * Runs in one transaction. Segments are removed when their trip *started* in a
 * window (so a segment straddling an edge isn't half-deleted), along with their
 * derived rows (via deleteSegmentData); visits go by timestamp. Orphaned places
 * are pruned and every affected file is recomputed (or dropped if emptied).
 */
export function clearDateWindows(db: DatabaseSync, windows: OverwriteWindow[]): void {
  const valid = windows.filter(
    (w) => Number.isFinite(w.startTsMs) && Number.isFinite(w.endTsMs) && w.endTsMs >= w.startTsMs
  )
  if (valid.length === 0) return

  const segsIn = db.prepare(
    'SELECT id, file_id AS fileId FROM segments WHERE start_ts_ms BETWEEN ? AND ?'
  )
  const visitFiles = db.prepare(
    'SELECT DISTINCT file_id AS fileId FROM waypoints WHERE ts_ms BETWEEN ? AND ?'
  )
  const deleteVisits = db.prepare('DELETE FROM waypoints WHERE ts_ms BETWEEN ? AND ?')

  db.exec('BEGIN IMMEDIATE')
  try {
    const affected = new Set<number>()
    for (const w of valid) {
      for (const s of segsIn.all(w.startTsMs, w.endTsMs) as Array<{ id: number; fileId: number }>) {
        affected.add(s.fileId)
        deleteSegmentData(db, s.id)
      }
      for (const v of visitFiles.all(w.startTsMs, w.endTsMs) as Array<{ fileId: number }>) {
        affected.add(v.fileId)
      }
      deleteVisits.run(w.startTsMs, w.endTsMs)
    }
    // A merged place may have lost all its visits.
    db.exec('DELETE FROM places WHERE id NOT IN (SELECT place_id FROM waypoints WHERE place_id IS NOT NULL)')
    for (const fileId of affected) recomputeFile(db, fileId)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/**
 * After a partial clear, bring a file row back in sync with what remains:
 * drop tracks that lost every segment, recompute counts / time span / bounds
 * from the surviving segments and visits, and delete the file outright if
 * nothing is left.
 */
function recomputeFile(db: DatabaseSync, fileId: number): void {
  db.prepare(`
    DELETE FROM tracks WHERE file_id = ?
      AND NOT EXISTS (SELECT 1 FROM segments s WHERE s.track_id = tracks.id)
  `).run(fileId)

  const agg = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM tracks WHERE file_id = :f) AS trackCount,
      (SELECT COUNT(*) FROM segments WHERE file_id = :f) AS segmentCount,
      (SELECT COALESCE(SUM(point_count), 0) FROM segments WHERE file_id = :f) AS pointCount,
      (SELECT COUNT(*) FROM waypoints WHERE file_id = :f) AS waypointCount,
      (SELECT MIN(start_ts_ms) FROM segments WHERE file_id = :f) AS segStart,
      (SELECT MAX(end_ts_ms) FROM segments WHERE file_id = :f) AS segEnd,
      (SELECT MIN(ts_ms) FROM waypoints WHERE file_id = :f) AS wpStart,
      (SELECT MAX(ts_ms) FROM waypoints WHERE file_id = :f) AS wpEnd,
      (SELECT MIN(min_lat) FROM segments WHERE file_id = :f) AS segMinLat,
      (SELECT MIN(min_lon) FROM segments WHERE file_id = :f) AS segMinLon,
      (SELECT MAX(max_lat) FROM segments WHERE file_id = :f) AS segMaxLat,
      (SELECT MAX(max_lon) FROM segments WHERE file_id = :f) AS segMaxLon,
      (SELECT MIN(lat) FROM waypoints WHERE file_id = :f) AS wpMinLat,
      (SELECT MIN(lon) FROM waypoints WHERE file_id = :f) AS wpMinLon,
      (SELECT MAX(lat) FROM waypoints WHERE file_id = :f) AS wpMaxLat,
      (SELECT MAX(lon) FROM waypoints WHERE file_id = :f) AS wpMaxLon
  `).get({ f: fileId }) as unknown as FileAgg

  if (agg.segmentCount === 0 && agg.waypointCount === 0) {
    db.prepare('DELETE FROM imported_files WHERE id = ?').run(fileId) // cascades the rest
    return
  }

  const minOf = (a: number | null, b: number | null): number | null =>
    a == null ? b : b == null ? a : Math.min(a, b)
  const maxOf = (a: number | null, b: number | null): number | null =>
    a == null ? b : b == null ? a : Math.max(a, b)

  db.prepare(`
    UPDATE imported_files SET
      track_count = ?, segment_count = ?, point_count = ?, waypoint_count = ?,
      start_ts_ms = ?, end_ts_ms = ?,
      min_lat = ?, min_lon = ?, max_lat = ?, max_lon = ?
    WHERE id = ?
  `).run(
    agg.trackCount, agg.segmentCount, agg.pointCount, agg.waypointCount,
    minOf(agg.segStart, agg.wpStart), maxOf(agg.segEnd, agg.wpEnd),
    minOf(agg.segMinLat, agg.wpMinLat), minOf(agg.segMinLon, agg.wpMinLon),
    maxOf(agg.segMaxLat, agg.wpMaxLat), maxOf(agg.segMaxLon, agg.wpMaxLon),
    fileId
  )
}

/** Recomputed file aggregates after a partial clear (counts never null). */
interface FileAgg {
  trackCount: number
  segmentCount: number
  pointCount: number
  waypointCount: number
  segStart: number | null
  segEnd: number | null
  wpStart: number | null
  wpEnd: number | null
  segMinLat: number | null
  segMinLon: number | null
  segMaxLat: number | null
  segMaxLon: number | null
  wpMinLat: number | null
  wpMinLon: number | null
  wpMaxLat: number | null
  wpMaxLon: number | null
}
