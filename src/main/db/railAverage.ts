/**
 * Display-time averaging of repeat rail rides ("cleaning", toggleable).
 *
 * Metro/tram GPS is noisy (tunnels, scatter), and the same line between the
 * same two stations is ridden again and again — rendering as a smear of
 * jittered polylines. When enabled, rides of one type whose endpoints anchor
 * to the same two places merge into a single consensus track: every member
 * is arc-length resampled to a common vertex count, oriented the same way
 * (A→B and B→A rides combine), and averaged per vertex.
 *
 * "Where possible": a ride only joins a group when BOTH endpoints are within
 * ANCHOR_RADIUS_DEG of a place; unanchored rides, loops (same place at both
 * ends), solo rides, and non-rail types pass through untouched. Raw points
 * are never modified — this runs on display geometry per viewport query.
 */
import type { ViewportSegmentRow } from './queries'
import type { ViewportWaypoint } from '../../shared/types'

export const RAIL_AVERAGE_TYPES: ReadonlySet<string> = new Set(['metro', 'tram'])

/** Max distance from a track end to a place for the ride to anchor (~440 m). */
const ANCHOR_RADIUS_DEG = 0.004

/** Resampled vertex count is the group's median, kept within sane bounds. */
const MAX_AVERAGED_POINTS = 200

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
    out.push(averageGroup(group))
    collapsed += group.length
  }
  return { rows: out, collapsed }
}

function averageGroup(group: Ride[]): ViewportSegmentRow {
  const counts = group.map((r) => r.row.point_count).sort((x, y) => x - y)
  const k = Math.min(MAX_AVERAGED_POINTS, Math.max(2, counts[counts.length >> 1]!))
  const acc = new Float64Array(k * 2)
  for (const ride of group) {
    const pts = resample(ride.coords, k, ride.flipped)
    for (let i = 0; i < acc.length; i++) acc[i]! += pts[i]!
  }
  const coords = new Float32Array(k * 2)
  for (let i = 0; i < coords.length; i++) coords[i] = acc[i]! / group.length
  // Deterministic identity: lowest member id; year color follows the most
  // recent ride, matching most-recent-wins elsewhere.
  let id = Infinity
  let startTsMs: number | null = null
  for (const ride of group) {
    id = Math.min(id, ride.row.id)
    const ts = ride.row.start_ts_ms
    if (ts != null && (startTsMs == null || ts > startTsMs)) startTsMs = ts
  }
  return {
    id,
    type: group[0]!.row.type,
    start_ts_ms: startTsMs,
    point_count: k,
    coords: new Uint8Array(coords.buffer)
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
