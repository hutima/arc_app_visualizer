/**
 * Track editing: the overlay merge (pure), draft persistence + derived
 * geometry rebuild, the effective-point path the matcher and raw-detail
 * queries consume, revert, permanent baking into raw points, point deletion,
 * and splitting a segment in two.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/main/db/db'
import {
  applyEdits,
  getSegmentEditState,
  prepareEffectivePoints,
  revertSegmentEdits,
  saveSegmentEdits,
  splitSegment,
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
