/**
 * Track editing: the overlay merge (pure), draft persistence + derived
 * geometry rebuild, the effective-point path the matcher and raw-detail
 * queries consume, revert, permanent baking into raw points, point deletion,
 * splitting a segment in two, and merging segments into one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/main/db/db'
import {
  applyEdits,
  commitAllDrafts,
  countDraftSegments,
  getSegmentEditState,
  listDraftSegmentIds,
  listMergeCandidates,
  mergeSegments,
  prepareEffectivePoints,
  revertAllDrafts,
  revertSegmentEdits,
  saveSegmentEdits,
  splitSegment,
  splitSegmentTyped,
  setSegmentType,
  deleteSegment,
  bulkDeleteSegments,
  type CleanPoint
} from '../src/main/db/editStore'
import { queryViewportSegments } from '../src/main/db/queries'
import { DETAIL_LEVELS } from '../src/shared/displayDetail'

let db: DatabaseSync

beforeEach(() => {
  db = openDb(':memory:')
})

afterEach(() => {
  db.close()
})

let nextHash = 0

/**
 * One synthetic walking segment along the equator: 5 raw points at seqs 0–4,
 * seq 2 flagged away by cleaning (so 4 clean points), timestamps every 10 s.
 */
function seedSegment(): number {
  const fileRes = db.prepare(`
    INSERT INTO imported_files (filename, source_path, file_hash, file_size, imported_at_ms)
    VALUES ('w.gpx', '/w.gpx', ?, 1, 0)
  `).run(`hash-${nextHash++}`)
  const fileId = Number(fileRes.lastInsertRowid)
  const trackRes = db.prepare("INSERT INTO tracks (file_id, type) VALUES (?, 'walking')").run(fileId)
  const trackId = Number(trackRes.lastInsertRowid)
  const segRes = db.prepare(`
    INSERT INTO segments
      (track_id, file_id, type, start_ts_ms, end_ts_ms, point_count, clean_point_count,
       min_lat, min_lon, max_lat, max_lon)
    VALUES (?, ?, 'walking', 0, 40000, 5, 4, 0, 0, 0, 0.04)
  `).run(trackId, fileId)
  const segId = Number(segRes.lastInsertRowid)
  const ins = db.prepare(
    'INSERT INTO points (segment_id, seq, ts_ms, lat, lon, ele, flags) VALUES (?, ?, ?, ?, ?, NULL, ?)'
  )
  ins.run(segId, 0, 0, 0, 0, 0)
  ins.run(segId, 1, 10000, 0, 0.01, 0)
  ins.run(segId, 2, 20000, 0.5, 0.02, 1) // flagged spike — invisible to editing
  ins.run(segId, 3, 30000, 0, 0.03, 0)
  ins.run(segId, 4, 40000, 0, 0.04, 0)
  // Display geometry as import would have built it (rebuild from raw).
  revertSegmentEdits(db, segId)
  return segId
}

const MOVE = { seq: 1, lat: 0.05, lon: 0.01, kind: 'move' as const }
const INSERT = { seq: 0.5, lat: 0.02, lon: 0.005, kind: 'insert' as const }

const displayCoords = (segId: number, detail: number): Float32Array => {
  const row = db.prepare(
    'SELECT coords FROM display_geometries WHERE segment_id = ? AND detail = ?'
  ).get(segId, detail) as { coords: Uint8Array } | undefined
  expect(row).toBeDefined()
  const c = row!.coords
  return new Float32Array(c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength))
}

const lats = (coords: Float32Array): number[] => {
  const out: number[] = []
  for (let i = 1; i < coords.length; i += 2) out.push(coords[i]!)
  return out
}

