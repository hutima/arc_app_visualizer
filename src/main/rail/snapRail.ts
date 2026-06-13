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
  monorail: 6,
  /** Road tunnels (highway + tunnel tags) — used only to bridge car GPS gaps. */
  road_tunnel: 7
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
 * which is geometrically near-identical anyway. road_tunnel is deliberately
 * absent — roads never participate in rail matching (and vice versa).
 */
export const ALLOWED_KINDS_BY_TYPE: Readonly<Record<string, readonly number[]>> = {
  metro: [RAIL_KIND.subway, RAIL_KIND.light_rail],
  subway: [RAIL_KIND.subway, RAIL_KIND.light_rail],
  tram: [RAIL_KIND.tram, RAIL_KIND.light_rail],
  train: [RAIL_KIND.rail, RAIL_KIND.narrow_gauge, RAIL_KIND.monorail]
}

/**
 * Road trips get tunnel-gap bridging only — never full map-matching (roads
 * overlap far too much for the greedy matcher). When GPS drops for a long
 * stretch and both sides of the gap sit near mapped road-tunnel geometry,
 * the gap is filled by routing through the tunnel instead of a straight
 * line skipping across downtown (Boston's Central Artery effect).
 */
export const ROAD_TUNNEL_TYPES: ReadonlySet<string> = new Set(['car', 'taxi', 'bus'])

/**
 * A tunnel gap is one that's both absolutely long (GPS doesn't vanish for
 * ~120 m on open road) and anomalous for *this* trip — a stop-and-go city
 * drive samples every few meters, a highway run every ~100 m, so the bar is
 * relative to the trip's own median spacing rather than a fixed distance.
 */
const ROAD_GAP_FLOOR_DEG = 1.1e-3 // ~120 m absolute minimum
const ROAD_GAP_REL_FACTOR = 4 // …and ≥ this × the trip's median point spacing
/** Below this many gaps the median is too noisy; fall back to the floor alone. */
const ROAD_GAP_MIN_SAMPLES = 4

/** Portal anchoring is forgiving — GPS dies/revives some way from the mouth. */
export const ROAD_TUNING: RailTuning = { snapRadiusM: 250, transferRadiusM: 0 }

/**
 * Time-plausibility gate: a fill between two fixes is a lie when the rider
 * had far more time than the path explains — an out-and-back through downtown
 * with dead GPS looks like a short hop between two nearby corridor points,
 * and routing it draws a track jump that never happened. Hops with more
 * elapsed time than the floor must cover at least dt × a minimum sustained
 * speed (dwell included), or they stay raw.
 */
const TIME_GATE_MIN_DT_MS = 300_000 // gate hops longer than 5 minutes
const RAIL_MIN_PROGRESS_MPS = 2 // slowest believable metro progress incl. stops
const RAIL_MAX_PROGRESS_MPS = 30 // fastest believable — rejects fictional detours
const ROAD_MIN_PROGRESS_MPS = 1.5 // jams included

/**
 * Rescue anchoring: tunnel scatter is wild but still traces the rider's
 * progress, so when a fill fails its time gate we retry the unanchored
 * in-between fixes at this multiple of the snap radius and route through
 * them — recovering e.g. an out-and-back through downtown instead of either
 * a shortcut or nothing.
 */
const RESCUE_ANCHOR_SCALE = 3

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
 * Flat cost added to every transfer hop (~220 m of travel). Routing minimises
 * total weight, so this buys contiguity: a fill between two anchors prefers
 * staying on one track over weaving across parallel rails, and takes a
 * transfer only where one is genuinely needed (a real interchange). Kept under
 * GAP_SLACK so a legitimate short transfer still fits the routing budget.
 */
const TRANSFER_PENALTY_DEG = 2e-3

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
  /**
   * Track-connected component per node, over real track edges only (not
   * transfers). Two directions of a line, or two unconnected lines, are
   * separate components — so a ride stays on one and only switches at a
   * genuine interchange. Anchoring prefers the previous vertex's component.
   */
  comp: Map<number, number>
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
 *
 * Only nodes referenced by a kept edge participate: per-mode graphs receive
 * every stored node but a kind-filtered edge list, and an edge-less node must
 * not exist here — transfer edges would otherwise chain across a parallel
 * line's orphaned nodes and route a metro ride along commuter/freight track.
 */
