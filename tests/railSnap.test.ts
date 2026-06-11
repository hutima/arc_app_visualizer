/**
 * OSM rail snapping: Overpass parsing (pure, no network) and the offline
 * map-matcher that snaps rail rides onto the network and routes through
 * tunnel gaps.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildOverpassQuery, parseOverpassJson, fetchRailNetwork } from '../src/main/rail/overpass'
import {
  buildRailGraph,
  snapRideToRail,
  snapRailTracks,
  type RailNodeInput,
  type RailEdgeInput
} from '../src/main/rail/snapRail'
import type { ViewportSegmentRow } from '../src/main/db/queries'

const f32row = (type: string, lonLat: number[], id = 1): ViewportSegmentRow => ({
  id,
  type,
  start_ts_ms: null,
  point_count: lonLat.length / 2,
  coords: new Uint8Array(new Float32Array(lonLat).buffer)
})

const coordsOf = (a: Float32Array | ViewportSegmentRow): number[] =>
  a instanceof Float32Array
    ? [...a]
    : [...new Float32Array(a.coords.buffer.slice(a.coords.byteOffset, a.coords.byteOffset + a.coords.byteLength))]

describe('overpass parsing', () => {
  it('builds a bbox query filtered to rail, excluding service tracks', () => {
    const q = buildOverpassQuery({ minLat: 1, minLon: 2, maxLat: 3, maxLon: 4 })
    expect(q).toContain('1,2,3,4')
    expect(q).toContain('subway|tram|light_rail|rail|narrow_gauge|monorail')
    expect(q).toContain('"service"!~"."')
  })

  it('splits ways into per-segment edges and keeps only referenced nodes', () => {
    const json = {
      elements: [
        { type: 'node', id: 10, lat: 0, lon: 0 },
        { type: 'node', id: 11, lat: 0, lon: 0.01 },
        { type: 'node', id: 12, lat: 0, lon: 0.02 },
        { type: 'node', id: 99, lat: 5, lon: 5 }, // unreferenced → dropped
        { type: 'way', id: 100, nodes: [10, 11, 12], tags: { railway: 'subway' } }
      ]
    }
    const { nodes, edges } = parseOverpassJson(json)
    expect(edges).toEqual([
      { a: 10, b: 11 },
      { a: 11, b: 12 }
    ])
    expect(nodes.map((n) => n.id).sort((x, y) => x - y)).toEqual([10, 11, 12])
  })

  it('tolerates ways referencing missing nodes', () => {
    const json = {
      elements: [
        { type: 'node', id: 1, lat: 0, lon: 0 },
        { type: 'way', id: 2, nodes: [1, 404] } // 404 absent
      ]
    }
    expect(parseOverpassJson(json).edges).toEqual([])
  })

  it('returns empty for malformed input', () => {
    expect(parseOverpassJson(null)).toEqual({ nodes: [], edges: [] })
    expect(parseOverpassJson({})).toEqual({ nodes: [], edges: [] })
  })

  const BOX = { minLat: 1, minLon: 2, maxLat: 3, maxLon: 4 }
  const MIRRORS = ['https://a.example/api/interpreter', 'https://b.example/api/interpreter']

  it('sends an identifying User-Agent (Overpass 406s anonymous requests)', async () => {
    const mock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ elements: [] }), { status: 200 })
    )
    vi.stubGlobal('fetch', mock)
    try {
      await fetchRailNetwork(BOX)
      const headers = mock.mock.calls[0]![1].headers as Record<string, string>
      expect(headers['User-Agent']).toMatch(/arc-visualizer/)
      expect(headers.Accept).toBe('application/json')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('falls back to a mirror when the primary 504s (busy dispatcher)', async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(new Response('Dispatcher_Client::request_read_and_idx::timeout', { status: 504 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ elements: [] }), { status: 200 }))
    vi.stubGlobal('fetch', mock)
    try {
      await expect(fetchRailNetwork(BOX, MIRRORS)).resolves.toEqual({ nodes: [], edges: [] })
      expect(mock).toHaveBeenCalledTimes(2)
      expect(mock.mock.calls[1]![0]).toBe(MIRRORS[1])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('surfaces the last failure (with host) when every mirror is down', async () => {
    const mock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response('<html><body>Too Many Requests</body></html>', { status: 429 }))
    )
    vi.stubGlobal('fetch', mock)
    try {
      await expect(fetchRailNetwork(BOX, MIRRORS)).rejects.toThrow(
        /Overpass HTTP 429 \(b\.example\): Too Many Requests/
      )
      expect(mock).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not retry a bad request (our bug, not server load)', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('parse error', { status: 400 }))
    vi.stubGlobal('fetch', mock)
    try {
      await expect(fetchRailNetwork(BOX, MIRRORS)).rejects.toThrow(/Overpass HTTP 400/)
      expect(mock).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('falls through to a mirror on a network-level failure', async () => {
    const mock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ elements: [] }), { status: 200 }))
    vi.stubGlobal('fetch', mock)
    try {
      await expect(fetchRailNetwork(BOX, MIRRORS)).resolves.toEqual({ nodes: [], edges: [] })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

/** A straight subway line along lat 0, lon 0..0.1, a node every 0.01 (ids 1..11). */
const LINE_NODES: RailNodeInput[] = Array.from({ length: 11 }, (_, i) => ({
  id: i + 1,
  lat: 0,
  lon: i * 0.01
}))
const LINE_EDGES: RailEdgeInput[] = Array.from({ length: 10 }, (_, i) => ({ a: i + 1, b: i + 2 }))

