/**
 * Offline map-matching of rail rides to OSM track geometry.
 *
 * Metro/tram/train GPS is worst exactly where OSM is best: tunnels are mapped
 * in OSM from official alignments even though the phone sees nothing. So
 * instead of averaging bad-with-bad, we snap each ride onto the rail network
 * and route along it between matched anchors — replacing garbage tunnel GPS
 * with the real alignment, and making every repeat ride coincide (the smear
 * collapses without merging identities).
 *
 * v1 is a greedy matcher: anchor each ride vertex to the nearest rail *edge*
 * (point-to-segment distance — OSM nodes are sparse on straight track, so
 * node distance alone misses most of the network), then Dijkstra between
 * consecutive anchors to bridge gaps (tunnels). A hop that won't route but
 * spans only a few meters (parallel-track ping-pong) is bridged straight; a
 * ride that can't be matched confidently (too far from rail, or a long hop
 * that won't route) is left untouched. Raw points are never modified — this
 * runs on display geometry per viewport query. A full HMM matcher can
 * replace the greedy core later without changing the call sites.
 */
import type { ViewportSegmentRow } from '../db/queries'

export const RAIL_SNAP_TYPES: ReadonlySet<string> = new Set(['metro', 'tram', 'train', 'subway'])

/** OSM node and its neighbors; coords are projected (see RailGraph). */
export interface RailNodeInput {
  id: number
  lat: number
  lon: number
}
export interface RailEdgeInput {
  a: number
  b: number
}

/** Snap a ride vertex to rail within ~100 m (of the track, not just nodes). */
const SNAP_RADIUS_DEG = 9e-4
/** A routed hop may be at most this multiple of the straight anchor distance… */
const GAP_FACTOR = 4
/** …plus this slack (~330 m), so short hops aren't over-constrained. */
const GAP_SLACK_DEG = 3e-3
/**
 * An unroutable hop no longer than this (~150 m) is bridged straight instead
 * of failing the run: adjacent parallel tracks (one way per direction) make
 * noisy anchors ping-pong across rails whose connecting crossover is far away.
 */
const SOFT_BRIDGE_DEG = 1.4e-3
/** Give up on a run unless at least this fraction of its vertices matched. */
const MIN_MATCH_FRACTION = 0.5

export interface RailGraph {
  /** Projected coords keyed by node id: X = lon·cos(refLat), Y = lat. */
  pos: Map<number, { x: number; y: number; lon: number; lat: number }>
  adj: Map<number, Array<{ to: number; w: number }>>
  /** Edges with both endpoints present; `grid` buckets hold indices into it. */
  edges: RailEdgeInput[]
  grid: Map<string, number[]>
  cell: number
  refCos: number
  empty: boolean
}

const cellKey = (cx: number, cy: number): string => `${cx}:${cy}`

/** Build the routing graph + edge spatial index from OSM nodes and edges. */
export function buildRailGraph(nodes: RailNodeInput[], edges: RailEdgeInput[]): RailGraph {
  if (nodes.length === 0) {
    return { pos: new Map(), adj: new Map(), edges: [], grid: new Map(), cell: SNAP_RADIUS_DEG, refCos: 1, empty: true }
  }
  let latSum = 0
  for (const n of nodes) latSum += n.lat
  const refCos = Math.max(0.1, Math.cos(((latSum / nodes.length) * Math.PI) / 180))

  const pos = new Map<number, { x: number; y: number; lon: number; lat: number }>()
  for (const n of nodes) {
    pos.set(n.id, { x: n.lon * refCos, y: n.lat, lon: n.lon, lat: n.lat })
  }

  const adj = new Map<number, Array<{ to: number; w: number }>>()
  const link = (a: number, b: number, w: number): void => {
    let list = adj.get(a)
    if (!list) adj.set(a, (list = []))
    list.push({ to: b, w })
  }
  const kept: RailEdgeInput[] = []
  for (const e of edges) {
    const pa = pos.get(e.a)
    const pb = pos.get(e.b)
    if (!pa || !pb || e.a === e.b) continue
    const w = Math.hypot(pa.x - pb.x, pa.y - pb.y)
    link(e.a, e.b, w)
    link(e.b, e.a, w)
    kept.push(e)
  }

  // Index edges into a grid sized so a 3×3 neighborhood covers the snap
  // radius: an edge is registered in every cell its bbox touches, so any
  // segment passing within the radius of a vertex is found.
  const cell = SNAP_RADIUS_DEG
  const grid = new Map<string, number[]>()
  for (let i = 0; i < kept.length; i++) {
    const pa = pos.get(kept[i]!.a)!
    const pb = pos.get(kept[i]!.b)!
    const x0 = Math.floor(Math.min(pa.x, pb.x) / cell)
    const x1 = Math.floor(Math.max(pa.x, pb.x) / cell)
    const y0 = Math.floor(Math.min(pa.y, pb.y) / cell)
    const y1 = Math.floor(Math.max(pa.y, pb.y) / cell)
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = cellKey(cx, cy)
        const bucket = grid.get(key)
        if (bucket) bucket.push(i)
        else grid.set(key, [i])
      }
    }
  }
  return { pos, adj, edges: kept, grid, cell, refCos, empty: pos.size === 0 }
}

