/**
 * Local road routing for the manual reroute tool: anchoring waypoints to the
 * fetched road graph, routing between them, and preferring arterials over an
 * equivalent residential path.
 */
import { describe, it, expect } from 'vitest'
import {
  computeRoadRoute,
  roadClassKind,
  emphasisForDistanceDeg,
  filterDriveEdges,
  BUS_KIND,
  DRIVE_HIGHWAY_TYPES,
  ROAD_CLASS
} from '../src/main/rail/roadRoute'
import { buildDriveQuery, parseOverpassJson } from '../src/main/rail/overpass'
import type { RailNodeInput } from '../src/main/rail/snapRail'

// A grid near (0,0): a straight residential path A–M–B, and a primary detour
// A–E–F–B that is geometrically *longer* but should win on the arterial bias.
const nodes: RailNodeInput[] = [
  { id: 1, lat: 0, lon: 0 }, // A
  { id: 2, lat: 0.01, lon: 0 }, // M (residential mid)
  { id: 3, lat: 0.02, lon: 0 }, // B
  { id: 4, lat: 0.005, lon: 0.005 }, // E (primary)
  { id: 5, lat: 0.015, lon: 0.005 } // F (primary)
]
const RES = ROAD_CLASS.residential
const PRI = ROAD_CLASS.primary
const edges = [
  { a: 1, b: 2, kind: RES },
  { a: 2, b: 3, kind: RES },
  { a: 1, b: 4, kind: PRI },
  { a: 4, b: 5, kind: PRI },
  { a: 5, b: 3, kind: PRI }
]
const A = { lon: 0, lat: 0 }
const B = { lon: 0, lat: 0.02 }

const lonsOf = (coords: Float32Array): number[] => {
  const out: number[] = []
  for (let i = 0; i < coords.length; i += 2) out.push(coords[i]!)
  return out
}

describe('computeRoadRoute', () => {
  it('prefers the arterial detour over the shorter residential path', () => {
    const res = computeRoadRoute(nodes, edges, [A, B])
    expect('coords' in res).toBe(true)
    if ('coords' in res) {
      // The primary nodes sit at lon 0.005; the residential path is all lon 0.
      expect(lonsOf(res.coords).some((l) => Math.abs(l - 0.005) < 1e-4)).toBe(true)
    }
  })

  it('routes through the residential path when no arterial exists', () => {
    const res = computeRoadRoute(nodes, edges.slice(0, 2), [A, B])
    expect('coords' in res).toBe(true)
    if ('coords' in res) {
      expect(lonsOf(res.coords).every((l) => Math.abs(l) < 1e-4)).toBe(true)
    }
  })

  it('follows the track corridor over the far arterial when given a guide', () => {
    // The guide runs along the residential line (lon 0); the arterial detour is
    // ~550 m east. The loose corridor bias should keep the route on the line the
    // user actually took, overriding the arterial preference for a far road.
    const guide = [
      { lon: 0, lat: 0 },
      { lon: 0, lat: 0.01 },
      { lon: 0, lat: 0.02 }
    ]
    const res = computeRoadRoute(nodes, edges, [A, B], guide)
    expect('coords' in res).toBe(true)
    if ('coords' in res) {
      expect(lonsOf(res.coords).every((l) => Math.abs(l) < 1e-4)).toBe(true)
    }
  })

  it('errors when a waypoint is too far from any road', () => {
    const res = computeRoadRoute(nodes, edges, [A, { lon: 5, lat: 5 }])
    expect('error' in res).toBe(true)
  })

  it('errors on an empty network', () => {
    expect('error' in computeRoadRoute([], [], [A, B])).toBe(true)
  })
})

