/**
 * Import overwrite: scanning pending files for date overlaps, and clearing a
 * date window before re-import — deleting only in-window data per the chosen
 * range, recomputing partially-emptied files, dropping fully-emptied ones, and
 * leaving undated rows and orphaned places consistent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/main/db/db'
import {
  analyzeImportOverlap,
  clearDateWindows,
  fileDateSpan
} from '../src/main/importer/importOverlap'
import { runImport } from '../src/main/importer/importFiles'
import { mergePlaces } from '../src/main/db/placeStore'

const T = (iso: string): number => Date.parse(iso)

/** Write a minimal synthetic GPX (one walking track + optional visits). */
function writeGpx(
  dir: string,
  name: string,
  pts: Array<[number, number, string]>,
  wpts: Array<[number, number, string, string]> = []
): string {
  const trkpts = pts
    .map(([la, lo, iso]) => `<trkpt lat="${la}" lon="${lo}"><time>${iso}</time></trkpt>`)
    .join('')
  const wp = wpts
    .map(([la, lo, iso, nm]) => `<wpt lat="${la}" lon="${lo}"><time>${iso}</time><name>${nm}</name></wpt>`)
    .join('')
  const xml = `<?xml version="1.0"?><gpx><trk><type>walking</type><trkseg>${trkpts}</trkseg></trk>${wp}</gpx>`
  const p = join(dir, name)
  writeFileSync(p, xml)
  return p
}
let db: DatabaseSync
let nextHash = 0

beforeEach(() => {
  db = openDb(':memory:')
})
afterEach(() => db.close())

function addFile(): number {
  return Number(
    db.prepare(`
      INSERT INTO imported_files (filename, source_path, file_hash, file_size, imported_at_ms)
      VALUES ('f.gpx', '/f.gpx', ?, 0, 0)
    `).run(`hash-${nextHash++}`).lastInsertRowid
  )
}

