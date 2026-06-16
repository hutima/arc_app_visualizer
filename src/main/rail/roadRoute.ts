/**
 * Drivable road routing for the manual "snap to road route" edit tool.
 *
 * Unlike rail/road-tunnel snapping (automatic, cached, all rides), this is an
 * on-demand, user-reviewed reroute: pick two points on a track, optionally add
 * must-pass via pins, and replace that stretch with the best road route between
 * them. "Best" prefers arterials — the router weights each road by its class so
 * a motorway/primary route wins over an equal-length crawl through residential
 * streets. We reuse the rail graph + Dijkstra; only the edge weighting differs.
 */
import {
  buildRailGraph,
  routeWaypoints,
  matchTrackToRoads,
  type RailGraph,
  type RailNodeInput,
  type RailEdgeInput
} from './snapRail'
import { simplifyIndices } from '../importer/simplify'
import type { RailTuning } from '../../shared/types'

/**
 * OSM `highway=*` classes we fetch + route on, as small per-edge codes. Link
 * ramps share their parent class's code. 0 = unknown (any drivable). service
 * ways are deliberately excluded — driveways/parking aisles add noise without
 * helping through-routes.
 */
export const ROAD_CLASS: Readonly<Record<string, number>> = {
  motorway: 1,
  motorway_link: 1,
  trunk: 2,
  trunk_link: 2,
  primary: 3,
  primary_link: 3,
  secondary: 4,
  secondary_link: 4,
  tertiary: 5,
  tertiary_link: 5,
  unclassified: 6,
  residential: 7,
  living_street: 8
}

/** Highway classes fetched for the routable road network (Overpass selector). */
export const DRIVE_HIGHWAY_TYPES: readonly string[] = Object.keys(ROAD_CLASS)

/**
 * Bus-only ways (dedicated busways/guideways and roads buses may use but cars
 * may not). Stored with this kind and excluded from routing unless the track
 * being rerouted is a bus, so a car never gets snapped onto a bus-only road.
 */
export const BUS_KIND = 20

/**
 * Cost multiplier per road class — the arterial preference. Below 1 makes a
 * road "cheaper" than its length, so the shortest-cost path favors big roads:
 * a slightly longer motorway run beats a shorter residential one, matching how
 * a driver actually goes. Tuned so the ordering motorway < … < living_street
 * holds but no class is so cheap it invents wild detours.
 */
const CLASS_PENALTY: Readonly<Record<number, number>> = {
  1: 0.55, // motorway
  2: 0.6, // trunk
  3: 0.7, // primary
  4: 0.8, // secondary
  5: 0.9, // tertiary
  6: 1.05, // unclassified
  7: 1.1, // residential
  8: 1.6, // living_street
  [BUS_KIND]: 0.85 // bus-only way (mildly preferred for buses)
}

/** Map an OSM highway tag to its road-class code (0 = unknown/any drivable). */
export function roadClassKind(highwayTag: string | undefined): number {
  if (!highwayTag) return 0
  return ROAD_CLASS[highwayTag] ?? 0
}

/**
 * The edges a trip of this type may route on: cars/taxis/etc. exclude bus-only
 * ways; buses keep everything (they drive normal roads too). The graph builder
 * then drops any node left edge-less, so a car can never touch a bus corridor.
 */
export function filterDriveEdges<E extends { kind?: number }>(
  edges: ReadonlyArray<E>,
  includeBus: boolean
): E[] {
  return includeBus ? [...edges] : edges.filter((e) => e.kind !== BUS_KIND)
}

const penaltyForKind = (kind: number | undefined): number =>
  (kind != null ? CLASS_PENALTY[kind] : undefined) ?? 1

const M_PER_DEG = 111320

