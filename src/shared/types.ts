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
  /**
   * Cleaning toggle: snap rail rides onto the fetched OSM rail network,
   * routing through tunnel gaps (display-only; needs a fetched network).
   */
  snapRail?: boolean
}

export interface LatLonBBox {
  minLat: number
  minLon: number
  maxLat: number
  maxLon: number
}

/** One fetched OSM rail region (a past viewport). */
export interface RailRegion {
  bbox: LatLonBBox
  fetchedAtMs: number
}

/**
 * Everything fetched so far. Regions accumulate one viewport at a time and
 * gate snapping: rides keep raw GPS wherever they leave fetched areas.
 */
export interface RailCoverage {
  regions: RailRegion[]
  nodeCount: number
  edgeCount: number
  /** Rail rides with cached map-matched geometry (built after each fetch). */
  matchedRides: number
  lastFetchedAtMs: number
}

/** Progress of the map-matching pass that runs after a rail fetch. */
export interface RailMatchProgress {
  done: number
  total: number
  matched: number
}

/**
 * User-tweakable matcher ranges (meters), persisted in settings.json under
 * `rail` and editable from the Cleaning panel. Changing them re-runs the
 * cached match pass.
 */
export interface RailTuning {
  /** Max distance from a GPS point to the track for it to anchor. */
  snapRadiusM: number
  /** Unconnected nodes within this link up so routing can cross at transfers. */
  transferRadiusM: number
}

export const DEFAULT_RAIL_TUNING: RailTuning = { snapRadiusM: 200, transferRadiusM: 60 }

/** Keep manual edits inside ranges the matcher behaves sanely in. */
export function clampRailTuning(t: Partial<RailTuning> | undefined): RailTuning {
  const num = (v: unknown, def: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def
  return {
    snapRadiusM: num(t?.snapRadiusM, DEFAULT_RAIL_TUNING.snapRadiusM, 20, 1000),
    transferRadiusM: num(t?.transferRadiusM, DEFAULT_RAIL_TUNING.transferRadiusM, 0, 500)
  }
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
  /** Rail segments snapped to the OSM network (0 = off/no coverage). */
  railSnapped: number
  /** Rail-typed segments seen by the snapper, so the UI can show "X of Y". */
  railRides: number
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
  /** Current matcher ranges, for the Cleaning panel inputs. */
  railTuning: RailTuning
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
  /** Persist type order; index 0 = top of the panel = drawn on top. */
  setCategoryOrder(names: string[]): Promise<void>
  getSummary(): Promise<DatasetSummary>
  getDataBounds(): Promise<DataBounds | null>
  getConfig(): Promise<AppConfig>
  /** Persists the basemap theme choice to settings.json. */
  setBasemapTheme(theme: 'dark' | 'light'): Promise<void>
  /** Saves a rendered map frame; the user picks the destination. */
  exportMapPng(dataUrl: string): Promise<{ saved: boolean; path?: string }>
  /**
   * Fetch OSM rail for the given (on-screen) bbox; regions accumulate. On
   * success the map-matched geometry is rebuilt (progress via onRailProgress),
   * so the returned coverage reflects the new matchedRides count.
   */
  fetchRailNetwork(bbox: LatLonBBox): Promise<{ ok: boolean; coverage?: RailCoverage; error?: string }>
  /** Re-run the match pass over all fetched coverage (e.g. when enabling snap). */
  rebuildRailMatches(): Promise<{ ok: boolean; coverage?: RailCoverage; error?: string }>
  /** Persist new matcher ranges and re-run the match pass with them. */
  setRailTuning(t: RailTuning): Promise<{ ok: boolean; coverage?: RailCoverage; error?: string }>
  /** Progress of the post-fetch / rebuild map-matching pass. */
  onRailProgress(cb: (p: RailMatchProgress) => void): () => void
  getRailCoverage(): Promise<RailCoverage | null>
  getRecentPerf(limit: number): Promise<PerfEntry[]>
}