describe('applyEdits (pure overlay merge)', () => {
  const base: CleanPoint[] = [
    { seq: 0, lon: 0, lat: 0, tsMs: 0 },
    { seq: 1, lon: 0.01, lat: 0, tsMs: 10000 },
    { seq: 2, lon: 0.02, lat: 0, tsMs: null },
    { seq: 3, lon: 0.03, lat: 0, tsMs: 30000 }
  ]

  it('returns untouched points when there are no edits', () => {
    const out = applyEdits(base, [])
    expect(out).toHaveLength(4)
    expect(out.every((p) => p.edit === null)).toBe(true)
  })

  it('moves replace coordinates but keep the raw timestamp', () => {
    const out = applyEdits(base, [{ seq: 1, kind: 0, lat: 0.1, lon: 0.011 }])
    expect(out[1]).toMatchObject({ seq: 1, lat: 0.1, lon: 0.011, tsMs: 10000, edit: 'move' })
  })

  it('inserts land between their neighbors with an interpolated timestamp', () => {
    const out = applyEdits(base, [{ seq: 0.25, kind: 1, lat: 0.05, lon: 0.004 }])
    expect(out).toHaveLength(5)
    expect(out[1]).toMatchObject({ seq: 0.25, edit: 'insert' })
    // Lerped by seq between ts(0)=0 and ts(1)=10000.
    expect(out[1]!.tsMs).toBe(2500)
  })

  it('interpolates across timestampless neighbors and nulls at the fringes', () => {
    const mid = applyEdits(base, [{ seq: 2.5, kind: 1, lat: 0, lon: 0.025 }])
    // Between seq 1 (10 s) and seq 3 (30 s); seq 2 has no ts.
    expect(mid[3]!.tsMs).toBe(25000)
    const fringe = applyEdits(
      [{ seq: 0, lon: 0, lat: 0, tsMs: null }, { seq: 1, lon: 0.01, lat: 0, tsMs: null }],
      [{ seq: 0.5, kind: 1, lat: 0, lon: 0.005 }]
    )
    expect(fringe[1]!.tsMs).toBeNull()
  })

  it('deletes drop the point at their seq', () => {
    const out = applyEdits(base, [{ seq: 1, kind: 2, lat: 0, lon: 0 }])
    expect(out.map((p) => p.seq)).toEqual([0, 2, 3])
  })

  it('an inserted vertex with an explicit ts keeps it (no interpolation)', () => {
    // The bulk archetype apply stamps each vertex's time directly; by-seq it
    // would have interpolated to 2500, but the explicit 12345 must win.
    const out = applyEdits(base, [{ seq: 0.25, kind: 1, lat: 0.05, lon: 0.004, tsMs: 12345 }])
    expect(out[1]).toMatchObject({ seq: 0.25, edit: 'insert', tsMs: 12345 })
  })
})

