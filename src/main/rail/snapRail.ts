/**
 * Offline map-matching of rail rides to OSM track geometry.
 *
 * Metro/tram/train GPS is worst exactly where OSM is best: tunnels are mapped
 * in OSM from official alignments even though the phone sees nothing. So
 * instead of averaging bad-with-bad, we snap a ride onto the rail network and
 * route along it between matched anchors — replacing garbage tunnel GPS with
 * the real alignment, and making every repeat ride coincide.
 *
 * The matcher is *segment-local*, not all-or-nothing: each ride vertex is
 * anchored to the nearest point on the network (within a radius — OSM nodes
 * are sparse on straight track, so we measure distance to the edge, not the
 * node), and consecutive anchors are joined by routing along the rail graph,
 * which fills the gap between two far-apart fixes with the real track and can
 * cross between lines at interchanges (transfer edges connect nearby nodes).
 * A hop that can't be routed and is too long to bridge keeps its raw GPS and
 * breaks the rail run — so a ride that wanders off the network (or spans two
 * disconnected systems) is cleaned where it can be and left raw where it
 * can't, instead of being rejected wholesale. Raw points are never modified;
 * the cleaned line is a display artifact. A full HMM matcher can replace the
 * greedy core later without changing the call sites.
 */

import { DEFAULT_RAIL_TUNING, type RailTuning } from '../../shared/types'

export const RAIL_SNAP_TYPES: ReadonlySet<string> = new Set(['metro', 'tram', 'train', 'subway'])

/**
 * OSM `railway=*` kinds we keep, as small codes (stored per edge). Matching is
 * constrained by kind so a metro ride can't snap to a parallel commuter-rail
 * line: each Arc mode matches only its own track kinds (ALLOWED_KINDS_BY_TYPE).
 * 0 = unknown (edges fetched before kinds were stored) and acts as a wildcard.
 */
export const RAIL_KIND = {
  unknown: 0,
  subway: 1,
  light_rail: 2,
  tram: 3,
  rail: 4,
  narrow_gauge: 5,
  monorail: 6
} as const

export function railKindCode(railwayTag: string | undefined): number {
  switch (railwayTag) {
    case 'subway': return RAIL_KIND.subway
    case 'light_rail': return RAIL_KIND.light_rail
    case 'tram': return RAIL_KIND.tram
    case 'rail': return RAIL_KIND.rail
    case 'narrow_gauge': return RAIL_KIND.narrow_gauge
    case 'monorail': return RAIL_KIND.monorail
    default: return RAIL_KIND.unknown
  }
}

/**
 * Which OSM track kinds each Arc mode may match. Splits heavy rail (train)
 * from subway/light modes so the corridors stop bleeding into each other;
 * metro and tram still share light_rail (the Green-Line-style gray zone),
 * which is geometrically near-identical anyway.
 */
export const ALLOWED_KINDS_BY_TYPE: Readonly<Record<string, readonly number[]>> = {
  metro: [RAIL_KIND.subway, RAIL_KIND.light_rail],
  subway: [RAIL_KIND.subway, RAIL_KIND.light_rail],
  tram: [RAIL_KIND.tram, RAIL_KIND.light_rail],
  train: [RAIL_KIND.rail, RAIL_KIND.narrow_gauge, RAIL_KIND.monorail]
}

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

/** Meters per degree of latitude; close enough for tuning radii. */
const M_PER_DEG = 111320

/** A routed hop may be at most this multiple of the straight anchor distance… */
const GAP_FACTOR = 4
/** …plus this slack (~330 m), so short hops aren't over-constrained. */
const GAP_SLACK_DEG = 3e-3
/**
 * An unroutable hop no longer than this (~155 m) is bridged straight instead
 * of breaking the run: adjacent parallel tracks (one way per direction) make
 * noisy anchors ping-pong across rails whose crossover is far away.
 */
const SOFT_BRIDGE_DEG = 1.4e-3

/**
 * Is this lon/lat inside a fetched coverage region? Rail is fetched one
 * viewport at a time, so a ride can run off the edge of everything fetched —
 * vertices outside coverage keep their raw GPS, never force-matched.
 */
export type CoverageTest = (lon: number, lat: number) => boolean

const FULL_COVERAGE: CoverageTest = () => true

export interface RailGraph {
  /** Projected coords keyed by node id: X = lon·cos(refLat), Y = lat. */
  pos: Map<number, { x: number; y: number; lon: number; lat: number }>
  adj: Map<number, Array<{ to: number; w: number }>>
  /** Edges with both endpoints present; `grid` buckets hold indices into it. */
  edges: RailEdgeInput[]
  grid: Map<string, number[]>
  /** Snap radius in degrees — also the grid cell size (3×3 covers it). */
  cell: number
  refCos: number
  empty: boolean
}

