/**
 * One-time fetch of OSM rail geometry for a bounding box, via Overpass.
 *
 * Local-first: this is the only place the app reaches the network, and only
 * when the user explicitly asks to fetch a rail network for their data's
 * extent. The result is stored locally (see db/railStore) and every later
 * snap runs offline. The JSON parser is pure so it's tested without network.
 */
import { railKindCode, RAIL_KIND, type RailNodeInput, type RailEdgeInput } from './snapRail'
import { roadClassKind, BUS_KIND, DRIVE_HIGHWAY_TYPES } from './roadRoute'
import type { OsmLayer } from '../../shared/types'

export interface BBox {
  minLat: number
  minLon: number
  maxLat: number
  maxLon: number
}

/** A track segment plus its OSM `railway` kind code (see RAIL_KIND). */
export type ParsedRailEdge = RailEdgeInput & { kind: number }

export interface ParsedRail {
  nodes: RailNodeInput[]
  edges: ParsedRailEdge[]
}

/** Rail kinds we match against; excludes sidings/yards/abandoned by default. */
const RAILWAY_TYPES = ['subway', 'tram', 'light_rail', 'rail', 'narrow_gauge', 'monorail']

/**
 * Road classes whose tunnels we fetch (for bridging car GPS gaps). Tunnels
 * only — the full road network would dwarf the rail data and is never
 * matched against. service/parking ways are deliberately absent.
 */
const ROAD_TYPES = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'
]

/**
 * Public Overpass instances, tried in order. The primary is busy — under
 * load its dispatcher rejects jobs with HTTP 504 ("Dispatcher_Client …
 * timeout") — so server-side failures fall through to mirrors.
 */
const DEFAULT_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
]

// OSM operations policy requires an identifying User-Agent; Node's fetch
// sends none by default and overpass-api.de rejects that with HTTP 406.
const USER_AGENT = 'arc-visualizer/0.1.0 (+https://github.com/hutima/arc_app_visualizer)'

/** Worth trying another mirror: rate limit or server-side failure. */
const isRetryable = (status: number): boolean => status === 429 || status >= 500

/**
 * One layer at a time: `rail` fetches transit track, `road` fetches highway
 * tunnels only (never the full road network — those just bridge car GPS gaps).
 * Splitting keeps each fetch small and lets the user load them independently.
 */
export function buildOverpassQuery(bbox: BBox, layer: OsmLayer): string {
  const b = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`
  const selector =
    layer === 'road'
      ? `  way["highway"~"^(${ROAD_TYPES.join('|')})$"]["tunnel"]["tunnel"!="no"](${b});`
      : `  way["railway"~"^(${RAILWAY_TYPES.join('|')})$"]["service"!~"."](${b});`
  // Ways + recursed-down nodes.
  return ['[out:json][timeout:180];', '(', selector, ');', '(._;>;);', 'out qt;'].join('\n')
}

/**
 * The drivable road network for routing (the manual reroute tool). The full
 * road network, not just tunnels — so it's fetched separately and only on
 * demand. service ways are excluded (see roadRoute) to keep the graph routable.
 * Also pulls bus-only ways (dedicated busways/guideways and roads where buses
 * are allowed but general traffic is not), tagged BUS_KIND so they're used only
 * when rerouting a bus. Tunnels are included implicitly (no tunnel filter).
 */
export function buildDriveQuery(bbox: BBox): string {
  const b = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`
  const selectors = [
    `  way["highway"~"^(${DRIVE_HIGHWAY_TYPES.join('|')})$"](${b});`,
    `  way["highway"~"^(busway|bus_guideway)$"](${b});`,
    `  way["highway"]["psv"~"^(yes|designated)$"](${b});`,
    `  way["highway"]["bus"~"^(yes|designated)$"](${b});`
  ]
  return ['[out:json][timeout:180];', '(', ...selectors, ');', '(._;>;);', 'out qt;'].join('\n')
}

/**
 * Resolve a way's stored kind from its tags. Rail ways carry their railway
 * kind; the rail/road layers tag highway ways (tunnels, by query construction)
 * as road_tunnel so they can never enter a rail graph.
 */
export type WayKind = (tags: Record<string, string>) => number