describe('draft save', () => {
  it('persists the overlay and reports it back through the edit state', () => {
    const segId = seedSegment()
    saveSegmentEdits(db, segId, [MOVE, INSERT], 'draft')

    const state = getSegmentEditState(db, segId)!
    expect(state.hasDraft).toBe(true)
    expect(state.type).toBe('walking')
    // 4 clean raw points + 1 insert; the flagged spike stays invisible.
    expect(state.points).toHaveLength(5)
    expect(state.points[1]).toMatchObject({ seq: 0.5, lat: 0.02, edit: 'insert', tsMs: 5000 })
    expect(state.points[2]).toMatchObject({ seq: 1, lat: 0.05, edit: 'move', tsMs: 10000 })
  })

  it('rebuilds display geometry and bounds, and drops stale matched geometry', () => {
    const segId = seedSegment()
    db.prepare(
      'INSERT INTO rail_matched_geom (segment_id, detail, point_count, coords) VALUES (?, 2, 2, ?)'
    ).run(segId, new Uint8Array(16))

    saveSegmentEdits(db, segId, [MOVE, INSERT], 'draft')

    for (const level of DETAIL_LEVELS) {
      expect(Math.max(...lats(displayCoords(segId, level.detail)))).toBeCloseTo(0.05, 5)
    }
    const seg = db.prepare('SELECT max_lat FROM segments WHERE id = ?').get(segId) as {
      max_lat: number
    }
    expect(seg.max_lat).toBeCloseTo(0.05, 9)
    const matched = db.prepare(
      'SELECT COUNT(*) AS n FROM rail_matched_geom WHERE segment_id = ?'
    ).get(segId) as { n: number }
    expect(matched.n).toBe(0)
  })

  it('leaves raw points untouched', () => {
    const segId = seedSegment()
    saveSegmentEdits(db, segId, [MOVE, INSERT], 'draft')
    const pts = db.prepare(
      'SELECT seq, lat, lon FROM points WHERE segment_id = ? ORDER BY seq'
    ).all(segId) as Array<{ seq: number; lat: number; lon: number }>
    expect(pts).toHaveLength(5)
    expect(pts[1]).toMatchObject({ seq: 1, lat: 0, lon: 0.01 })
  })

  it('feeds the effective-point path used by the matcher and raw queries', () => {
    const segId = seedSegment()
    saveSegmentEdits(db, segId, [MOVE, INSERT], 'draft')

    const pts = prepareEffectivePoints(db)(segId)
    expect(pts.map((p) => p.lat)).toEqual([0, 0.02, 0.05, 0, 0])
    expect(pts.map((p) => p.tsMs)).toEqual([0, 5000, 10000, 30000, 40000])

    // 'All points' viewport mode serves the edited line.
    const { rows } = queryViewportSegments(
      db,
      { minLat: -1, maxLat: 1, minLon: -1, maxLon: 1, zoom: 14, startTsMs: null, endTsMs: null, detailMode: 'all' },
      { segments: 100, points: 100000 }
    )
    expect(rows).toHaveLength(1)
    const coords = new Float32Array(rows[0]!.coords.slice().buffer)
    expect(rows[0]!.point_count).toBe(5)
    expect(Math.max(...lats(coords))).toBeCloseTo(0.05, 5)
  })

  it('rejects out-of-range or non-finite payloads and unknown segments', () => {
    const segId = seedSegment()
    expect(() =>
      saveSegmentEdits(db, segId, [{ seq: 1, lat: 999, lon: 0, kind: 'move' }], 'draft')
    ).toThrow(/invalid/)
    expect(() =>
      saveSegmentEdits(db, segId, [{ seq: NaN, lat: 0, lon: 0, kind: 'move' }], 'draft')
    ).toThrow(/invalid/)
    expect(() => saveSegmentEdits(db, 99999, [MOVE], 'draft')).toThrow(/unknown segment/)
  })
})

describe('revert', () => {
  it('drops the draft and restores original geometry and bounds', () => {
    const segId = seedSegment()
    saveSegmentEdits(db, segId, [MOVE, INSERT], 'draft')
    revertSegmentEdits(db, segId)

    expect(getSegmentEditState(db, segId)!.hasDraft).toBe(false)
    expect(Math.max(...lats(displayCoords(segId, 2)))).toBe(0)
    const seg = db.prepare('SELECT max_lat, max_lon FROM segments WHERE id = ?').get(segId) as {
      max_lat: number
      max_lon: number
    }
    expect(seg.max_lat).toBe(0)
    expect(seg.max_lon).toBeCloseTo(0.04, 9)
  })
})