/**
 * Anchor a projected point to the rail: nearest edge by point-to-segment
 * distance (within the snap radius), returning the endpoint node nearer to
 * the projection. Nodes are sparse on straight track, so node distance alone
 * would miss vertices sitting right on the rail.
 */
function nearestAnchor(g: RailGraph, x: number, y: number): number | null {
  const cx = Math.floor(x / g.cell)
  const cy = Math.floor(y / g.cell)
  let best: number | null = null
  let bestD = SNAP_RADIUS_DEG * SNAP_RADIUS_DEG
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = g.grid.get(cellKey(cx + dx, cy + dy))
      if (!bucket) continue
      for (const ei of bucket) {
        const e = g.edges[ei]!
        const pa = g.pos.get(e.a)!
        const pb = g.pos.get(e.b)!
        const vx = pb.x - pa.x
        const vy = pb.y - pa.y
        const len2 = vx * vx + vy * vy
        let t = len2 === 0 ? 0 : ((x - pa.x) * vx + (y - pa.y) * vy) / len2
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const d = (pa.x + t * vx - x) ** 2 + (pa.y + t * vy - y) ** 2
        const anchor = t < 0.5 ? e.a : e.b
        if (d < bestD || (d === bestD && best !== null && anchor < best)) {
          best = anchor
          bestD = d
        }
      }
    }
  }
  return best
}

/**
 * Is this lon/lat inside a fetched coverage region? Rail is fetched one
 * viewport at a time, so a ride can run off the edge of everything fetched —
 * vertices outside coverage must keep their raw GPS, never be force-matched
 * (or worse, dropped).
 */
export type CoverageTest = (lon: number, lat: number) => boolean

const FULL_COVERAGE: CoverageTest = () => true

/**
 * Snap one ride (interleaved lon,lat display coords) to the rail network.
 * Each in-coverage run of vertices is matched independently; off-coverage
 * runs (and runs that won't match confidently) pass through raw, so a ride
 * leaving the fetched area keeps its real tail. Returns the stitched
 * polyline, or null when nothing snapped (caller keeps the original row).
 */
export function snapRideToRail(
  coords: Float32Array,
  g: RailGraph,
  isCovered: CoverageTest = FULL_COVERAGE
): Float32Array | null {
  if (g.empty) return null
  const n = coords.length / 2
  if (n < 2) return null

  const out: number[] = []
  const pushLonLat = (lon: number, lat: number): void => {
    const m = out.length
    if (m >= 2 && out[m - 2] === lon && out[m - 1] === lat) return
    out.push(lon, lat)
  }
  const pushRaw = (i: number): void => pushLonLat(coords[i * 2]!, coords[i * 2 + 1]!)

  let snappedRuns = 0
  let i = 0
  while (i < n) {
    if (!isCovered(coords[i * 2]!, coords[i * 2 + 1]!)) {
      pushRaw(i)
      i++
      continue
    }
    // Maximal in-coverage run [i, end).
    let end = i + 1
    while (end < n && isCovered(coords[end * 2]!, coords[end * 2 + 1]!)) end++
    const path = matchRun(coords, i, end, g)
    if (path) {
      snappedRuns++
      for (const id of path) {
        const p = g.pos.get(id)!
        pushLonLat(p.lon, p.lat)
      }
    } else {
      for (let j = i; j < end; j++) pushRaw(j)
    }
    i = end
  }

  if (snappedRuns === 0 || out.length < 4) return null
  return new Float32Array(out)
}

/**
 * Greedy-match vertices [start, end) to a rail node path, or null when the
 * run can't be matched confidently (too far from rail, or a long hop that
 * won't route sanely).
 */
