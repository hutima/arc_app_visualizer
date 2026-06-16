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
   * routing through tunnel gaps (display-only; needs a fetched rail layer).
   */
  snapRail?: boolean
  /**
   * Cleaning toggle: bridge car/taxi/bus GPS dropouts through fetched OSM
   * road tunnels (display-only; needs a fetched road layer).
   */
  snapRoad?: boolean
}

export interface LatLonBBox {
  minLat: number
  minLon: number
  maxLat: number
  maxLon: number
}

/**
 * The two OSM layers, fetched and gated independently: `rail` (subway/tram/
 * commuter geometry, fully map-matched for metro/tram/train rides) and `road`
 * (highway tunnels only, used to bridge car/taxi/bus GPS gaps).
 */
export type OsmLayer = 'rail' | 'road'

/** One fetched OSM region (a past viewport), tagged with its layer. */
export interface RailRegion {
  bbox: LatLonBBox
  fetchedAtMs: number
  layer: OsmLayer
}

/**
 * Everything fetched so far. Regions accumulate one viewport at a time, per
 * layer, and gate matching: rides keep raw GPS wherever they leave their
 * layer's fetched areas.
 */
export interface RailCoverage {
  regions: RailRegion[]
  nodeCount: number
  edgeCount: number
  /** Rail rides + car trips with cached matched/bridged geometry. */
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
 * Coverage of the drivable OSM road network fetched for the manual reroute
 * tool. Separate from RailCoverage: this network is only routed on demand, not
 * bulk map-matched, so there's no cached-geometry count here.
 */
export interface RouteCoverage {
  regions: LatLonBBox[]
  nodeCount: number
  edgeCount: number
  lastFetchedAtMs: number
}

/** One waypoint a road route must pass through (track endpoint or a via pin). */
export interface RoutePoint {
  lat: number
  lon: number
}

/**
 * A computed road route for the reroute preview: the snapped polyline as
 * interleaved [lon, lat, …] pairs (already simplified for display + draft).
 */
export interface RoutePreviewResult {
  ok: boolean
  /** Interleaved lon,lat pairs from the first waypoint's anchor to the last. */
  coords?: number[]
  /**
   * True when no clean arterial route existed and the result instead follows
   * the GPS track shape, snapped to the nearest roads (the matchTrackToRoads
   * fallback) — the UI tells the user so they know it tracks their GPS.
   */
  followedTrack?: boolean
  error?: string
}

/**
 * How "select similar tracks" matches an anchor (always same type +
 * direction-aware): 'endpoints' = the candidate's own start/end are within the
 * radius; 'passthrough' = it has a point near the start then, later, near the end.
 */
export type SimilarMode = 'endpoints' | 'passthrough'

/** Outcome of stamping an archetype's shape across a selection of tracks. */
export interface BulkApplyResult {
  /** Tracks stamped (as drafts). */
  applied: number
  /** Tracks left untouched (too few points, or the archetype itself). */
  skipped: number
  /** Tracks that errored mid-apply. */
  failed: number
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

/** How an overlay row relates to the raw track. */
export type EditKind = 'move' | 'insert' | 'delete'

/**
 * One vertex of a segment being edited. Raw points keep their integer seq;
 * user-inserted points sit between neighbors at fractional seqs. `edit` is
 * null for untouched raw points (deletes never appear — they're absent).
 */
export interface EditablePoint {
  seq: number
  lat: number
  lon: number
  tsMs: number | null
  edit: 'move' | 'insert' | null
}

/** A segment's effective (raw + draft overlay) points, for the editor UI. */
export interface SegmentEditState {
  segmentId: number
  type: string
  points: EditablePoint[]
  /** True when a saved draft overlay exists for this segment. */
  hasDraft: boolean
  /** Raw seqs the overlay deletes (absent from `points`); for round-tripping. */
  deletedSeqs: number[]
}

/**
 * One overlay row to persist: a moved raw point, an inserted vertex, or a
 * deleted raw point (deletes carry the removed point's last coords, unused).
 */
export interface SegmentEditInput {
  seq: number
  lat: number
  lon: number
  kind: EditKind
  /**
   * For inserts only: an explicit timestamp (ms). Omitted/null means the
   * inserted vertex's time is interpolated by seq between dated neighbors (the
   * default for hand edits); the bulk archetype apply sets it so each stamped
   * track keeps its own speed.
   */
  tsMs?: number | null
}

/**
 * 'draft' keeps edits in an overlay table (raw points untouched, revertible);
 * 'permanent' rewrites the segment's points with the edits baked in.
 */
export type EditSaveMode = 'draft' | 'permanent'

/**
 * One track in the merge sequence: a segment near the anchor in time. The UI
 * lists these chronologically so the user can pick a run to stitch together.
 */
export interface MergeCandidate {
  segmentId: number
  type: string
  startTsMs: number | null
  endTsMs: number | null
  /** Clean point count — also the tie-breaker for the default merged type. */
  pointCount: number
}

/** Anchor for the merge window: an existing track, or a picked moment in time. */
export type MergeAnchor = { segmentId: number } | { tsMs: number }

/** Default merge window: tracks within a day of the anchor are candidates. */
export const MERGE_WINDOW_MS = 24 * 60 * 60 * 1000

export interface ViewportWaypoint {
  id: number
  lat: number
  lon: number
  tsMs: number | null
  name: string | null
  /** Set when this dot is a user-merged place (persistent identity + name). */
  placeId: number | null
}

/**
 * Reference to a place. A user-merged place is identified by its `placeId`; an
 * un-merged place is just a name+proximity cluster, referenced by any one of
 * its visits (`waypointId`) — the backend recovers the rest of the cluster.
 */
export type PlaceRef = { placeId: number } | { waypointId: number }

export interface YearCount {
  year: number
  count: number
}

/** Visit statistics for one place (the Stats tab's per-place drill-down). */
export interface PlaceStats {
  placeId: number | null
  name: string | null
  /** Mean location of all the place's visits. */
  lat: number
  lon: number
  visitCount: number
  firstTsMs: number | null
  lastTsMs: number | null
  /** Visits per local hour-of-day (length 24). */
  hourCounts: number[]
  /** Visits per local day-of-week (length 7, index 0 = Sunday). */
  dowCounts: number[]
  /** Visits per calendar year, ascending. */
  yearCounts: YearCount[]
}

export interface TopPlace {
  name: string
  visitCount: number
  lat: number
  lon: number
  ref: PlaceRef
}

/**
 * One visit of a place for the place-detail editor, tagged with its distance
 * from the place centroid and whether that makes it a visit-level outlier (an
 * exclusion candidate). Outliers are judged per visit, not per GPS point.
 */
export interface PlaceMember {
  /** Visit (waypoint) id. */
  id: number
  name: string | null
  tsMs: number | null
  lat: number
  lon: number
  /** Distance from the place centroid, in metres. */
  distM: number
  /** Far enough from the centroid to suggest separating it from the place. */
  outlier: boolean
}

/** Dataset-wide statistics for the Stats tab's global summary. */
export interface DatasetStats {
  fileCount: number
  trackCount: number
  segmentCount: number
  pointCount: number
  /** Raw place-visit rows (waypoints). */
  visitCount: number
  /** Distinct places — merged + name clusters + unnamed singles (approximate). */
  placeCount: number
  startTsMs: number | null
  endTsMs: number | null
  segmentsByYear: YearCount[]
  visitsByYear: YearCount[]
  topPlaces: TopPlace[]
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

/** A date window (inclusive ms) of existing data to clear before importing. */
export interface OverwriteWindow {
  startTsMs: number
  endTsMs: number
}

/**
 * One incoming file whose dates overlap data already in the database. The
 * overlap span is the tightest range of *existing* data the file's dates touch
 * — the suggested (editable) window to overwrite.
 */
export interface ImportOverlapFile {
  path: string
  filename: string
  /** Date span the incoming file itself covers. */
  fileStartTsMs: number | null
  fileEndTsMs: number | null
  /** Tightest span of existing DB data within the file's range. */
  overlapStartTsMs: number
  overlapEndTsMs: number
  /** Existing tracks / visits within that overlap, for the review summary. */
  overlapSegmentCount: number
  overlapVisitCount: number
}

/** Result of scanning a pending import for date overlaps with existing data. */
export interface ImportOverlapAnalysis {
  totalFiles: number
  overlaps: ImportOverlapFile[]
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
  /**
   * Begin importing the given paths. With `overwrite` windows, existing data
   * dated within each window is cleared first (partially-emptied files are
   * recomputed), so re-exported / overlapping files replace the old data
   * instead of duplicating it.
   */
  startImport(
    paths: string[],
    overwrite?: OverwriteWindow[]
  ): Promise<{ started: boolean; reason?: string }>
  /** Scan pending paths for date overlaps with existing data (for the review UI). */
  analyzeImportOverlap(paths: string[]): Promise<ImportOverlapAnalysis>
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
   * Fetch one OSM layer (`rail` or `road` tunnels) for the given on-screen
   * bbox; regions accumulate per layer. On success the matched geometry is
   * rebuilt (progress via onRailProgress), so the returned coverage reflects
   * the new matchedRides count.
   */
  fetchRailNetwork(
    bbox: LatLonBBox,
    layer: OsmLayer
  ): Promise<{ ok: boolean; coverage?: RailCoverage; error?: string }>
  /** Re-run the match pass over all fetched coverage (e.g. when enabling snap). */
  rebuildRailMatches(): Promise<{ ok: boolean; coverage?: RailCoverage; error?: string }>
  /** Persist new matcher ranges and re-run the match pass with them. */
  setRailTuning(t: RailTuning): Promise<{ ok: boolean; coverage?: RailCoverage; error?: string }>
  /**
   * Wipe fetched OSM rail/road data. With `keepMatched`, the bulky network
   * (nodes/edges/coverage) is dropped but the cached map-matched geometry is
   * kept — snapped rides keep rendering from cache, you just can't re-match
   * (or match new rides) until you re-fetch. Without it, everything goes.
   */
  clearRailNetwork(keepMatched?: boolean): Promise<{ ok: boolean }>
  /** Progress of the post-fetch / rebuild map-matching pass. */
  onRailProgress(cb: (p: RailMatchProgress) => void): () => void
  getRailCoverage(): Promise<RailCoverage | null>
  /**
   * Fetch the drivable road network for the given on-screen bbox (for the
   * manual reroute tool); regions accumulate. Routing happens later, on demand.
   */
  fetchRouteNetwork(
    bbox: LatLonBBox
  ): Promise<{ ok: boolean; coverage?: RouteCoverage; error?: string }>
  getRouteCoverage(): Promise<RouteCoverage | null>
  /** Drop the fetched road network. Applied reroutes (edit overlays) are unaffected. */
  clearRouteNetwork(): Promise<{ ok: boolean }>
  /**
   * Compute the best road route through the given waypoints in order, for the
   * reroute preview. `guide` (the original track span) gives the trip length —
   * which sharpens the highway preference for long routes — and, while
   * `useGuideCorridor` is true (the initial estimate), also a loose corridor
   * bias so the route follows where the user actually went. Once the user
   * starts dragging vias, pass `useGuideCorridor = false` so the GPS is ignored
   * and the drags take priority. `type` is the track's activity type; a `bus`
   * may route on bus-only ways, anything else can't. Needs road coverage. When
   * no clean route exists the result falls back to following the track shape
   * (`followedTrack` set), so a bus on a non-fastest path still snaps.
   */
  previewRoadRoute(
    waypoints: RoutePoint[],
    guide: RoutePoint[],
    useGuideCorridor: boolean,
    type: string
  ): Promise<RoutePreviewResult>
  getRecentPerf(limit: number): Promise<PerfEntry[]>
  /** Effective points of one segment (raw + draft edits) for the editor. */
  getSegmentEditState(segmentId: number): Promise<SegmentEditState | null>
  /**
   * Persist the full edit overlay for a segment. Draft mode keeps raw points
   * untouched (revertible); permanent mode rewrites them. Either way display
   * geometry rebuilds and stale matched geometry is invalidated, so edits
   * always precede rail/road snapping.
   */
  saveSegmentEdits(
    segmentId: number,
    edits: SegmentEditInput[],
    mode: EditSaveMode
  ): Promise<{ ok: boolean; error?: string }>
  /** Drop a segment's draft edits and restore its original geometry. */
  revertSegmentEdits(segmentId: number): Promise<{ ok: boolean; error?: string }>
  /** How many tracks currently carry draft (unsaved) edits. */
  countDraftSegments(): Promise<number>
  /**
   * Bake every track's draft edits into its points permanently (bulk "save
   * all"). Returns how many tracks were committed.
   */
  commitAllDrafts(): Promise<{ ok: boolean; count?: number; error?: string }>
  /** Drop every track's draft edits, restoring originals. Returns the count. */
  revertAllDrafts(): Promise<{ ok: boolean; count?: number; error?: string }>
  /** Change a segment's activity type (re-snaps it if it was snapped). */
  setSegmentType(segmentId: number, type: string): Promise<{ ok: boolean; error?: string }>
  /** Delete a whole track (segment) and everything derived from it. */
  deleteSegment(segmentId: number): Promise<{ ok: boolean; error?: string }>
  /**
   * Tracks similar to the anchor (same type, direction-aware) for bulk cleaning:
   * 'endpoints' matches tracks starting + ending within `radiusM`; 'passthrough'
   * matches longer tracks running through both points. Includes the anchor.
   */
  findSimilarSegments(segmentId: number, radiusM: number, mode: SimilarMode): Promise<number[]>
  /** Delete many tracks at once. Returns how many were removed. */
  bulkDeleteSegments(segmentIds: number[]): Promise<{ ok: boolean; count?: number; error?: string }>
  /**
   * Stamp the archetype's edited shape onto each given track as a revertible
   * draft, timing every copy from its own start→end point progression so each
   * keeps its real speed (undated tracks get no timestamps). The archetype id is
   * skipped if present. Reads the archetype's effective (edited) points, so its
   * own draft must be flushed first.
   */
  applyArchetypeToSegments(
    archetypeId: number,
    segmentIds: number[]
  ): Promise<{ ok: boolean; result?: BulkApplyResult; error?: string }>
  /**
   * Split a segment into two at one of its points (by seq). Commits the
   * segment's current overlay; returns the id of the new (second-half)
   * segment so the caller can refresh.
   */
  splitSegment(
    segmentId: number,
    seq: number
  ): Promise<{ ok: boolean; newSegmentId?: number; error?: string }>
  /**
   * Precise split at any effective point, giving each half its own type.
   * Commits the overlay; returns the new (second-half) segment's id.
   */
  splitSegmentTyped(
    segmentId: number,
    seq: number,
    firstType: string,
    secondType: string
  ): Promise<{ ok: boolean; newSegmentId?: number; error?: string }>
  /**
   * Tracks within `windowMs` (default a day) of the anchor's time, ordered
   * chronologically — the candidate sequence for a merge.
   */
  listMergeCandidates(anchor: MergeAnchor, windowMs?: number): Promise<MergeCandidate[]>
  /**
   * Stitch the given segments into one (their points concatenated in time
   * order, the others removed). `type` is the merged track's activity type.
   * Permanent and structural; returns the surviving segment's id.
   */
  mergeSegments(
    segmentIds: number[],
    type: string
  ): Promise<{ ok: boolean; mergedId?: number; error?: string }>
  /**
   * Merge several places into one with the chosen name. Non-destructive — it
   * only regroups visits under a shared place identity (no waypoint is
   * deleted), so it's reversible by re-merging. Returns the surviving place id.
   */
  mergePlaces(
    refs: PlaceRef[],
    name: string
  ): Promise<{ ok: boolean; placeId?: number; error?: string }>
  /**
   * Fold a track into a place as one stationary visit at the track's centroid,
   * then delete the track. Permanent and structural, like a track merge.
   */
  assignTrackToPlace(
    segmentId: number,
    ref: PlaceRef
  ): Promise<{ ok: boolean; error?: string }>
  /** Visit stats for one place (counts + time-of-day / day-of-week histograms). */
  getPlaceStats(ref: PlaceRef): Promise<PlaceStats | null>
  /**
   * A place's individual visits for the detail editor — each with its distance
   * from the centroid and an outlier flag (exclusion candidates), farthest first.
   */
  getPlaceMembers(ref: PlaceRef): Promise<PlaceMember[] | null>
  /**
   * Rename a place. An implicit name+proximity cluster is materialized into an
   * explicit place so the chosen name sticks. Returns the place id.
   */
  renamePlace(ref: PlaceRef, name: string): Promise<{ ok: boolean; placeId?: number; error?: string }>
  /**
   * Separate visits out of their place into standalone unnamed sites (clears
   * place_id + name so they stop dragging the centroid and won't re-cluster).
   * The location is kept — re-merge a visit into the right place to re-home it.
   */
  separateVisits(visitIds: number[]): Promise<{ ok: boolean; error?: string }>
  /** Dataset-wide stats for the Stats tab's global summary. */
  getDatasetStats(): Promise<DatasetStats>
}