/**
 * The arterial preference, sharpened for long trips. Raising each class penalty
 * to `emphasis` widens the spread around 1: at emphasis 1 a motorway is ~2×
 * preferred over a residential street, at 3 it's ~8×. Long drives really do
 * funnel onto highways, so a 10 km+ reroute should bias far harder than a
 * cross-town hop. Unknown/neutral roads (penalty 1) are unaffected by any power.
 */
const classCost = (kind: number | undefined, emphasis: number): number =>
  penaltyForKind(kind) ** emphasis

/**
 * Distance → highway emphasis. Flat (1) for short hops, then climbs once a trip
 * is long enough to be worth detouring onto highways: ~1.25 at 10 km, ~2 (≈4×
 * preference) at 16 km, capped at 4 (≈16×) by ~32 km.
 */
export function emphasisForDistanceDeg(distDeg: number): number {
  const km = (distDeg * M_PER_DEG) / 1000
  return Math.min(4, Math.max(1, km / 8))
}

/** Anchoring is forgiving so deliberately-placed pins reach a nearby road. */
export const DRIVE_TUNING: RailTuning = { snapRadiusM: 200, transferRadiusM: 0 }

export interface GuidePoint {
  lon: number
  lat: number
}

/**
 * Loose corridor around the original track. GPS is uncertain, so the route is
 * *biased* toward the track, not pinned to it: a road within ~CORRIDOR_WIDTH of
 * the track pays little, and the penalty grows quadratically beyond — but it's
 * capped (not infinite), so a genuine detour (bridge, one-way pair, a stretch
 * where the nearest road is just far) can still be taken. The width is generous
 * because the intermediate points are used only directionally.
 */
const CORRIDOR_WIDTH_DEG = 0.002 // ~220 m half-width
const CORRIDOR_STRENGTH = 4 // quadratic steepness past the width
const CORRIDOR_MAX = 50 // cost cap, so the corridor guides without forbidding

/** refCos for a small area, from the mean latitude of the points. */
function refCosOf(pts: ReadonlyArray<GuidePoint>): number {
  if (pts.length === 0) return 1
  let s = 0
  for (const p of pts) s += p.lat
  return Math.max(0.1, Math.cos(((s / pts.length) * Math.PI) / 180))
}

/** Simplify + project a guide polyline to (x = lon·refCos, y = lat) arrays. */
function projectGuide(
  guide: ReadonlyArray<GuidePoint>,
  refCos: number
): { xs: Float64Array; ys: Float64Array } {
  const lons = new Float64Array(guide.length)
  const lats = new Float64Array(guide.length)
  for (let i = 0; i < guide.length; i++) {
    lons[i] = guide[i]!.lon
    lats[i] = guide[i]!.lat
  }
  // The corridor shape doesn't need full resolution; thinning it also damps GPS
  // jitter so the bias is directional, not point-chasing.
  const kept =
    guide.length > 2 ? simplifyIndices(lons, lats, CORRIDOR_WIDTH_DEG / 3) : guide.map((_, i) => i)
  const xs = new Float64Array(kept.length)
  const ys = new Float64Array(kept.length)
  for (let i = 0; i < kept.length; i++) {
    xs[i] = lons[kept[i]!]! * refCos
    ys[i] = lats[kept[i]!]!
  }
  return { xs, ys }
}

/** Min distance (deg) from a projected point to a projected polyline. */
function distToPolyline(px: number, py: number, xs: Float64Array, ys: Float64Array): number {
  if (xs.length === 0) return Infinity
  if (xs.length === 1) return Math.hypot(px - xs[0]!, py - ys[0]!)
  let best = Infinity
  for (let i = 0; i < xs.length - 1; i++) {
    const ax = xs[i]!
    const ay = ys[i]!
    const dx = xs[i + 1]! - ax
    const dy = ys[i + 1]! - ay
    const len2 = dx * dx + dy * dy
    let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
    if (d < best) best = d
  }
  return best
}

