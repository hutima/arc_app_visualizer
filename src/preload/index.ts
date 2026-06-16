import { contextBridge, ipcRenderer } from 'electron'
import type { ArcApi, ImportProgress, RailMatchProgress } from '../shared/types'

const api: ArcApi = {
  selectPaths: (kind) => ipcRenderer.invoke('dialog:selectPaths', kind),
  startImport: (paths, overwrite) => ipcRenderer.invoke('import:start', paths, overwrite),
  analyzeImportOverlap: (paths) => ipcRenderer.invoke('import:analyzeOverlap', paths),
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
  fetchRailNetwork: (bbox, layer) => ipcRenderer.invoke('rail:fetch', bbox, layer),
  rebuildRailMatches: () => ipcRenderer.invoke('rail:rebuildMatches'),
  setRailTuning: (t) => ipcRenderer.invoke('rail:setTuning', t),
  clearRailNetwork: (keepMatched) => ipcRenderer.invoke('rail:clear', keepMatched),
  fetchRouteNetwork: (bbox) => ipcRenderer.invoke('route:fetch', bbox),
  getRouteCoverage: () => ipcRenderer.invoke('route:coverage'),
  clearRouteNetwork: () => ipcRenderer.invoke('route:clear'),
  previewRoadRoute: (waypoints, guide, useGuideCorridor, type) =>
    ipcRenderer.invoke('route:preview', waypoints, guide, useGuideCorridor, type),
  onRailProgress: (cb) => {
    const handler = (_event: unknown, p: RailMatchProgress): void => cb(p)
    ipcRenderer.on('rail:progress', handler)
    return () => ipcRenderer.removeListener('rail:progress', handler)
  },
  getRailCoverage: () => ipcRenderer.invoke('rail:coverage'),
  exportMapPng: (dataUrl) => ipcRenderer.invoke('export:png', dataUrl),
  getRecentPerf: (limit) => ipcRenderer.invoke('perf:recent', limit),
  getSegmentEditState: (segmentId) => ipcRenderer.invoke('edits:getSegment', segmentId),
  saveSegmentEdits: (segmentId, edits, mode) =>
    ipcRenderer.invoke('edits:save', segmentId, edits, mode),
  revertSegmentEdits: (segmentId) => ipcRenderer.invoke('edits:revert', segmentId),
  countDraftSegments: () => ipcRenderer.invoke('edits:countDrafts'),
  commitAllDrafts: () => ipcRenderer.invoke('edits:commitAllDrafts'),
  revertAllDrafts: () => ipcRenderer.invoke('edits:revertAllDrafts'),
  setSegmentType: (segmentId, type) => ipcRenderer.invoke('edits:setType', segmentId, type),
  deleteSegment: (segmentId) => ipcRenderer.invoke('edits:deleteSegment', segmentId),
  findSimilarSegments: (segmentId, radiusM, mode) =>
    ipcRenderer.invoke('edits:findSimilar', segmentId, radiusM, mode),
  bulkRerouteSegments: (segmentIds) => ipcRenderer.invoke('edits:bulkReroute', segmentIds),
  bulkDeleteSegments: (segmentIds) => ipcRenderer.invoke('edits:bulkDelete', segmentIds),
  applyArchetypeToSegments: (archetypeId, segmentIds) =>
    ipcRenderer.invoke('edits:applyArchetype', archetypeId, segmentIds),
  splitSegment: (segmentId, seq) => ipcRenderer.invoke('edits:split', segmentId, seq),
  splitSegmentTyped: (segmentId, seq, firstType, secondType) =>
    ipcRenderer.invoke('edits:splitTyped', segmentId, seq, firstType, secondType),
  listMergeCandidates: (anchor, windowMs) =>
    ipcRenderer.invoke('edits:mergeCandidates', anchor, windowMs),
  mergeSegments: (segmentIds, type) => ipcRenderer.invoke('edits:merge', segmentIds, type),
  mergePlaces: (refs, name) => ipcRenderer.invoke('places:merge', refs, name),
  assignTrackToPlace: (segmentId, ref) =>
    ipcRenderer.invoke('places:assignTrack', segmentId, ref),
  getPlaceStats: (ref) => ipcRenderer.invoke('places:stats', ref),
  getPlaceMembers: (ref) => ipcRenderer.invoke('places:members', ref),
  renamePlace: (ref, name) => ipcRenderer.invoke('places:rename', ref, name),
  separateVisits: (visitIds) => ipcRenderer.invoke('places:separate', visitIds),
  getDatasetStats: () => ipcRenderer.invoke('stats:dataset')
}

contextBridge.exposeInMainWorld('api', api)
