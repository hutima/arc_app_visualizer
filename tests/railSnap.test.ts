/**
 * OSM rail snapping: Overpass parsing (pure, no network) and the offline
 * map-matcher that threads rail rides onto the network, routes through tunnel
 * gaps, and keeps raw GPS where it can't match.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildOverpassQuery, parseOverpassJson, fetchRailNetwork } from '../src/main/rail/overpass'
import {
  ALLOWED_KINDS_BY_TYPE,
  bridgeRoadGaps,
  buildRailGraph,
  matchRideToRail,
  matchTrackToRoads,
  RAIL_KIND,
  ROAD_TUNING,
  type RailNodeInput,
  type RailEdgeInput
} from '../src/main/rail/snapRail'

const coordsOf = (a: Float32Array): number[] => [...a]

describe('overpass parsing', () => {
  it('builds a rail-layer query filtered to rail, excluding service tracks', () => {
    const q = buildOverpassQuery({ minLat: 1, minLon: 2, maxLat: 3, maxLon: 4 }, 'rail')
    expect(q).toContain('1,2,3,4')
    expect(q).toContain('subway|tram|light_rail|rail|narrow_gauge|monorail')
    expect(q).toContain('"service"!~"."')
    expect(q).not.toContain('highway') // rail layer never pulls roads
  })

  it('builds a road-layer query for tunnels only (car gap bridging)', () => {
    const q = buildOverpassQuery({ minLat: 1, minLon: 2, maxLat: 3, maxLon: 4 }, 'road')
    expect(q).toMatch(/way\["highway"~"\^\(motorway\|.*\)\$"\]\["tunnel"\]\["tunnel"!="no"\]/)
    expect(q).not.toContain('railway') // road layer never pulls rail
  })

  it('splits ways into per-segment edges, tagging each with its railway kind', () => {
    const json = {
      elements: [
        { type: 'node', id: 10, lat: 0, lon: 0 },
        { type: 'node', id: 11, lat: 0, lon: 0.01 },
        { type: 'node', id: 12, lat: 0, lon: 0.02 },
        { type: 'node', id: 20, lat: 1, lon: 0 },
        { type: 'node', id: 21, lat: 1, lon: 0.01 },
        { type: 'node', id: 99, lat: 5, lon: 5 }, // unreferenced → dropped
        { type: 'way', id: 100, nodes: [10, 11, 12], tags: { railway: 'subway' } },
        { type: 'way', id: 101, nodes: [20, 21], tags: { railway: 'rail' } }
      ]
    }
    const { nodes, edges } = parseOverpassJson(json)
    expect(edges).toEqual([
      { a: 10, b: 11, kind: RAIL_KIND.subway },
      { a: 11, b: 12, kind: RAIL_KIND.subway },
      { a: 20, b: 21, kind: RAIL_KIND.rail }
    ])
    expect(nodes.map((n) => n.id).sort((x, y) => x - y)).toEqual([10, 11, 12, 20, 21])
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

  it('codes an untagged/unknown railway as kind 0 (wildcard)', () => {
    const json = {
      elements: [
        { type: 'node', id: 1, lat: 0, lon: 0 },
        { type: 'node', id: 2, lat: 0, lon: 0.01 },
        { type: 'way', id: 3, nodes: [1, 2], tags: { railway: 'funicular' } }
      ]
    }
    expect(parseOverpassJson(json).edges[0]!.kind).toBe(RAIL_KIND.unknown)
  })

  it('tags highway ways with the road kind so they stay out of rail graphs', () => {
    const json = {
      elements: [
        { type: 'node', id: 1, lat: 0, lon: 0 },
        { type: 'node', id: 2, lat: 0, lon: 0.01 },
        { type: 'way', id: 3, nodes: [1, 2], tags: { highway: 'motorway', tunnel: 'yes' } }
      ]
    }
    expect(parseOverpassJson(json).edges[0]!.kind).toBe(RAIL_KIND.road_tunnel)
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
      await fetchRailNetwork(BOX, 'rail')
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
      await expect(fetchRailNetwork(BOX, 'rail', MIRRORS)).resolves.toEqual({ nodes: [], edges: [] })
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
      await expect(fetchRailNetwork(BOX, 'rail', MIRRORS)).rejects.toThrow(
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
      await expect(fetchRailNetwork(BOX, 'rail', MIRRORS)).rejects.toThrow(/Overpass HTTP 400/)
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
      await expect(fetchRailNetwork(BOX, 'rail', MIRRORS)).resolves.toEqual({ nodes: [], edges: [] })
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

describe('matchRideToRail', () => {
  const graph = buildRailGraph(LINE_NODES, LINE_EDGES)

  it('routes through a tunnel gap: two jittered fixes become the full alignment', () => {
    // Only the endpoints are "seen"; the middle is a tunnel with no GPS.
    const ride = new Float32Array([0, 0.0003, 0.1, -0.0003])
    const snapped = matchRideToRail(ride, graph)!
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
    const c = coordsOf(matchRideToRail(new Float32Array(jitter), graph)!)
    for (let i = 1; i < c.length; i += 2) expect(Math.abs(c[i]!)).toBeLessThan(1e-9)
  })

  it('leaves a ride far from any rail unmatched (null)', () => {
    expect(matchRideToRail(new Float32Array([5, 5, 5.1, 5]), graph)).toBeNull()
  })

  it('refuses a hop that will not route (disconnected lines)', () => {
    // Second line is far away and unconnected; a ride touching both can't route.
    const farNodes = [...LINE_NODES, { id: 50, lat: 1, lon: 1 }, { id: 51, lat: 1, lon: 1.01 }]
    const farEdges = [...LINE_EDGES, { a: 50, b: 51 }]
    const g = buildRailGraph(farNodes, farEdges)
    const ride = new Float32Array([0, 0, 1, 1]) // one end per line
    expect(matchRideToRail(ride, g)).toBeNull()
  })

  it('returns null on an empty network', () => {
    expect(matchRideToRail(new Float32Array([0, 0, 0.1, 0]), buildRailGraph([], []))).toBeNull()
  })

  it('snaps only the covered portion; an off-coverage tail keeps raw GPS', () => {
    // Rail is fetched per-viewport, so a ride can run off the fetched area.
    const ride = new Float32Array([
      0, 0.0003, 0.02, -0.0004, 0.04, 0.0003, // inside coverage (lon ≤ 0.05)
      0.06, 0.0005, 0.08, -0.0005, 0.1, 0.0004 // outside → must stay raw
    ])
    const isCovered = (lon: number): boolean => lon <= 0.05
    const c = coordsOf(matchRideToRail(ride, graph, isCovered)!)
    // Covered prefix rides the rail: routed nodes 1..5, all exactly on lat 0.
    expect(c.length / 2).toBe(5 + 3)
    for (let i = 1; i < 10; i += 2) expect(c[i]).toBe(0)
    // The tail is byte-identical raw GPS — never truncated or force-matched.
    expect(c.slice(10)).toEqual([...ride.slice(6)])
  })

  it('returns null when the whole ride is outside coverage', () => {
    const ride = new Float32Array([0, 0.0003, 0.05, -0.0003, 0.1, 0.0004])
    expect(matchRideToRail(ride, graph, () => false)).toBeNull()
  })

  it('matches vertices mid-edge on sparse-node straight track', () => {
    // One straight edge 1.1 km long: nodes only at the ends, as OSM maps
    // straight track. Ride vertices sit ~30 m off the rail but hundreds of
    // meters from both nodes — node-distance matching loses these rides.
    const g = buildRailGraph(
      [
        { id: 1, lat: 0, lon: 0 },
        { id: 2, lat: 0, lon: 0.01 }
      ],
      [{ a: 1, b: 2 }]
    )
    const ride = new Float32Array([0.002, 0.0003, 0.008, -0.0003])
    const c = coordsOf(matchRideToRail(ride, g)!)
    expect(c).toEqual([0, 0, expect.closeTo(0.01, 6), 0])
  })

  it('bridges parallel-track ping-pong instead of rejecting the ride', () => {
    // Two unconnected parallel tracks ~11 m apart (one OSM way per direction).
    // Noisy anchors alternate between them; the connecting crossover may be
    // far away, but the straight gap is meters — bridge it, don't give up.
    const nodes: RailNodeInput[] = []
    const edges: RailEdgeInput[] = []
    for (let i = 0; i <= 20; i++) {
      nodes.push({ id: 100 + i, lat: 0, lon: i * 0.001 })
      nodes.push({ id: 200 + i, lat: 0.0001, lon: i * 0.001 })
      if (i > 0) {
        edges.push({ a: 99 + i, b: 100 + i })
        edges.push({ a: 199 + i, b: 200 + i })
      }
    }
    const g = buildRailGraph(nodes, edges)
    // Dense vertices (~55 m apart) hugging track A, every 7th flipping to B.
    const ride: number[] = []
    for (let i = 0; i <= 40; i++) {
      ride.push(i * 0.0005, i % 7 === 3 ? 0.00008 : 0.00002)
    }
    const c = coordsOf(matchRideToRail(new Float32Array(ride), g)!)
    expect(c.length).toBeGreaterThanOrEqual(4)
    // Every output point lies on one of the two tracks — never off-network.
    const lats = new Set([0, Math.fround(0.0001)])
    for (let i = 1; i < c.length; i += 2) expect(lats.has(c[i]!)).toBe(true)
  })
})

describe('matchTrackToRoads (follow-track fallback)', () => {
  const graph = buildRailGraph(LINE_NODES, LINE_EDGES)

  it('snaps a noisy track onto the line, following its shape', () => {
    const jitter = [
      { lon: 0, lat: 0.0004 },
      { lon: 0.03, lat: -0.0005 },
      { lon: 0.06, lat: 0.0004 },
      { lon: 0.1, lat: -0.0003 }
    ]
    const res = matchTrackToRoads(graph, jitter)
    expect('coords' in res).toBe(true)
    if ('coords' in res) {
      const c = coordsOf(res.coords)
      for (let i = 1; i < c.length; i += 2) expect(Math.abs(c[i]!)).toBeLessThan(1e-9)
    }
  })

  it('bridges a GPS dropout (tunnel) with no time gate', () => {
    // Only the two ends are seen; the middle is a tunnel with no fixes. Unlike
    // the rail matcher, follow-mode never time-gates — the user asked to follow.
    const ends = [{ lon: 0, lat: 0.0003 }, { lon: 0.1, lat: -0.0003 }]
    const res = matchTrackToRoads(graph, ends)
    expect('coords' in res).toBe(true)
    if ('coords' in res) {
      const c = coordsOf(res.coords)
      expect(c.length / 2).toBe(11) // filled with the intermediate nodes
      for (let i = 1; i < c.length; i += 2) expect(c[i]).toBe(0)
    }
  })

  it('keeps raw GPS where the track leaves the network (continuous, not dropped)', () => {
    // Runs along the line, detours far off it, then returns — the off-network
    // stretch stays raw so the line is continuous rather than rejected.
    const track = [
      { lon: 0, lat: 0 },
      { lon: 0.02, lat: 0 },
      { lon: 0.05, lat: 5 }, // way off any road
      { lon: 0.08, lat: 0 },
      { lon: 0.1, lat: 0 }
    ]
    const res = matchTrackToRoads(graph, track)
    expect('coords' in res).toBe(true)
    if ('coords' in res) {
      const c = coordsOf(res.coords)
      // The raw detour vertex survives verbatim (kept, not snapped to lat 0).
      expect(c.some((v, i) => i % 2 === 1 && v === 5)).toBe(true)
      // …and on-network stretches did snap (some points sit exactly on lat 0).
      expect(c.some((v, i) => i % 2 === 1 && v === 0)).toBe(true)
    }
  })

  it('errors on an empty network', () => {
    expect('error' in matchTrackToRoads(buildRailGraph([], []), [{ lon: 0, lat: 0 }, { lon: 0.1, lat: 0 }])).toBe(true)
  })

  it('errors when nothing is near a road', () => {
    expect('error' in matchTrackToRoads(graph, [{ lon: 5, lat: 5 }, { lon: 5.1, lat: 5 }])).toBe(true)
  })
})

describe('matchRideToRail — segment-local fallback', () => {
  // Two separate lines: A on lat 0 (lon 0..0.05), B on lat 1 (lon 0..0.05),
  // unconnected. A ride that runs along A, jumps to B, then rides B should
  // snap both on-rail stretches and keep only the un-routable jump raw —
  // not reject the whole ride (the old all-or-nothing behavior).
  const nodes: RailNodeInput[] = []
  const edges: RailEdgeInput[] = []
  for (let i = 0; i <= 5; i++) {
    nodes.push({ id: 10 + i, lat: 0, lon: i * 0.01 })
    nodes.push({ id: 60 + i, lat: 1, lon: i * 0.01 })
    if (i > 0) {
      edges.push({ a: 9 + i, b: 10 + i })
      edges.push({ a: 59 + i, b: 60 + i })
    }
  }
  const graph = buildRailGraph(nodes, edges)

  it('snaps both on-rail stretches and breaks the line at the impossible jump', () => {
    const ride = new Float32Array([
      0, 0.0003, 0.02, -0.0003, 0.04, 0.0003, // along line A
      0.04, 1.0003, 0.02, 0.9997, 0, 1.0003 // along line B (after a big jump)
    ])
    const c = coordsOf(matchRideToRail(ride, graph)!)
    const lats = c.filter((_, k) => k % 2 === 1)
    // Both halves land on a rail (lat 0 or lat 1): ≥5 on A + ≥3 on B.
    const onRail = lats.filter((lat) => lat === 0 || lat === 1)
    expect(onRail.length).toBeGreaterThanOrEqual(8)
    // The cross-line jump can't route: instead of drawing a connection that
    // never happened, the line is split there (NaN break sentinel).
    expect(lats.some((lat) => Number.isNaN(lat))).toBe(true)
  })

  it('returns null when nothing routes (single far point is not a snap)', () => {
    // Touches line A once then leaves — no routed hop, so keep the raw line.
    const ride = new Float32Array([0, 0.0003, 9, 9])
    expect(matchRideToRail(ride, graph)).toBeNull()
  })
})

describe('tuning ranges', () => {
  it('snap radius is user-tunable: a ride ~100 m off matches at 200 m, not at 50 m', () => {
    const nodes = [
      { id: 1, lat: 0, lon: 0 },
      { id: 2, lat: 0, lon: 0.01 }
    ]
    const edges = [{ a: 1, b: 2 }]
    const offset = 9e-4 // ~100 m off the track
    const ride = new Float32Array([0.002, offset, 0.008, offset])

    const wide = buildRailGraph(nodes, edges, { snapRadiusM: 200, transferRadiusM: 60 })
    expect(matchRideToRail(ride, wide)).not.toBeNull()

    const tight = buildRailGraph(nodes, edges, { snapRadiusM: 50, transferRadiusM: 60 })
    expect(matchRideToRail(ride, tight)).toBeNull()
  })

  it('transfer radius 0 disables cross-line routing', () => {
    // Two lines whose ends sit ~30 m apart: with transfers, a ride spanning
    // both routes through the junction; with transferRadiusM 0 it cannot.
    const nodes = [
      { id: 1, lat: 0, lon: 0 },
      { id: 2, lat: 0, lon: 0.01 },
      { id: 3, lat: 0.00028, lon: 0.01 }, // ~30 m from node 2, other line
      { id: 4, lat: 0.00028, lon: 0.02 }
    ]
    const edges = [
      { a: 1, b: 2 },
      { a: 3, b: 4 }
    ]
    const ride = new Float32Array([0, 0.0001, 0.02, 0.00038]) // one end per line

    const linked = buildRailGraph(nodes, edges, { snapRadiusM: 200, transferRadiusM: 60 })
    const c = [...matchRideToRail(ride, linked)!]
    expect(c.length / 2).toBe(4) // routed 1→2→(transfer)→3→4

    const unlinked = buildRailGraph(nodes, edges, { snapRadiusM: 200, transferRadiusM: 0 })
    expect(matchRideToRail(ride, unlinked)).toBeNull() // long hop won't route
  })
})

describe('contiguity (sticky anchoring + transfer penalty)', () => {
  // Two parallel directions of one line, ~11 m apart, joined only by
  // transfers — distinct track components.
  const nodes: RailNodeInput[] = []
  const edges: RailEdgeInput[] = []
  for (let i = 0; i <= 20; i++) {
    nodes.push({ id: 100 + i, lat: 0, lon: i * 0.001 }) // direction A (lat 0)
    nodes.push({ id: 200 + i, lat: 0.0001, lon: i * 0.001 }) // direction B (lat 0.0001)
    if (i > 0) {
      edges.push({ a: 99 + i, b: 100 + i })
      edges.push({ a: 199 + i, b: 200 + i })
    }
  }
  const g = buildRailGraph(nodes, edges, { snapRadiusM: 200, transferRadiusM: 60 })

  it('keeps a noisy ride on one track instead of flipping to the parallel one', () => {
    // Starts clearly on A, then several fixes drift closer to B; sticky
    // anchoring should hold the whole ride on A (every point at lat 0).
    const ride: number[] = []
    for (let i = 0; i <= 20; i++) {
      const driftToB = i > 0 && i % 3 === 1 // closer to B (lat 0.0001); start on A
      ride.push(i * 0.001, driftToB ? 0.00007 : 0.00001)
    }
    const c = coordsOf(matchRideToRail(new Float32Array(ride), g)!)
    for (let i = 1; i < c.length; i += 2) expect(c[i]).toBe(0)
  })

  it('a fill between two anchors stays on one track (no weaving)', () => {
    // Two fixes far apart on direction A with a tunnel gap between: the routed
    // fill must ride A throughout, never hop onto B and back.
    const ride = new Float32Array([0, 0.00001, 0.02, 0.00001])
    const c = coordsOf(matchRideToRail(ride, g)!)
    for (let i = 1; i < c.length; i += 2) expect(c[i]).toBe(0)
    expect(c.length / 2).toBeGreaterThan(10) // genuinely routed the line
  })
})

describe('type-constrained matching', () => {
  // A subway line and a parallel commuter-rail line ~30 m apart.
  const nodes: RailNodeInput[] = []
  const subwayEdges: Array<RailEdgeInput & { kind: number }> = []
  const railEdges: Array<RailEdgeInput & { kind: number }> = []
  for (let i = 0; i <= 10; i++) {
    nodes.push({ id: 100 + i, lat: 0, lon: i * 0.005 }) // subway
    nodes.push({ id: 200 + i, lat: 0.00028, lon: i * 0.005 }) // commuter rail
    if (i > 0) {
      subwayEdges.push({ a: 99 + i, b: 100 + i, kind: RAIL_KIND.subway })
      railEdges.push({ a: 199 + i, b: 200 + i, kind: RAIL_KIND.rail })
    }
  }
  const all = [...subwayEdges, ...railEdges]
  // Mirror buildMatches: a mode matches only edges of its allowed kinds.
  const graphFor = (type: string): ReturnType<typeof buildRailGraph> => {
    const allow = new Set(ALLOWED_KINDS_BY_TYPE[type])
    return buildRailGraph(
      nodes,
      all.filter((e) => allow.has(e.kind)),
      { snapRadiusM: 120, transferRadiusM: 60 }
    )
  }

  // A ride that hugs the subway line (lat 0) but is closer to it than to rail.
  const subwayRide = new Float32Array([0, 0.00003, 0.02, -0.00003, 0.04, 0.00004])

  it('a metro ride snaps to subway track (lat 0), never the parallel rail', () => {
    const c = coordsOf(matchRideToRail(subwayRide, graphFor('metro'))!)
    for (let i = 1; i < c.length; i += 2) expect(c[i]).toBe(0)
  })

  it('a train ride ignores the subway and snaps to the rail line (lat ≈ 0.00028)', () => {
    // Same path, but as a train it may only use the commuter-rail edges.
    const c = coordsOf(matchRideToRail(subwayRide, graphFor('train'))!)
    const railLat = Math.fround(0.00028)
    for (let i = 1; i < c.length; i += 2) expect(c[i]).toBe(railLat)
  })

  it('transfers never chain through another mode\'s edge-less nodes', () => {
    // Subway makes a U (the long way round between its tips); a foreign line
    // runs straight between them with nodes spaced inside the transfer
    // radius. Its EDGES are kind-filtered out but its NODES are passed in,
    // exactly as buildMatches does per mode — routing must take the long
    // subway path, never hop transfer-to-transfer along the foreign nodes.
    const nodes: RailNodeInput[] = []
    const edges: RailEdgeInput[] = []
    let id = 0
    const subwayIds: number[] = []
    const addSub = (lat: number, lon: number): void => {
      nodes.push({ id: ++id, lat, lon })
      subwayIds.push(id)
    }
    for (let i = 0; i <= 10; i++) addSub(i * 0.001, 0) // up
    for (let i = 1; i <= 10; i++) addSub(0.01, i * 0.001) // across
    for (let i = 9; i >= 0; i--) addSub(i * 0.001, 0.01) // down
    for (let k = 1; k < subwayIds.length; k++) {
      edges.push({ a: subwayIds[k - 1]!, b: subwayIds[k]! })
    }
    // Foreign (commuter) nodes: dense straight line between the U's tips.
    const foreignLat = 0.0004
    for (let i = 0; i <= 25; i++) nodes.push({ id: ++id, lat: foreignLat, lon: i * 0.0004 })

    const g = buildRailGraph(nodes, edges, { snapRadiusM: 100, transferRadiusM: 60 })
    const ride = new Float32Array([0, 0.00005, 0.01, 0.00005]) // tip to tip
    const c = coordsOf(matchRideToRail(ride, g)!)
    const fLat = Math.fround(foreignLat)
    for (let i = 1; i < c.length; i += 2) expect(c[i]).not.toBe(fLat)
    expect(c.length / 2).toBeGreaterThan(10) // actually routed the long way
  })
})

describe('bridgeRoadGaps (car tunnels)', () => {
  // A road tunnel along lat 0, lon 0.01..0.03 (≈2.2 km, Central-Artery-ish).
  const tunnelNodes: RailNodeInput[] = [0.01, 0.015, 0.02, 0.025, 0.03].map((lon, i) => ({
    id: i + 1,
    lat: 0,
    lon
  }))
  const tunnelEdges: RailEdgeInput[] = [1, 2, 3, 4].map((a) => ({ a, b: a + 1 }))
  const g = buildRailGraph(tunnelNodes, tunnelEdges, ROAD_TUNING)

  it('splices a long GPS gap through the tunnel, keeping every raw point', () => {
    const trip = new Float32Array([
      0, 0.0001, 0.005, -0.0001, 0.009, 0.0001, // approach (raw, stays raw)
      0.031, -0.0001, 0.035, 0.0001 // GPS resumes past the far portal
    ])
    const c = coordsOf(bridgeRoadGaps(trip, g)!)
    expect(c.length / 2).toBe(5 + 5) // 5 raw points + 5 tunnel nodes
    const lons = c.filter((_, k) => k % 2 === 0)
    for (const lon of [0, 0.005, 0.009, 0.031, 0.035]) {
      expect(lons).toContain(Math.fround(lon)) // raw points intact
    }
    // The gap is filled with the tunnel alignment (lat exactly 0)…
    const lats = c.filter((_, k) => k % 2 === 1)
    expect(lats.filter((lat) => lat === 0)).toHaveLength(5)
  })

  it('leaves ordinary point cadence alone (nothing bridged → null)', () => {
    const trip: number[] = []
    for (let i = 0; i <= 10; i++) trip.push(i * 0.001, 0.0001) // ~110 m steps
    expect(bridgeRoadGaps(new Float32Array(trip), g)).toBeNull()
  })

  it('does not bridge a road sampled over the tunnel at coarse-but-steady cadence', () => {
    // Surface traffic right above the tunnel, sampled every ~280 m — each gap
    // exceeds the old fixed ~200 m bar, but is normal for the trip, so the
    // relative rule keeps it raw instead of snapping the whole drive onto the
    // tunnel. (A fixed threshold would wrongly bridge every step here.)
    const trip: number[] = []
    for (let i = 0; i <= 9; i++) trip.push(0.008 + i * 0.0025, 0.0001)
    expect(bridgeRoadGaps(new Float32Array(trip), g)).toBeNull()
  })

  it('bridges a gap that is anomalous for the trip even amid fine sampling', () => {
    // Same fine cadence, but one ~2 km jump across the tunnel mid-trip.
    const trip = new Float32Array([
      0.008, 0.0001, 0.0095, 0.0001, 0.011, 0.0001, // dense approach near west portal
      0.029, 0.0001, 0.0305, 0.0001, 0.032, 0.0001 // resumes near east portal
    ])
    const c = coordsOf(bridgeRoadGaps(trip, g)!)
    const lats = c.filter((_, k) => k % 2 === 1)
    expect(lats.filter((lat) => lat === 0).length).toBeGreaterThanOrEqual(3) // tunnel spliced in
  })

  it('does not invent a tunnel for gaps far from any', () => {
    const trip = new Float32Array([0.5, 0.5, 0.55, 0.5])
    expect(bridgeRoadGaps(trip, g)).toBeNull()
  })

  it('does not bridge when elapsed time says the driver went elsewhere', () => {
    // Portal-to-portal fixes, but 40 minutes apart: parked downtown and came
    // back, not a 2 km tunnel run — the bridge would be a lie.
    const trip = new Float32Array([0.009, 0.0001, 0.031, -0.0001])
    expect(bridgeRoadGaps(trip, g, undefined, [0, 40 * 60_000])).toBeNull()
    // The same trip in 4 minutes is a normal tunnel transit — bridge it.
    expect(bridgeRoadGaps(trip, g, undefined, [0, 4 * 60_000])).not.toBeNull()
  })
})

describe('time plausibility (out-and-back wormholes)', () => {
  const graph = buildRailGraph(LINE_NODES, LINE_EDGES)

  it('rejects a short routed fill when the elapsed time implies a long journey', () => {
    // Two fixes ~1.1 km apart on the corridor, 30 minutes apart: the rider
    // went downtown and back with dead GPS. Routing the short way would draw
    // a track jump that never happened — keep raw instead.
    const ride = new Float32Array([0, 0.0003, 0.01, -0.0003])
    expect(matchRideToRail(ride, graph, undefined, [0, 30 * 60_000])).toBeNull()
    // The same hop in 2 minutes is an ordinary tunnel fill — snap it.
    expect(matchRideToRail(ride, graph, undefined, [0, 2 * 60_000])).not.toBeNull()
    // No timestamps → no gate (legacy data without times still snaps).
    expect(matchRideToRail(ride, graph)).not.toBeNull()
  })

  it('platform dwell does not poison the next hop', () => {
    // Sit at one station for 10 minutes, then ride one stop in 90 seconds:
    // dt for the moving hop is measured from the *latest* sighting at the
    // anchor, so the short hop stays snappable.
    const ride = new Float32Array([0, 0.0002, 0.0002, -0.0002, 0.008, 0.0003])
    const times = [0, 10 * 60_000, 10 * 60_000 + 90_000]
    const c = coordsOf(matchRideToRail(ride, graph, undefined, times)!)
    for (let i = 1; i < c.length; i += 2) expect(c[i]).toBe(0) // snapped to the line
  })

  it('breaks the line at a mid-ride wormhole and keeps snapping after it', () => {
    // Normal hop, then a 30-minute hole over ~1 km (out-and-back, unseen),
    // then a normal hop: the hole becomes a gap in the line — never a jump —
    // and both flanks stay snapped.
    const ride = new Float32Array([0, 0.0003, 0.01, -0.0003, 0.02, 0.0003, 0.03, -0.0003])
    const times = [0, 60_000, 60_000 + 30 * 60_000, 60_000 + 32 * 60_000]
    const c = coordsOf(matchRideToRail(ride, graph, undefined, times)!)
    const lats = c.filter((_, k) => k % 2 === 1)
    expect(lats.some((lat) => Number.isNaN(lat))).toBe(true) // the gap
    expect(lats.filter((lat) => lat === 0).length).toBeGreaterThanOrEqual(4) // both flanks
  })
})

describe('most-likely route through scatter (rescue)', () => {
  // One straight line, lon 0..0.04, node every 0.001.
  const nodes: RailNodeInput[] = Array.from({ length: 41 }, (_, i) => ({
    id: i + 1,
    lat: 0,
    lon: i * 0.001
  }))
  const edges: RailEdgeInput[] = Array.from({ length: 40 }, (_, i) => ({ a: i + 1, b: i + 2 }))
  const graph = buildRailGraph(nodes, edges)

  it('recovers an out-and-back from mid-gap scatter instead of shortcutting', () => {
    // Start at lon 0, end at lon 0.005 thirty minutes later — the direct fill
    // is far too short for the time. One wild mid-gap fix (~330 m off-track,
    // beyond the normal snap radius) betrays the rider went out to ~0.03:
    // rescue anchoring routes out and back, explaining the elapsed time.
    const ride = new Float32Array([0, 0.00005, 0.03, 0.003, 0.005, -0.00005])
    const times = [0, 15 * 60_000, 30 * 60_000]
    const c = coordsOf(matchRideToRail(ride, graph, undefined, times)!)
    const lons = c.filter((_, k) => k % 2 === 0)
    expect(lons.some((lon) => lon === Math.fround(0.03))).toBe(true) // reached the turnaround
    expect(c[c.length - 2]).toBe(Math.fround(0.005)) // and came back
    // The wild fix itself is rejected — explained by the route, not drawn.
    const lats = c.filter((_, k) => k % 2 === 1)
    expect(lats.every((lat) => lat === 0)).toBe(true)
  })

  it('rejects covered scatter explained by the reconstructed route', () => {
    // A short tunnel hop with one wild fix (~280 m off-track, beyond the
    // snap radius) inside it: the route explains the journey, so the scatter
    // is dropped instead of drawn as a spike.
    const ride = new Float32Array([0, 0.00005, 0.005, 0.0025, 0.01, -0.00005])
    const times = [0, 60_000, 2 * 60_000]
    const c = coordsOf(matchRideToRail(ride, graph, undefined, times)!)
    const lats = c.filter((_, k) => k % 2 === 1)
    expect(lats.every((lat) => lat === 0)).toBe(true) // no 0.0025 spike
  })
})