/** Simplify a routed polyline (interleaved lon,lat) so a draft stays light (~1 m). */
export function simplifyRoutePolyline(coords: Float32Array): number[] {
  const n = coords.length / 2
  if (n < 2) return Array.from(coords)
  const lons = new Float64Array(n)
  const lats = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    lons[i] = coords[i * 2]!
    lats[i] = coords[i * 2 + 1]!
  }
  const kept = simplifyIndices(lons, lats, 1e-5)
  const out: number[] = []
  for (const k of kept) out.push(lons[k]!, lats[k]!)
  return out
}

/** Total length (deg) of a guide polyline, for the routing budget. */
export function guideLengthDeg(guide: ReadonlyArray<GuidePoint>): number {
  if (guide.length < 2) return 0
  const refCos = refCosOf(guide)
  let len = 0
  for (let i = 1; i < guide.length; i++) {
    len += Math.hypot(
      (guide[i]!.lon - guide[i - 1]!.lon) * refCos,
      guide[i]!.lat - guide[i - 1]!.lat
    )
  }
  return len
}

/** Build the routable road graph: real geometry for anchoring, class-weighted for routing. */
export function buildDriveGraph(
  nodes: RailNodeInput[],
  edges: ReadonlyArray<RailEdgeInput & { kind?: number }>,
  emphasis = 1,
  tuning: RailTuning = DRIVE_TUNING
): RailGraph {
  return buildRailGraph(nodes, edges as RailEdgeInput[], tuning, (e, dist) => dist * classCost(e.kind, emphasis))
}

/**
 * Build the drive graph with a loose corridor bias toward the original track:
 * each road's cost is multiplied by how far its midpoint sits from the track
 * polyline, so the route follows where the user actually went (using the noisy
 * intermediate points only directionally — never forced through any of them)
 * while still preferring arterials among the roads in the corridor. Far-off
 * roads are expensive but not forbidden. Falls back to the plain class-weighted
 * graph when there's no usable guide.
 */
export function buildGuidedDriveGraph(
  nodes: RailNodeInput[],
  edges: ReadonlyArray<RailEdgeInput & { kind?: number }>,
  guide: ReadonlyArray<GuidePoint>,
  emphasis = 1,
  tuning: RailTuning = DRIVE_TUNING
): RailGraph {
  if (guide.length < 2) return buildDriveGraph(nodes, edges, emphasis, tuning)
  const refCos = refCosOf(guide)
  const { xs, ys } = projectGuide(guide, refCos)
  const coordById = new Map(nodes.map((n) => [n.id, n]))
  // Precompute a corridor factor per edge (keyed by the edge object buildRailGraph
  // will pass straight back into edgeCost), so the distance work happens once.
  const factor = new Map<RailEdgeInput, number>()
  for (const e of edges) {
    const a = coordById.get(e.a)
    const b = coordById.get(e.b)
    if (!a || !b) continue
    const mx = ((a.lon + b.lon) / 2) * refCos
    const my = (a.lat + b.lat) / 2
    const r = distToPolyline(mx, my, xs, ys) / CORRIDOR_WIDTH_DEG
    factor.set(e, Math.min(CORRIDOR_MAX, 1 + CORRIDOR_STRENGTH * r * r))
  }
  return buildRailGraph(
    nodes,
    edges as RailEdgeInput[],
    tuning,
    (e, dist) => dist * classCost(e.kind, emphasis) * (factor.get(e) ?? 1)
  )
}

/**
 * Weave the via pins into the track guide at their nearest position along it, so
 * the follow-mode fallback bends toward a dragged pin — a via becomes one more
 * anchor the matched line routes through (the same "must pass here" intent the
 * strict router gives a via). Monotonic: each via is placed at or after the
 * previous one's slot, so out-of-order GPS noise can't make the line double back.
 */