export function buildRailGraph(
  nodes: RailNodeInput[],
  edges: RailEdgeInput[],
  tuning: RailTuning = DEFAULT_RAIL_TUNING
): RailGraph {
  const snapRadiusDeg = tuning.snapRadiusM / M_PER_DEG
  const emptyGraph = (): RailGraph => ({
    pos: new Map(), adj: new Map(), edges: [], grid: new Map(), comp: new Map(), cell: snapRadiusDeg, refCos: 1, empty: true
  })
  if (nodes.length === 0) return emptyGraph()

  const byId = new Map<number, RailNodeInput>()
  for (const n of nodes) byId.set(n.id, n)

  const kept: RailEdgeInput[] = []
  const used = new Set<number>()
  for (const e of edges) {
    if (e.a === e.b || !byId.has(e.a) || !byId.has(e.b)) continue
    kept.push(e)
    used.add(e.a)
    used.add(e.b)
  }
  if (used.size === 0) return emptyGraph()

  // Track-connected components over real edges only (transfers come later and
  // deliberately don't merge components).
  const comp = trackComponents(used, kept)

  let latSum = 0
  for (const id of used) latSum += byId.get(id)!.lat
  const refCos = Math.max(0.1, Math.cos(((latSum / used.size) * Math.PI) / 180))

  const pos = new Map<number, { x: number; y: number; lon: number; lat: number }>()
  for (const id of used) {
    const n = byId.get(id)!
    pos.set(id, { x: n.lon * refCos, y: n.lat, lon: n.lon, lat: n.lat })
  }

  const adj = new Map<number, Array<{ to: number; w: number }>>()
  const link = (a: number, b: number, w: number): void => {
    let list = adj.get(a)
    if (!list) adj.set(a, (list = []))
    list.push({ to: b, w })
  }
  for (const e of kept) {
    const pa = pos.get(e.a)!
    const pb = pos.get(e.b)!
    const w = Math.hypot(pa.x - pb.x, pa.y - pb.y)
    link(e.a, e.b, w)
    link(e.b, e.a, w)
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
  return { pos, adj, edges: kept, grid, comp, cell, refCos, empty: false }
}

/** Union-find over track edges → a component id per node. */
function trackComponents(used: Set<number>, edges: RailEdgeInput[]): Map<number, number> {
  const parent = new Map<number, number>()
  for (const id of used) parent.set(id, id)
  const find = (x: number): number => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    while (parent.get(x) !== r) {
      const nx = parent.get(x)!
      parent.set(x, r)
      x = nx
    }
    return r
  }
  for (const e of edges) {
    const ra = find(e.a)
    const rb = find(e.b)
    if (ra !== rb) parent.set(ra, rb)
  }
  const comp = new Map<number, number>()
  for (const id of used) comp.set(id, find(id))
  return comp
}

/**
 * Link distinct nodes within the transfer radius that the track doesn't
 * already connect: interchange platforms and at-grade crossings that OSM maps
 * as separate, unconnected ways. Weighted by real distance, so a transfer is
 * only taken when it genuinely shortens the path. `pos` holds only this
 * graph's own (mode-filtered) network, so transfers never cross modes.
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
          // Penalised so routing prefers contiguous track over weaving.
          const w = Math.sqrt(d2) + TRANSFER_PENALTY_DEG
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
 *
 * `preferComp` is the previous vertex's track component: when given, a
 * candidate in that component within the radius wins over a geometrically
 * closer one on a different track — so a noisy point near a parallel line
 * doesn't flip the ride onto it. -1 disables the preference (start of a run).
 * `radiusScale` widens the search (rescue anchoring of tunnel scatter).
 */
