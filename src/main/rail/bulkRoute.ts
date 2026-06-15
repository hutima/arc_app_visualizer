/**
 * Bulk reroute: snap each of many similar tracks to its *own* clean road route,
 * applied as a revertible draft (so the user can spot-check / discard via the
 * Drafts panel). Each track routes between its own start and end, biased by its
 * own GPS corridor and type — same as a single reviewed reroute, just without
 * the per-track preview. Yields between tracks so the main process stays
 * responsive on a big selection.
 */
import type { DatabaseSync } from 'node:sqlite'
import { prepareEffectivePoints, saveSegmentEdits } from '../db/editStore'
import { routeCoverageBoxes, routeBoxesCover, loadRouteForBbox } from '../db/routeStore'
import { routeWaypoints } from './snapRail'
import {
  buildGuidedDriveGraph,
  filterDriveEdges,
  guideLengthDeg,
  emphasisForDistanceDeg,
  simplifyRoutePolyline,
  type GuidePoint
} from './roadRoute'
import { spliceRoute } from '../../shared/reroute'
import type { BulkRerouteResult, EditablePoint, LatLonBBox, SegmentEditInput } from '../../shared/types'

const bboxOf = (pts: ReadonlyArray<GuidePoint>): LatLonBBox => {
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity
  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat
    if (p.lat > maxLat) maxLat = p.lat
    if (p.lon < minLon) minLon = p.lon
    if (p.lon > maxLon) maxLon = p.lon
  }
  return { minLat, minLon, maxLat, maxLon }
}

type Outcome = 'ok' | 'skip' | 'fail'

function rerouteOne(
  db: DatabaseSync,
  segId: number,
  boxes: LatLonBBox[],
  effectivePoints: (id: number) => EditablePoint[]
): Outcome {
  const seg = db.prepare('SELECT type FROM segments WHERE id = ?').get(segId) as
    | { type: string }
    | undefined
  if (!seg) return 'fail'
  const pts = effectivePoints(segId)
  if (pts.length < 2) return 'skip'
  const guide: GuidePoint[] = pts.map((p) => ({ lon: p.lon, lat: p.lat }))
  const start = guide[0]!
  const end = guide[guide.length - 1]!
  if (!routeBoxesCover(boxes, [start, end])) return 'skip'

  const bbox = bboxOf(guide)
  const pad = Math.max(0.04, bbox.maxLat - bbox.minLat, bbox.maxLon - bbox.minLon)
  const loaded = loadRouteForBbox(db, {
    minLat: bbox.minLat - pad, minLon: bbox.minLon - pad,
    maxLat: bbox.maxLat + pad, maxLon: bbox.maxLon + pad
  })
  const edges = filterDriveEdges(loaded.edges, seg.type === 'bus')
  const emphasis = emphasisForDistanceDeg(guideLengthDeg(guide))
  const graph = buildGuidedDriveGraph(loaded.nodes, edges, guide, emphasis)
  const res = routeWaypoints(graph, [start, end], guideLengthDeg(guide))
  if ('error' in res) return 'fail'
  const coords = simplifyRoutePolyline(res.coords)
  if (coords.length < 4) return 'fail'

  const spliced = spliceRoute(pts, 0, pts.length - 1, coords)
  const overlay: SegmentEditInput[] = []
  // Serialize every non-null edit (route inserts + any prior 'move' kept on a
  // boundary vertex), mirroring MapController.buildOverlay — otherwise a moved
  // start/end point would revert when this draft replaces the old overlay.
  for (const p of spliced.points) {
    if (p.edit !== null) overlay.push({ seq: p.seq, lat: p.lat, lon: p.lon, kind: p.edit })
  }
  for (const d of spliced.deleted) overlay.push({ seq: d.seq, lat: d.lat, lon: d.lon, kind: 'delete' })
  saveSegmentEdits(db, segId, overlay, 'draft')
  return 'ok'
}

export async function bulkRerouteSegments(
  db: DatabaseSync,
  segmentIds: number[]
): Promise<BulkRerouteResult> {
  const ids = [...new Set(segmentIds)].filter((id) => Number.isInteger(id))
  const boxes = routeCoverageBoxes(db)
  if (boxes.length === 0) return { rerouted: 0, skipped: ids.length, failed: 0 }

  const effectivePoints = prepareEffectivePoints(db)
  const result: BulkRerouteResult = { rerouted: 0, skipped: 0, failed: 0 }
  let n = 0
  for (const id of ids) {
    try {
      const outcome = rerouteOne(db, id, boxes, effectivePoints)
      if (outcome === 'ok') result.rerouted++
      else if (outcome === 'skip') result.skipped++
      else result.failed++
    } catch {
      result.failed++
    }
    if (++n % 8 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return result
}
