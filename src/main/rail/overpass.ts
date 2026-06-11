/**
 * One-time fetch of OSM rail geometry for a bounding box, via Overpass.
 *
 * Local-first: this is the only place the app reaches the network, and only
 * when the user explicitly asks to fetch a rail network for their data's
 * extent. The result is stored locally (see db/railStore) and every later
 * snap runs offline. The JSON parser is pure so it's tested without network.
 */
import type { RailNodeInput, RailEdgeInput } from './snapRail'

export interface BBox {
  minLat: number
  minLon: number
  maxLat: number
  maxLon: number
}

export interface ParsedRail {
  nodes: RailNodeInput[]
  edges: RailEdgeInput[]
}

/** Rail kinds we match against; excludes sidings/yards/abandoned by default. */
const RAILWAY_TYPES = ['subway', 'tram', 'light_rail', 'rail', 'narrow_gauge', 'monorail']

const DEFAULT_ENDPOINT = 'https://overpass-api.de/api/interpreter'

export function buildOverpassQuery(bbox: BBox): string {
  const b = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`
  const filter = RAILWAY_TYPES.join('|')
  // Ways + recursed-down nodes; service tracks (yards/sidings) excluded.
  return [
    '[out:json][timeout:180];',
    '(',
    `  way["railway"~"^(${filter})$"]["service"!~"."](${b});`,
    ');',
    '(._;>;);',
    'out qt;'
  ].join('\n')
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
export function parseOverpassJson(json: unknown): ParsedRail {
  const elements = (json as { elements?: OverpassElement[] })?.elements
  if (!Array.isArray(elements)) return { nodes: [], edges: [] }

  const nodeCoords = new Map<number, { lat: number; lon: number }>()
  for (const el of elements) {
    if (el.type === 'node' && typeof el.lat === 'number' && typeof el.lon === 'number') {
      nodeCoords.set(el.id, { lat: el.lat, lon: el.lon })
    }
  }

  const edges: RailEdgeInput[] = []
  const usedNodes = new Set<number>()
  for (const el of elements) {
    if (el.type !== 'way' || !Array.isArray(el.nodes)) continue
    for (let i = 1; i < el.nodes.length; i++) {
      const a = el.nodes[i - 1]!
      const b = el.nodes[i]!
      if (a === b || !nodeCoords.has(a) || !nodeCoords.has(b)) continue
      edges.push({ a, b })
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
 * Fetch + parse a rail network for the bbox. Network-only; callers handle the
 * stored result. Throws on network/HTTP failure so the UI can surface it.
 */
export async function fetchRailNetwork(
  bbox: BBox,
  endpoint: string = DEFAULT_ENDPOINT
): Promise<ParsedRail> {
  const body = 'data=' + encodeURIComponent(buildOverpassQuery(bbox))
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`)
  return parseOverpassJson(await res.json())
}
