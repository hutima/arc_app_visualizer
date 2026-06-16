/**
 * Bulk archetype apply: timing the shared shape from each track's own speed
 * profile (pure), the overlay that replaces a track's geometry (pure), and the
 * end-to-end stamp that writes revertible drafts per track.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/main/db/db'
import {
  computeLayeredTimes,
  buildArchetypeOverlay,
  applyArchetypeToSegments,
  type CleanSeqPoint,
  type LonLat,
  type TimedPoint
} from '../src/main/db/archetypeApply'
import {
  countDraftSegments,
  prepareEffectivePoints,
  revertSegmentEdits
} from '../src/main/db/editStore'

describe('computeLayeredTimes (speed profile transfer)', () => {
  // A symmetric archetype (peak in the middle) and equator instances make
  // distances proportional to longitude, so fractions are exact.
  const archetype: LonLat[] = [
    { lon: 0, lat: 0 },
    { lon: 0.5, lat: 0 },
    { lon: 1, lat: 0 },
    { lon: 1.5, lat: 0 },
    { lon: 2, lat: 0 }
  ]

  it('spreads a constant-speed trip linearly along the shape', () => {
    const instance: TimedPoint[] = [
      { lon: 0, lat: 0, tsMs: 0 },
      { lon: 1, lat: 0, tsMs: 50000 },
      { lon: 2, lat: 0, tsMs: 100000 }
    ]
    expect(computeLayeredTimes(archetype, instance)).toEqual([0, 25000, 50000, 75000, 100000])
  })

  it('transfers a varying profile: slow first half, fast second half', () => {
    // 90 s to the midpoint, then only 10 s to the end.
    const instance: TimedPoint[] = [
      { lon: 0, lat: 0, tsMs: 0 },
      { lon: 1, lat: 0, tsMs: 90000 },
      { lon: 2, lat: 0, tsMs: 100000 }
    ]
    // A quarter of the way is half of the slow leg → 45 s; three-quarters is
    // half of the fast leg → 95 s. The shape's geometry didn't change the timing.
    expect(computeLayeredTimes(archetype, instance)).toEqual([0, 45000, 90000, 95000, 100000])
  })

  it('keeps time moving forward even if the profile wiggles backward', () => {
    const instance: TimedPoint[] = [
      { lon: 0, lat: 0, tsMs: 0 },
      { lon: 1, lat: 0, tsMs: 80000 },
      { lon: 2, lat: 0, tsMs: 40000 } // earlier than the midpoint (noisy clock)
    ]
    const out = computeLayeredTimes(archetype, instance)
    for (let i = 1; i < out.length; i++) expect(out[i]!).toBeGreaterThanOrEqual(out[i - 1]!)
  })

  it('returns all nulls when the instance has fewer than two dated points', () => {
    const instance: TimedPoint[] = [
      { lon: 0, lat: 0, tsMs: null },
      { lon: 1, lat: 0, tsMs: 5000 },
      { lon: 2, lat: 0, tsMs: null }
    ]
    expect(computeLayeredTimes(archetype, instance)).toEqual([null, null, null, null, null])
  })
})

describe('buildArchetypeOverlay', () => {
  it('keeps the endpoints, deletes the interior, and inserts the timed shape', () => {
    const clean: CleanSeqPoint[] = [
      { seq: 0, lon: 0, lat: 0 },
      { seq: 1, lon: 1, lat: 0 },
      { seq: 2, lon: 2, lat: 0 },
      { seq: 3, lon: 3, lat: 0 }
    ]
    const archetype: LonLat[] = [
      { lon: 0, lat: 0 },
      { lon: 1.5, lat: 0.5 },
      { lon: 3, lat: 0 }
    ]
    const overlay = buildArchetypeOverlay(clean, archetype, [10, 20, 30])

    const deletes = overlay.filter((e) => e.kind === 'delete')
    expect(deletes.map((e) => e.seq)).toEqual([1, 2]) // interior raw points
    const inserts = overlay.filter((e) => e.kind === 'insert')
    // Three vertices clustered in the open interval just above the first seq.
    expect(inserts.map((e) => e.seq)).toEqual([0.25, 0.5, 0.75])
    expect(inserts.map((e) => e.tsMs)).toEqual([10, 20, 30])
    expect(inserts[1]).toMatchObject({ lat: 0.5, lon: 1.5 })
  })

  it('is a no-op for a degenerate target or archetype', () => {
    const one: CleanSeqPoint[] = [{ seq: 0, lon: 0, lat: 0 }]
    expect(buildArchetypeOverlay(one, [{ lon: 0, lat: 0 }, { lon: 1, lat: 0 }], [0, 1])).toEqual([])
    const two: CleanSeqPoint[] = [
      { seq: 0, lon: 0, lat: 0 },
      { seq: 1, lon: 1, lat: 0 }
    ]
    expect(buildArchetypeOverlay(two, [{ lon: 0, lat: 0 }], [0])).toEqual([])
  })
})

let db: DatabaseSync
let nextHash = 0

beforeEach(() => {
  db = openDb(':memory:')
})
afterEach(() => {
  db.close()
})

/** Seed one segment of `type` from [lon, lat, tsMs] points. Returns its id. */
function seedTimed(type: string, pts: Array<[number, number, number]>): number {
  const fileId = Number(
    db.prepare(
      `INSERT INTO imported_files (filename, source_path, file_hash, file_size, imported_at_ms)
       VALUES ('f.gpx', '/f.gpx', ?, 1, 0)`
    ).run(`h${nextHash++}`).lastInsertRowid
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      trackId, fileId, type, pts[0]![2], pts[pts.length - 1]![2],
      pts.length, pts.length, minLat, minLon, maxLat, maxLon
    ).lastInsertRowid
  )
  const ins = db.prepare(
    'INSERT INTO points (segment_id, seq, ts_ms, lat, lon, flags) VALUES (?, ?, ?, ?, ?, 0)'
  )
  pts.forEach(([lon, lat, ts], i) => ins.run(segId, i, ts, lat, lon))
  revertSegmentEdits(db, segId) // build display geometry as import would
  return segId
}