function nearestAnchor(
  g: RailGraph,
  x: number,
  y: number,
  preferComp = -1,
  radiusScale = 1
): number | null {
  const cx = Math.floor(x / g.cell)
  const cy = Math.floor(y / g.cell)
  const reach = Math.ceil(radiusScale) // cell size = snap radius
  const radius2 = g.cell * radiusScale * (g.cell * radiusScale)
  let best: number | null = null
  let bestD = radius2
  let bestPref: number | null = null
  let bestPrefD = radius2
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dy = -reach; dy <= reach; dy++) {
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
        if (preferComp >= 0 && g.comp.get(anchor) === preferComp) {
          if (d < bestPrefD || (d === bestPrefD && bestPref !== null && anchor < bestPref)) {
            bestPref = anchor
            bestPrefD = d
          }
        }
      }
    }
  }
  return bestPref ?? best
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
  isCovered: CoverageTest = FULL_COVERAGE,
  timesMs?: ArrayLike<number> | null
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

  // A break renders as a gap (MultiLineString part on the map): where we know
  // connecting two fixes would draw a path that never happened, draw nothing.
  const pushBreak = (): void => {
    const m = out.length
    if (m === 0 || Number.isNaN(out[m - 1]!)) return
    out.push(NaN, NaN)
  }
  const pushRaw = (i: number): void => pushLonLat(coords[i * 2]!, coords[i * 2 + 1]!)

  let prev: number | null = null // last anchored node, or null if last point was raw
  let prevComp = -1 // its track component, so anchoring stays on one line
  let prevTs = NaN // when the rider was last seen at an anchor
  let pending: number[] = [] // covered-but-unanchored fixes inside a run (tunnel scatter)
  let snappedHops = 0
  const acceptAnchor = (anchor: number, t: number): void => {
    prev = anchor
    prevComp = g.comp.get(anchor) ?? -1
    prevTs = t
  }

  for (let i = 0; i < n; i++) {
    const lon = coords[i * 2]!
    const lat = coords[i * 2 + 1]!
    const t = timesMs ? Number(timesMs[i]) : NaN
    if (!isCovered(lon, lat)) {
      // Real geometry beyond fetched coverage: stays connected and raw.
      for (const p of pending) pushRaw(p)
      pending = []
      pushRaw(i)
      prev = null
      prevComp = -1
      continue
    }
    const anchor = nearestAnchor(g, lon * g.refCos, lat, prevComp)
    if (anchor === null) {
      if (prev === null) pushRaw(i) // head scatter: nothing to explain it yet
      else pending.push(i) // inside a run: judged when the next anchor arrives
      continue
    }
    if (prev === null) {
      pushNode(anchor)
      acceptAnchor(anchor, t)
      continue
    }
    if (anchor === prev) {
      pending = [] // dwell at a station: scatter around it is explained — drop it
      prevTs = t // and dwell time must not poison the next hop's dt
      continue
    }
    const dtMs = t - prevTs
    const fill = pending.length
      ? (rescueRoute(g, coords, pending, prev, anchor, dtMs) ?? directFill(g, prev, anchor, dtMs))
      : directFill(g, prev, anchor, dtMs)
    pending = [] // either way the scatter is judged: explained by a fill, or garbage
    if (fill) {
      for (let j = 1; j < fill.length; j++) pushNode(fill[j]!)
      snappedHops++
    } else {
      // No believable path between the two fixes (an unseen out-and-back, or
      // an unroutable long hop): draw nothing rather than a jump that never
      // happened, and restart the run here.
      pushBreak()
      pushNode(anchor)
    }
    acceptAnchor(anchor, t)
  }
  // Trailing scatter has no closing anchor to explain it: keep it, detached.
  if (pending.length) {
    pushBreak()
    for (const p of pending) pushRaw(p)
  }
  if (snappedHops === 0 || out.length < 4) return null
  return new Float32Array(out)
}

