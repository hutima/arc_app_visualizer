/**
 * The post-fetch map-matching pass: match every rail ride's raw points against
 * the fetched OSM network once, simplify the cleaned line into the same
 * per-zoom detail levels as display geometry, and cache it in
 * rail_matched_geom for the viewport query to swap in. Heavy, so it runs on
 * demand (after a fetch / when enabling snap), not per viewport — and yields
 * between chunks so the UI stays responsive and can show progress.
 */
import type { DatabaseSync } from 'node:sqlite'
import { DEFAULT_RAIL_TUNING, type LatLonBBox, type RailMatchProgress, type RailTuning } from '../../shared/types'
import { DETAIL_LEVELS } from '../../shared/displayDetail'
import { simplifyIndices } from '../importer/simplify'
import {
  ALLOWED_KINDS_BY_TYPE,
  bridgeRoadGaps,
  buildRailGraph,
  matchRideToRail,
  RAIL_KIND,
  RAIL_SNAP_TYPES,
  ROAD_TUNNEL_TYPES,
  ROAD_TUNING,
  type CoverageTest,
  type RailGraph
} from './snapRail'
import { coverageBoxes, loadAllRail, clearMatchedGeom } from '../db/railStore'
import { prepareEffectivePoints } from '../db/editStore'

const CHUNK = 150

export interface RebuildResult {
  matched: number
  railSegments: number
}

/**
 * Rebuild all cached matched geometry from scratch: full map-matching for
 * rail rides, tunnel-gap bridging for road trips. Returns once every
 * candidate segment intersecting coverage has been (re)processed.
 */
export async function rebuildRailMatches(
  db: DatabaseSync,
  tuning: RailTuning = DEFAULT_RAIL_TUNING,
  onProgress?: (p: RailMatchProgress) => void
): Promise<RebuildResult> {
  // Each layer is fetched and gated independently: a rail ride only snaps
  // inside fetched rail coverage, a car trip only bridges inside fetched road
  // coverage. (You can load one without the other.)
  const railBoxes = coverageBoxes(db, 'rail')
  const roadBoxes = coverageBoxes(db, 'road')
  clearMatchedGeom(db)
  if (railBoxes.length === 0 && roadBoxes.length === 0) {
    onProgress?.({ done: 0, total: 0, matched: 0 })
    return { matched: 0, railSegments: 0 }
  }

  const { nodes, edges } = loadAllRail(db)
  const gate = (boxes: LatLonBBox[]): CoverageTest => (lon, lat) =>
    boxes.some((b) => lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon)
  const railCovered = gate(railBoxes)
  const roadCovered = gate(roadBoxes)

  // One graph per Arc mode, each filtered to the OSM track kinds that mode may
  // match (a metro ride routes only on subway/light-rail, never commuter rail).
  // Cached by kind-set so metro and subway share a graph. Unknown-kind edges
  // (0, from pre-v9 fetches) are wildcards until the area is re-fetched — but
  // never for roads, whose graph wants exactly the tunnel ways.
  const graphByKindSet = new Map<string, RailGraph>()
  const graphFor = (type: string): RailGraph => {
    const allowed = ALLOWED_KINDS_BY_TYPE[type] ?? null
    const key = allowed ? [...allowed].sort((x, y) => x - y).join(',') : 'all'
    let g = graphByKindSet.get(key)
    if (!g) {
      const allow = allowed ? new Set(allowed) : null
      const usable = allow
        ? edges.filter((e) => e.kind === 0 || allow.has(e.kind))
        : edges
      g = buildRailGraph(nodes, usable, tuning)
      graphByKindSet.set(key, g)
    }
    return g
  }
  let roadGraphCache: RailGraph | null = null
  const roadGraph = (): RailGraph => {
    if (!roadGraphCache) {
      roadGraphCache = buildRailGraph(
        nodes,
        edges.filter((e) => e.kind === RAIL_KIND.road_tunnel),
        ROAD_TUNING
      )
    }
    return roadGraphCache
  }

  const u = unionBox([...railBoxes, ...roadBoxes])
  const typeList = [...RAIL_SNAP_TYPES, ...ROAD_TUNNEL_TYPES]
  const segs = db.prepare(
    `SELECT id, type FROM segments
     WHERE type IN (${typeList.map(() => '?').join(',')})
       AND max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?
     ORDER BY id`
  ).all(...typeList, u.minLat, u.maxLat, u.minLon, u.maxLon) as Array<{ id: number; type: string }>

  // Effective points = clean raw + user track edits, so manual fixes apply
  // before matching; timestamps (interpolated for inserted vertices) feed the
  // matcher's time-plausibility gate (wormhole rejection).
  const effectivePoints = prepareEffectivePoints(db)
  const insertStmt = db.prepare(
    'INSERT INTO rail_matched_geom (segment_id, detail, point_count, coords) VALUES (?, ?, ?, ?)'
  )

  let matched = 0
  for (let start = 0; start < segs.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, segs.length)
    db.exec('BEGIN')
    try {
      for (let i = start; i < end; i++) {
        const pts = effectivePoints(segs[i]!.id)
        if (pts.length < 2) continue
        const coords = new Float32Array(pts.length * 2)
        const times = new Float64Array(pts.length)
        for (let k = 0; k < pts.length; k++) {
          coords[k * 2] = pts[k]!.lon
          coords[k * 2 + 1] = pts[k]!.lat
          times[k] = pts[k]!.tsMs == null ? NaN : Number(pts[k]!.tsMs)
        }
        // Rail rides are fully map-matched; road trips only get long GPS
        // gaps bridged through mapped tunnels (everything else stays raw).
        const snapped = ROAD_TUNNEL_TYPES.has(segs[i]!.type)
          ? bridgeRoadGaps(coords, roadGraph(), roadCovered, times)
          : matchRideToRail(coords, graphFor(segs[i]!.type), railCovered, times)
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

/**
 * Simplify the matched line into each detail level and insert it. The matcher
 * may emit NaN break sentinels (deliberate gaps — "don't connect these");
 * each part is simplified independently so a break survives simplification.
 */
function storeDetailLevels(
  insertStmt: ReturnType<DatabaseSync['prepare']>,
  segmentId: number,
  coords: Float32Array
): boolean {
  const n = coords.length / 2
  const parts: Array<{ lons: Float64Array; lats: Float64Array }> = []
  let partStart = 0
  const flushPart = (from: number, to: number): void => {
    if (to - from < 2) return // a 1-point part draws nothing anyway
    const lons = new Float64Array(to - from)
    const lats = new Float64Array(to - from)
    for (let i = from; i < to; i++) {
      lons[i - from] = coords[i * 2]!
      lats[i - from] = coords[i * 2 + 1]!
    }
    parts.push({ lons, lats })
  }
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(coords[i * 2]!)) {
      flushPart(partStart, i)
      partStart = i + 1
    }
  }
  flushPart(partStart, n)
  if (parts.length === 0) return false

  let wrote = false
  for (const level of DETAIL_LEVELS) {
    const outPts: number[] = []
    for (const part of parts) {
      const kept = simplifyIndices(part.lons, part.lats, level.toleranceDeg)
      if (kept.length < 2) continue
      if (outPts.length > 0) outPts.push(NaN, NaN)
      for (const k of kept) outPts.push(part.lons[k]!, part.lats[k]!)
    }
    if (outPts.length < 4) continue
    insertStmt.run(
      segmentId, level.detail, outPts.length / 2,
      new Uint8Array(new Float32Array(outPts).buffer)
    )
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
