/**
 * Splice a computed road route into a track's points as overlay edits, so the
 * manual reroute applies through the same draft/permanent machinery as every
 * other point edit (revertible by default; raw points survive).
 *
 * The two chosen boundary points (startIdx, endIdx) are kept — the route
 * connects to them — and everything strictly between is replaced: original
 * (raw/moved) interior points become deletes, prior inserts just drop, and the
 * routed polyline is threaded in as new inserted vertices at fractional seqs
 * between the boundaries, so they sort into place and round-trip through the
 * overlay exactly like a hand-inserted midpoint.
 */
import type { EditablePoint } from './types'

export interface RerouteSplice {
  /** The new effective points (boundaries kept, interior replaced by the route). */
  points: EditablePoint[]
  /** Raw interior points the overlay must delete, with their last coords. */
  deleted: Array<{ seq: number; lat: number; lon: number }>
}

/**
 * @param points     current effective points (sorted by seq)
 * @param startIdx   index of the first kept boundary point
 * @param endIdx     index of the last kept boundary point (> startIdx)
 * @param routeLonLat interleaved [lon, lat, …] of the road route to insert
 */
export function spliceRoute(
  points: ReadonlyArray<EditablePoint>,
  startIdx: number,
  endIdx: number,
  routeLonLat: ReadonlyArray<number>
): RerouteSplice {
  if (
    !Number.isInteger(startIdx) ||
    !Number.isInteger(endIdx) ||
    startIdx < 0 ||
    endIdx > points.length - 1 ||
    endIdx <= startIdx
  ) {
    throw new Error('invalid reroute range')
  }
  const sLo = points[startIdx]!.seq
  const sHi = points[endIdx]!.seq
  if (!(sHi > sLo)) throw new Error('reroute boundaries are out of order')

  // Interior originals get deleted; prior inserts simply vanish from the line.
  const deleted: Array<{ seq: number; lat: number; lon: number }> = []
  for (let i = startIdx + 1; i < endIdx; i++) {
    const p = points[i]!
    if (p.edit !== 'insert') deleted.push({ seq: p.seq, lat: p.lat, lon: p.lon })
  }

  // Routed vertices take fractional seqs strictly inside (sLo, hi), where hi is
  // the first *occupied* seq above sLo — sHi, or the next integer if there's a
  // deleted interior raw point before it. The deletes keep their integer seqs
  // (as delete rows in the same segment_edits keyspace), so an insert must
  // never land on an integer in the span or it collides on the (segment_id,
  // seq) primary key. Clustering them just above sLo (open interval, so no
  // integer falls inside) keeps them off that grid while still sorting
  // start → route → end. Drawing uses array order, not seq, so the clustered
  // values don't distort the line. Timestamps stay null — the overlay
  // interpolates inserted-vertex times by seq when it's applied.
  const hi = Math.min(sHi, Math.floor(sLo) + 1)
  const r = Math.floor(routeLonLat.length / 2)
  const inserts: EditablePoint[] = []
  for (let k = 0; k < r; k++) {
    const lon = routeLonLat[k * 2]!
    const lat = routeLonLat[k * 2 + 1]!
    const seq = sLo + ((k + 1) / (r + 1)) * (hi - sLo)
    inserts.push({ seq, lat, lon, tsMs: null, edit: 'insert' })
  }

  const next = [...points.slice(0, startIdx + 1), ...inserts, ...points.slice(endIdx)]
  return { points: next, deleted }
}
