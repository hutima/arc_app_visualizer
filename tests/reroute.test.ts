/**
 * The pure reroute splice: replacing a span of a track's points with a routed
 * polyline, expressed as overlay edits (boundaries kept, interior originals
 * deleted, route threaded in as fractional-seq inserts) so it applies as a
 * revertible draft.
 */
import { describe, it, expect } from 'vitest'
import { spliceRoute } from '../src/shared/reroute'
import type { EditablePoint } from '../src/shared/types'

const pt = (seq: number, lon: number, lat: number, edit: EditablePoint['edit'] = null): EditablePoint => ({
  seq,
  lon,
  lat,
  tsMs: seq * 1000,
  edit
})

describe('spliceRoute', () => {
  const pts: EditablePoint[] = [pt(0, 0, 0), pt(1, 1, 1), pt(2, 2, 2), pt(3, 3, 3), pt(4, 4, 4)]

  it('keeps the two boundaries, deletes the interior, and inserts the route between', () => {
    const route = [10, 10, 11, 11] // two routed lon/lat pairs
    const { points, deleted } = spliceRoute(pts, 1, 3, route)

    // Boundaries (idx 0,1 and 3,4) survive unchanged.
    expect(points[0]).toEqual(pts[0])
    expect(points[1]).toEqual(pts[1])
    expect(points.slice(-2)).toEqual([pts[3], pts[4]])

    // Interior original (seq 2) is deleted, with its coords.
    expect(deleted).toEqual([{ seq: 2, lat: 2, lon: 2 }])

    // Route becomes ordered inserts strictly between the boundary seqs.
    const inserts = points.filter((p) => p.edit === 'insert')
    expect(inserts.map((p) => [p.lon, p.lat])).toEqual([
      [10, 10],
      [11, 11]
    ])
    for (const ins of inserts) {
      expect(ins.seq).toBeGreaterThan(1)
      expect(ins.seq).toBeLessThan(3)
      expect(ins.tsMs).toBeNull()
    }
    expect(inserts[0]!.seq).toBeLessThan(inserts[1]!.seq)
  })

  it('drops a prior insert in the interior without recording a delete for it', () => {
    const withInsert: EditablePoint[] = [
      pt(0, 0, 0),
      pt(1, 1, 1),
      { seq: 1.5, lon: 1.5, lat: 1.5, tsMs: null, edit: 'insert' },
      pt(2, 2, 2),
      pt(3, 3, 3)
    ]
    // Replace indices 1..4 (seqs 1..3): interior is the insert (1.5) + raw 2.
    const { deleted } = spliceRoute(withInsert, 1, 4, [9, 9, 8, 8])
    expect(deleted).toEqual([{ seq: 2, lat: 2, lon: 2 }]) // only the raw point
  })

  it('reroutes the whole track between its endpoints', () => {
    const { points, deleted } = spliceRoute(pts, 0, 4, [5, 5])
    expect(points[0]).toEqual(pts[0])
    expect(points.at(-1)).toEqual(pts[4])
    expect(deleted.map((d) => d.seq)).toEqual([1, 2, 3])
    expect(points.filter((p) => p.edit === 'insert')).toHaveLength(1)
  })

  it('never lands an insert seq on a deleted interior seq (overlay PK collision)', () => {
    // A wide span with several routed points: evenly spacing them across the
    // span used to hit integers (here 1,2,3) that the interior deletes occupy,
    // colliding on segment_edits(segment_id, seq). Inserts must avoid them.
    const route = [10, 10, 11, 11, 12, 12] // 3 routed points
    const { points, deleted } = spliceRoute(pts, 0, 4, route)
    const deletedSeqs = new Set(deleted.map((d) => d.seq))
    const insertSeqs = points.filter((p) => p.edit === 'insert').map((p) => p.seq)
    expect(insertSeqs).toHaveLength(3)
    for (const seq of insertSeqs) {
      expect(deletedSeqs.has(seq)).toBe(false)
      expect(Number.isInteger(seq)).toBe(false) // off the raw-point grid
      expect(seq).toBeGreaterThan(0)
      expect(seq).toBeLessThan(4)
    }
    // Strictly increasing, so they sort start → route → end.
    expect([...insertSeqs]).toEqual([...insertSeqs].sort((a, b) => a - b))
    expect(new Set(insertSeqs).size).toBe(3) // and distinct
  })

  it('rejects an invalid range', () => {
    expect(() => spliceRoute(pts, 3, 1, [0, 0])).toThrow()
    expect(() => spliceRoute(pts, 0, 9, [0, 0])).toThrow()
  })
})
