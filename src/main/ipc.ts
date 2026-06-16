import { ipcMain, dialog, BrowserWindow } from 'electron'
import { Worker } from 'node:worker_threads'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  queryViewportSegments,
  queryViewportWaypoints,
  getCategories,
  setCategoryVisible,
  setCategoryColor,
  setCategoryOrder,
  getSummary,
  getDatasetStats,
  getDataBounds,
  getRecentPerf,
  insertPerf
} from './db/queries'
import {
  mergePlaces,
  assignTrackToPlace,
  getPlaceStats,
  getPlaceMembers,
  renamePlace,
  separateVisits
} from './db/placeStore'
import { averageRailTracks } from './db/railAverage'
import { collectGpxFiles } from './importer/importFiles'
import { analyzeImportOverlap } from './importer/importOverlap'
import { RAIL_SNAP_TYPES, routeWaypoints, type RailGraph } from './rail/snapRail'
import {
  buildDriveGraph,
  buildGuidedDriveGraph,
  filterDriveEdges,
  guideLengthDeg,
  emphasisForDistanceDeg,
  simplifyRoutePolyline
} from './rail/roadRoute'
import { findSimilarSegments, type SimilarMode } from './db/similarSegments'
import { applyArchetypeToSegments } from './db/archetypeApply'
import { rebuildRailMatches, rematchSegment } from './rail/buildMatches'
import { fetchRailNetwork, fetchDriveNetwork } from './rail/overpass'
import { addRailNetwork, getRailCoverage, clearRailNetwork, clearRailNetworkData } from './db/railStore'
import {
  addRoadNetwork,
  getRouteCoverage,
  clearRouteNetwork,
  routeCoverageBoxes,
  routeBoxesCover,
  loadRouteForBbox
} from './db/routeStore'
import {
  getSegmentEditState,
  saveSegmentEdits,
  revertSegmentEdits,
  splitSegment,
  splitSegmentTyped,
  setSegmentType,
  deleteSegment,
  bulkDeleteSegments,
  segmentStartTs,
  listMergeCandidates,
  mergeSegments,
  hasMatchedGeom,
  listDraftSegmentIds,
  countDraftSegments,
  commitAllDrafts,
  revertAllDrafts
} from './db/editStore'
import { encodeGeometry, type EncodedSegment } from '../shared/geomCodec'
import { saveSettings, type AppSettings } from './settings'
import { clampRailTuning, type MergeAnchor, type OsmLayer, type PlaceRef } from '../shared/types'
import type {
  EditSaveMode,
  ImportOverlapAnalysis,
  ImportProgress,
  LatLonBBox,
  OverwriteWindow,
  RailTuning,
  RoutePoint,
  SegmentEditInput,
  ViewportQuery,
  ViewportResult
} from '../shared/types'

export interface IpcContext {
  db: DatabaseSync
  dbPath: string
  settings: AppSettings
  settingsPath: string
}

let activeImport: Worker | null = null

/**
 * Cached drivable graph for the reroute preview. Building it (and its corridor
 * weighting) from the stored road edges is the costly step, so dragging a via
 * pin (which re-routes live, with the span's corridor unchanged) reuses one
 * graph for a padded area instead of rebuilding each frame. Keyed by the
 * corridor guide too, so changing the span rebuilds. Invalidated whenever the
 * road network changes (fetch / clear).
 */
let routeGraphCache: { bbox: LatLonBBox; guideKey: string; graph: RailGraph } | null = null

/** Cheap identity of a corridor guide — span length + its endpoints. */
const guideSignature = (guide: ReadonlyArray<RoutePoint>): string => {
  if (guide.length === 0) return ''
  const a = guide[0]!
  const b = guide[guide.length - 1]!
  return `${guide.length}:${a.lat.toFixed(5)},${a.lon.toFixed(5)}:${b.lat.toFixed(5)},${b.lon.toFixed(5)}`
}

const bboxOfPoints = (pts: ReadonlyArray<RoutePoint>): LatLonBBox => {
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity
  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat
    if (p.lat > maxLat) maxLat = p.lat
    if (p.lon < minLon) minLon = p.lon
    if (p.lon > maxLon) maxLon = p.lon
  }
  return { minLat, minLon, maxLat, maxLon }
}

