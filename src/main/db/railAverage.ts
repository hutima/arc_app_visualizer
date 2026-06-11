/**
 * Display-time averaging of repeat rail rides ("cleaning", toggleable).
 *
 * Metro/tram GPS is noisy (tunnels, scatter), and the same line between the
 * same two stations is ridden again and again — rendering as a smear of
 * jittered polylines. When enabled, rides of one type whose endpoints anchor
 * to the same two places merge into a best-fit consensus track at ~50 m
 * resolution: every member is arc-length resampled to common parameters,
 * oriented the same way (A→B and B→A rides combine), reduced per parameter to
 * a robust consensus (component-wise median, not mean), then spline-smoothed
 * with endpoints pinned to kill residual zigzag.
 *
 * Why median + outlier rejection: tunnel GPS occasionally throws a ride wildly
 * off-route, and a mean would bend the consensus toward it — drawing a "spur"
 * through empty space where no ride actually went. The median ignores such
 * excursions, and rides that still disagree with the consensus beyond a robust
 * threshold are dropped from it and rendered as their own lines instead of
 * being blended into a phantom path.
 *
 * "Where possible": a ride only joins a group when BOTH endpoints are within
 * ANCHOR_RADIUS_DEG of a place; unanchored rides, loops (same place at both
 * ends), solo rides, and non-rail types pass through untouched. Raw points
 * are never modified — this runs on display geometry per viewport query.
 */
import type { ViewportSegmentRow } from './queries'
import type { ViewportWaypoint } from '../../shared/types'

export const RAIL_AVERAGE_TYPES: ReadonlySet<string> = new Set(['metro', 'tram', 'train'])

/** Max distance from a track end to a place for the ride to anchor (~440 m). */
const ANCHOR_RADIUS_DEG = 0.004

/** Consensus sample spacing: ~50 m (degree-space, like the simplifier). */
const SAMPLE_RESOLUTION_DEG = 4.5e-4

/** Vertex-count bounds for an averaged track (500 ≈ a 25 km ride at 50 m). */
const MAX_AVERAGED_POINTS = 500

/** Smoothing passes of the [1,2,1]/4 kernel over the averaged polyline. */
const SMOOTHING_PASSES = 2

/**
 * A member is an outlier (different route / tunnel excursion, not noise) when
 * its peak distance from the consensus exceeds OUTLIER_FACTOR × the median
 * member distance, and also clears an absolute floor (so a tight cluster never
 * rejects a member just for being marginally looser). Robust, scale-free.
 */
const OUTLIER_FACTOR = 3
const OUTLIER_ABS_FLOOR_DEG = 1e-3 // ~110 m

export interface RailAverageResult {
  rows: ViewportSegmentRow[]
  /** Member segments replaced by averaged lines (0 = nothing merged). */
  collapsed: number
}

interface Ride {
  row: ViewportSegmentRow
  coords: Float32Array
  /** True when the ride runs B→A relative to its group's orientation. */
  flipped: boolean
}

export function averageRailTracks(
  rows: ViewportSegmentRow[],
  places: ViewportWaypoint[]
): RailAverageResult {
  if (places.length === 0) return { rows, collapsed: 0 }
  const index = buildPlaceIndex(places)
  const out: ViewportSegmentRow[] = []
  const groups = new Map<string, Ride[]>()

  for (const row of rows) {
    if (!RAIL_AVERAGE_TYPES.has(row.type) || row.point_count < 2) {
      out.push(row)
      continue
    }
    const coords = floatView(row)
    const a = nearestPlace(index, coords[0]!, coords[1]!)
    const b = nearestPlace(index, coords[coords.length - 2]!, coords[coords.length - 1]!)
    if (!a || !b || a.id === b.id) {
      out.push(row)
      continue
    }
    const flipped = a.id > b.id
    const key = `${row.type}:${flipped ? b.id : a.id}:${flipped ? a.id : b.id}`
    let group = groups.get(key)
    if (!group) groups.set(key, (group = []))
    group.push({ row, coords, flipped })
  }

  let collapsed = 0
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]!.row)
      continue
    }
    const { averaged, passthrough } = averageGroup(group)
    if (averaged) {
      out.push(averaged)
      collapsed += group.length - passthrough.length
    }
    for (const row of passthrough) out.push(row)
  }
  return { rows: out, collapsed }
}

