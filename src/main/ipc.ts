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
import { buildRailGraph, snapRailTracks } from './rail/snapRail'
import { fetchRailNetwork } from './rail/overpass'
import { addRailNetwork, getRailCoverage, loadRailForViewport } from './db/railStore'
import { encodeGeometry, type EncodedSegment } from '../shared/geomCodec'
import { saveSettings, type AppSettings } from './settings'
import type { ImportProgress, LatLonBBox, ViewportQuery, ViewportResult } from '../shared/types'

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

    // Cleaning (display-only). Snapping to OSM rail supersedes averaging for
    // rail rides — snapped rides already coincide on the real alignment.
    let rows = queried.rows
    let railSnapped = 0
    if (q.snapRail) {
      const net = loadRailForViewport(ctx.db, q)
      if (net.edges.length > 0) {
        // Coverage gate: only vertices inside a fetched region snap; the rest
        // of a ride keeps raw GPS (rail is fetched one viewport at a time).
        const boxes = (getRailCoverage(ctx.db)?.regions ?? []).map((r) => r.bbox)
        const isCovered = (lon: number, lat: number): boolean =>
          boxes.some(
            (b) => lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon
          )
        const result = snapRailTracks(rows, buildRailGraph(net.nodes, net.edges), isCovered)
        rows = result.rows
        railSnapped = result.snapped
      }
    }
    const rail = q.averageRail
      ? averageRailTracks(rows, wp.waypoints)
      : { rows, collapsed: 0 }
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
        ` places=${wp.waypoints.length}/${wp.totalCount} railAvg=${rail.collapsed} railSnap=${railSnapped}`
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
        railSnapped
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
  ipcMain.handle('summary:get', () => getSummary(ctx.db))
  ipcMain.handle('bounds:get', () => getDataBounds(ctx.db))
  ipcMain.handle('rail:coverage', () => getRailCoverage(ctx.db))
  ipcMain.handle('rail:fetch', async (_e, view: LatLonBBox) => {
    const nums = [view?.minLat, view?.maxLat, view?.minLon, view?.maxLon]
    if (nums.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      return { ok: false, error: 'no view to fetch' }
    }
    // City-sized fetches only: Overpass times out (and the local graph
    // balloons) on continent-scale rail. Load cities one view at a time.
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
      const rail = await fetchRailNetwork(bbox)
      const coverage = addRailNetwork(ctx.db, rail, bbox)
      return { ok: true, coverage }
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
