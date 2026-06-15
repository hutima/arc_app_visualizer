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
  coverageBoxes,
  loadRailForViewport,
  clearRailNetwork,
  clearRailNetworkData,
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

  it('tracks rail and road coverage on separate layers', () => {
    addRailNetwork(db, cityA, boxA, 'rail')
    addRailNetwork(db, cityB, boxB, 'road')
    const cov = getRailCoverage(db)!
    expect(cov.regions.map((r) => r.layer).sort()).toEqual(['rail', 'road'])
    expect(coverageBoxes(db, 'rail')).toHaveLength(1)
    expect(coverageBoxes(db, 'road')).toHaveLength(1)
    // Re-fetching one layer leaves the other's coverage untouched.
    addRailNetwork(db, cityA, boxA, 'rail')
    expect(coverageBoxes(db, 'rail')).toHaveLength(1)
    expect(coverageBoxes(db, 'road')).toHaveLength(1)
  })

  it('clears everything back to empty', () => {
    addRailNetwork(db, cityA, boxA)
    clearRailNetwork(db)
    expect(getRailCoverage(db)).toBeNull()
    expect(hasRailNetwork(db)).toBe(false)
    expect(coverageBoxes(db, 'rail')).toHaveLength(0)
  })

  it('clears the network but keeps cached matched geometry', () => {
    addRailNetwork(db, cityA, boxA)
    // A cached snapped ride (one detail level) for segment 1.
    db.prepare(
      'INSERT INTO rail_matched_geom (segment_id, detail, point_count, coords) VALUES (1, 0, 2, ?)'
    ).run(new Uint8Array(16))

    clearRailNetworkData(db)
    expect(hasRailNetwork(db)).toBe(false) // network gone
    const cov = getRailCoverage(db)!
    expect(cov.regions).toHaveLength(0) // …yet coverage reports the cache
    expect(cov.matchedRides).toBe(1) // snapped rides keep rendering

    clearRailNetwork(db) // full clear drops the cache too
    expect(getRailCoverage(db)).toBeNull()
  })
})