interface GroupResult {
  /** The consensus line, or null when the group never reached agreement. */
  averaged: ViewportSegmentRow | null
  /** Member rows shown as-is (outliers, or all members when no consensus). */
  passthrough: ViewportSegmentRow[]
}

function averageGroup(group: Ride[]): GroupResult {
  // ~50 m sample spacing along the median-length member.
  const lengths = group.map((r) => arcLength(r.coords)).sort((x, y) => x - y)
  const medianLen = lengths[lengths.length >> 1]!
  const k = Math.min(
    MAX_AVERAGED_POINTS,
    Math.max(2, Math.round(medianLen / SAMPLE_RESOLUTION_DEG) + 1)
  )
  const resampled = group.map((r) => resample(r.coords, k, r.flipped))

  // Robust consensus, then reject members that disagree with it too much.
  const consensus0 = medianConsensus(resampled, k)
  const deviations = resampled.map((pts) => maxDeviation(pts, consensus0, k))
  const threshold = Math.max(OUTLIER_ABS_FLOOR_DEG, OUTLIER_FACTOR * medianOf(deviations))
  const inliers: Ride[] = []
  const inlierPts: Float64Array[] = []
  const passthrough: ViewportSegmentRow[] = []
  group.forEach((ride, i) => {
    if (deviations[i]! <= threshold) {
      inliers.push(ride)
      inlierPts.push(resampled[i]!)
    } else {
      passthrough.push(ride.row)
    }
  })
  // Too few agree to trust a consensus — show every ride raw instead.
  if (inliers.length < 2) return { averaged: null, passthrough: group.map((r) => r.row) }

  const consensus = medianConsensus(inlierPts, k)
  smooth(consensus, SMOOTHING_PASSES)
  const coords = new Float32Array(consensus)
  // Deterministic identity: lowest inlier id; year color follows the most
  // recent inlier ride, matching most-recent-wins elsewhere.
  let id = Infinity
  let startTsMs: number | null = null
  for (const ride of inliers) {
    id = Math.min(id, ride.row.id)
    const ts = ride.row.start_ts_ms
    if (ts != null && (startTsMs == null || ts > startTsMs)) startTsMs = ts
  }
  return {
    averaged: {
      id,
      type: group[0]!.row.type,
      start_ts_ms: startTsMs,
      point_count: k,
      coords: new Uint8Array(coords.buffer)
    },
    passthrough
  }
}

/** Component-wise median of resampled members at each of the k parameters. */
function medianConsensus(members: Float64Array[], k: number): Float64Array {
  const out = new Float64Array(k * 2)
  const xs = new Float64Array(members.length)
  const ys = new Float64Array(members.length)
  for (let j = 0; j < k; j++) {
    for (let r = 0; r < members.length; r++) {
      xs[r] = members[r]![j * 2]!
      ys[r] = members[r]![j * 2 + 1]!
    }
    out[j * 2] = medianSorted(Float64Array.from(xs).sort())
    out[j * 2 + 1] = medianSorted(Float64Array.from(ys).sort())
  }
  return out
}

/** Peak point-to-point distance between a resampled member and the consensus. */
function maxDeviation(pts: Float64Array, consensus: Float64Array, k: number): number {
  let max = 0
  for (let j = 0; j < k; j++) {
    const d = Math.hypot(pts[j * 2]! - consensus[j * 2]!, pts[j * 2 + 1]! - consensus[j * 2 + 1]!)
    if (d > max) max = d
  }
  return max
}