const railWayKind: WayKind = (tags) =>
  tags.railway ? railKindCode(tags.railway) : tags.highway ? RAIL_KIND.road_tunnel : RAIL_KIND.unknown

/**
 * Drive layer: a known drivable highway class carries its road-class code; any
 * other highway way reached us via a bus selector (busway/guideway, or a road
 * with bus/psv access), so it's BUS_KIND — usable only when rerouting a bus.
 */
const driveWayKind: WayKind = (tags) => {
  const cls = roadClassKind(tags.highway)
  return cls !== 0 ? cls : BUS_KIND
}

interface OverpassElement {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  nodes?: number[]
  tags?: Record<string, string>
}

/**
 * Parse Overpass JSON into nodes and per-segment edges. A way of k nodes
 * becomes k-1 edges so routing follows the real polyline; only nodes
 * referenced by a kept way are emitted.
 */
export function parseOverpassJson(json: unknown, wayKind: WayKind = railWayKind): ParsedRail {
  const elements = (json as { elements?: OverpassElement[] })?.elements
  if (!Array.isArray(elements)) return { nodes: [], edges: [] }

  const nodeCoords = new Map<number, { lat: number; lon: number }>()
  for (const el of elements) {
    if (el.type === 'node' && typeof el.lat === 'number' && typeof el.lon === 'number') {
      nodeCoords.set(el.id, { lat: el.lat, lon: el.lon })
    }
  }

  const edges: ParsedRailEdge[] = []
  const usedNodes = new Set<number>()
  for (const el of elements) {
    if (el.type !== 'way' || !Array.isArray(el.nodes)) continue
    const kind = wayKind(el.tags ?? {})
    for (let i = 1; i < el.nodes.length; i++) {
      const a = el.nodes[i - 1]!
      const b = el.nodes[i]!
      if (a === b || !nodeCoords.has(a) || !nodeCoords.has(b)) continue
      edges.push({ a, b, kind })
      usedNodes.add(a)
      usedNodes.add(b)
    }
  }

  const nodes: RailNodeInput[] = []
  for (const id of usedNodes) {
    const c = nodeCoords.get(id)!
    nodes.push({ id, lat: c.lat, lon: c.lon })
  }
  return { nodes, edges }
}

/**
 * Fetch + parse a rail network for the bbox, falling back across mirrors on
 * rate limits, 5xx, and network failures (a bad request fails immediately).
 * Network-only; callers handle the stored result. Throws the last failure so
 * the UI can surface it.
 */
export async function fetchRailNetwork(
  bbox: BBox,
  layer: OsmLayer,
  endpoints: readonly string[] = DEFAULT_ENDPOINTS
): Promise<ParsedRail> {
  return fetchOverpass(buildOverpassQuery(bbox, layer), railWayKind, endpoints)
}

/**
 * Fetch + parse the drivable road network for the bbox (the reroute tool).
 * Same mirror-fallback behavior as the rail fetch; highway ways are tagged with
 * their road class so routing can prefer arterials.
 */
export async function fetchDriveNetwork(
  bbox: BBox,
  endpoints: readonly string[] = DEFAULT_ENDPOINTS
): Promise<ParsedRail> {
  return fetchOverpass(buildDriveQuery(bbox), driveWayKind, endpoints)
}

/** Shared fetch core: POST the query, fall back across mirrors, parse on success. */
async function fetchOverpass(
  query: string,
  wayKind: WayKind,
  endpoints: readonly string[]
): Promise<ParsedRail> {
  const body = 'data=' + encodeURIComponent(query)
  let lastError: Error | null = null
  for (const endpoint of endpoints) {
    const host = new URL(endpoint).host
    let res: Response
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': USER_AGENT
        },
        body
      })
    } catch (err) {
      lastError = new Error(`${host}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    if (res.ok) return parseOverpassJson(await res.json(), wayKind)
    const detail = (await res.text().catch(() => '')).replace(/<[^>]+>/g, ' ').trim()
    const error = new Error(
      `Overpass HTTP ${res.status} (${host})${detail ? `: ${detail.slice(0, 200)}` : ''}`
    )
    if (!isRetryable(res.status)) throw error
    lastError = error
  }
  throw lastError ?? new Error('no Overpass endpoint configured')
}