/** Routed (or soft-bridged) fill between two anchors, time-gated; null = no believable fill. */
function directFill(g: RailGraph, from: number, to: number, dtMs: number): number[] | null {
  const a = g.pos.get(from)!
  const b = g.pos.get(to)!
  const straight = Math.hypot(a.x - b.x, a.y - b.y)
  const route = dijkstra(g, from, to, GAP_FACTOR * straight + GAP_SLACK_DEG)
  if (route) {
    return timePlausible(routeLengthDeg(g, route), dtMs, RAIL_MIN_PROGRESS_MPS) ? route : null
  }
  // Parallel-track ping-pong: bridge the few meters straight.
  return straight <= SOFT_BRIDGE_DEG ? [from, to] : null
}

/**
 * Most-likely route through mid-gap scatter. Tunnel fixes are wild but still
 * trace the rider's progress: re-anchor them with a generous radius (sticky
 * to the running track component) and route leg by leg. Accepted only when
 * the total length is believable for the elapsed time in both directions —
 * long enough to explain it, short enough to be physically possible — which
 * recovers an out-and-back through downtown instead of a shortcut across it.
 * Needs timestamps: without time evidence there is no "most likely".
 */
function rescueRoute(
  g: RailGraph,
  coords: Float32Array,
  pending: readonly number[],
  from: number,
  to: number,
  dtMs: number
): number[] | null {
  if (!Number.isFinite(dtMs)) return null
  const seq: number[] = [from]
  let comp = g.comp.get(from) ?? -1
  for (const i of pending) {
    const a = nearestAnchor(
      g, coords[i * 2]! * g.refCos, coords[i * 2 + 1]!, comp, RESCUE_ANCHOR_SCALE
    )
    if (a === null || a === seq[seq.length - 1]) continue
    seq.push(a)
    comp = g.comp.get(a) ?? comp
  }
  if (seq[seq.length - 1] !== to) seq.push(to)
  if (seq.length < 2) return null

  const path: number[] = [from]
  let lenDeg = 0
  for (let k = 1; k < seq.length; k++) {
    const u = seq[k - 1]!
    const v = seq[k]!
    const a = g.pos.get(u)!
    const b = g.pos.get(v)!
    const straight = Math.hypot(a.x - b.x, a.y - b.y)
    const route = dijkstra(g, u, v, GAP_FACTOR * straight + GAP_SLACK_DEG)
    if (route) {
      for (let j = 1; j < route.length; j++) path.push(route[j]!)
      lenDeg += routeLengthDeg(g, route)
    } else if (straight <= SOFT_BRIDGE_DEG) {
      path.push(v)
      lenDeg += straight
    } else {
      return null
    }
  }
  if (!timePlausible(lenDeg, dtMs, RAIL_MIN_PROGRESS_MPS)) return null
  if (lenDeg * M_PER_DEG > (dtMs / 1000) * RAIL_MAX_PROGRESS_MPS) return null
  return path
}

/**
 * Bridge long GPS gaps in a road trip through mapped road tunnels. Unlike
 * rail matching, every raw point is kept verbatim — the only change is that a
 * tunnel-shaped gap (long absolutely, and large relative to the trip's median
 * point spacing) whose two sides both anchor near tunnel geometry gets the
 * routed tunnel path spliced in between them. The gap need not be at the
 * trip's start/end — any anomalous jump between two near-tunnel fixes
 * qualifies. Gaps that don't anchor or won't route sanely stay as they were.
 * Returns null when nothing was bridged (caller keeps the original row).
 */