describe('applyArchetypeToSegments', () => {
  it('stamps the archetype shape onto each track, timed from its own span', async () => {
    // Archetype: a peak in the middle (lat 0.5). Instances: straight lines with
    // the same endpoints but different durations.
    const archetype = seedTimed('car', [[0, 0, 0], [1, 0.5, 1000], [2, 0, 2000]])
    const fast = seedTimed('car', [[0, 0, 0], [1, 0, 60000], [2, 0, 120000]]) // 2 min
    const slow = seedTimed('car', [[0, 0, 1_000_000], [1, 0, 1_120_000], [2, 0, 1_240_000]]) // 4 min

    const res = await applyArchetypeToSegments(db, archetype, [archetype, fast, slow])
    expect(res).toEqual({ applied: 2, skipped: 0, failed: 0 })

    // Both targets carry a draft; the archetype itself is untouched.
    expect(countDraftSegments(db)).toBe(2)
    const eff = prepareEffectivePoints(db)

    // Each target's drawn line now follows the archetype (its peak appears).
    const fastPts = eff(fast)
    const peakFast = fastPts.find((p) => Math.abs(p.lat - 0.5) < 1e-9)
    expect(peakFast).toBeDefined()
    // The peak sits at the midpoint of the shape, so it takes the trip's own
    // midpoint time — 60 s for the fast trip, 1 120 000 ms for the slow one.
    expect(peakFast!.tsMs).toBe(60000)
    const peakSlow = eff(slow).find((p) => Math.abs(p.lat - 0.5) < 1e-9)
    expect(peakSlow!.tsMs).toBe(1_120_000)

    // The archetype's own points are unchanged (it was skipped).
    expect(eff(archetype).map((p) => p.lat)).toEqual([0, 0.5, 0])
  })

  it('skips undated tracks for timing but still stamps the shape', async () => {
    const archetype = seedTimed('car', [[0, 0, 0], [1, 0.5, 1000], [2, 0, 2000]])
    // An undated instance: timestamps absent (NULL).
    const undated = Number(
      db.prepare(
        `INSERT INTO imported_files (filename, source_path, file_hash, file_size, imported_at_ms)
         VALUES ('u.gpx', '/u.gpx', ?, 1, 0)`
      ).run(`h${nextHash++}`).lastInsertRowid
    )
    const trackId = Number(
      db.prepare("INSERT INTO tracks (file_id, type) VALUES (?, 'car')").run(undated).lastInsertRowid
    )
    const seg = Number(
      db.prepare(
        `INSERT INTO segments
          (track_id, file_id, type, start_ts_ms, end_ts_ms, point_count, clean_point_count,
           min_lat, min_lon, max_lat, max_lon)
         VALUES (?, ?, 'car', NULL, NULL, 3, 3, 0, 0, 0, 2)`
      ).run(trackId, undated).lastInsertRowid
    )
    const ins = db.prepare(
      'INSERT INTO points (segment_id, seq, ts_ms, lat, lon, flags) VALUES (?, ?, NULL, ?, ?, 0)'
    )
    const undatedPts: Array<[number, number]> = [[0, 0], [1, 0], [2, 0]]
    undatedPts.forEach(([lon, lat], i) => ins.run(seg, i, lat, lon))

    const res = await applyArchetypeToSegments(db, archetype, [seg])
    expect(res.applied).toBe(1)
    const pts = prepareEffectivePoints(db)(seg)
    expect(pts.find((p) => Math.abs(p.lat - 0.5) < 1e-9)).toBeDefined() // shape stamped
    expect(pts.every((p) => p.tsMs === null)).toBe(true) // no speed to infer
  })

  it('is fully revertible (drafts only; raw points survive)', async () => {
    const archetype = seedTimed('car', [[0, 0, 0], [1, 0.5, 1000], [2, 0, 2000]])
    const inst = seedTimed('car', [[0, 0, 0], [1, 0, 60000], [2, 0, 120000]])

    await applyArchetypeToSegments(db, archetype, [inst])
    expect(countDraftSegments(db)).toBe(1)

    revertSegmentEdits(db, inst)
    expect(countDraftSegments(db)).toBe(0)
    // The original straight line is back (no peak), raw points intact.
    expect(prepareEffectivePoints(db)(inst).every((p) => p.lat === 0)).toBe(true)
    const raw = db.prepare('SELECT COUNT(*) AS n FROM points WHERE segment_id = ?').get(inst) as {
      n: number
    }
    expect(raw.n).toBe(3)
  })
})
