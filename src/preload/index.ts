import { contextBridge, ipcRenderer } from 'electron'
import type { ArcApi, ImportProgress, RailMatchProgress } from '../shared/types'

const api: ArcApi = {
  selectPaths: (kind) => ipcRenderer.invoke('dialog:selectPaths', kind),
  startImport: (paths) => ipcRenderer.invoke('import:start', paths),
  onImportProgress: (cb) => {
    const handler = (_event: unknown, p: ImportProgress): void => cb(p)
    ipcRenderer.on('import:progress', handler)
    return () => ipcRenderer.removeListener('import:progress', handler)
  },
  queryViewport: (q) => ipcRenderer.invoke('query:viewport', q),
  getCategories: () => ipcRenderer.invoke('categories:get'),
  setCategoryVisible: (name, visible) =>
    ipcRenderer.invoke('categories:setVisible', name, visible),
  setCategoryColor: (name, color) =>
    ipcRenderer.invoke('categories:setColor', name, color),
  setCategoryOrder: (names) => ipcRenderer.invoke('categories:setOrder', names),
  getSummary: () => ipcRenderer.invoke('summary:get'),
  getDataBounds: () => ipcRenderer.invoke('bounds:get'),
  getConfig: () => ipcRenderer.invoke('app:getConfig'),
  setBasemapTheme: (theme) => ipcRenderer.invoke('settings:setBasemapTheme', theme),
  fetchRailNetwork: (bbox) => ipcRenderer.invoke('rail:fetch', bbox),
  rebuildRailMatches: () => ipcRenderer.invoke('rail:rebuildMatches'),
  setRailTuning: (t) => ipcRenderer.invoke('rail:setTuning', t),
  onRailProgress: (cb) => {
    const handler = (_event: unknown, p: RailMatchProgress): void => cb(p)
    ipcRenderer.on('rail:progress', handler)
    return () => ipcRenderer.removeListener('rail:progress', handler)
  },
  getRailCoverage: () => ipcRenderer.invoke('rail:coverage'),
  exportMapPng: (dataUrl) => ipcRenderer.invoke('export:png', dataUrl),
  getRecentPerf: (limit) => ipcRenderer.invoke('perf:recent', limit)
}

contextBridge.exposeInMainWorld('api', api)