/** A dated track+segment with the given points ([lat, lon, tsMs]). */
function addSegment(fileId: number, type: string, pts: Array<[number, number, number]>): number {
  const trackId = Number(
    db.prepare('INSERT INTO tracks (file_id, type) VALUES (?, ?)').run(fileId, type).lastInsertRowid
  )
  const ts = pts.map((p) => p[2])
  const lats = pts.map((p) => p[0])
  const lons = pts.map((p) => p[1])
  const segId = Number(
    db.prepare(`
      INSERT INTO segments
        (track_id, file_id, type, start_ts_ms, end_ts_ms, point_count, clean_point_count,
         min_lat, min_lon, max_lat, max_lon)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trackId, fileId, type, Math.min(...ts), Math.max(...ts), pts.length, pts.length,
      Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)
    ).lastInsertRowid
  )
  const ins = db.prepare(
    'INSERT INTO points (segment_id, seq, ts_ms, lat, lon, ele, flags) VALUES (?, ?, ?, ?, ?, NULL, 0)'
  )
  pts.forEach(([lat, lon, t], i) => ins.run(segId, i, t, lat, lon))
  return segId
}

const addWaypoint = (fileId: number, name: string | null, ts: number | null, lat: number, lon: number): number =>
  Number(
    db.prepare('INSERT INTO waypoints (file_id, name, ts_ms, lat, lon) VALUES (?, ?, ?, ?, ?)')
      .run(fileId, name, ts, lat, lon).lastInsertRowid
  )

const countOf = (table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
const fileRow = (id: number): Record<string, number | null> | undefined =>
  db.prepare('SELECT * FROM imported_files WHERE id = ?').get(id) as never

describe('clearDateWindows', () => {
  it('deletes in-window data, keeps the rest, and recomputes the file', () => {
    const f = addFile()
    const inSeg = addSegment(f, 'walking', [[0, 0, T('2022-03-01T08:00:00Z')], [0.001, 0, T('2022-03-01T08:30:00Z')]])
    addSegment(f, 'walking', [[1, 1, T('2022-03-20T08:00:00Z')], [1.001, 1, T('2022-03-20T08:30:00Z')]]) // out
    addWaypoint(f, 'In', T('2022-03-02T00:00:00Z'), 0, 0) // in window
    addWaypoint(f, 'Out', T('2022-03-21T00:00:00Z'), 1, 1) // out

    clearDateWindows(db, [{ startTsMs: T('2022-03-01T00:00:00Z'), endTsMs: T('2022-03-05T23:59:59Z') }])

    expect(countOf('segments')).toBe(1) // only the March 20 segment
    expect(db.prepare('SELECT 1 FROM segments WHERE id = ?').get(inSeg)).toBeUndefined()
    expect(countOf('points')).toBe(2) // the surviving segment's points
    expect(countOf('tracks')).toBe(1) // the emptied track was dropped
    expect(countOf('waypoints')).toBe(1)
    const row = fileRow(f)!
    expect(row.segment_count).toBe(1)
    expect(row.waypoint_count).toBe(1)
    // Span recomputed across the survivors: segment start … the later visit.
    expect(row.start_ts_ms).toBe(T('2022-03-20T08:00:00Z'))
    expect(row.end_ts_ms).toBe(T('2022-03-21T00:00:00Z'))
  })

  it('deletes a file left fully empty by the clear', () => {
    const f = addFile()
    addSegment(f, 'walking', [[0, 0, T('2022-05-01T00:00:00Z')], [0.001, 0, T('2022-05-01T00:10:00Z')]])
    addWaypoint(f, 'X', T('2022-05-02T00:00:00Z'), 0, 0)

    clearDateWindows(db, [{ startTsMs: T('2022-05-01T00:00:00Z'), endTsMs: T('2022-05-10T00:00:00Z') }])

    expect(fileRow(f)).toBeUndefined()
    expect(countOf('segments')).toBe(0)
    expect(countOf('waypoints')).toBe(0)
    expect(countOf('tracks')).toBe(0)
  })

  it('never touches undated rows', () => {
    const f = addFile()
    // An undated segment + visit: no BETWEEN match, so a clear must skip them.
    const trackId = Number(db.prepare('INSERT INTO tracks (file_id, type) VALUES (?, ?)').run(f, 'walking').lastInsertRowid)
    db.prepare(`
      INSERT INTO segments (track_id, file_id, type, start_ts_ms, end_ts_ms, point_count, clean_point_count)
      VALUES (?, ?, 'walking', NULL, NULL, 1, 1)
    `).run(trackId, f)
    addWaypoint(f, 'Undated', null, 0, 0)

    clearDateWindows(db, [{ startTsMs: 0, endTsMs: T('2100-01-01T00:00:00Z') }])

    expect(countOf('segments')).toBe(1)
    expect(countOf('waypoints')).toBe(1)
  })

  it('prunes a place orphaned when its visits are cleared', () => {
    const f = addFile()
    const a = addWaypoint(f, 'Home', T('2022-06-01T00:00:00Z'), 0, 0)
    const b = addWaypoint(f, 'Casa', T('2022-06-02T00:00:00Z'), 40, 40)
    mergePlaces(db, [{ waypointId: a }, { waypointId: b }], 'Home')
    expect(countOf('places')).toBe(1)

    clearDateWindows(db, [{ startTsMs: T('2022-06-01T00:00:00Z'), endTsMs: T('2022-06-30T00:00:00Z') }])

    expect(countOf('waypoints')).toBe(0)
    expect(countOf('places')).toBe(0)
  })
})

describe('analyzeImportOverlap / fileDateSpan', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'arc-overlap-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads a file date span across points and waypoints', () => {
    const p = writeGpx(
      dir,
      'span.gpx',
      [[0, 0, '2022-03-01T08:00:00Z'], [0.001, 0, '2022-03-01T09:00:00Z']],
      [[0, 0, '2022-03-05T00:00:00Z', 'Home']]
    )
    const span = fileDateSpan(p)
    expect(span.start).toBe(T('2022-03-01T08:00:00Z'))
    expect(span.end).toBe(T('2022-03-05T00:00:00Z'))
  })

  it('reports the existing-data overlap for each overlapping file, skipping the rest', () => {
    // Existing data: a track on Mar 3 and a visit on Mar 4.
    const f = addFile()
    addSegment(f, 'walking', [[0, 0, T('2022-03-03T12:00:00Z')], [0.001, 0, T('2022-03-03T12:30:00Z')]])
    addWaypoint(f, 'Home', T('2022-03-04T00:00:00Z'), 0, 0)

    const overlapping = writeGpx(dir, 'mar.gpx', [
      [0, 0, '2022-03-01T00:00:00Z'],
      [0.001, 0, '2022-03-07T00:00:00Z']
    ])
    const disjoint = writeGpx(dir, 'dec.gpx', [
      [0, 0, '2022-12-01T00:00:00Z'],
      [0.001, 0, '2022-12-02T00:00:00Z']
    ])

    const result = analyzeImportOverlap(db, [overlapping, disjoint])
    expect(result.totalFiles).toBe(2)
    expect(result.overlaps).toHaveLength(1)
    const o = result.overlaps[0]!
    expect(o.filename).toBe('mar.gpx')
    expect(o.overlapSegmentCount).toBe(1)
    expect(o.overlapVisitCount).toBe(1)
    // Tightest span of existing data inside the file's Mar 1–7 range.
    expect(o.overlapStartTsMs).toBe(T('2022-03-03T12:00:00Z'))
    expect(o.overlapEndTsMs).toBe(T('2022-03-04T00:00:00Z'))
  })
})

describe('runImport with overwrite', () => {
  let dir: string
  let dbPath: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'arc-import-'))
    dbPath = join(dir, 'test.db')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('clears the overlap window before importing the replacement file', async () => {
    const v1 = writeGpx(
      dir,
      'week1.gpx',
      [[0, 0, '2022-01-03T08:00:00Z'], [0.001, 0, '2022-01-03T09:00:00Z']],
      [[0, 0, '2022-01-03T10:00:00Z', 'Old']]
    )
    await runImport({ dbPath, paths: [v1] })

    // A re-export of that week (different hash) plus a new day outside it.
    const v2 = writeGpx(
      dir,
      'week1-v2.gpx',
      [[0.2, 0.2, '2022-01-03T08:05:00Z'], [0.5, 0.5, '2022-01-10T09:00:00Z']],
      [[0, 0, '2022-01-10T10:00:00Z', 'New']]
    )
    await runImport({
      dbPath,
      paths: [v2],
      overwrite: [{ startTsMs: T('2022-01-01T00:00:00Z'), endTsMs: T('2022-01-05T23:59:59Z') }]
    })

    const db2 = openDb(dbPath)
    try {
      const names = (db2.prepare('SELECT name FROM waypoints ORDER BY name').all() as Array<{ name: string }>)
        .map((r) => r.name)
      expect(names).toContain('New') // the replacement imported
      expect(names).not.toContain('Old') // the Jan-3 visit was overwritten
      // The original v1 segment was cleared; only week1-v2's segment remains.
      const segs = db2.prepare('SELECT start_ts_ms AS ts FROM segments ORDER BY ts').all() as Array<{ ts: number }>
      expect(segs).toHaveLength(1)
      expect(segs[0]!.ts).toBe(T('2022-01-03T08:05:00Z')) // from week1-v2, not the cleared original
    } finally {
      db2.close()
    }
  })
})
