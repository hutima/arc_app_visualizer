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
import { buildRailGraph, routeWaypoints, type RailGraph, type RailNodeInput, type RailEdgeInput } from './snapRail'
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
  8: 1.6 // living_street
}

/** Map an OSM highway tag to its road-class code (0 = unknown/any drivable). */
export function roadClassKind(highwayTag: string | undefined): number {
  if (!highwayTag) return 0
  return ROAD_CLASS[highwayTag] ?? 0
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
 * Compute the road route through `waypoints` in order, biased toward the
 * (optional) original-track `guide`, with a road-class `emphasis` (≥1, higher
 * = prefer highways harder). Returns the snapped polyline (interleaved lon,lat)
 * or an error to surface.
 */
export function computeRoadRoute(
  nodes: RailNodeInput[],
  edges: ReadonlyArray<RailEdgeInput & { kind?: number }>,
  waypoints: ReadonlyArray<{ lon: number; lat: number }>,
  guide: ReadonlyArray<GuidePoint> = [],
  emphasis = 1
): { coords: Float32Array } | { error: string } {
  const graph =
    guide.length >= 2
      ? buildGuidedDriveGraph(nodes, edges, guide, emphasis)
      : buildDriveGraph(nodes, edges, emphasis)
  return routeWaypoints(graph, waypoints, guideLengthDeg(guide))
}