function matchRun(coords: Float32Array, start: number, end: number, g: RailGraph): number[] | null {
  // Anchor sequence: nearest edge per vertex, consecutive duplicates dropped.
  const anchors: number[] = []
  let matched = 0
  for (let i = start; i < end; i++) {
    const x = coords[i * 2]! * g.refCos
    const y = coords[i * 2 + 1]!
    const node = nearestAnchor(g, x, y)
    if (node === null) continue
    matched++
    if (anchors.length === 0 || anchors[anchors.length - 1] !== node) anchors.push(node)
  }
  if (anchors.length < 2 || matched < (end - start) * MIN_MATCH_FRACTION) return null

  // Route along the rail between consecutive anchors, bridging tunnels.
  const path: number[] = [anchors[0]!]
  for (let k = 1; k < anchors.length; k++) {
    const from = anchors[k - 1]!
    const to = anchors[k]!
    if (from === to) continue
    const a = g.pos.get(from)!
    const b = g.pos.get(to)!
    const straight = Math.hypot(a.x - b.x, a.y - b.y)
    const seg = dijkstra(g, from, to, GAP_FACTOR * straight + GAP_SLACK_DEG)
    if (seg) {
      for (let j = 1; j < seg.length; j++) path.push(seg[j]!)
    } else if (straight <= SOFT_BRIDGE_DEG) {
      path.push(to) // parallel-track ping-pong: bridge the few meters straight
    } else {
      return null // a long hop that won't route sanely → don't trust the match
    }
  }
  return path
}

/** Shortest node path from src to dst within a distance cutoff, or null. */
function dijkstra(g: RailGraph, src: number, dst: number, maxDist: number): number[] | null {
  const dist = new Map<number, number>([[src, 0]])
  const prev = new Map<number, number>()
  const heap = new MinHeap()
  heap.push(src, 0)
  while (heap.size > 0) {
    const { id: u, key: du } = heap.pop()!
    if (u === dst) break
    if (du > (dist.get(u) ?? Infinity)) continue
    if (du > maxDist) continue
    for (const { to, w } of g.adj.get(u) ?? []) {
      const nd = du + w
      if (nd <= maxDist && nd < (dist.get(to) ?? Infinity)) {
        dist.set(to, nd)
        prev.set(to, u)
        heap.push(to, nd)
      }
    }
  }
  if (!dist.has(dst)) return null
  const path: number[] = []
  for (let at: number | undefined = dst; at !== undefined; at = prev.get(at)) {
    path.push(at)
    if (at === src) break
  }
  return path.reverse()
}

/** Snap every matchable rail row; non-rail rows pass through untouched. */
export interface RailSnapResult {
  rows: ViewportSegmentRow[]
  /** Rail rides successfully snapped to OSM geometry. */
  snapped: number
  /** Rail-typed rides seen (snapped + passed through), for "X of Y" stats. */
  railRides: number
}

export function snapRailTracks(
  rows: ViewportSegmentRow[],
  g: RailGraph,
  isCovered: CoverageTest = FULL_COVERAGE
): RailSnapResult {
  if (g.empty) return { rows, snapped: 0, railRides: 0 }
  const out: ViewportSegmentRow[] = []
  let snapped = 0
  let railRides = 0
  for (const row of rows) {
    if (!RAIL_SNAP_TYPES.has(row.type) || row.point_count < 2) {
      out.push(row)
      continue
    }
    railRides++
    const snappedCoords = snapRideToRail(floatView(row), g, isCovered)
    if (!snappedCoords) {
      out.push(row)
      continue
    }
    snapped++
    out.push({
      id: row.id,
      type: row.type,
      start_ts_ms: row.start_ts_ms,
      point_count: snappedCoords.length / 2,
      coords: new Uint8Array(snappedCoords.buffer)
    })
  }
  return { rows: out, snapped, railRides }
}

function floatView(row: ViewportSegmentRow): Float32Array {
  return row.coords.byteOffset % 4 === 0
    ? new Float32Array(row.coords.buffer, row.coords.byteOffset, row.point_count * 2)
    : new Float32Array(row.coords.slice().buffer)
}

/** Tiny binary min-heap keyed by distance (no dependency, allows stale entries). */
class MinHeap {
  private ids: number[] = []
  private keys: number[] = []
  get size(): number {
    return this.ids.length
  }
  push(id: number, key: number): void {
    this.ids.push(id)
    this.keys.push(key)
    let i = this.ids.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.keys[p]! <= this.keys[i]!) break
      this.swap(i, p)
      i = p
    }
  }
  pop(): { id: number; key: number } | undefined {
    if (this.ids.length === 0) return undefined
    const id = this.ids[0]!
    const key = this.keys[0]!
    const lastId = this.ids.pop()!
    const lastKey = this.keys.pop()!
    if (this.ids.length > 0) {
      this.ids[0] = lastId
      this.keys[0] = lastKey
      let i = 0
      const n = this.ids.length
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let s = i
        if (l < n && this.keys[l]! < this.keys[s]!) s = l
        if (r < n && this.keys[r]! < this.keys[s]!) s = r
        if (s === i) break
        this.swap(i, s)
        i = s
      }
    }
    return { id, key }
  }
  private swap(i: number, j: number): void {
    ;[this.ids[i], this.ids[j]] = [this.ids[j]!, this.ids[i]!]
    ;[this.keys[i], this.keys[j]] = [this.keys[j]!, this.keys[i]!]
  }
}
