/**
 * Bulk archetype apply: the user perfects one "archetype" track (the anchor,
 * edited with the normal point tools), then stamps its shape onto every similar
 * track at once. Each copy takes the archetype's *geometry* but keeps its *own*
 * timing — every stamped vertex is timestamped by transferring the target's own
 * speed profile onto the shared shape (a vertex at fraction f of the archetype's
 * length gets the target's time at fraction f of its own length). So a commute
 * logged hundreds of times collapses to one clean line while each trip keeps its
 * real duration and accel/dwell shape.
 *
 * The stamp is written as a revertible draft overlay (`saveSegmentEdits`,
 * 'draft'): the target's first and last raw points stay as real-time anchors,
 * its drawn interior is deleted, and the archetype vertices are inserted between
 * them carrying their layered timestamps directly — so it shows in the Drafts
 * panel and can be committed or discarded with the rest.
 */
import type { DatabaseSync } from 'node:sqlite'
import { haversineMeters } from '../../shared/geo'
import { prepareEffectivePoints, saveSegmentEdits } from './editStore'
import type { BulkApplyResult, SegmentEditInput } from '../../shared/types'

export interface LonLat {
  lon: number
  lat: number
}

export interface TimedPoint extends LonLat {
  tsMs: number | null
}

/** A target track's clean point: its raw seq plus location (no timestamp). */
export interface CleanSeqPoint {
  seq: number
  lon: number
  lat: number
}

/** Cumulative haversine distance (meters) at each vertex; `out[0]` is 0. */
function cumulativeMeters(path: ReadonlyArray<LonLat>): number[] {
  const out = new Array<number>(path.length)
  out[0] = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!
    const b = path[i]!
    out[i] = out[i - 1]! + haversineMeters(a.lat, a.lon, b.lat, b.lon)
  }
  return out
}

/** Piecewise-linear lookup of ts at fraction `f` over ascending controls. */
function interpAtFraction(ctrl: ReadonlyArray<{ frac: number; ts: number }>, f: number): number {
  const first = ctrl[0]!
  const last = ctrl[ctrl.length - 1]!
  if (f <= first.frac) return first.ts
  if (f >= last.frac) return last.ts
  for (let i = 1; i < ctrl.length; i++) {
    const a = ctrl[i - 1]!
    const b = ctrl[i]!
    if (f <= b.frac) {
      const t = (f - a.frac) / (b.frac - a.frac)
      return Math.round(a.ts + t * (b.ts - a.ts))
    }
  }
  return last.ts
}

/**
 * Time each archetype vertex by transferring the instance's own speed profile
 * onto the shared shape. Returns one ts (or null) per archetype vertex; all
 * nulls when the instance can't be timed (fewer than two dated points), since an
 * undated track has no speed to infer.
 */
export function computeLayeredTimes(
  archetype: ReadonlyArray<LonLat>,
  instance: ReadonlyArray<TimedPoint>
): Array<number | null> {
  const m = archetype.length
  if (m === 0) return []
  const nullTimes = (): Array<number | null> => new Array<number | null>(m).fill(null)
  if (instance.filter((p) => p.tsMs !== null).length < 2) return nullTimes()

  // Build the instance's (distance-fraction → ts) control curve from its dated
  // points. With no usable length (a stationary instance) fall back to index
  // order so the curve is still strictly increasing.
  const instCum = cumulativeMeters(instance)
  const instTotal = instCum[instCum.length - 1]!
  const ctrl: Array<{ frac: number; ts: number }> = []
  for (let j = 0; j < instance.length; j++) {
    const ts = instance[j]!.tsMs
    if (ts === null) continue
    const frac = instTotal > 0 ? instCum[j]! / instTotal : j / (instance.length - 1)
    const prev = ctrl[ctrl.length - 1]
    if (prev && frac <= prev.frac) {
      // Coincident points share a fraction; keep the latest (largest) time.
      prev.ts = Math.max(prev.ts, ts)
    } else {
      ctrl.push({ frac, ts })
    }
  }
  if (ctrl.length < 2) return nullTimes()

  const arcCum = cumulativeMeters(archetype)
  const arcTotal = arcCum[arcCum.length - 1]!
  const out: Array<number | null> = new Array(m)
  let prev = -Infinity
  for (let k = 0; k < m; k++) {
    const f = arcTotal > 0 ? arcCum[k]! / arcTotal : 0
    // A track's clock only moves forward, so never let a later vertex precede
    // an earlier one even if the profile wiggles.
    const ts = Math.max(prev, interpAtFraction(ctrl, f))
    out[k] = ts
    prev = ts
  }
  return out
}

/**
 * The draft overlay that replaces a target's drawn geometry with the
 * archetype's: keep its first and last raw points (real-time anchors), delete
 * the clean interior, and insert the archetype vertices between them. Inserts
 * cluster in the open seq interval just above the first point — drawing uses
 * array order, so the cluster doesn't distort the line, and it stays clear of
 * the integer seqs the deletes occupy, so nothing collides on (segment_id, seq).
 * Each insert carries its layered timestamp directly, so no seq interpolation is
 * needed. Returns [] (a no-op) for a degenerate target or archetype.
 */
export function buildArchetypeOverlay(
  clean: ReadonlyArray<CleanSeqPoint>,
  archetype: ReadonlyArray<LonLat>,
  times: ReadonlyArray<number | null>
): SegmentEditInput[] {
  const n = clean.length
  const m = archetype.length
  if (n < 2 || m < 2) return []
  const overlay: SegmentEditInput[] = []
  for (let j = 1; j < n - 1; j++) {
    const p = clean[j]!
    overlay.push({ seq: p.seq, lat: p.lat, lon: p.lon, kind: 'delete' })
  }
  const firstSeq = clean[0]!.seq
  for (let k = 0; k < m; k++) {
    const v = archetype[k]!
    overlay.push({
      seq: firstSeq + (k + 1) / (m + 1),
      lat: v.lat,
      lon: v.lon,
      kind: 'insert',
      tsMs: times[k] ?? null
    })
  }
  return overlay
}

/**
 * Stamp the archetype's edited shape onto each target track as a draft, timing
 * each from its own progression. The archetype id is skipped, as are targets
 * with fewer than two clean points. Yields between tracks so the main process
 * stays responsive on a big selection.
 */
export async function applyArchetypeToSegments(
  db: DatabaseSync,
  archetypeId: number,
  segmentIds: number[]
): Promise<BulkApplyResult> {
  const result: BulkApplyResult = { applied: 0, skipped: 0, failed: 0 }
  const archetype: LonLat[] = prepareEffectivePoints(db)(archetypeId).map((p) => ({
    lon: p.lon,
    lat: p.lat
  }))
  const ids = [...new Set(segmentIds)].filter((id) => Number.isInteger(id) && id !== archetypeId)
  if (archetype.length < 2) {
    result.skipped = ids.length
    return result
  }

  const cleanStmt = db.prepare(`
    SELECT seq, lon, lat, ts_ms AS tsMs FROM points
    WHERE segment_id = ? AND flags = 0 AND lat IS NOT NULL AND lon IS NOT NULL
    ORDER BY seq
  `)
  let n = 0
  for (const id of ids) {
    try {
      const clean = cleanStmt.all(id) as unknown as Array<CleanSeqPoint & { tsMs: number | null }>
      if (clean.length < 2) {
        result.skipped++
      } else {
        const times = computeLayeredTimes(archetype, clean)
        saveSegmentEdits(db, id, buildArchetypeOverlay(clean, archetype, times), 'draft')
        result.applied++
      }
    } catch {
      result.failed++
    }
    if (++n % 8 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return result
}