const medianSorted = (sorted: Float64Array): number => {
  const n = sorted.length
  const mid = n >> 1
  return n % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

const medianOf = (vals: number[]): number =>
  medianSorted(Float64Array.from(vals).sort())

function arcLength(coords: Float32Array): number {
  let len = 0
  for (let i = 2; i < coords.length; i += 2) {
    len += Math.hypot(coords[i]! - coords[i - 2]!, coords[i + 1]! - coords[i - 1]!)
  }
  return len
}

/**
 * Spline-like smoothing: binomial [1,2,1]/4 kernel over interior vertices,
 * endpoints pinned to their places. At ~50 m spacing a couple of passes
 * approximates a light smoothing-spline fit without overshooting curves.
 */
function smooth(pts: Float64Array, passes: number): void {
  const n = pts.length / 2
  if (n < 3) return
  for (let pass = 0; pass < passes; pass++) {
    let prevX = pts[0]!
    let prevY = pts[1]!
    for (let i = 1; i < n - 1; i++) {
      const curX = pts[i * 2]!
      const curY = pts[i * 2 + 1]!
      pts[i * 2] = (prevX + 2 * curX + pts[(i + 1) * 2]!) / 4
      pts[i * 2 + 1] = (prevY + 2 * curY + pts[(i + 1) * 2 + 1]!) / 4
      prevX = curX // neighbors read pre-pass values, not freshly smoothed ones
      prevY = curY
    }
  }
}

/** Uniform arc-length resample to k ≥ 2 points, optionally reversed. */
function resample(coords: Float32Array, k: number, flipped: boolean): Float64Array {
  const n = coords.length / 2
  const x = (i: number): number => coords[(flipped ? n - 1 - i : i) * 2]!
  const y = (i: number): number => coords[(flipped ? n - 1 - i : i) * 2 + 1]!
  const cum = new Float64Array(n)
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1]! + Math.hypot(x(i) - x(i - 1), y(i) - y(i - 1))
  }
  const total = cum[n - 1]!
  const out = new Float64Array(k * 2)
  if (total === 0) {
    for (let j = 0; j < k; j++) {
      out[j * 2] = x(0)
      out[j * 2 + 1] = y(0)
    }
    return out
  }
  let seg = 1
  for (let j = 0; j < k; j++) {
    const target = (total * j) / (k - 1)
    while (seg < n - 1 && cum[seg]! < target) seg++
    const span = cum[seg]! - cum[seg - 1]!
    const t = span === 0 ? 0 : (target - cum[seg - 1]!) / span
    out[j * 2] = x(seg - 1) + (x(seg) - x(seg - 1)) * t
    out[j * 2 + 1] = y(seg - 1) + (y(seg) - y(seg - 1)) * t
  }
  return out
}

/** Grid index over places at the anchor radius; lookups scan 3×3 cells. */
function buildPlaceIndex(places: ViewportWaypoint[]): Map<string, ViewportWaypoint[]> {
  const index = new Map<string, ViewportWaypoint[]>()
  for (const p of places) {
    const key = cellKey(Math.floor(p.lat / ANCHOR_RADIUS_DEG), Math.floor(p.lon / ANCHOR_RADIUS_DEG))
    const cell = index.get(key)
    if (cell) cell.push(p)
    else index.set(key, [p])
  }
  return index
}

const cellKey = (ci: number, cj: number): string => `${ci}:${cj}`

function nearestPlace(
  index: Map<string, ViewportWaypoint[]>,
  lon: number,
  lat: number
): ViewportWaypoint | null {
  const ci = Math.floor(lat / ANCHOR_RADIUS_DEG)
  const cj = Math.floor(lon / ANCHOR_RADIUS_DEG)
  let best: ViewportWaypoint | null = null
  let bestD = ANCHOR_RADIUS_DEG * ANCHOR_RADIUS_DEG
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const cell = index.get(cellKey(ci + di, cj + dj))
      if (!cell) continue
      for (const p of cell) {
        const d = (p.lat - lat) ** 2 + (p.lon - lon) ** 2
        if (d < bestD || (d === bestD && best !== null && p.id < best.id)) {
          best = p
          bestD = d
        }
      }
    }
  }
  return best
}

function floatView(row: ViewportSegmentRow): Float32Array {
  // Blobs from SQLite are byte-aligned copies; realign for a Float32 view.
  return row.coords.byteOffset % 4 === 0
    ? new Float32Array(row.coords.buffer, row.coords.byteOffset, row.point_count * 2)
    : new Float32Array(row.coords.slice().buffer)
}
