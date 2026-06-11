/**
 * Types shared across main process, preload, and renderer.
 * Pure types only — this module must stay importable from both Node and DOM
 * contexts.
 */
import type { DetailMode, ResolvedDetail } from './displayDetail'

/** Track line coloring: by activity type (default) or by calendar year. */
export type TrackColorMode = 'type' | 'year'

export interface CategoryInfo {
  name: string
  color: string
  visible: boolean
  ignored: boolean
  /** True when the user picked this color; exempt from palette refreshes. */
  custom: boolean
  segmentCount: number
  pointCount: number
}

export interface DatasetSummary {
  fileCount: number
  trackCount: number
  segmentCount: number
  pointCount: number
  waypointCount: number
  startTsMs: number | null
  endTsMs: number | null
}

export interface ViewportQuery {
  minLat: number
  maxLat: number
  minLon: number
  maxLon: number
  zoom: number
  /** Inclusive time-range filter; null means unbounded. */
  startTsMs: number | null
  endTsMs: number | null
  /** Geometry detail; omitted/'auto' follows zoom (shared/displayDetail). */
  detailMode?: DetailMode
  /**
   * Cleaning toggle: average repeat metro/tram rides between the same two
   * places into one consensus track (display-only).
   */
  averageRail?: boolean
}

export interface ViewportWaypoint {
  id: number
  lat: number
  lon: number
  tsMs: number | null
  name: string | null
}

export interface ViewportResultMeta {
  segmentCount: number
  pointCount: number
  /** SQLite query time in the main process. */
  queryMs: number
  /** Binary payload encode time in the main process. */
  encodeMs: number
  /** True when the segment safety cap was hit and results were truncated. */
  truncated: boolean
  /** Detail level served: a precomputed level, or 'raw' for all points. */
  detail: ResolvedDetail
  /** 1 = full detail; k > 1 = lines thinned to every k-th vertex (endpoints kept). */
  downsampleStride: number
  /** Places served to the map (after any spatial thinning). */
  waypointCount: number
  /** Distinct places matching the viewport (same-name visits merged), before thinning. */
  waypointTotal: number
  /** Rail segments collapsed into averaged consensus tracks (0 = off/none). */
  railAveraged: number
}

export interface ViewportResult {
  /** Binary track geometry; decode with shared/geomCodec. */
  buffer: ArrayBuffer
  waypoints: ViewportWaypoint[]
  meta: ViewportResultMeta
}

export interface ImportStats {
  filesProcessed: number
  filesSkipped: number
  filesFailed: number
  trackCount: number
  segmentCount: number
  pointCount: number
  waypointCount: number
  durationMs: number
}

export type ImportProgress =
  | { kind: 'started'; totalFiles: number }
  | {
      kind: 'file'
      index: number
      totalFiles: number
      filename: string
      skipped: boolean
      failed: boolean
      error?: string
      pointCount: number
      segmentCount: number
      durationMs: number
    }
  | { kind: 'done'; stats: ImportStats }
  | { kind: 'error'; error: string }

export interface PerfEntry {
  atMs: number
  op: string
  durationMs: number
  detail: string | null
}

export interface AppConfig {
  /** Style URL of the active theme. */
  basemapStyleUrl: string
  basemapTheme: 'dark' | 'light'
  /** Both theme styles, so the renderer can switch without a round trip. */
  basemapStyles: { dark: string; light: string }
  /** line-opacity applied to basemap road layers (1 = no dimming). */
  roadDimOpacity: number
  dbPath: string
  settingsPath: string
}

export interface DataBounds {
  minLat: number
  minLon: number
  maxLat: number
  maxLon: number
}

/** API exposed to the renderer via contextBridge (window.api). */
export interface ArcApi {
  selectPaths(kind: 'files' | 'folder'): Promise<string[] | null>
  startImport(paths: string[]): Promise<{ started: boolean; reason?: string }>
  onImportProgress(cb: (p: ImportProgress) => void): () => void
  queryViewport(q: ViewportQuery): Promise<ViewportResult>
  getCategories(): Promise<CategoryInfo[]>
  setCategoryVisible(name: string, visible: boolean): Promise<void>
  /** Hex color from the picker; null reverts to the default palette color. */
  setCategoryColor(name: string, color: string | null): Promise<void>
  getSummary(): Promise<DatasetSummary>
  getDataBounds(): Promise<DataBounds | null>
  getConfig(): Promise<AppConfig>
  /** Persists the basemap theme choice to settings.json. */
  setBasemapTheme(theme: 'dark' | 'light'): Promise<void>
  /** Saves a rendered map frame; the user picks the destination. */
  exportMapPng(dataUrl: string): Promise<{ saved: boolean; path?: string }>
  getRecentPerf(limit: number): Promise<PerfEntry[]>
}