describe('permanent save', () => {
  it('bakes the overlay into renumbered points, keeping flagged points in place', () => {
    const segId = seedSegment()
    saveSegmentEdits(db, segId, [MOVE, INSERT], 'permanent')

    const pts = db.prepare(
      'SELECT seq, ts_ms AS tsMs, lat, lon, flags FROM points WHERE segment_id = ? ORDER BY seq'
    ).all(segId) as Array<{ seq: number; tsMs: number | null; lat: number; lon: number; flags: number }>
    // 5 originals + 1 insert, renumbered 0..5.
    expect(pts.map((p) => p.seq)).toEqual([0, 1, 2, 3, 4, 5])
    expect(pts[1]).toMatchObject({ lat: 0.02, lon: 0.005, tsMs: 5000, flags: 0 }) // baked insert
    expect(pts[2]).toMatchObject({ lat: 0.05, lon: 0.01, tsMs: 10000, flags: 0 }) // baked move
    expect(pts[3]).toMatchObject({ lat: 0.5, lon: 0.02, flags: 1 }) // flagged spike survives

    const seg = db.prepare(
      'SELECT point_count, clean_point_count, max_lat FROM segments WHERE id = ?'
    ).get(segId) as { point_count: number; clean_point_count: number; max_lat: number }
    expect(seg.point_count).toBe(6)
    expect(seg.clean_point_count).toBe(5)
    expect(seg.max_lat).toBeCloseTo(0.05, 9)

    // Overlay cleared; the edit state now reports plain raw points.
    const state = getSegmentEditState(db, segId)!
    expect(state.hasDraft).toBe(false)
    expect(state.points).toHaveLength(5)
    expect(state.points.every((p) => p.edit === null)).toBe(true)
    expect(state.points[2]).toMatchObject({ lat: 0.05, lon: 0.01 })
  })

  it('a saved draft can be promoted by re-sending its overlay permanently', () => {
    const segId = seedSegment()
    saveSegmentEdits(db, segId, [MOVE], 'draft')
    // The renderer round-trips the loaded draft rows as the new payload.
    const draft = getSegmentEditState(db, segId)!
      .points.filter((p) => p.edit !== null)
      .map((p) => ({ seq: p.seq, lat: p.lat, lon: p.lon, kind: p.edit! }))
    saveSegmentEdits(db, segId, draft, 'permanent')

    const n = db.prepare('SELECT COUNT(*) AS n FROM segment_edits WHERE segment_id = ?').get(segId) as {
      n: number
    }
    expect(n.n).toBe(0)
    const moved = db.prepare(
      'SELECT lat FROM points WHERE segment_id = ? AND seq = 1'
    ).get(segId) as { lat: number }
    expect(moved.lat).toBeCloseTo(0.05, 9)
  })
})

describe('explicit insert timestamps (bulk archetype apply)', () => {
  const TIMED_INSERT = { seq: 0.5, lat: 0.02, lon: 0.005, kind: 'insert' as const, tsMs: 7777 }

  it('round-trips an explicit ts through a draft into the effective points', () => {
    const segId = seedSegment()
    saveSegmentEdits(db, segId, [TIMED_INSERT], 'draft')
    const pts = prepareEffectivePoints(db)(segId)
    // By-seq it would interpolate to 5000; the stored 7777 must survive instead.
    expect(pts[1]).toMatchObject({ seq: 0.5, edit: 'insert', tsMs: 7777 })
  })

  it('bakes the explicit ts into the raw point on a permanent save', () => {
    const segId = seedSegment()
    saveSegmentEdits(db, segId, [TIMED_INSERT], 'permanent')
    const baked = db.prepare(
      'SELECT ts_ms AS ts FROM points WHERE segment_id = ? AND lon = 0.005'
    ).get(segId) as { ts: number }
    expect(baked.ts).toBe(7777)
  })
})

describe('bulk drafts (commit / revert all)', () => {
  it('lists and counts only segments with a draft overlay', () => {
    const a = seedSegment()
    const b = seedSegment()
    seedSegment() // no draft
    saveSegmentEdits(db, a, [MOVE], 'draft')
    saveSegmentEdits(db, b, [INSERT], 'draft')
    expect(listDraftSegmentIds(db)).toEqual([a, b])
    expect(countDraftSegments(db)).toBe(2)
  })

  it('commitAllDrafts bakes every overlay into points and clears them', () => {
    const a = seedSegment()
    const b = seedSegment()
    saveSegmentEdits(db, a, [MOVE], 'draft') // seq 1 → lat 0.05
    saveSegmentEdits(db, b, [INSERT], 'draft') // adds one point

    expect(commitAllDrafts(db)).toEqual([a, b])
    expect(countDraftSegments(db)).toBe(0)
    const movedLat = db.prepare('SELECT lat FROM points WHERE segment_id = ? AND seq = 1').get(a) as {
      lat: number
    }
    expect(movedLat.lat).toBeCloseTo(0.05, 9) // baked into raw points
    const bPts = db.prepare('SELECT COUNT(*) AS n FROM points WHERE segment_id = ?').get(b) as {
      n: number
    }
    expect(bPts.n).toBe(6) // 5 originals + baked insert
    expect(getSegmentEditState(db, a)!.hasDraft).toBe(false)
  })

  it('revertAllDrafts drops every overlay and restores originals', () => {
    const a = seedSegment()
    const b = seedSegment()
    saveSegmentEdits(db, a, [MOVE], 'draft')
    saveSegmentEdits(db, b, [MOVE], 'draft')

    expect(revertAllDrafts(db)).toEqual([a, b])
    expect(countDraftSegments(db)).toBe(0)
    // Raw points untouched and display geometry rebuilt to the original line.
    const lat = db.prepare('SELECT lat FROM points WHERE segment_id = ? AND seq = 1').get(a) as {
      lat: number
    }
    expect(lat.lat).toBe(0)
    expect(Math.max(...lats(displayCoords(a, 2)))).toBe(0)
  })

  it('are no-ops with no drafts present', () => {
    seedSegment()
    expect(commitAllDrafts(db)).toEqual([])
    expect(revertAllDrafts(db)).toEqual([])
    expect(countDraftSegments(db)).toBe(0)
  })
})

