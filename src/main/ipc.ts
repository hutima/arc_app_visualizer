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
  getDataBounds,
  getRecentPerf,
  insertPerf
} from './db/queries'
import { averageRailTracks } from './db/railAverage'
import { RAIL_SNAP_TYPES } from './rail/snapRail'
import { rebuildRailMatches } from './rail/buildMatches'
import { fetchRailNetwork } from './rail/overpass'
import { addRailNetwork, getRailCoverage, clearRailNetwork } from './db/railStore'
import {
  getSegmentEditState,
  saveSegmentEdits,
  revertSegmentEdits,
  splitSegment,
  splitSegmentTyped,
  segmentStartTs,
  listMergeCandidates,
  mergeSegments
} from './db/editStore'
import { encodeGeometry, type EncodedSegment } from '../shared/geomCodec'
import { saveSettings, type AppSettings } from './settings'
import { clampRailTuning, type MergeAnchor, type OsmLayer } from '../shared/types'
import type {
  EditSaveMode,
  ImportProgress,
  LatLonBBox,
  RailTuning,
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

  ipcMain.handle('import:start', (event, paths: string[]) => {
    if (activeImport) {
      return { started: false, reason: 'an import is already running' }
    }
    if (!Array.isArray(paths) || paths.length === 0) {
      return { started: false, reason: 'no paths selected' }
    }
    const sender = event.sender

    // Parsing/indexing runs in a worker thread with its own DB connection
    // (WAL) so the main process and renderer stay responsive throughout.
    const worker = new Worker(join(__dirname, 'importWorker.js'), {
      workerData: { dbPath: ctx.dbPath, paths, cleaning: ctx.settings.cleaning }
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
        saveSegmentEdits(ctx.db, segmentId, edits, mode === 'permanent' ? 'permanent' : 'draft')
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
  ipcMain.handle('edits:split', (_e, segmentId: number, seq: number) => {
    try {
      if (!Number.isInteger(segmentId) || !Number.isFinite(seq)) {
        return { ok: false, error: 'invalid split request' }
      }
      const newSegmentId = splitSegment(ctx.db, segmentId, seq)
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
        const newSegmentId = splitSegmentTyped(ctx.db, segmentId, seq, firstType, secondType)
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
      const mergedId = mergeSegments(ctx.db, segmentIds, type)
      return { ok: true, mergedId }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
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
  ipcMain.handle('rail:clear', () => {
    clearRailNetwork(ctx.db)
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
