/**
 * Local storage for the OSM rail network: persist a fetched extent, load the
 * edges intersecting a viewport, and report coverage. Keeps the Overpass
 * fetch (rail/overpass) and the matcher (rail/snapRail) decoupled from SQLite.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { ParsedRail, BBox } from '../rail/overpass'
import type { RailNodeInput, RailEdgeInput } from '../rail/snapRail'

export interface RailCoverage {
  bbox: BBox
  fetchedAtMs: number
  nodeCount: number
  edgeCount: number
}

/** Replace any stored rail network with a freshly fetched one (single region). */
export function storeRailNetwork(db: DatabaseSync, rail: ParsedRail, bbox: BBox): RailCoverage {
  const coords = new Map(rail.nodes.map((n) => [n.id, n]))
  db.exec('BEGIN')
  try {
    db.exec('DELETE FROM rail_edges')
    db.exec('DELETE FROM rail_nodes')
    db.exec('DELETE FROM rail_coverage')

    const insNode = db.prepare('INSERT OR REPLACE INTO rail_nodes (id, lat, lon) VALUES (?, ?, ?)')
    for (const n of rail.nodes) insNode.run(n.id, n.lat, n.lon)

    const insEdge = db.prepare(
      `INSERT INTO rail_edges (a, b, min_lat, max_lat, min_lon, max_lon)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    for (const e of rail.edges) {
      const a = coords.get(e.a)
      const b = coords.get(e.b)
      if (!a || !b) continue
      insEdge.run(
        e.a, e.b,
        Math.min(a.lat, b.lat), Math.max(a.lat, b.lat),
        Math.min(a.lon, b.lon), Math.max(a.lon, b.lon)
      )
    }
    const fetchedAtMs = Date.now()
    db.prepare(
      `INSERT INTO rail_coverage (min_lat, min_lon, max_lat, max_lon, fetched_at_ms, node_count, edge_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      bbox.minLat, bbox.minLon, bbox.maxLat, bbox.maxLon,
      fetchedAtMs, rail.nodes.length, rail.edges.length
    )
    db.exec('COMMIT')
    return { bbox, fetchedAtMs, nodeCount: rail.nodes.length, edgeCount: rail.edges.length }
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function getRailCoverage(db: DatabaseSync): RailCoverage | null {
  const row = db.prepare(
    `SELECT min_lat AS minLat, min_lon AS minLon, max_lat AS maxLat, max_lon AS maxLon,
            fetched_at_ms AS fetchedAtMs, node_count AS nodeCount, edge_count AS edgeCount
     FROM rail_coverage ORDER BY id DESC LIMIT 1`
  ).get() as
    | { minLat: number; minLon: number; maxLat: number; maxLon: number; fetchedAtMs: number; nodeCount: number; edgeCount: number }
    | undefined
  if (!row) return null
  return {
    bbox: { minLat: row.minLat, minLon: row.minLon, maxLat: row.maxLat, maxLon: row.maxLon },
    fetchedAtMs: row.fetchedAtMs,
    nodeCount: row.nodeCount,
    edgeCount: row.edgeCount
  }
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