const DELETE = { seq: 3, lat: 0, lon: 0.03, kind: 'delete' as const }

describe('point deletion', () => {
  it('drops the point from the effective line and reports it in deletedSeqs', () => {
    const segId = seedSegment()
    saveSegmentEdits(db, segId, [DELETE], 'draft')

    const state = getSegmentEditState(db, segId)!
    expect(state.deletedSeqs).toEqual([3])
    // Clean seqs were 0,1,3,4; deleting 3 leaves 0,1,4.
    expect(state.points.map((p) => p.seq)).toEqual([0, 1, 4])
    // Draft leaves raw points intact.
    const raw = db.prepare('SELECT COUNT(*) AS n FROM points WHERE segment_id = ?').get(segId) as {
      n: number
    }
    expect(raw.n).toBe(5)
  })

  it('refuses an edit that would strand the track below two points', () => {
    const segId = seedSegment()
    expect(() =>
      saveSegmentEdits(
        db,
        segId,
        [
          { seq: 0, lat: 0, lon: 0, kind: 'delete' },
          { seq: 1, lat: 0, lon: 0, kind: 'delete' },
          { seq: 3, lat: 0, lon: 0, kind: 'delete' }
        ],
        'draft'
      )
    ).toThrow(/fewer than 2/)
  })

  it('bakes deletes permanently, dropping the raw point', () => {
    const segId = seedSegment()
    saveSegmentEdits(db, segId, [DELETE], 'permanent')
    const lons = db.prepare(
      'SELECT lon FROM points WHERE segment_id = ? AND flags = 0 ORDER BY seq'
    ).all(segId) as Array<{ lon: number }>
    // 0, 0.01, (0.02 spike flagged out), 0.03 deleted, 0.04 → 0, 0.01, 0.04.
    expect(lons.map((r) => r.lon)).toEqual([0, 0.01, 0.04])
  })
})

