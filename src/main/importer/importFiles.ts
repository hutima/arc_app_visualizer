/**
 * Import pipeline: walk → hash → dedupe → parse → clean → simplify → insert.
 *
 * Pure Node (no Electron imports) so it runs identically inside the
 * worker_thread and inside vitest. Each file is one SQLite transaction:
 * either a file is fully indexed or not at all, and a crash mid-import can
 * be resumed by simply re-running (hash dedupe skips finished files).
 */
import { readFileSync, statSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { openDb } from '../db/db'
import { insertPerf } from '../db/queries'
import { parseGpx, type ParsedPoint } from './parseGpx'
import { cleanSegment, DEFAULT_CLEANING, type CleaningConfig } from './clean'
import { simplifyIndices } from './simplify'
import { isoWeekFromFilename, isoWeekFromTimestamp } from './isoWeek'
import { hashFile } from './hashFile'
import { clearDateWindows } from './importOverlap'
import { DETAIL_LEVELS } from '../../shared/displayDetail'
import { colorForCategory, IGNORED_BY_DEFAULT } from '../../shared/categories'
import { emptyBounds, extendBounds, mergeBounds, boundsValid } from '../../shared/geo'
import type { ImportProgress, ImportStats, OverwriteWindow } from '../../shared/types'

export interface ImportOptions {
  dbPath: string
  paths: string[]
  cleaning?: CleaningConfig
  /** Date windows of existing data to clear before importing (overwrite mode). */
  overwrite?: OverwriteWindow[]
  onProgress?: (p: ImportProgress) => void
}

/** Recursively collect .gpx files from the given files/directories. */
export function collectGpxFiles(paths: string[]): string[] {
  const found = new Set<string>()
  const visit = (p: string): void => {
    let st
    try {
      st = statSync(p)
    } catch {
      return
    }
    if (st.isDirectory()) {
      for (const entry of readdirSync(p, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue
        visit(join(p, entry.name))
      }
    } else if (st.isFile() && /\.gpx$/i.test(p)) {
      found.add(p)
    }
  }
  for (const p of paths) visit(p)
  return [...found].sort()
}

interface PreparedStatements {
  findByHash: StatementSync
  insertFile: StatementSync
  updateFile: StatementSync
  insertTrack: StatementSync
  insertSegment: StatementSync
  insertPoint: StatementSync
  insertGeometry: StatementSync
  insertWaypoint: StatementSync
  insertCategory: StatementSync
  segmentIdsForFile: StatementSync
  deletePointsForSegment: StatementSync
  deleteGeomsForSegment: StatementSync
  deleteFile: StatementSync
}

function prepareAll(db: DatabaseSync): PreparedStatements {
  return {
    findByHash: db.prepare('SELECT id, status FROM imported_files WHERE file_hash = ?'),
    insertFile: db.prepare(`
      INSERT INTO imported_files
        (filename, source_path, file_hash, file_size, file_mtime_ms, imported_at_ms,
         iso_year, iso_week, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'importing')
    `),
    updateFile: db.prepare(`
      UPDATE imported_files SET
        start_ts_ms = ?, end_ts_ms = ?,
        min_lat = ?, min_lon = ?, max_lat = ?, max_lon = ?,
        track_count = ?, segment_count = ?, point_count = ?, waypoint_count = ?,
        import_ms = ?, status = 'imported', error = NULL
      WHERE id = ?
    `),
    insertTrack: db.prepare(`
      INSERT INTO tracks (file_id, name, type, start_ts_ms, end_ts_ms, min_lat, min_lon, max_lat, max_lon)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertSegment: db.prepare(`
      INSERT INTO segments
        (track_id, file_id, type, start_ts_ms, end_ts_ms, point_count, clean_point_count,
         min_lat, min_lon, max_lat, max_lon, flags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertPoint: db.prepare(`
      INSERT INTO points (segment_id, seq, ts_ms, lat, lon, ele, flags)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    insertGeometry: db.prepare(`
      INSERT INTO display_geometries (segment_id, detail, point_count, coords)
      VALUES (?, ?, ?, ?)
    `),
    insertWaypoint: db.prepare(`
      INSERT INTO waypoints (file_id, name, ts_ms, lat, lon) VALUES (?, ?, ?, ?, ?)
    `),
    insertCategory: db.prepare(`
      INSERT OR IGNORE INTO categories (name, color, visible, ignored) VALUES (?, ?, ?, ?)
    `),
    segmentIdsForFile: db.prepare('SELECT id FROM segments WHERE file_id = ?'),
    deletePointsForSegment: db.prepare('DELETE FROM points WHERE segment_id = ?'),
    deleteGeomsForSegment: db.prepare('DELETE FROM display_geometries WHERE segment_id = ?'),
    deleteFile: db.prepare('DELETE FROM imported_files WHERE id = ?')
  }
}

/** Remove all rows belonging to a previously failed/partial file import. */
function deleteFileData(stmts: PreparedStatements, fileId: number): void {
  const segs = stmts.segmentIdsForFile.all(fileId) as unknown as Array<{ id: number }>
  for (const s of segs) {
    stmts.deletePointsForSegment.run(s.id)
    stmts.deleteGeomsForSegment.run(s.id)
  }
  // tracks/segments/waypoints cascade from the file row (FK ON DELETE CASCADE).
  stmts.deleteFile.run(fileId)
}

interface FileResult {
  skipped: boolean
  trackCount: number
  segmentCount: number
  pointCount: number
  waypointCount: number
}

function importOneFile(
  db: DatabaseSync,
  stmts: PreparedStatements,
  path: string,
  hash: string,
  cleaning: CleaningConfig
): FileResult {
  const st = statSync(path)
  const filename = basename(path)
  const xml = readFileSync(path, 'utf8')
  const parsed = parseGpx(xml)

  db.exec('BEGIN IMMEDIATE')
  try {
    const week = isoWeekFromFilename(filename)
    const fileRes = stmts.insertFile.run(
      filename, path, hash, st.size, Math.round(st.mtimeMs), Date.now(),
      week?.year ?? null, week?.week ?? null
    )
    const fileId = Number(fileRes.lastInsertRowid)

    const fileBounds = emptyBounds()
    let fileStart: number | null = null
    let fileEnd: number | null = null
    let segmentCount = 0
    let pointCount = 0
    const seenTypes = new Set<string>()

    for (const track of parsed.tracks) {
      seenTypes.add(track.type)
      const trackBounds = emptyBounds()
      let trackStart: number | null = null
      let trackEnd: number | null = null

      // Insert the track first; segment rows reference it.
      const trackRes = stmts.insertTrack.run(
        fileId, track.name, track.type, null, null, null, null, null, null
      )
      const trackId = Number(trackRes.lastInsertRowid)

      for (const segPoints of track.segments) {
        const { flags, segmentFlags, cleanCount } = cleanSegment(segPoints, track.type, cleaning)

        const segBounds = emptyBounds()
        let segStart: number | null = null
        let segEnd: number | null = null
        for (let i = 0; i < segPoints.length; i++) {
          if (flags[i] !== 0) continue
          const p = segPoints[i]!
          extendBounds(segBounds, p.lat, p.lon)
          if (p.tsMs !== null) {
            if (segStart === null || p.tsMs < segStart) segStart = p.tsMs
            if (segEnd === null || p.tsMs > segEnd) segEnd = p.tsMs
          }
        }
        const hasBounds = boundsValid(segBounds)

        const segRes = stmts.insertSegment.run(
          trackId, fileId, track.type, segStart, segEnd,
          segPoints.length, cleanCount,
          hasBounds ? segBounds.minLat : null, hasBounds ? segBounds.minLon : null,
          hasBounds ? segBounds.maxLat : null, hasBounds ? segBounds.maxLon : null,
          segmentFlags
        )
        const segmentId = Number(segRes.lastInsertRowid)
        segmentCount++

        for (let i = 0; i < segPoints.length; i++) {
          const p = segPoints[i]!
          stmts.insertPoint.run(
            segmentId, i, p.tsMs,
            Number.isFinite(p.lat) ? p.lat : null,
            Number.isFinite(p.lon) ? p.lon : null,
            p.ele, flags[i]!
          )
          pointCount++
        }

        insertDisplayGeometries(stmts, segmentId, segPoints, flags)

        if (hasBounds) {
          mergeBounds(trackBounds, segBounds)
        }
        if (segStart !== null && (trackStart === null || segStart < trackStart)) trackStart = segStart
        if (segEnd !== null && (trackEnd === null || segEnd > trackEnd)) trackEnd = segEnd
      }

      const hasTrackBounds = boundsValid(trackBounds)
      db.prepare(`
        UPDATE tracks SET start_ts_ms = ?, end_ts_ms = ?, min_lat = ?, min_lon = ?, max_lat = ?, max_lon = ?
        WHERE id = ?
      `).run(
        trackStart, trackEnd,
        hasTrackBounds ? trackBounds.minLat : null, hasTrackBounds ? trackBounds.minLon : null,
        hasTrackBounds ? trackBounds.maxLat : null, hasTrackBounds ? trackBounds.maxLon : null,
        trackId
      )
      if (hasTrackBounds) mergeBounds(fileBounds, trackBounds)
      if (trackStart !== null && (fileStart === null || trackStart < fileStart)) fileStart = trackStart
      if (trackEnd !== null && (fileEnd === null || trackEnd > fileEnd)) fileEnd = trackEnd
    }

    for (const w of parsed.waypoints) {
      stmts.insertWaypoint.run(fileId, w.name, w.tsMs, w.lat, w.lon)
      extendBounds(fileBounds, w.lat, w.lon)
      if (w.tsMs !== null && (fileStart === null || w.tsMs < fileStart)) fileStart = w.tsMs
      if (w.tsMs !== null && (fileEnd === null || w.tsMs > fileEnd)) fileEnd = w.tsMs
    }

    for (const type of seenTypes) {
      const ignored = IGNORED_BY_DEFAULT.has(type) ? 1 : 0
      stmts.insertCategory.run(type, colorForCategory(type), ignored ? 0 : 1, ignored)
    }

    // Fall back to timestamps for week labeling when the filename has none.
    if (week === null && fileStart !== null) {
      const w = isoWeekFromTimestamp(fileStart)
      db.prepare('UPDATE imported_files SET iso_year = ?, iso_week = ? WHERE id = ?')
        .run(w.year, w.week, fileId)
    }

    const hasFileBounds = boundsValid(fileBounds)
    stmts.updateFile.run(
      fileStart, fileEnd,
      hasFileBounds ? fileBounds.minLat : null, hasFileBounds ? fileBounds.minLon : null,
      hasFileBounds ? fileBounds.maxLat : null, hasFileBounds ? fileBounds.maxLon : null,
      parsed.tracks.length, segmentCount, pointCount, parsed.waypoints.length,
      0, fileId
    )
    db.exec('COMMIT')
    return {
      skipped: false,
      trackCount: parsed.tracks.length,
      segmentCount,
      pointCount,
      waypointCount: parsed.waypoints.length
    }
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** Build per-zoom simplified polylines from the clean (unflagged) points. */
function insertDisplayGeometries(
  stmts: PreparedStatements,
  segmentId: number,
  points: ParsedPoint[],
  flags: Uint8Array
): void {
  const lons: number[] = []
  const lats: number[] = []
  for (let i = 0; i < points.length; i++) {
    if (flags[i] === 0) {
      lons.push(points[i]!.lon)
      lats.push(points[i]!.lat)
    }
  }
  if (lons.length < 2) return

  for (const level of DETAIL_LEVELS) {
    const kept = simplifyIndices(lons, lats, level.toleranceDeg)
    if (kept.length < 2) continue
    const coords = new Float32Array(kept.length * 2)
    for (let i = 0; i < kept.length; i++) {
      coords[i * 2] = lons[kept[i]!]!
      coords[i * 2 + 1] = lats[kept[i]!]!
    }
    stmts.insertGeometry.run(
      segmentId, level.detail, kept.length,
      new Uint8Array(coords.buffer, 0, coords.byteLength)
    )
  }
}

export async function runImport(options: ImportOptions): Promise<ImportStats> {
  const cleaning = options.cleaning ?? DEFAULT_CLEANING
  const onProgress = options.onProgress ?? (() => undefined)
  const t0 = performance.now()

  const files = collectGpxFiles(options.paths)
  onProgress({ kind: 'started', totalFiles: files.length })

  const db = openDb(options.dbPath)
  try {
    // Overwrite mode: clear existing data in the chosen windows before this
    // import adds the replacement files (so overlapping dates don't duplicate).
    if (options.overwrite && options.overwrite.length > 0) {
      clearDateWindows(db, options.overwrite)
    }
    const stmts = prepareAll(db)
    const stats: ImportStats = {
      filesProcessed: 0,
      filesSkipped: 0,
      filesFailed: 0,
      trackCount: 0,
      segmentCount: 0,
      pointCount: 0,
      waypointCount: 0,
      durationMs: 0
    }

    for (let i = 0; i < files.length; i++) {
      const path = files[i]!
      const filename = basename(path)
      const tFile = performance.now()
      try {
        const hash = await hashFile(path)
        const existing = stmts.findByHash.get(hash) as
          | { id: number; status: string }
          | undefined

        if (existing && existing.status === 'imported') {
          stats.filesSkipped++
          onProgress({
            kind: 'file', index: i, totalFiles: files.length, filename,
            skipped: true, failed: false, pointCount: 0, segmentCount: 0,
            durationMs: performance.now() - tFile
          })
          continue
        }
        if (existing) {
          // Leftover from a failed/interrupted import: clear and redo.
          deleteFileData(stmts, existing.id)
        }

        const res = importOneFile(db, stmts, path, hash, cleaning)
        const durationMs = performance.now() - tFile
        db.prepare('UPDATE imported_files SET import_ms = ? WHERE file_hash = ?').run(durationMs, hash)

        stats.filesProcessed++
        stats.trackCount += res.trackCount
        stats.segmentCount += res.segmentCount
        stats.pointCount += res.pointCount
        stats.waypointCount += res.waypointCount
        onProgress({
          kind: 'file', index: i, totalFiles: files.length, filename,
          skipped: false, failed: false,
          pointCount: res.pointCount, segmentCount: res.segmentCount, durationMs
        })
      } catch (err) {
        stats.filesFailed++
        const message = err instanceof Error ? err.message : String(err)
        onProgress({
          kind: 'file', index: i, totalFiles: files.length, filename,
          skipped: false, failed: true, error: message,
          pointCount: 0, segmentCount: 0, durationMs: performance.now() - tFile
        })
      }
    }

    stats.durationMs = performance.now() - t0
    insertPerf(
      db, 'import', stats.durationMs,
      `files=${stats.filesProcessed} skipped=${stats.filesSkipped} failed=${stats.filesFailed} points=${stats.pointCount}`
    )
    onProgress({ kind: 'done', stats })
    return stats
  } finally {
    db.close()
  }
}
