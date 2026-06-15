/**
 * Local storage for the drivable OSM road network used by the manual reroute
 * tool. Mirrors railStore's accumulation model (regions fetched one viewport at
 * a time, canonical a < b edges that dedupe across overlapping fetches) but is
 * deliberately a separate set of tables: this network is large and only routed
 * on demand, so it stays out of the rail snapping path entirely. Edges keep a
 * road-class kind so the router can prefer arterials.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { BBox } from '../rail/overpass'
import type { RailNodeInput, RailEdgeInput } from '../rail/snapRail'
import type { LatLonBBox, RouteCoverage } from '../../shared/types'

/** A stored road edge plus its road-class code (ROAD_CLASS; 0 = unknown). */
export type StoredRouteEdge = RailEdgeInput & { kind: number }

/**
 * Add a fetched road region to the stored network. Nodes dedupe by OSM id;
 * edges store canonically (a < b, unique) and a re-fetch refreshes their class;
 * coverage regions the new bbox subsumes are absorbed.
 */
export function addRoadNetwork(
  db: DatabaseSync,
  road: { nodes: RailNodeInput[]; edges: ReadonlyArray<RailEdgeInput & { kind?: number }> },
  bbox: BBox
): RouteCoverage {
  const coords = new Map(road.nodes.map((n) => [n.id, n]))
  db.exec('BEGIN')
  try {
    const insNode = db.prepare('INSERT OR REPLACE INTO route_nodes (id, lat, lon) VALUES (?, ?, ?)')
    for (const n of road.nodes) insNode.run(n.id, n.lat, n.lon)

    const insEdge = db.prepare(
      `INSERT INTO route_edges (a, b, kind, min_lat, max_lat, min_lon, max_lon)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(a, b) DO UPDATE SET kind = excluded.kind`
    )
    for (const e of road.edges) {
      const a = coords.get(e.a)
      const b = coords.get(e.b)
      if (!a || !b || e.a === e.b) continue
      insEdge.run(
        Math.min(e.a, e.b), Math.max(e.a, e.b), e.kind ?? 0,
        Math.min(a.lat, b.lat), Math.max(a.lat, b.lat),
        Math.min(a.lon, b.lon), Math.max(a.lon, b.lon)
      )
    }

    // A re-fetch of the same (or a larger) view replaces the regions it covers.
    db.prepare(
      `DELETE FROM route_coverage
       WHERE min_lat >= ? AND max_lat <= ? AND min_lon >= ? AND max_lon <= ?`
    ).run(bbox.minLat, bbox.maxLat, bbox.minLon, bbox.maxLon)
    db.prepare(
      `INSERT INTO route_coverage (min_lat, min_lon, max_lat, max_lon, fetched_at_ms, node_count, edge_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      bbox.minLat, bbox.minLon, bbox.maxLat, bbox.maxLon,
      Date.now(), road.nodes.length, road.edges.length
    )
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return getRouteCoverage(db)!
}

/** All fetched road regions plus live totals; null when none fetched. */
export function getRouteCoverage(db: DatabaseSync): RouteCoverage | null {
  const rows = db.prepare(
    `SELECT min_lat AS minLat, min_lon AS minLon, max_lat AS maxLat, max_lon AS maxLon,
            fetched_at_ms AS fetchedAtMs
     FROM route_coverage ORDER BY fetched_at_ms ASC, id ASC`
  ).all() as Array<{ minLat: number; minLon: number; maxLat: number; maxLon: number; fetchedAtMs: number }>
  if (rows.length === 0) return null
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM route_nodes').get() as { n: number }
  const { e } = db.prepare('SELECT COUNT(*) AS e FROM route_edges').get() as { e: number }
  return {
    regions: rows.map((r) => ({ minLat: r.minLat, minLon: r.minLon, maxLat: r.maxLat, maxLon: r.maxLon })),
    nodeCount: n,
    edgeCount: e,
    lastFetchedAtMs: rows[rows.length - 1]!.fetchedAtMs
  }
}

/** Fetched road bboxes — the gate for whether a reroute can run somewhere. */
export function routeCoverageBoxes(db: DatabaseSync): LatLonBBox[] {
  return db.prepare(
    `SELECT min_lat AS minLat, min_lon AS minLon, max_lat AS maxLat, max_lon AS maxLon
     FROM route_coverage`
  ).all() as unknown as LatLonBBox[]
}

/** True when every lon/lat in `points` lies inside some fetched road region. */
export function routeBoxesCover(boxes: LatLonBBox[], points: ReadonlyArray<{ lat: number; lon: number }>): boolean {
  return points.every((p) =>
    boxes.some((b) => p.lat >= b.minLat && p.lat <= b.maxLat && p.lon >= b.minLon && p.lon <= b.maxLon)
  )
}

/**
 * Load the road nodes + edges (with class) whose edge bbox intersects the
 * given bbox, plus the nodes they touch — the working graph for one reroute.
 */
export function loadRouteForBbox(
  db: DatabaseSync,
  bbox: BBox
): { nodes: RailNodeInput[]; edges: StoredRouteEdge[] } {
  const edges = db.prepare(
    `SELECT a, b, kind FROM route_edges
     WHERE max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?`
  ).all(bbox.minLat, bbox.maxLat, bbox.minLon, bbox.maxLon) as unknown as StoredRouteEdge[]
  if (edges.length === 0) return { nodes: [], edges: [] }

  const ids = new Set<number>()
  for (const e of edges) {
    ids.add(e.a)
    ids.add(e.b)
  }
  // Dense road networks reference far more nodes than SQLite's bound-variable
  // limit (~32k), so load them in batches rather than one giant IN (...).
  // node ids come straight from our own edge rows (no injection surface).
  const idList = [...ids]
  const BATCH = 900
  const nodes: RailNodeInput[] = []
  for (let i = 0; i < idList.length; i += BATCH) {
    const chunk = idList.slice(i, i + BATCH)
    const placeholders = chunk.map(() => '?').join(',')
    nodes.push(
      ...(db.prepare(
        `SELECT id, lat, lon FROM route_nodes WHERE id IN (${placeholders})`
      ).all(...chunk) as unknown as RailNodeInput[])
    )
  }
  return { nodes, edges }
}

/** Wipe the fetched road network (applied reroutes are edit overlays — untouched). */
export function clearRouteNetwork(db: DatabaseSync): void {
  db.exec('BEGIN')
  try {
    db.exec('DELETE FROM route_edges')
    db.exec('DELETE FROM route_nodes')
    db.exec('DELETE FROM route_coverage')
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function hasRouteNetwork(db: DatabaseSync): boolean {
  return db.prepare('SELECT 1 FROM route_edges LIMIT 1').get() !== undefined
}