describe('split', () => {
  it('divides a segment into two at a raw point, sharing the boundary vertex', () => {
    const segId = seedSegment()
    const before = db.prepare('SELECT track_id, file_id FROM segments WHERE id = ?').get(segId) as {
      track_id: number
      file_id: number
    }
    const newId = splitSegment(db, segId, 3)

    const first = db.prepare(
      'SELECT seq, lon, flags FROM points WHERE segment_id = ? ORDER BY seq'
    ).all(segId) as Array<{ seq: number; lon: number; flags: number }>
    const second = db.prepare(
      'SELECT seq, lon, flags FROM points WHERE segment_id = ? ORDER BY seq'
    ).all(newId) as Array<{ seq: number; lon: number; flags: number }>

    // First half keeps seqs 0..3 (the flagged spike preserved), renumbered.
    expect(first.map((r) => r.lon)).toEqual([0, 0.01, 0.02, 0.03])
    expect(first[2]!.flags).toBe(1)
    // Second half starts at the shared split point (lon 0.03) then 0.04.
    expect(second.map((r) => r.lon)).toEqual([0.03, 0.04])

    const newSeg = db.prepare(
      'SELECT track_id, file_id, type, point_count, clean_point_count FROM segments WHERE id = ?'
    ).get(newId) as {
      track_id: number
      file_id: number
      type: string
      point_count: number
      clean_point_count: number
    }
    expect(newSeg).toMatchObject({
      track_id: before.track_id,
      file_id: before.file_id,
      type: 'walking',
      point_count: 2,
      clean_point_count: 2
    })
    // Both halves drew display geometry.
    for (const id of [segId, newId]) {
      const g = db.prepare(
        'SELECT COUNT(*) AS n FROM display_geometries WHERE segment_id = ?'
      ).get(id) as { n: number }
      expect(g.n).toBeGreaterThan(0)
    }
  })

  it('commits pending edits into the correct half', () => {
    const segId = seedSegment()
    // Move seq 4 well north, then split at seq 1.
    saveSegmentEdits(db, segId, [{ seq: 4, lat: 0.2, lon: 0.04, kind: 'move' }], 'draft')
    const newId = splitSegment(db, segId, 1)

    const second = db.prepare(
      'SELECT lat, lon FROM points WHERE segment_id = ? AND flags = 0 ORDER BY seq'
    ).all(newId) as Array<{ lat: number; lon: number }>
    // Second half (seq >= 1): 0.01, (0.02 flagged out), 0.03, moved 0.04@lat0.2.
    expect(second.at(-1)).toMatchObject({ lat: 0.2, lon: 0.04 })
    // Overlay consumed by the split.
    expect(getSegmentEditState(db, segId)!.hasDraft).toBe(false)
  })

  it('rejects an inserted (non-integer) seq and out-of-range splits', () => {
    const segId = seedSegment()
    expect(() => splitSegment(db, segId, 1.5)).toThrow(/original track point/)
    expect(() => splitSegment(db, segId, 0)).toThrow(/too few points/)
    expect(() => splitSegment(db, 99999, 1)).toThrow(/unknown segment/)
  })
})

describe('typed split (precise slider)', () => {
  it('gives each half its own activity type', () => {
    const segId = seedSegment() // type 'walking'
    const newId = splitSegmentTyped(db, segId, 3, 'running', 'cycling')
    expect(db.prepare('SELECT type FROM segments WHERE id = ?').get(segId)).toMatchObject({
      type: 'running'
    })
    expect(db.prepare('SELECT type FROM segments WHERE id = ?').get(newId)).toMatchObject({
      type: 'cycling'
    })
  })

  it('can split at a fractional (inserted) point', () => {
    const segId = seedSegment()
    saveSegmentEdits(db, segId, [{ seq: 1.5, lat: 0, lon: 0.015, kind: 'insert' }], 'draft')
    const newId = splitSegmentTyped(db, segId, 1.5, 'walking', 'cycling')
    // First half: clean seqs 0,1 + the inserted boundary → 3 clean points.
    const firstClean = db.prepare(
      'SELECT COUNT(*) AS n FROM points WHERE segment_id = ? AND flags = 0'
    ).get(segId) as { n: number }
    expect(firstClean.n).toBe(3)
    expect(db.prepare('SELECT type FROM segments WHERE id = ?').get(newId)).toMatchObject({
      type: 'cycling'
    })
  })

  it('rejects a type that is not a known category', () => {
    const segId = seedSegment()
    expect(() => splitSegmentTyped(db, segId, 3, 'walking', 'notacategory')).toThrow(/unknown type/)
  })
})

/**
 * A simple dated segment for merge tests: `n` clean points 60 s apart along a
 * short east-west run, starting at `startMs` and longitude `lon0`.
 */