const bboxContains = (outer: LatLonBBox, inner: LatLonBBox): boolean =>
  inner.minLat >= outer.minLat && inner.maxLat <= outer.maxLat &&
  inner.minLon >= outer.minLon && inner.maxLon <= outer.maxLon

/**
 * A drivable graph covering the waypoints + the corridor guide, reusing the
 * cache when it still fits the same guide. The graph is corridor-weighted
 * toward the guide (the original track span) so the route follows it loosely.
 */
function routeGraphFor(
  db: DatabaseSync,
  waypoints: ReadonlyArray<RoutePoint>,
  guide: ReadonlyArray<RoutePoint>,
  emphasis: number,
  includeBus: boolean
): RailGraph {
  const wb = bboxOfPoints([...waypoints, ...guide])
  // The graph weighting depends on the corridor, the highway emphasis, and
  // whether bus-only ways are in play, so all three are in the key (emphasis
  // quantized so via-drags still hit the cache).
  const key = `${guideSignature(guide)}|e${Math.round(emphasis * 10)}|b${includeBus ? 1 : 0}`
  if (routeGraphCache && routeGraphCache.guideKey === key && bboxContains(routeGraphCache.bbox, wb)) {
    return routeGraphCache.graph
  }
  // Pad generously so (a) nearby pin drags keep reusing this graph and (b) the
  // best route has room to bow out past the waypoints' own box before the load
  // window clips it — at least ~4 km, or the span itself for a long reroute.
  const pad = Math.max(0.04, wb.maxLat - wb.minLat, wb.maxLon - wb.minLon)
  const load: LatLonBBox = {
    minLat: wb.minLat - pad, minLon: wb.minLon - pad,
    maxLat: wb.maxLat + pad, maxLon: wb.maxLon + pad
  }
  const loaded = loadRouteForBbox(db, load)
  const edges = filterDriveEdges(loaded.edges, includeBus)
  const graph =
    guide.length >= 2
      ? buildGuidedDriveGraph(loaded.nodes, edges, guide, emphasis)
      : buildDriveGraph(loaded.nodes, edges, emphasis)
  routeGraphCache = { bbox: load, guideKey: key, graph }
  return graph
}

/** A place reference from the renderer: a merged place id, or a visit's id. */
const validPlaceRef = (r: unknown): r is PlaceRef =>
  !!r &&
  typeof r === 'object' &&
  (('placeId' in r && Number.isInteger((r as { placeId: unknown }).placeId)) ||
    ('waypointId' in r && Number.isInteger((r as { waypointId: unknown }).waypointId)))

