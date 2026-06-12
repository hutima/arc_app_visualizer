/**
 * The post-fetch map-matching pass: match every rail ride's raw points against
 * the fetched OSM network once, simplify the cleaned line into the same
 * per-zoom detail levels as display geometry, and cache it in
 * rail_matched_geom for the viewport query to swap in. Heavy, so it runs on
 * demand (after a fetch / when enabling snap), not per viewport — and yields
 * between chunks so the UI stays responsive and can show progress.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { LatLonBBox, RailMatchProgress } from '../../shared/types'
import { DETAIL_LEVELS } from '../../shared/displayDetail'
import { simplifyIndices } from '../importer/simplify'
import { buildRailGraph, matchRideToRail, RAIL_SNAP_TYPES, type CoverageTest } from './snapRail'
import { coverageBoxes, loadAllRail, clearMatchedGeom } from '../db/railStore'

const CHUNK = 150

export interface RebuildResult {
  matched: number
  railSegments: number
}

/**
 * Rebuild all cached matched geometry from scratch. Returns once every
 * rail segment intersecting coverage has been (re)matched.
 */
export async function rebuildRailMatches(
  db: DatabaseSync,
  onProgress?: (p: RailMatchProgress) => void
): Promise<RebuildResult> {
  const boxes = coverageBoxes(db)
  clearMatchedGeom(db)
  if (boxes.length === 0) {
    onProgress?.({ done: 0, total: 0, matched: 0 })
    return { matched: 0, railSegments: 0 }
  }

  const { nodes, edges } = loadAllRail(db)
  const graph = buildRailGraph(nodes, edges)
  const isCovered: CoverageTest = (lon, lat) =>
    boxes.some((b) => lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon)

  const u = unionBox(boxes)
  const typeList = [...RAIL_SNAP_TYPES]
  const segs = db.prepare(
    `SELECT id FROM segments
     WHERE type IN (${typeList.map(() => '?').join(',')})
       AND max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?
     ORDER BY id`
  ).all(...typeList, u.minLat, u.maxLat, u.minLon, u.maxLon) as Array<{ id: number }>

  const pointsStmt = db.prepare(
    `SELECT lon, lat FROM points
     WHERE segment_id = ? AND flags = 0 AND lat IS NOT NULL AND lon IS NOT NULL
     ORDER BY seq`
  )
  const insertStmt = db.prepare(
    'INSERT INTO rail_matched_geom (segment_id, detail, point_count, coords) VALUES (?, ?, ?, ?)'
  )

  let matched = 0
  for (let start = 0; start < segs.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, segs.length)
    db.exec('BEGIN')
    try {
      for (let i = start; i < end; i++) {
        const pts = pointsStmt.all(segs[i]!.id) as Array<{ lon: number; lat: number }>
        if (pts.length < 2) continue
        const coords = new Float32Array(pts.length * 2)
        for (let k = 0; k < pts.length; k++) {
          coords[k * 2] = pts[k]!.lon
          coords[k * 2 + 1] = pts[k]!.lat
        }
        const snapped = matchRideToRail(coords, graph, isCovered)
        if (snapped && storeDetailLevels(insertStmt, segs[i]!.id, snapped)) matched++
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    onProgress?.({ done: end, total: segs.length, matched })
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return { matched, railSegments: segs.length }
}

/** Simplify the matched line into each detail level and insert it. */
function storeDetailLevels(
  insertStmt: ReturnType<DatabaseSync['prepare']>,
  segmentId: number,
  coords: Float32Array
): boolean {
  const n = coords.length / 2
  const lons = new Float64Array(n)
  const lats = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    lons[i] = coords[i * 2]!
    lats[i] = coords[i * 2 + 1]!
  }
  let wrote = false
  for (const level of DETAIL_LEVELS) {
    const kept = simplifyIndices(lons, lats, level.toleranceDeg)
    if (kept.length < 2) continue
    const out = new Float32Array(kept.length * 2)
    for (let i = 0; i < kept.length; i++) {
      out[i * 2] = lons[kept[i]!]!
      out[i * 2 + 1] = lats[kept[i]!]!
    }
    insertStmt.run(segmentId, level.detail, kept.length, new Uint8Array(out.buffer))
    wrote = true
  }
  return wrote
}

function unionBox(boxes: LatLonBBox[]): LatLonBBox {
  const u = { ...boxes[0]! }
  for (const b of boxes) {
    u.minLat = Math.min(u.minLat, b.minLat)
    u.minLon = Math.min(u.minLon, b.minLon)
    u.maxLat = Math.max(u.maxLat, b.maxLat)
    u.maxLon = Math.max(u.maxLon, b.maxLon)
  }
  return u
}