function seedAt(startMs: number, type: string, n = 3, lon0 = 0): number {
  const fileRes = db.prepare(`
    INSERT INTO imported_files (filename, source_path, file_hash, file_size, imported_at_ms)
    VALUES ('m.gpx', '/m.gpx', ?, 1, 0)
  `).run(`hash-${nextHash++}`)
  const fileId = Number(fileRes.lastInsertRowid)
  const trackId = Number(
    db.prepare('INSERT INTO tracks (file_id, type) VALUES (?, ?)').run(fileId, type).lastInsertRowid
  )
  const endMs = startMs + (n - 1) * 60000
  const segId = Number(
    db.prepare(`
      INSERT INTO segments
        (track_id, file_id, type, start_ts_ms, end_ts_ms, point_count, clean_point_count,
         min_lat, min_lon, max_lat, max_lon)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?)
    `).run(trackId, fileId, type, startMs, endMs, n, n, lon0, lon0 + (n - 1) * 0.01).lastInsertRowid
  )
  const ins = db.prepare(
    'INSERT INTO points (segment_id, seq, ts_ms, lat, lon, ele, flags) VALUES (?, ?, ?, 0, ?, NULL, 0)'
  )
  for (let i = 0; i < n; i++) ins.run(segId, i, startMs + i * 60000, lon0 + i * 0.01)
  revertSegmentEdits(db, segId)
  return segId
}

const HOUR = 3600000
const DAY = 24 * HOUR

describe('merge candidates', () => {
  it('lists dated segments within 24h of the anchor, in time order', () => {
    const a = seedAt(10 * HOUR, 'walking')
    const b = seedAt(12 * HOUR, 'train')
    seedAt(40 * HOUR, 'walking') // >24h after a → out of window
    const anchorTs = 10 * HOUR

    const cands = listMergeCandidates(db, anchorTs)
    expect(cands.map((c) => c.segmentId)).toEqual([a, b])
    expect(cands[0]).toMatchObject({ type: 'walking', startTsMs: 10 * HOUR, pointCount: 3 })
  })

  it('excludes ignored categories (bogus/unknown)', () => {
    seedAt(10 * HOUR, 'bogus') // ignored by default
    const ok = seedAt(11 * HOUR, 'walking')
    expect(listMergeCandidates(db, 10 * HOUR).map((c) => c.segmentId)).toEqual([ok])
  })
})

describe('merge', () => {
  it('stitches segments into the earliest, concatenated in time order', () => {
    const first = seedAt(10 * HOUR, 'walking', 3, 0) // lons 0, 0.01, 0.02
    const second = seedAt(11 * HOUR, 'train', 2, 1) // lons 1, 1.01
    const mergedId = mergeSegments(db, [second, first], 'train')

    expect(mergedId).toBe(first) // earliest survives
    expect(db.prepare('SELECT COUNT(*) AS n FROM segments WHERE id = ?').get(second)).toMatchObject({
      n: 0
    })
    const pts = db.prepare(
      'SELECT seq, lon, ts_ms AS ts FROM points WHERE segment_id = ? ORDER BY seq'
    ).all(mergedId) as Array<{ seq: number; lon: number; ts: number }>
    expect(pts.map((p) => p.seq)).toEqual([0, 1, 2, 3, 4]) // renumbered
    expect(pts.map((p) => p.lon)).toEqual([0, 0.01, 0.02, 1, 1.01]) // time order
    const seg = db.prepare(
      'SELECT type, point_count, clean_point_count, start_ts_ms AS s, end_ts_ms AS e, max_lon FROM segments WHERE id = ?'
    ).get(mergedId) as {
      type: string
      point_count: number
      clean_point_count: number
      s: number
      e: number
      max_lon: number
    }
    expect(seg).toMatchObject({ type: 'train', point_count: 5, clean_point_count: 5 })
    expect(seg.s).toBe(10 * HOUR)
    expect(seg.e).toBe(11 * HOUR + 60000)
    expect(seg.max_lon).toBeCloseTo(1.01, 9)
    // Display geometry rebuilt for the merged line.
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM display_geometries WHERE segment_id = ?').get(mergedId)
    ).toMatchObject({ n: DETAIL_LEVELS.length })
  })

  it('applies pending edits before stitching (effective points)', () => {
    const a = seedAt(10 * HOUR, 'walking', 3, 0)
    const b = seedAt(11 * HOUR, 'walking', 2, 1)
    // Move a's last point far north; it should carry into the merged line.
    saveSegmentEdits(db, a, [{ seq: 2, lat: 0.9, lon: 0.02, kind: 'move' }], 'draft')
    const mergedId = mergeSegments(db, [a, b], 'walking')
    const maxLat = db.prepare('SELECT max_lat AS m FROM segments WHERE id = ?').get(mergedId) as {
      m: number
    }
    expect(maxLat.m).toBeCloseTo(0.9, 9)
  })

  it('preserves flagged points from each constituent', () => {
    const a = seedSegment() // 5 raw points, seq 2 flagged (clean 4)
    const b = seedAt(DAY, 'walking', 2, 1)
    const mergedId = mergeSegments(db, [a, b], 'walking')
    const seg = db.prepare(
      'SELECT point_count, clean_point_count FROM segments WHERE id = ?'
    ).get(mergedId) as { point_count: number; clean_point_count: number }
    // 5 (incl. 1 flagged) + 2 = 7 total, 6 clean.
    expect(seg).toMatchObject({ point_count: 7, clean_point_count: 6 })
  })

  it('rejects fewer than two, unknown ids, and an unknown type', () => {
    const a = seedAt(10 * HOUR, 'walking')
    const b = seedAt(11 * HOUR, 'train')
    expect(() => mergeSegments(db, [a], 'walking')).toThrow(/at least two/)
    expect(() => mergeSegments(db, [a, 99999], 'walking')).toThrow(/unknown segment/)
    expect(() => mergeSegments(db, [a, b], 'notacategory')).toThrow(/unknown type/)
  })

  it('lets the merged track take any known category, not just a constituent', () => {
    const a = seedAt(10 * HOUR, 'walking')
    const b = seedAt(11 * HOUR, 'train')
    // 'cycling' is neither constituent's type, but it is a known category.
    const mergedId = mergeSegments(db, [a, b], 'cycling')
    expect(db.prepare('SELECT type FROM segments WHERE id = ?').get(mergedId)).toMatchObject({
      type: 'cycling'
    })
  })
})