export function registerIpc(ctx: IpcContext): void {
  ipcMain.handle('dialog:selectPaths', async (event, kind: 'files' | 'folder') => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: kind === 'folder' ? 'Select folder of GPX exports' : 'Select GPX files',
      properties:
        kind === 'folder'
          ? ['openDirectory']
          : ['openFile', 'multiSelections'],
      filters: kind === 'files' ? [{ name: 'GPX', extensions: ['gpx'] }] : []
    })
    return result.canceled ? null : result.filePaths
  })

  ipcMain.handle('import:analyzeOverlap', (_event, paths: string[]): ImportOverlapAnalysis => {
    if (!Array.isArray(paths) || paths.length === 0) return { totalFiles: 0, overlaps: [] }
    return analyzeImportOverlap(ctx.db, collectGpxFiles(paths))
  })

  ipcMain.handle('import:start', (event, paths: string[], overwrite?: OverwriteWindow[]) => {
    if (activeImport) {
      return { started: false, reason: 'an import is already running' }
    }
    if (!Array.isArray(paths) || paths.length === 0) {
      return { started: false, reason: 'no paths selected' }
    }
    const windows = Array.isArray(overwrite)
      ? overwrite.filter(
          (w) => w && Number.isFinite(w.startTsMs) && Number.isFinite(w.endTsMs) && w.endTsMs >= w.startTsMs
        )
      : []
    const sender = event.sender

    // Parsing/indexing runs in a worker thread with its own DB connection
    // (WAL) so the main process and renderer stay responsive throughout.
    const worker = new Worker(join(__dirname, 'importWorker.js'), {
      workerData: { dbPath: ctx.dbPath, paths, cleaning: ctx.settings.cleaning, overwrite: windows }
    })
    activeImport = worker

    const send = (p: ImportProgress): void => {
      if (!sender.isDestroyed()) sender.send('import:progress', p)
    }
    worker.on('message', (p: ImportProgress) => {
      send(p)
      if (p.kind === 'done' || p.kind === 'error') {
        activeImport = null
      }
    })
    worker.on('error', (err) => {
      send({ kind: 'error', error: err.message })
      activeImport = null
    })
    worker.on('exit', () => {
      activeImport = null
    })
    return { started: true }
  })

  ipcMain.handle('query:viewport', (_event, q: ViewportQuery): ViewportResult => {
    const t0 = performance.now()
    const queried = queryViewportSegments(ctx.db, q, ctx.settings.queryLimits)
    const { truncated, detail, downsampleStride } = queried
    const wp = queryViewportWaypoints(ctx.db, q, ctx.settings.queryLimits.waypoints)

    // Snap mode substitutes cached map-matched geometry inside the query, so
    // here we just tally how many rail rides were served from it. Snapping
    // supersedes averaging — averaging the already-snapped lines would only
    // re-blur them — so the two are mutually exclusive.
    let rows = queried.rows
    let railRides = 0
    let railSnapped = 0
    if (q.snapRail) {
      for (const r of rows) {
        if (!RAIL_SNAP_TYPES.has(r.type)) continue
        railRides++
        if (r._matched) railSnapped++
      }
    }
    const rail =
      q.averageRail && !q.snapRail ? averageRailTracks(rows, wp.waypoints) : { rows, collapsed: 0 }
    rows = rail.rows
    const queryMs = performance.now() - t0

    const tEncode = performance.now()
    const typeTable: string[] = []
    const typeIndex = new Map<string, number>()
    let pointCount = 0
    const segments: EncodedSegment[] = rows.map((r) => {
      let idx = typeIndex.get(r.type)
      if (idx === undefined) {
        idx = typeTable.length
        typeTable.push(r.type)
        typeIndex.set(r.type, idx)
      }
      pointCount += r.point_count
      // Blobs from SQLite are byte-aligned copies; realign for Float32 view.
      const coords =
        r.coords.byteOffset % 4 === 0
          ? new Float32Array(r.coords.buffer, r.coords.byteOffset, r.coords.byteLength / 4)
          : new Float32Array(r.coords.slice().buffer)
      const year = r.start_ts_ms == null ? 0 : new Date(r.start_ts_ms).getUTCFullYear()
      return { id: r.id, typeIndex: idx, year, coords }
    })
    const buffer = encodeGeometry(typeTable, segments)
    const encodeMs = performance.now() - tEncode

    insertPerf(
      ctx.db, 'query.viewport', queryMs,
      `segments=${rows.length} points=${pointCount} detail=${detail} stride=${downsampleStride}` +
        ` places=${wp.waypoints.length}/${wp.totalCount} railAvg=${rail.collapsed}` +
        ` railSnap=${railSnapped}/${railRides}`
    )

    return {
      buffer,
      waypoints: wp.waypoints,
      meta: {
        segmentCount: rows.length,
        pointCount,
        queryMs,
        encodeMs,
        truncated,
        detail,
        downsampleStride,
        waypointCount: wp.waypoints.length,
        waypointTotal: wp.totalCount,
        railAveraged: rail.collapsed,
        railSnapped,
        railRides
      }
    }
  })

  ipcMain.handle('categories:get', () => getCategories(ctx.db))
  ipcMain.handle('categories:setVisible', (_e, name: string, visible: boolean) => {
    setCategoryVisible(ctx.db, name, visible)
  })
  ipcMain.handle('categories:setColor', (_e, name: string, color: string | null) => {
    setCategoryColor(ctx.db, name, color)
  })
  ipcMain.handle('categories:setOrder', (_e, names: string[]) => {
    if (Array.isArray(names) && names.every((n) => typeof n === 'string')) {
      setCategoryOrder(ctx.db, names)
    }
  })
  // An edit/split/merge drops a segment's cached snap geometry. If it had one,
  // re-match just the affected segment(s) so an already-snapped rail/metro/tram
  // ride (or bridged road trip) stays snapped without a full dataset pass.
  const reSnap = (hadSnap: boolean, ...segmentIds: number[]): void => {
    if (!hadSnap) return
    const t0 = performance.now()
    for (const id of segmentIds) rematchSegment(ctx.db, id, ctx.settings.rail)
    insertPerf(ctx.db, 'rail.rematch', performance.now() - t0, `segments=${segmentIds.join(',')}`)
  }

  ipcMain.handle('edits:getSegment', (_e, segmentId: number) =>
    Number.isInteger(segmentId) ? getSegmentEditState(ctx.db, segmentId) : null
  )
  ipcMain.handle(
    'edits:save',
    (_e, segmentId: number, edits: SegmentEditInput[], mode: EditSaveMode) => {
      try {
        if (!Number.isInteger(segmentId) || !Array.isArray(edits)) {
          return { ok: false, error: 'invalid edit payload' }
        }
        const hadSnap = hasMatchedGeom(ctx.db, segmentId)
        saveSegmentEdits(ctx.db, segmentId, edits, mode === 'permanent' ? 'permanent' : 'draft')
        reSnap(hadSnap, segmentId)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
  ipcMain.handle('edits:revert', (_e, segmentId: number) => {
    try {
      if (!Number.isInteger(segmentId)) return { ok: false, error: 'invalid segment id' }
      revertSegmentEdits(ctx.db, segmentId)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('edits:countDrafts', () => countDraftSegments(ctx.db))
  // Bake every draft into its track's points permanently (bulk "save all").
  // Re-snap the segments that were snapped, mirroring per-segment permanent saves.
  ipcMain.handle('edits:commitAllDrafts', () => {
    try {
      const snapped = listDraftSegmentIds(ctx.db).filter((id) => hasMatchedGeom(ctx.db, id))
      const committed = commitAllDrafts(ctx.db)
      reSnap(snapped.length > 0, ...snapped)
      return { ok: true, count: committed.length }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  // Drop every draft, restoring originals (bulk "revert"). Like the per-segment
  // revert, snapped geometry is dropped and left for a fresh match pass.
  ipcMain.handle('edits:revertAllDrafts', () => {
    try {
      const reverted = revertAllDrafts(ctx.db)
      return { ok: true, count: reverted.length }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('edits:setType', (_e, segmentId: number, type: string) => {
    try {
      if (!Number.isInteger(segmentId) || typeof type !== 'string') {
        return { ok: false, error: 'invalid type change' }
      }
      // The match graph is type-specific; re-snap with the new type if it had one.
      const hadSnap = hasMatchedGeom(ctx.db, segmentId)
      setSegmentType(ctx.db, segmentId, type)
      reSnap(hadSnap, segmentId)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('edits:deleteSegment', (_e, segmentId: number) => {
    try {
      if (!Number.isInteger(segmentId)) return { ok: false, error: 'invalid segment id' }
      deleteSegment(ctx.db, segmentId)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  // Bulk cleaning: select similar tracks, then reroute or delete them en masse.
  ipcMain.handle('edits:findSimilar', (_e, segmentId: number, radiusM: number, mode: SimilarMode) => {
    if (!Number.isInteger(segmentId) || !Number.isFinite(radiusM) || radiusM <= 0) return []
    const m: SimilarMode = mode === 'passthrough' ? 'passthrough' : 'endpoints'
    return findSimilarSegments(ctx.db, segmentId, Math.min(radiusM, 5000), m)
  })
  ipcMain.handle('edits:bulkDelete', (_e, segmentIds: number[]) => {
    try {
      if (!Array.isArray(segmentIds) || !segmentIds.every((id) => Number.isInteger(id))) {
        return { ok: false, error: 'invalid bulk delete request' }
      }
      return { ok: true, count: bulkDeleteSegments(ctx.db, segmentIds) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('edits:applyArchetype', async (_e, archetypeId: number, segmentIds: number[]) => {
    try {
      if (
        !Number.isInteger(archetypeId) ||
        !Array.isArray(segmentIds) ||
        !segmentIds.every((id) => Number.isInteger(id))
      ) {
        return { ok: false, error: 'invalid apply request' }
      }
      const t0 = performance.now()
      const result = await applyArchetypeToSegments(ctx.db, archetypeId, segmentIds)
      insertPerf(
        ctx.db, 'edits.applyArchetype', performance.now() - t0,
        `applied=${result.applied} skipped=${result.skipped} failed=${result.failed}`
      )
      return { ok: true, result }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('edits:split', (_e, segmentId: number, seq: number) => {
    try {
      if (!Number.isInteger(segmentId) || !Number.isFinite(seq)) {
        return { ok: false, error: 'invalid split request' }
      }
      const hadSnap = hasMatchedGeom(ctx.db, segmentId)
      const newSegmentId = splitSegment(ctx.db, segmentId, seq)
      reSnap(hadSnap, segmentId, newSegmentId)
      return { ok: true, newSegmentId }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(
    'edits:splitTyped',
    (_e, segmentId: number, seq: number, firstType: string, secondType: string) => {
      try {
        if (
          !Number.isInteger(segmentId) ||
          !Number.isFinite(seq) ||
          typeof firstType !== 'string' ||
          typeof secondType !== 'string'
        ) {
          return { ok: false, error: 'invalid split request' }
        }
        const hadSnap = hasMatchedGeom(ctx.db, segmentId)
        const newSegmentId = splitSegmentTyped(ctx.db, segmentId, seq, firstType, secondType)
        reSnap(hadSnap, segmentId, newSegmentId)
        return { ok: true, newSegmentId }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
  ipcMain.handle('edits:mergeCandidates', (_e, anchor: MergeAnchor, windowMs?: number) => {
    const ts =
      anchor && 'segmentId' in anchor && Number.isInteger(anchor.segmentId)
        ? segmentStartTs(ctx.db, anchor.segmentId)
        : anchor && 'tsMs' in anchor && Number.isFinite(anchor.tsMs)
          ? anchor.tsMs
          : null
    if (ts === null) return []
    return listMergeCandidates(ctx.db, ts, typeof windowMs === 'number' ? windowMs : undefined)
  })
  ipcMain.handle('edits:merge', (_e, segmentIds: number[], type: string) => {
    try {
      if (!Array.isArray(segmentIds) || !segmentIds.every((id) => Number.isInteger(id))) {
        return { ok: false, error: 'invalid merge request' }
      }
      const hadSnap = segmentIds.some((id) => hasMatchedGeom(ctx.db, id))
      const mergedId = mergeSegments(ctx.db, segmentIds, type)
      reSnap(hadSnap, mergedId)
      return { ok: true, mergedId }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('places:merge', (_e, refs: PlaceRef[], name: string) => {
    try {
      if (!Array.isArray(refs) || !refs.every(validPlaceRef) || typeof name !== 'string') {
        return { ok: false, error: 'invalid merge request' }
      }
      const placeId = mergePlaces(ctx.db, refs, name)
      return { ok: true, placeId }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('places:assignTrack', (_e, segmentId: number, ref: PlaceRef) => {
    try {
      if (!Number.isInteger(segmentId) || !validPlaceRef(ref)) {
        return { ok: false, error: 'invalid assign request' }
      }
      assignTrackToPlace(ctx.db, segmentId, ref)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('places:stats', (_e, ref: PlaceRef) =>
    validPlaceRef(ref) ? getPlaceStats(ctx.db, ref) : null
  )
  ipcMain.handle('places:members', (_e, ref: PlaceRef) =>
    validPlaceRef(ref) ? getPlaceMembers(ctx.db, ref) : null
  )
  ipcMain.handle('places:rename', (_e, ref: PlaceRef, name: string) => {
    try {
      if (!validPlaceRef(ref) || typeof name !== 'string') {
        return { ok: false, error: 'invalid rename request' }
      }
      const placeId = renamePlace(ctx.db, ref, name)
      return { ok: true, placeId }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('places:separate', (_e, visitIds: number[]) => {
    try {
      if (!Array.isArray(visitIds) || !visitIds.every((id) => Number.isInteger(id))) {
        return { ok: false, error: 'invalid separate request' }
      }
      separateVisits(ctx.db, visitIds)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('stats:dataset', () => getDatasetStats(ctx.db))
  ipcMain.handle('summary:get', () => getSummary(ctx.db))
  ipcMain.handle('bounds:get', () => getDataBounds(ctx.db))
  ipcMain.handle('rail:coverage', () => getRailCoverage(ctx.db))

  /** One match pass with the current tuning, streaming progress to `sender`. */
  const runMatchPass = async (sender: Electron.WebContents): Promise<void> => {
    const t0 = performance.now()
    const { matched, railSegments } = await rebuildRailMatches(ctx.db, ctx.settings.rail, (p) => {
      if (!sender.isDestroyed()) sender.send('rail:progress', p)
    })
    insertPerf(ctx.db, 'rail.match', performance.now() - t0, `matched=${matched}/${railSegments}`)
  }

  ipcMain.handle('rail:fetch', async (event, view: LatLonBBox, layer: OsmLayer) => {
    const nums = [view?.minLat, view?.maxLat, view?.minLon, view?.maxLon]
    if (nums.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      return { ok: false, error: 'no view to fetch' }
    }
    const osmLayer: OsmLayer = layer === 'road' ? 'road' : 'rail'
    // City-sized fetches only: Overpass times out (and the local graph
    // balloons) on continent-scale data. Load cities one view at a time.
    const MAX_SPAN_DEG = 4
    if (view.maxLat - view.minLat > MAX_SPAN_DEG || view.maxLon - view.minLon > MAX_SPAN_DEG) {
      return { ok: false, error: 'view too large — zoom in to one city and fetch areas individually' }
    }
    // Small margin so rides ending just off-screen still match.
    const pad = 0.02
    const bbox = {
      minLat: Math.max(-90, view.minLat - pad), minLon: Math.max(-180, view.minLon - pad),
      maxLat: Math.min(90, view.maxLat + pad), maxLon: Math.min(180, view.maxLon + pad)
    }
    try {
      const fetched = await fetchRailNetwork(bbox, osmLayer)
      addRailNetwork(ctx.db, fetched, bbox, osmLayer)
      // Cache matched/bridged geometry for the new coverage (progress to UI).
      await runMatchPass(event.sender)
      return { ok: true, coverage: getRailCoverage(ctx.db) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('rail:clear', (_e, keepMatched?: boolean) => {
    // keepMatched drops the bulky network but keeps the cached snapped
    // geometry, so already-matched rides keep rendering from cache.
    if (keepMatched) clearRailNetworkData(ctx.db)
    else clearRailNetwork(ctx.db)
    return { ok: true }
  })
  ipcMain.handle('rail:rebuildMatches', async (event) => {
    try {
      await runMatchPass(event.sender)
      return { ok: true, coverage: getRailCoverage(ctx.db) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('rail:setTuning', async (event, t: RailTuning) => {
    try {
      ctx.settings.rail = clampRailTuning(t)
      saveSettings(ctx.settingsPath, ctx.settings)
      await runMatchPass(event.sender)
      return { ok: true, coverage: getRailCoverage(ctx.db) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  // --- Drivable road network (manual reroute tool) -------------------------
  ipcMain.handle('route:fetch', async (_event, view: LatLonBBox) => {
    const nums = [view?.minLat, view?.maxLat, view?.minLon, view?.maxLon]
    if (nums.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      return { ok: false, error: 'no view to fetch' }
    }
    // Roads are far denser than rail, so keep fetches small: a whole city of
    // full road geometry already strains Overpass. Fetch area by area.
    const MAX_SPAN_DEG = 2
    if (view.maxLat - view.minLat > MAX_SPAN_DEG || view.maxLon - view.minLon > MAX_SPAN_DEG) {
      return { ok: false, error: 'view too large — zoom in and fetch roads area by area' }
    }
    const pad = 0.01
    const bbox = {
      minLat: Math.max(-90, view.minLat - pad), minLon: Math.max(-180, view.minLon - pad),
      maxLat: Math.min(90, view.maxLat + pad), maxLon: Math.min(180, view.maxLon + pad)
    }
    try {
      const t0 = performance.now()
      const fetched = await fetchDriveNetwork(bbox)
      const coverage = addRoadNetwork(ctx.db, fetched, bbox)
      routeGraphCache = null // network changed
      insertPerf(ctx.db, 'route.fetch', performance.now() - t0, `edges=${coverage.edgeCount}`)
      return { ok: true, coverage }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('route:coverage', () => getRouteCoverage(ctx.db))
  ipcMain.handle('route:clear', () => {
    clearRouteNetwork(ctx.db)
    routeGraphCache = null
    return { ok: true }
  })
  ipcMain.handle(
    'route:preview',
    (_e, waypoints: RoutePoint[], guide?: RoutePoint[], useGuideCorridor?: boolean, type?: string) => {
      try {
        const validPt = (w: RoutePoint): boolean => !!w && Number.isFinite(w.lat) && Number.isFinite(w.lon)
        if (!Array.isArray(waypoints) || waypoints.length < 2 || !waypoints.every(validPt)) {
          return { ok: false, error: 'need at least two valid points to route' }
        }
        const span = Array.isArray(guide) ? guide.filter(validPt) : []
        const boxes = routeCoverageBoxes(ctx.db)
        if (boxes.length === 0) {
          return { ok: false, error: 'no driving roads fetched — fetch them in view first (separate from “road tunnels”)' }
        }
        if (!routeBoxesCover(boxes, waypoints)) {
          return { ok: false, error: 'part of this route is outside the fetched roads — zoom out to the whole route and fetch driving roads again' }
        }
        // Highway emphasis scales with the trip's length (always — even when the
        // corridor is off, long legs through the vias still funnel onto highways).
        const emphasis = emphasisForDistanceDeg(
          Math.max(guideLengthDeg(span), guideLengthDeg(waypoints))
        )
        // The GPS span is a *loose corridor* only for the first estimate; once
        // the user starts dragging vias it's dropped so the drags take over.
        const corridor = useGuideCorridor === false ? [] : span
        const includeBus = type === 'bus'
        const t0 = performance.now()
        const graph = routeGraphFor(ctx.db, waypoints, corridor, emphasis, includeBus)
        const res = routeWaypoints(graph, waypoints, guideLengthDeg(corridor))
        insertPerf(
          ctx.db, 'route.preview', performance.now() - t0,
          `points=${waypoints.length} emphasis=${emphasis.toFixed(1)} corridor=${corridor.length > 0} bus=${includeBus}`
        )
        if ('error' in res) return { ok: false, error: res.error }
        return { ok: true, coords: simplifyRoutePolyline(res.coords) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('perf:recent', (_e, limit: number) => getRecentPerf(ctx.db, Math.min(limit, 200)))
  ipcMain.handle('app:getConfig', () => ({
    basemapStyleUrl:
      ctx.settings.basemapTheme === 'light'
        ? ctx.settings.basemapStyleUrlLight
        : ctx.settings.basemapStyleUrl,
    basemapTheme: ctx.settings.basemapTheme,
    basemapStyles: {
      dark: ctx.settings.basemapStyleUrl,
      light: ctx.settings.basemapStyleUrlLight
    },
    roadDimOpacity: ctx.settings.roadDimOpacity,
    railTuning: ctx.settings.rail,
    dbPath: ctx.dbPath,
    settingsPath: ctx.settingsPath
  }))
  ipcMain.handle('settings:setBasemapTheme', (_e, theme: 'dark' | 'light') => {
    ctx.settings.basemapTheme = theme === 'light' ? 'light' : 'dark'
    saveSettings(ctx.settingsPath, ctx.settings)
  })
  ipcMain.handle('export:png', async (event, dataUrl: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const prefix = 'data:image/png;base64,'
    if (!win || !dataUrl.startsWith(prefix)) return { saved: false }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    const result = await dialog.showSaveDialog(win, {
      title: 'Export map as PNG',
      defaultPath: `arc-map-${stamp}.png`,
      filters: [{ name: 'PNG image', extensions: ['png'] }]
    })
    if (result.canceled || !result.filePath) return { saved: false }
    writeFileSync(result.filePath, Buffer.from(dataUrl.slice(prefix.length), 'base64'))
    return { saved: true, path: result.filePath }
  })
}
