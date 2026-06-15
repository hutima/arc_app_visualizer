/**
 * Selecting tracks similar to an anchor for bulk cleaning: same type,
 * direction-aware (no reverse trips), either same-endpoints or passes-through.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/main/db/db'
import { findSimilarSegments } from '../src/main/db/similarSegments'

let db: DatabaseSync
let hash = 0

/** Insert a segment of `type` from an array of [lon, lat] clean points. */
function addSegment(db: DatabaseSync, type: string, pts: Array<[number, number]>): number {
  const fileId = Number(
    db.prepare(
      `INSERT INTO imported_files (filename, source_path, file_hash, file_size, imported_at_ms)
       VALUES ('f.gpx', '/f.gpx', ?, 1, 0)`
    ).run(`h${hash++}`).lastInsertRowid
  )
  const trackId = Number(
    db.prepare('INSERT INTO tracks (file_id, type) VALUES (?, ?)').run(fileId, type).lastInsertRowid
  )
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity
  for (const [lon, lat] of pts) {
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat)
    minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon)
  }
  const segId = Number(
    db.prepare(
      `INSERT INTO segments
        (track_id, file_id, type, start_ts_ms, end_ts_ms, point_count, clean_point_count,
         min_lat, min_lon, max_lat, max_lon)
       VALUES (?, ?, ?, 0, 1000, ?, ?, ?, ?, ?, ?)`
    ).run(trackId, fileId, type, pts.length, pts.length, minLat, minLon, maxLat, maxLon).lastInsertRowid
  )
  const ins = db.prepare(
    'INSERT INTO points (segment_id, seq, ts_ms, lat, lon, flags) VALUES (?, ?, ?, ?, ?, 0)'
  )
  pts.forEach(([lon, lat], i) => ins.run(segId, i, i * 1000, lat, lon))
  return segId
}

describe('findSimilarSegments', () => {
  let anchor: number, match: number, wrongType: number, farEnd: number, reverse: number, through: number

  beforeEach(() => {
    db = openDb(':memory:')
    anchor = addSegment(db, 'car', [[0, 0], [0, 0.01], [0, 0.02]])
    // Same corridor, endpoints ~50–80 m off → matches.
    match = addSegment(db, 'car', [[0.0005, 0.0005], [0, 0.01], [0.0003, 0.0201]])
    wrongType = addSegment(db, 'walking', [[0, 0], [0, 0.01], [0, 0.02]])
    // Ends ~3 km away from the anchor's end.
    farEnd = addSegment(db, 'car', [[0, 0], [0, 0.025], [0, 0.05]])
    // The same journey reversed (start≈end, end≈start).
    reverse = addSegment(db, 'car', [[0, 0.02], [0, 0.01], [0, 0]])
    // A longer track running through both endpoints in order.
    through = addSegment(db, 'car', [[0, -0.01], [0, 0], [0, 0.01], [0, 0.02], [0, 0.03]])
  })

  it('matches same-type tracks with similar endpoints, including the anchor', () => {
    const ids = findSimilarSegments(db, anchor, 100, 'endpoints').sort((a, b) => a - b)
    expect(ids).toEqual([anchor, match].sort((a, b) => a - b))
  })

  it('is direction-aware (a reverse trip never matches)', () => {
    expect(findSimilarSegments(db, anchor, 100, 'endpoints')).not.toContain(reverse)
    expect(findSimilarSegments(db, anchor, 100, 'passthrough')).not.toContain(reverse)
  })

  it('passthrough mode also catches longer tracks running through both points', () => {
    const ids = findSimilarSegments(db, anchor, 100, 'passthrough')
    expect(ids).toContain(anchor)
    expect(ids).toContain(match)
    expect(ids).toContain(through)
    expect(ids).not.toContain(farEnd) // never comes within 100 m of the end
    expect(ids).not.toContain(wrongType)
  })

  it('excludes other activity types', () => {
    expect(findSimilarSegments(db, anchor, 100, 'endpoints')).not.toContain(wrongType)
  })

  it('a tighter radius drops the offset match', () => {
    expect(findSimilarSegments(db, anchor, 20, 'endpoints')).toEqual([anchor])
  })
})