describe('change type / delete track', () => {
  it('changes a segment to any known category, rejecting unknown types/segments', () => {
    const segId = seedSegment() // 'walking'
    setSegmentType(db, segId, 'cycling')
    expect(db.prepare('SELECT type FROM segments WHERE id = ?').get(segId)).toMatchObject({
      type: 'cycling'
    })
    expect(() => setSegmentType(db, segId, 'notacategory')).toThrow(/unknown type/)
    expect(() => setSegmentType(db, 99999, 'walking')).toThrow(/unknown segment/)
  })

  it('deletes a segment and everything derived from it', () => {
    const segId = seedSegment()
    saveSegmentEdits(db, segId, [MOVE], 'draft') // an overlay row
    db.prepare(
      'INSERT INTO rail_matched_geom (segment_id, detail, point_count, coords) VALUES (?, 2, 2, ?)'
    ).run(segId, new Uint8Array(16))

    deleteSegment(db, segId)

    for (const t of ['points', 'display_geometries', 'segment_edits', 'rail_matched_geom']) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE segment_id = ?`).get(segId) as {
        n: number
      }
      expect(row.n).toBe(0)
    }
    expect(db.prepare('SELECT 1 FROM segments WHERE id = ?').get(segId)).toBeUndefined()
    expect(() => deleteSegment(db, segId)).toThrow(/unknown segment/)
  })

  it('bulk-deletes many segments, ignoring unknown ids', () => {
    const a = seedSegment()
    const b = seedSegment()
    const c = seedSegment()
    // Duplicates and a non-existent id are tolerated; count is distinct + real.
    const removed = bulkDeleteSegments(db, [a, b, a, 999999])
    expect(removed).toBe(2)
    expect(db.prepare('SELECT 1 FROM segments WHERE id = ?').get(a)).toBeUndefined()
    expect(db.prepare('SELECT 1 FROM segments WHERE id = ?').get(b)).toBeUndefined()
    expect(db.prepare('SELECT 1 FROM segments WHERE id = ?').get(c)).toBeDefined()
  })
})
