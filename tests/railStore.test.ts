/**
 * Accumulating OSM rail storage: regions fetched one viewport at a time add
 * up, overlapping fetches dedupe nodes and edges, and coverage reports every
 * region for the snap gate.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/main/db/db'
import {
  addRailNetwork,
  getRailCoverage,
  loadRailForViewport,
  hasRailNetwork
} from '../src/main/db/railStore'

const cityA = {
  nodes: [
    { id: 1, lat: 0, lon: 0 },
    { id: 2, lat: 0, lon: 0.01 },
    { id: 3, lat: 0, lon: 0.02 }
  ],
  edges: [
    { a: 1, b: 2 },
    { a: 2, b: 3 }
  ]
}
const boxA = { minLat: -0.1, minLon: -0.1, maxLat: 0.1, maxLon: 0.1 }

// Overlaps cityA: shares nodes 2–3 and the 2–3 edge (reversed), adds node 4.
const cityB = {
  nodes: [
    { id: 2, lat: 0, lon: 0.01 },
    { id: 3, lat: 0, lon: 0.02 },
    { id: 4, lat: 0, lon: 0.03 }
  ],
  edges: [
    { a: 3, b: 2 },
    { a: 3, b: 4 }
  ]
}
const boxB = { minLat: -0.1, minLon: 0.005, maxLat: 0.1, maxLon: 0.2 }

describe('rail store', () => {
  let db: DatabaseSync
  beforeEach(() => {
    db = openDb(':memory:')
  })

  it('starts with no coverage', () => {
    expect(getRailCoverage(db)).toBeNull()
    expect(hasRailNetwork(db)).toBe(false)
  })

  it('accumulates regions and dedupes overlapping nodes and edges', () => {
    addRailNetwork(db, cityA, boxA)
    const cov = addRailNetwork(db, cityB, boxB)
    expect(cov.regions).toHaveLength(2)
    expect(cov.regions[0]!.bbox).toEqual(boxA)
    expect(cov.regions[1]!.bbox).toEqual(boxB)
    expect(cov.nodeCount).toBe(4) // nodes 2 and 3 shared between fetches
    expect(cov.edgeCount).toBe(3) // 1–2, 2–3 (reversed duplicate dropped), 3–4
    expect(hasRailNetwork(db)).toBe(true)
  })

  it('re-fetching the same view replaces its region instead of stacking', () => {
    addRailNetwork(db, cityA, boxA)
    const cov = addRailNetwork(db, cityA, boxA)
    expect(cov.regions).toHaveLength(1)
    expect(cov.edgeCount).toBe(2)
  })

  it('loads a merged graph for a viewport spanning both regions', () => {
    addRailNetwork(db, cityA, boxA)
    addRailNetwork(db, cityB, boxB)
    const net = loadRailForViewport(db, { minLat: -1, minLon: -1, maxLat: 1, maxLon: 1 })
    expect(net.edges).toHaveLength(3)
    expect(net.nodes.map((n) => n.id).sort((x, y) => x - y)).toEqual([1, 2, 3, 4])
  })
})