describe('snapRideToRail', () => {
  const graph = buildRailGraph(LINE_NODES, LINE_EDGES)

  it('routes through a tunnel gap: two jittered fixes become the full alignment', () => {
    // Only the endpoints are "seen"; the middle is a tunnel with no GPS.
    const ride = new Float32Array([0, 0.0003, 0.1, -0.0003])
    const snapped = snapRideToRail(ride, graph)!
    expect(snapped).not.toBeNull()
    const c = coordsOf(snapped)
    // Output rides the real rail: every point on lat 0, spanning the line.
    for (let i = 1; i < c.length; i += 2) expect(c[i]).toBe(0)
    expect(c[0]).toBe(0)
    expect(c[c.length - 2]).toBeCloseTo(0.1, 6) // float32 rail coord
    expect(c.length / 2).toBe(11) // tunnel bridged with the intermediate nodes
  })

  it('pulls a noisy ride onto the rail geometry', () => {
    const jitter = [0, 0.0004, 0.03, -0.0005, 0.06, 0.0004, 0.1, -0.0003]
    const c = coordsOf(snapRideToRail(new Float32Array(jitter), graph)!)
    for (let i = 1; i < c.length; i += 2) expect(Math.abs(c[i]!)).toBeLessThan(1e-9)
  })

  it('leaves a ride far from any rail unmatched (null)', () => {
    expect(snapRideToRail(new Float32Array([5, 5, 5.1, 5]), graph)).toBeNull()
  })

  it('refuses a hop that will not route (disconnected lines)', () => {
    // Second line is far away and unconnected; a ride touching both can't route.
    const farNodes = [...LINE_NODES, { id: 50, lat: 1, lon: 1 }, { id: 51, lat: 1, lon: 1.01 }]
    const farEdges = [...LINE_EDGES, { a: 50, b: 51 }]
    const g = buildRailGraph(farNodes, farEdges)
    const ride = new Float32Array([0, 0, 1, 1]) // one end per line
    expect(snapRideToRail(ride, g)).toBeNull()
  })

  it('returns null on an empty network', () => {
    expect(snapRideToRail(new Float32Array([0, 0, 0.1, 0]), buildRailGraph([], []))).toBeNull()
  })

  it('snaps only the covered portion; an off-coverage tail keeps raw GPS', () => {
    // Rail is fetched per-viewport, so a ride can run off the fetched area.
    const ride = new Float32Array([
      0, 0.0003, 0.02, -0.0004, 0.04, 0.0003, // inside coverage (lon ≤ 0.05)
      0.06, 0.0005, 0.08, -0.0005, 0.1, 0.0004 // outside → must stay raw
    ])
    const isCovered = (lon: number): boolean => lon <= 0.05
    const c = coordsOf(snapRideToRail(ride, graph, isCovered)!)
    // Covered prefix rides the rail: routed nodes 1..5, all exactly on lat 0.
    expect(c.length / 2).toBe(5 + 3)
    for (let i = 1; i < 10; i += 2) expect(c[i]).toBe(0)
    // The tail is byte-identical raw GPS — never truncated or force-matched.
    expect(c.slice(10)).toEqual([...ride.slice(6)])
  })

  it('returns null when the whole ride is outside coverage', () => {
    const ride = new Float32Array([0, 0.0003, 0.05, -0.0003, 0.1, 0.0004])
    expect(snapRideToRail(ride, graph, () => false)).toBeNull()
  })
})

describe('snapRailTracks', () => {
  const graph = buildRailGraph(LINE_NODES, LINE_EDGES)

  it('snaps rail rows and passes non-rail through untouched', () => {
    const metro = f32row('metro', [0, 0.0002, 0.1, -0.0002], 1)
    const walk = f32row('walking', [0, 0.0002, 0.1, -0.0002], 2)
    const { rows, snapped } = snapRailTracks([metro, walk], graph)
    expect(snapped).toBe(1)
    const outWalk = rows.find((r) => r.id === 2)!
    expect(coordsOf(outWalk)).toEqual(coordsOf(walk)) // byte-identical passthrough
    const outMetro = rows.find((r) => r.id === 1)!
    expect(outMetro.point_count).toBe(11) // snapped to the full line
    expect(outMetro.type).toBe('metro')
  })

  it('keeps an unmatchable rail ride as-is', () => {
    const metro = f32row('metro', [5, 5, 5.1, 5], 7)
    const { rows, snapped } = snapRailTracks([metro], graph)
    expect(snapped).toBe(0)
    expect(coordsOf(rows[0]!)).toEqual(coordsOf(metro))
  })
})