export function weaveVias(
  guide: ReadonlyArray<GuidePoint>,
  vias: ReadonlyArray<GuidePoint>
): GuidePoint[] {
  if (vias.length === 0) return [...guide]
  if (guide.length < 2) return [...guide, ...vias] // no shape to weave into
  const refCos = refCosOf(guide)
  // Insert each via into the guide *segment* it sits closest to (projected onto
  // the segment, not snapped to the nearer endpoint) so a via mid-segment lands
  // between its two vertices instead of jumping ahead of one — which would make
  // the followed line double back. Monotonic in the segment index.
  const slots: Array<{ at: number; via: GuidePoint }> = []
  let fromSeg = 0
  for (const via of vias) {
    const vx = via.lon * refCos
    let bestSeg = fromSeg
    let bestD = Infinity
    for (let s = fromSeg; s < guide.length - 1; s++) {
      const d = distPointToSeg(
        vx, via.lat,
        guide[s]!.lon * refCos, guide[s]!.lat,
        guide[s + 1]!.lon * refCos, guide[s + 1]!.lat
      )
      if (d < bestD) {
        bestD = d
        bestSeg = s
      }
    }
    slots.push({ at: bestSeg + 1, via }) // between guide[bestSeg] and guide[bestSeg+1]
    fromSeg = bestSeg
  }
  const out = [...guide]
  // Splice from the end so earlier insertion indices stay valid.
  for (let i = slots.length - 1; i >= 0; i--) out.splice(slots[i]!.at, 0, slots[i]!.via)
  return out
}

/** Distance from a projected point to a projected segment (clamped to its ends). */
function distPointToSeg(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number
): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/**
 * Route through `waypoints`, preferring a clean arterial path; if none exists
 * (routeWaypoints fails — a bus that didn't take the quickest way, a one-way
 * maze, a tunnel with no GPS, a slightly disconnected fetch), fall back to
 * following the original track shape onto the roads (matchTrackToRoads), with
 * the via pins woven in so drags still steer the result. `followGuide` is the
 * full original track span used only by the fallback's shape; `guideLenDeg`
 * widens the strict router's budget for a winding corridor. `followedTrack`
 * flags that the fallback produced the result, so the UI can tell the user the
 * line tracks their GPS rather than the fastest route.
 */
export function routeOrFollow(
  g: RailGraph,
  waypoints: ReadonlyArray<{ lon: number; lat: number }>,
  followGuide: ReadonlyArray<GuidePoint>,
  guideLenDeg = 0
): { coords: Float32Array; followedTrack?: boolean } | { error: string } {
  const strict = routeWaypoints(g, waypoints, guideLenDeg)
  if ('coords' in strict) return strict
  const base = followGuide.length >= 2 ? followGuide : waypoints
  const followed = matchTrackToRoads(g, weaveVias(base, waypoints.slice(1, -1)))
  if ('coords' in followed) return { coords: followed.coords, followedTrack: true }
  // Both failed: the strict routing error is the more actionable one to surface.
  return strict
}

/**
 * Compute the road route through `waypoints` in order, biased toward the
 * (optional) original-track `guide`, with a road-class `emphasis` (≥1, higher
 * = prefer highways harder). `includeBus` keeps bus-only ways in play (set it
 * for bus trips). Falls back to following the track shape when no clean route
 * exists (see routeOrFollow). Returns the snapped polyline (interleaved
 * lon,lat) or an error.
 */
export function computeRoadRoute(
  nodes: RailNodeInput[],
  edges: ReadonlyArray<RailEdgeInput & { kind?: number }>,
  waypoints: ReadonlyArray<{ lon: number; lat: number }>,
  guide: ReadonlyArray<GuidePoint> = [],
  emphasis = 1,
  includeBus = false
): { coords: Float32Array; followedTrack?: boolean } | { error: string } {
  const usable = filterDriveEdges(edges, includeBus)
  const graph =
    guide.length >= 2
      ? buildGuidedDriveGraph(nodes, usable, guide, emphasis)
      : buildDriveGraph(nodes, usable, emphasis)
  return routeOrFollow(graph, waypoints, guide, guideLengthDeg(guide))
}
