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

/** Anchoring is forgiving so deliberately-placed pins reach a nearby road. */
export const DRIVE_TUNING: RailTuning = { snapRadiusM: 200, transferRadiusM: 0 }

/** Build the routable road graph: real geometry for anchoring, class-weighted for routing. */
export function buildDriveGraph(
  nodes: RailNodeInput[],
  edges: ReadonlyArray<RailEdgeInput & { kind?: number }>,
  tuning: RailTuning = DRIVE_TUNING
): RailGraph {
  return buildRailGraph(nodes, edges as RailEdgeInput[], tuning, (e, dist) => dist * penaltyForKind(e.kind))
}

/**
 * Compute the arterial-preferring road route through `waypoints` in order.
 * Returns the snapped polyline (interleaved lon,lat) or an error to surface.
 */
export function computeRoadRoute(
  nodes: RailNodeInput[],
  edges: ReadonlyArray<RailEdgeInput & { kind?: number }>,
  waypoints: ReadonlyArray<{ lon: number; lat: number }>
): { coords: Float32Array } | { error: string } {
  return routeWaypoints(buildDriveGraph(nodes, edges), waypoints)
}
