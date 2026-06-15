/**
 * Accumulating drivable-road storage for the reroute tool: regions add up,
 * overlapping fetches dedupe nodes/edges, edges keep their road class, and
 * coverage gates where a route can be computed.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/main/db/db'
import {
  addRoadNetwork,
  getRouteCoverage,
  routeCoverageBoxes,
  routeBoxesCover,
  loadRouteForBbox,
  clearRouteNetwork,
  hasRouteNetwork
} from '../src/main/db/routeStore'

const cityA = {
  nodes: [
    { id: 1, lat: 0, lon: 0 },
    { id: 2, lat: 0, lon: 0.01 },
    { id: 3, lat: 0, lon: 0.02 }
  ],
  edges: [
    { a: 1, b: 2, kind: 3 },
    { a: 2, b: 3, kind: 7 }
  ]
}
const boxA = { minLat: -0.1, minLon: -0.1, maxLat: 0.1, maxLon: 0.1 }

// Overlaps cityA (shares 2–3, reversed) and adds node 4.
const cityB = {
  nodes: [
    { id: 2, lat: 0, lon: 0.01 },
    { id: 3, lat: 0, lon: 0.02 },
    { id: 4, lat: 0, lon: 0.03 }
  ],
  edges: [
    { a: 3, b: 2, kind: 7 },
    { a: 3, b: 4, kind: 5 }
  ]
}
const boxB = { minLat: -0.1, minLon: 0.005, maxLat: 0.1, maxLon: 0.2 }

describe('route store', () => {
  let db: DatabaseSync
  beforeEach(() => {
    db = openDb(':memory:')
  })

  it('starts empty', () => {
    expect(getRouteCoverage(db)).toBeNull()
    expect(hasRouteNetwork(db)).toBe(false)
    expect(routeCoverageBoxes(db)).toHaveLength(0)
  })

  it('accumulates regions and dedupes overlapping nodes and edges', () => {
    addRoadNetwork(db, cityA, boxA)
    const cov = addRoadNetwork(db, cityB, boxB)
    expect(cov.regions).toHaveLength(2)
    expect(cov.nodeCount).toBe(4) // nodes 2,3 shared
    expect(cov.edgeCount).toBe(3) // 1–2, 2–3 (reversed dup dropped), 3–4
  })

  it('re-fetching the same view replaces its region', () => {
    addRoadNetwork(db, cityA, boxA)
    const cov = addRoadNetwork(db, cityA, boxA)
    expect(cov.regions).toHaveLength(1)
    expect(cov.edgeCount).toBe(2)
  })

  it('loads intersecting edges with their road class', () => {
    addRoadNetwork(db, cityA, boxA)
    const net = loadRouteForBbox(db, { minLat: -1, minLon: -1, maxLat: 1, maxLon: 1 })
    expect(net.edges).toHaveLength(2)
    expect(net.edges.find((e) => e.a === 1 && e.b === 2)!.kind).toBe(3)
    expect(net.nodes.map((n) => n.id).sort((x, y) => x - y)).toEqual([1, 2, 3])
  })

  it('gates coverage by point containment', () => {
    addRoadNetwork(db, cityA, boxA)
    expect(routeBoxesCover(routeCoverageBoxes(db), [{ lat: 0, lon: 0 }])).toBe(true)
    expect(routeBoxesCover(routeCoverageBoxes(db), [{ lat: 9, lon: 9 }])).toBe(false)
  })

  it('clears back to empty', () => {
    addRoadNetwork(db, cityA, boxA)
    clearRouteNetwork(db)
    expect(getRouteCoverage(db)).toBeNull()
    expect(hasRouteNetwork(db)).toBe(false)
  })

  it('loads every node for a dense network (node lookup is batched)', () => {
    // > one batch of node ids: a single IN (...) would blow SQLite's variable
    // cap on a real dense city; loadRouteForBbox must batch and still return all.
    const n = 2000
    const dense = {
      nodes: Array.from({ length: n }, (_, i) => ({ id: i + 1, lat: 0, lon: i * 1e-4 })),
      edges: Array.from({ length: n - 1 }, (_, i) => ({ a: i + 1, b: i + 2, kind: 6 }))
    }
    addRoadNetwork(db, dense, { minLat: -1, minLon: -1, maxLat: 1, maxLon: 1 })
    const net = loadRouteForBbox(db, { minLat: -1, minLon: -1, maxLat: 1, maxLon: 1 })
    expect(net.edges).toHaveLength(n - 1)
    expect(net.nodes).toHaveLength(n)
  })
})
