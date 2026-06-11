import { ipcMain, dialog, BrowserWindow } from 'electron'
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  queryViewportSegments,
  queryViewportWaypoints,
  getCategories,
  setCategoryVisible,
  setCategoryColor,
  getSummary,
  getDataBounds,
  getRecentPerf,
  insertPerf
} from './db/queries'
import { encodeGeometry, type EncodedSegment } from '../shared/geomCodec'
import { saveSettings, type AppSettings } from './settings'
import type { ImportProgress, ViewportQuery, ViewportResult } from '../shared/types'

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
    const { rows, truncated, detail, downsampleStride } = queryViewportSegments(
      ctx.db, q, ctx.settings.queryLimits
    )
    const wp = queryViewportWaypoints(ctx.db, q, ctx.settings.queryLimits.waypoints)
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
        ` places=${wp.waypoints.length}/${wp.totalCount}`
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
        waypointTotal: wp.totalCount
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
  ipcMain.handle('summary:get', () => getSummary(ctx.db))
  ipcMain.handle('bounds:get', () => getDataBounds(ctx.db))
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
}