describe('highway emphasis (long routes)', () => {
  // A–B with a short residential straight (lon 0) and a longer motorway detour
  // (lon 0.025). At base emphasis the shorter residential wins; at the high
  // emphasis of a long trip the motorway is preferred despite being longer.
  const n2: RailNodeInput[] = [
    { id: 1, lat: 0, lon: 0 },
    { id: 2, lat: 0.01, lon: 0 },
    { id: 3, lat: 0.02, lon: 0 },
    { id: 4, lat: 0.005, lon: 0.025 },
    { id: 5, lat: 0.015, lon: 0.025 }
  ]
  const e2 = [
    { a: 1, b: 2, kind: ROAD_CLASS.residential },
    { a: 2, b: 3, kind: ROAD_CLASS.residential },
    { a: 1, b: 4, kind: ROAD_CLASS.motorway },
    { a: 4, b: 5, kind: ROAD_CLASS.motorway },
    { a: 5, b: 3, kind: ROAD_CLASS.motorway }
  ]

  it('takes the residential straight at base emphasis', () => {
    const res = computeRoadRoute(n2, e2, [A, B], [], 1)
    expect('coords' in res).toBe(true)
    if ('coords' in res) expect(lonsOf(res.coords).every((l) => Math.abs(l) < 1e-4)).toBe(true)
  })

  it('funnels onto the motorway detour at high emphasis', () => {
    const res = computeRoadRoute(n2, e2, [A, B], [], 3)
    expect('coords' in res).toBe(true)
    if ('coords' in res) expect(lonsOf(res.coords).some((l) => Math.abs(l - 0.025) < 1e-4)).toBe(true)
  })

  it('ramps emphasis up with distance, capped', () => {
    expect(emphasisForDistanceDeg(0)).toBe(1)
    expect(emphasisForDistanceDeg(0.05)).toBe(1) // ~5.5 km → still base
    expect(emphasisForDistanceDeg(0.18)).toBeGreaterThan(1.5) // ~20 km
    expect(emphasisForDistanceDeg(0.45)).toBe(4) // ~50 km → capped
  })
})

describe('bus-only ways', () => {
  it('keeps bus-only edges only when the trip is a bus', () => {
    const edges = [
      { a: 1, b: 2, kind: ROAD_CLASS.residential },
      { a: 2, b: 3, kind: BUS_KIND }
    ]
    expect(filterDriveEdges(edges, false).map((e) => e.kind)).toEqual([ROAD_CLASS.residential])
    expect(filterDriveEdges(edges, true)).toHaveLength(2)
  })

  it('routes a bus through a bus-only link a car cannot use', () => {
    // The only A–B connection is a bus-only way.
    const busNodes: RailNodeInput[] = [
      { id: 1, lat: 0, lon: 0 },
      { id: 2, lat: 0.01, lon: 0 }
    ]
    const busEdges = [{ a: 1, b: 2, kind: BUS_KIND }]
    const ends = [{ lon: 0, lat: 0 }, { lon: 0, lat: 0.01 }]
    expect('error' in computeRoadRoute(busNodes, busEdges, ends, [], 1, false)).toBe(true)
    expect('coords' in computeRoadRoute(busNodes, busEdges, ends, [], 1, true)).toBe(true)
  })
})

describe('road class + drive query', () => {
  it('maps highway tags to class codes (0 = unknown)', () => {
    expect(roadClassKind('motorway')).toBeGreaterThan(0)
    expect(roadClassKind('residential')).toBeGreaterThan(0)
    expect(roadClassKind('motorway')).not.toBe(roadClassKind('residential'))
    expect(roadClassKind('footway')).toBe(0) // not a drivable class
    expect(roadClassKind(undefined)).toBe(0)
  })

  it('fetches the drivable highway classes plus bus-only ways for a bbox', () => {
    const q = buildDriveQuery({ minLat: 1, minLon: 2, maxLat: 3, maxLon: 4 })
    expect(q).toContain('highway')
    expect(q).toContain('1,2,3,4')
    for (const cls of DRIVE_HIGHWAY_TYPES) expect(q).toContain(cls)
    expect(q).toContain('busway')
    expect(q).toContain('psv')
  })

  it('tags a non-drivable bus way as the bus kind', () => {
    const json = {
      elements: [
        { type: 'node', id: 1, lat: 0, lon: 0 },
        { type: 'node', id: 2, lat: 0, lon: 0.01 },
        { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'busway' } }
      ]
    }
    const parsed = parseOverpassJson(json, (tags) =>
      roadClassKind(tags.highway) !== 0 ? roadClassKind(tags.highway) : BUS_KIND
    )
    expect(parsed.edges[0]!.kind).toBe(BUS_KIND)
  })

  it('parses highway ways into road-class edges with a drive kind resolver', () => {
    const json = {
      elements: [
        { type: 'node', id: 1, lat: 0, lon: 0 },
        { type: 'node', id: 2, lat: 0, lon: 0.01 },
        { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'primary' } }
      ]
    }
    const parsed = parseOverpassJson(json, (tags) => roadClassKind(tags.highway))
    expect(parsed.edges).toHaveLength(1)
    expect(parsed.edges[0]!.kind).toBe(ROAD_CLASS.primary)
  })
})