export function bridgeRoadGaps(
  coords: Float32Array,
  g: RailGraph,
  isCovered: CoverageTest = FULL_COVERAGE,
  timesMs?: ArrayLike<number> | null
): Float32Array | null {
  if (g.empty) return null
  const n = coords.length / 2
  if (n < 2) return null

  // A gap counts as a tunnel candidate only if it's an outlier for this trip.
  const gaps = new Float64Array(n - 1)
  for (let i = 0; i < n - 1; i++) {
    gaps[i] = Math.hypot(
      (coords[i * 2 + 2]! - coords[i * 2]!) * g.refCos,
      coords[i * 2 + 3]! - coords[i * 2 + 1]!
    )
  }
  const threshold = Math.max(
    ROAD_GAP_FLOOR_DEG,
    gaps.length >= ROAD_GAP_MIN_SAMPLES ? ROAD_GAP_REL_FACTOR * median(gaps) : 0
  )

  const out: number[] = []
  const pushLonLat = (lon: number, lat: number): void => {
    const m = out.length
    if (m >= 2 && out[m - 2] === lon && out[m - 1] === lat) return
    out.push(lon, lat)
  }

  // Tunnel route between the fixes at vertex `a` and vertex `b`, or null.
  const tryBridge = (vi: number, vj: number): number[] | null => {
    const lon1 = coords[vi * 2]!
    const lat1 = coords[vi * 2 + 1]!
    const lon2 = coords[vj * 2]!
    const lat2 = coords[vj * 2 + 1]!
    if (!isCovered(lon1, lat1) || !isCovered(lon2, lat2)) return null
    const a = nearestAnchor(g, lon1 * g.refCos, lat1)
    const b = nearestAnchor(g, lon2 * g.refCos, lat2)
    if (a === null || b === null || a === b) return null
    const pa = g.pos.get(a)!
    const pb = g.pos.get(b)!
    const straight = Math.hypot(pa.x - pb.x, pa.y - pb.y)
    const route = dijkstra(g, a, b, GAP_FACTOR * straight + GAP_SLACK_DEG)
    if (!route || route.length < 2) return null
    // Same wormhole guard as rail: if the driver had far more time than the
    // tunnel explains (parked downtown and came back), don't bridge.
    const dtMs = timesMs ? Number(timesMs[vj]) - Number(timesMs[vi]) : NaN
    if (!timePlausible(routeLengthDeg(g, route), dtMs, ROAD_MIN_PROGRESS_MPS)) return null
    return route
  }
  const pushRoute = (route: number[]): void => {
    for (const id of route) {
      const p = g.pos.get(id)!
      pushLonLat(p.lon, p.lat)
    }
  }

  let bridged = 0
  let i = 0
  while (i < n) {
    pushLonLat(coords[i * 2]!, coords[i * 2 + 1]!)
    if (i + 1 >= n) break
    if (gaps[i]! < threshold) {
      i++
      continue
    }
    // A dropout window: consecutive anomalous gaps. The fixes inside it are
    // tunnel scatter, not travel — if one bridge spans the whole window,
    // splice the tunnel and reject the scatter instead of drawing its fan.
    let wEnd = i + 1
    while (wEnd < n - 1 && gaps[wEnd]! >= threshold) wEnd++
    const whole = tryBridge(i, wEnd)
    if (whole) {
      pushRoute(whole)
      bridged++
      i = wEnd
      continue
    }
    if (wEnd === i + 1) {
      i++
      continue // single un-bridgeable gap: nothing more to try
    }
    // Window didn't bridge as one (e.g. two separate tunnels with a real fix
    // between): keep the interior fixes and bridge each gap individually.
    for (let k = i; k < wEnd; k++) {
      if (k > i) pushLonLat(coords[k * 2]!, coords[k * 2 + 1]!)
      const single = tryBridge(k, k + 1)
      if (single) {
        pushRoute(single)
        bridged++
      }
    }
    i = wEnd
  }
  if (bridged === 0) return null
  return new Float32Array(out)
}

/** Median of a numeric array (non-mutating; the trip's typical point spacing). */
function median(values: ArrayLike<number>): number {
  if (values.length === 0) return 0
  const sorted = Array.from(values).sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** A fill is a lie if the rider had far more time than the path explains. */
function timePlausible(lenDeg: number, dtMs: number, minMps: number): boolean {
  if (!Number.isFinite(dtMs) || dtMs <= TIME_GATE_MIN_DT_MS) return true
  return lenDeg * M_PER_DEG >= (dtMs / 1000) * minMps
}

/** Geometric length of a node path (graph weights include transfer penalties). */
function routeLengthDeg(g: RailGraph, route: number[]): number {
  let len = 0
  for (let j = 1; j < route.length; j++) {
    const p = g.pos.get(route[j - 1]!)!
    const q = g.pos.get(route[j]!)!
    len += Math.hypot(p.x - q.x, p.y - q.y)
  }
  return len
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
