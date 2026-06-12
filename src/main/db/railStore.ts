/**
 * Local storage for the OSM rail network. Regions are fetched one viewport at
 * a time and accumulate, so cities can be loaded individually; coverage bboxes
 * double as the snap gate (rides keep raw GPS outside fetched areas). Keeps
 * the Overpass fetch (rail/overpass) and the matcher (rail/snapRail) decoupled
 * from SQLite.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { BBox } from '../rail/overpass'
import type { RailNodeInput, RailEdgeInput } from '../rail/snapRail'
import type { LatLonBBox, RailCoverage } from '../../shared/types'

/** A stored edge plus its OSM railway kind code (RAIL_KIND; 0 = unknown). */
export type StoredRailEdge = RailEdgeInput & { kind: number }

/**
 * Add a fetched region to the stored network. Nodes and edges from
 * overlapping fetches dedupe (OSM ids; canonical a < b edges); coverage
 * regions made redundant by the new bbox are absorbed into it.
 */
export function addRailNetwork(
  db: DatabaseSync,
  rail: { nodes: RailNodeInput[]; edges: ReadonlyArray<RailEdgeInput & { kind?: number }> },
  bbox: BBox
): RailCoverage {
  const coords = new Map(rail.nodes.map((n) => [n.id, n]))
  db.exec('BEGIN')
  try {
    const insNode = db.prepare('INSERT OR REPLACE INTO rail_nodes (id, lat, lon) VALUES (?, ?, ?)')
    for (const n of rail.nodes) insNode.run(n.id, n.lat, n.lon)

    // On a re-fetch the edge may already exist (from a v8 db with no kind, or
    // an overlapping region): refresh its kind so type constraints take hold.
    const insEdge = db.prepare(
      `INSERT INTO rail_edges (a, b, kind, min_lat, max_lat, min_lon, max_lon)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(a, b) DO UPDATE SET kind = excluded.kind`
    )
    for (const e of rail.edges) {
      const a = coords.get(e.a)
      const b = coords.get(e.b)
      if (!a || !b || e.a === e.b) continue
      insEdge.run(
        Math.min(e.a, e.b), Math.max(e.a, e.b), e.kind ?? 0,
        Math.min(a.lat, b.lat), Math.max(a.lat, b.lat),
        Math.min(a.lon, b.lon), Math.max(a.lon, b.lon)
      )
    }

    // A re-fetch of the same (or a larger) view replaces the rows it covers.
    db.prepare(
      `DELETE FROM rail_coverage
       WHERE min_lat >= ? AND max_lat <= ? AND min_lon >= ? AND max_lon <= ?`
    ).run(bbox.minLat, bbox.maxLat, bbox.minLon, bbox.maxLon)
    db.prepare(
      `INSERT INTO rail_coverage (min_lat, min_lon, max_lat, max_lon, fetched_at_ms, node_count, edge_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      bbox.minLat, bbox.minLon, bbox.maxLat, bbox.maxLon,
      Date.now(), rail.nodes.length, rail.edges.length
    )
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return getRailCoverage(db)!
}

/** All fetched regions plus live totals; null when nothing is fetched yet. */
export function getRailCoverage(db: DatabaseSync): RailCoverage | null {
  const rows = db.prepare(
    `SELECT min_lat AS minLat, min_lon AS minLon, max_lat AS maxLat, max_lon AS maxLon,
            fetched_at_ms AS fetchedAtMs
     FROM rail_coverage ORDER BY fetched_at_ms ASC, id ASC`
  ).all() as Array<{ minLat: number; minLon: number; maxLat: number; maxLon: number; fetchedAtMs: number }>
  if (rows.length === 0) return null

  // Counts come from the tables, not per-region sums: overlaps would double-count.
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM rail_nodes').get() as { n: number }
  const { e } = db.prepare('SELECT COUNT(*) AS e FROM rail_edges').get() as { e: number }
  return {
    regions: rows.map((r) => ({
      bbox: { minLat: r.minLat, minLon: r.minLon, maxLat: r.maxLat, maxLon: r.maxLon },
      fetchedAtMs: r.fetchedAtMs
    })),
    nodeCount: n,
    edgeCount: e,
    matchedRides: matchedRideCount(db),
    lastFetchedAtMs: rows[rows.length - 1]!.fetchedAtMs
  }
}

/** Every fetched region's bbox (for the coverage gate during a match pass). */
export function coverageBoxes(db: DatabaseSync): LatLonBBox[] {
  return db.prepare(
    `SELECT min_lat AS minLat, min_lon AS minLon, max_lat AS maxLat, max_lon AS maxLon
     FROM rail_coverage`
  ).all() as unknown as LatLonBBox[]
}

/** The whole stored network (edges carry kind), for building match graphs. */
export function loadAllRail(db: DatabaseSync): { nodes: RailNodeInput[]; edges: StoredRailEdge[] } {
  const nodes = db.prepare('SELECT id, lat, lon FROM rail_nodes').all() as unknown as RailNodeInput[]
  const edges = db.prepare('SELECT a, b, kind FROM rail_edges').all() as unknown as StoredRailEdge[]
  return { nodes, edges }
}

/** Rail segments with cached matched geometry. */
export function matchedRideCount(db: DatabaseSync): number {
  const { n } = db.prepare(
    'SELECT COUNT(DISTINCT segment_id) AS n FROM rail_matched_geom'
  ).get() as { n: number }
  return n
}

export function clearMatchedGeom(db: DatabaseSync): void {
  db.exec('DELETE FROM rail_matched_geom')
}

/**
 * Load the rail nodes and edges needed to match within a viewport bbox: every
 * edge whose bbox intersects the (padded) view, plus the nodes they touch.
 */
export function loadRailForViewport(
  db: DatabaseSync,
  bbox: BBox
): { nodes: RailNodeInput[]; edges: RailEdgeInput[] } {
  const edgeRows = db.prepare(
    `SELECT a, b FROM rail_edges
     WHERE max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?`
  ).all(bbox.minLat, bbox.maxLat, bbox.minLon, bbox.maxLon) as Array<{ a: number; b: number }>
  if (edgeRows.length === 0) return { nodes: [], edges: [] }

  const ids = new Set<number>()
  for (const e of edgeRows) {
    ids.add(e.a)
    ids.add(e.b)
  }
  // node ids come straight from our own edge rows (no injection surface)
  const placeholders = Array.from(ids, () => '?').join(',')
  const nodeRows = db.prepare(
    `SELECT id, lat, lon FROM rail_nodes WHERE id IN (${placeholders})`
  ).all(...ids) as Array<{ id: number; lat: number; lon: number }>

  return { nodes: nodeRows, edges: edgeRows }
}

export function hasRailNetwork(db: DatabaseSync): boolean {
  const row = db.prepare('SELECT 1 FROM rail_edges LIMIT 1').get()
  return row !== undefined
}