const cellKey = (cx: number, cy: number): string => `${cx}:${cy}`

/**
 * Build the routing graph + edge spatial index from OSM nodes and edges.
 * Tuning ranges (user-adjustable, meters) set the anchor snap radius and how
 * far apart unconnected nodes may be while still linked for transfers.
 */
export function buildRailGraph(
  nodes: RailNodeInput[],
  edges: RailEdgeInput[],
  tuning: RailTuning = DEFAULT_RAIL_TUNING
): RailGraph {
  const snapRadiusDeg = tuning.snapRadiusM / M_PER_DEG
  if (nodes.length === 0) {
    return { pos: new Map(), adj: new Map(), edges: [], grid: new Map(), cell: snapRadiusDeg, refCos: 1, empty: true }
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
  addTransferEdges(pos, adj, link, tuning.transferRadiusM / M_PER_DEG)

  // Index edges into a grid sized so a 3×3 neighborhood covers the snap
  // radius: an edge is registered in every cell its bbox touches, so any
  // segment passing within the radius of a vertex is found.
  const cell = snapRadiusDeg
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
 * Link distinct nodes within the transfer radius that the track doesn't
 * already connect: interchange platforms and at-grade crossings that OSM maps
 * as separate, unconnected ways. Weighted by real distance, so a transfer is
 * only taken when it genuinely shortens the path.
 */
function addTransferEdges(
  pos: Map<number, { x: number; y: number; lon: number; lat: number }>,
  adj: Map<number, Array<{ to: number; w: number }>>,
  link: (a: number, b: number, w: number) => void,
  radiusDeg: number
): void {
  if (radiusDeg <= 0) return
  const cell = radiusDeg
  const grid = new Map<string, number[]>()
  for (const [id, p] of pos) {
    const key = cellKey(Math.floor(p.x / cell), Math.floor(p.y / cell))
    const bucket = grid.get(key)
    if (bucket) bucket.push(id)
    else grid.set(key, [id])
  }
  const r2 = radiusDeg * radiusDeg
  const adjacent = (a: number, b: number): boolean => (adj.get(a) ?? []).some((e) => e.to === b)
  for (const [id, p] of pos) {
    const cx = Math.floor(p.x / cell)
    const cy = Math.floor(p.y / cell)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(cellKey(cx + dx, cy + dy))
        if (!bucket) continue
        for (const other of bucket) {
          if (other <= id) continue // each unordered pair once
          const q = pos.get(other)!
          const d2 = (p.x - q.x) ** 2 + (p.y - q.y) ** 2
          if (d2 === 0 || d2 > r2 || adjacent(id, other)) continue
          const w = Math.sqrt(d2)
          link(id, other, w)
          link(other, id, w)
        }
      }
    }
  }
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
  let bestD = g.cell * g.cell // cell size = snap radius
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
 * Map-match one ride (interleaved lon,lat coords) to the rail network. The
 * result threads rail geometry through anchored, routable stretches and keeps
 * raw GPS everywhere else (off-network, off-coverage, or across a gap too long
 * to route). Returns null when nothing snapped — the caller keeps the raw line.
 */
export function matchRideToRail(
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
  const pushNode = (id: number): void => {
    const p = g.pos.get(id)!
    pushLonLat(p.lon, p.lat)
  }

  let prev: number | null = null // last anchored node, or null if last point was raw
  let snappedHops = 0
  for (let i = 0; i < n; i++) {
    const lon = coords[i * 2]!
    const lat = coords[i * 2 + 1]!
    const anchor = isCovered(lon, lat) ? nearestAnchor(g, lon * g.refCos, lat) : null
    if (anchor === null) {
      pushLonLat(lon, lat) // off-network / off-coverage: keep raw, break the run
      prev = null
      continue
    }
    if (prev === null) {
      pushNode(anchor)
      prev = anchor
      continue
    }
    if (anchor === prev) continue
    const a = g.pos.get(prev)!
    const b = g.pos.get(anchor)!
    const straight = Math.hypot(a.x - b.x, a.y - b.y)
    const route = dijkstra(g, prev, anchor, GAP_FACTOR * straight + GAP_SLACK_DEG)
    if (route) {
      for (let j = 1; j < route.length; j++) pushNode(route[j]!)
      snappedHops++
      prev = anchor
    } else if (straight <= SOFT_BRIDGE_DEG) {
      pushNode(anchor) // parallel-track ping-pong: bridge the few meters straight
      snappedHops++
      prev = anchor
    } else {
      pushLonLat(lon, lat) // long gap that won't route → keep raw, break the run
      prev = null
    }
  }
  if (snappedHops === 0 || out.length < 4) return null
  return new Float32Array(out)
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
