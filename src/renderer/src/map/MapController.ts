/**
 * Owns the MapLibre instance and ALL track geometry. React only sends small
 * filter/state changes in and receives small stat objects out — geometry
 * never enters component state.
 *
 * Data flow per refresh: debounce → viewport+filters to main via IPC →
 * binary payload → decode to GeoJSON → setData on the existing source.
 * Category visibility toggles are pure layer filter updates (no re-query).
 */
import maplibregl from 'maplibre-gl'
import type {
  ExpressionSpecification,
  GeoJSONSource,
  LayerSpecification,
  MapGeoJSONFeature,
  MapLayerMouseEvent,
  MapMouseEvent,
  PointLike,
  StyleSpecification
} from 'maplibre-gl'
import type { Feature, FeatureCollection } from 'geojson'
import { decodeGeometry } from '../../../shared/geomCodec'
import { WAYPOINT_COLOR, colorForCategory } from '../../../shared/categories'
import { colorForYear, UNDATED_YEAR_COLOR } from '../../../shared/yearColors'
import { spliceRoute } from '../../../shared/reroute'
import type { DetailMode } from '../../../shared/displayDetail'
import type {
  CategoryInfo,
  EditablePoint,
  EditSaveMode,
  PlaceRef,
  RoutePoint,
  SegmentEditInput,
  TrackColorMode,
  ViewportResultMeta
} from '../../../shared/types'

export interface RenderStats extends ViewportResultMeta {
  decodeMs: number
  renderMs: number
}

/** Small state object the editor panel renders from (geometry stays here). */
export interface EditSessionInfo {
  segmentId: number
  type: string
  pointCount: number
  /** Unsaved in-session changes exist. */
  dirty: boolean
  /** A saved draft overlay exists in the database. */
  hasDraft: boolean
}

/** Reroute sub-tool status for the panel (geometry — vias/route — stays here). */
export interface RerouteInfo {
  /** A range is active (the reroute tool is open). */
  active: boolean
  /** Must-pass via pins currently placed. */
  viaCount: number
  /** A preview request is in flight. */
  previewing: boolean
  /** A previewed route is ready to apply. */
  hasPreview: boolean
  error: string | null
}

const TRACKS_SOURCE = 'arc-tracks'
const TRACKS_LAYER = 'arc-tracks-line'
const PLACES_SOURCE = 'arc-places'
const PLACES_LAYER = 'arc-places-circle'
const EDIT_LINE_SOURCE = 'arc-edit-line'
const EDIT_LINE_LAYER = 'arc-edit-line-line'
const EDIT_VERTEX_SOURCE = 'arc-edit-vertices'
const EDIT_VERTEX_LAYER = 'arc-edit-vertices-circle'
const EDIT_SPLIT_SOURCE = 'arc-edit-split'
const EDIT_SPLIT_LAYER = 'arc-edit-split-circle'
// Reroute tool overlays: the previewed road route, the draggable must-pass via
// pins, and the two range-boundary markers (start green, end red).
const EDIT_ROUTE_SOURCE = 'arc-edit-route'
const EDIT_ROUTE_LAYER = 'arc-edit-route-line'
const EDIT_VIA_SOURCE = 'arc-edit-via'
const EDIT_VIA_LAYER = 'arc-edit-via-circle'
const EDIT_RANGE_SOURCE = 'arc-edit-range'
const EDIT_RANGE_LAYER = 'arc-edit-range-circle'
// Merge-mode highlights ride on the tracks source (filtered by segment id).
const MERGE_CAND_LAYER = 'arc-merge-candidates-line'
const MERGE_SEL_LAYER = 'arc-merge-selected-line'
// Bulk-mode highlight (the similar-track selection), also on the tracks source.
const BULK_HL_LAYER = 'arc-bulk-highlight-line'
// Place highlight (stats inspection / merge selection): its own source of
// rings at place centroids, so it works for off-screen places too.
const PLACE_HL_SOURCE = 'arc-place-highlight'
const PLACE_HL_LAYER = 'arc-place-highlight-circle'

/**
 * Hit radii (screen px) for the point-edit tool. Grabbing an existing vertex
 * takes priority and gets the larger radius, so a click near a point moves it
 * rather than inserting a new one on the line; only clicks clearly between
 * points (within the smaller line radius, outside every vertex's radius)
 * insert. Endpoints have no insert fallback, so the generous grab radius is
 * what makes them draggable at all.
 */
const VERTEX_GRAB_TOLERANCE_PX = 13
const LINE_INSERT_TOLERANCE_PX = 8
// Place dots render only a few px wide; pick within this forgiving box so they
// are actually clickable (the pixel-perfect dot is easy to miss).
const PLACE_PICK_PAD_PX = 8

/**
 * Editing sub-tool: per-point vertex editing, stitching tracks together,
 * combining stationary places (and folding a track into one), or bulk-selecting
 * similar tracks for mass cleaning.
 */
export type EditTool = 'points' | 'merge' | 'mergePlaces' | 'bulk'

/** A clicked/selected place: the rendered dot, a backend ref, name, location. */
export interface PlacePick {
  dotId: number
  ref: PlaceRef
  name: string | null
  lat: number
  lon: number
}

const EMPTY_FC: FeatureCollection = { type: 'FeatureCollection', features: [] }

/** A MapLibre filter matching features whose id is in `ids` (empty ⇒ none). */
const matchIds = (ids: number[]): ExpressionSpecification =>
  ['in', ['id'], ['literal', ids]] as unknown as ExpressionSpecification

/** Interleaved [lon,lat,…] → [[lon,lat],…] for a GeoJSON LineString. */
const pairs = (flat: ReadonlyArray<number>): number[][] => {
  const out: number[][] = []
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i]!, flat[i + 1]!])
  return out
}

/** A colored reroute range-boundary marker feature (start green / end red). */
const rangeMarker = (lon: number, lat: number, color: string): Feature => ({
  type: 'Feature',
  properties: { color },
  geometry: { type: 'Point', coordinates: [lon, lat] }
})

/** Used when the online basemap style cannot be fetched (e.g. offline). */
const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  name: 'offline-fallback-dark',
  sources: {},
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0b0e14' } }
  ]
}

async function resolveStyle(styleUrl: string): Promise<StyleSpecification | string> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(styleUrl, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) throw new Error(`style fetch ${res.status}`)
    return (await res.json()) as StyleSpecification
  } catch {
    return FALLBACK_STYLE
  }
}

export class MapController {
  private map: maplibregl.Map
  private startTsMs: number | null = null
  private endTsMs: number | null = null
  private categories: CategoryInfo[] = []
  private showWaypoints = true
  private detailMode: DetailMode = 'auto'
  private colorMode: TrackColorMode = 'type'
  /** Distinct years among segments of the last refresh (0 = undated). */
  private yearsInView: number[] = []
  /** Dataset year span [min, max] driving the gradient; null until known. */
  private yearExtent: [number, number] | null = null
  private averageRail = false
  private snapRail = false
  private snapRoad = false
  /** Track editing: geometry being edited lives here, never in React. */
  private editMode = false
  private editTool: EditTool = 'points'
  private editingId: number | null = null
  private editType = ''
  private editHasDraft = false
  private editDirty = false
  private editPts: EditablePoint[] = []
  /** Raw seqs deleted this session → their last coords, for the saved overlay. */
  private deletedSeqs = new Map<number, { lat: number; lon: number }>()
  /** Split tool: editPts index previewed as the split point (null = none). */
  private splitPreviewIndex: number | null = null
  /** Split tool: per-half colors so the two halves read by type (null = off). */
  private splitColors: { first: string; second: string } | null = null
  /** Reroute tool: the active [startIdx, endIdx] range, or null when closed. */
  private rerouteRange: { startIdx: number; endIdx: number } | null = null
  /**
   * The GPS corridor is used only for the first estimate of a span; once the
   * user starts dragging/adding vias it's "consumed" so the drags take over and
   * the route stops being pulled back toward the noisy original track.
   */
  private rerouteGuideConsumed = false
  /** Reroute tool: must-pass via pins, in order placed. */
  private rerouteVias: RoutePoint[] = []
  /** Reroute tool: last previewed route (interleaved lon,lat), or null. */
  private reroutePreview: number[] | null = null
  private reroutePreviewToken = 0
  private rerouteBusy = false
  private rerouteError: string | null = null
  private rerouteTimer: ReturnType<typeof setTimeout> | null = null
  private rerouteListener: ((info: RerouteInfo | null) => void) | null = null
  /** How a click-off auto-save commits the session ('permanent' in skip mode). */
  private leaveSaveMode: EditSaveMode = 'draft'
  /** A mousedown that grabbed/inserted suppresses the click-off it precedes. */
  private suppressClickOff = false
  private editHandlersBound = false
  private editListener: ((s: EditSessionInfo | null) => void) | null = null
  private splitRequestListener: ((segmentId: number, seq: number) => void) | null = null
  private mergeAnchorListener: ((segmentId: number) => void) | null = null
  /** Bulk tool: clicking a track reports it as the anchor for "find similar". */
  private bulkAnchorListener: ((segmentId: number) => void) | null = null
  /** Notified after a permanent/structural change so React can refresh stats. */
  private datasetChangeListener: (() => void) | null = null
  /** Last merge highlight ids, so a theme re-add can restore them. */
  private mergeCandidateIds: number[] = []
  private mergeSelectedIds: number[] = []
  /** Bulk-selection highlight ids, restored on a theme re-add. */
  private bulkHighlightIds: number[] = []
  /** Stats mode: clicking a place reports it for inspection (no track edits). */
  private statsMode = false
  /** Centroids of highlighted places (rings); restored on a theme re-add. */
  private placeHighlight: Array<[number, number]> = []
  private placeSelectListener: ((p: PlacePick) => void) | null = null
  private statsPlaceListener: ((p: PlacePick) => void) | null = null
  private trackToPlaceListener: ((segmentId: number) => void) | null = null
  private readonly roadDimOpacity: number
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private queryToken = 0
  private destroyed = false
  private readonly onStats: (s: RenderStats) => void

  static async create(
    container: HTMLElement,
    basemapStyleUrl: string,
    roadDimOpacity: number,
    onStats: (s: RenderStats) => void
  ): Promise<MapController> {
    const style = await resolveStyle(basemapStyleUrl)
    return new MapController(container, style, roadDimOpacity, onStats)
  }

  private constructor(
    container: HTMLElement,
    style: StyleSpecification | string,
    roadDimOpacity: number,
    onStats: (s: RenderStats) => void
  ) {
    this.onStats = onStats
    this.roadDimOpacity = roadDimOpacity
    this.map = new maplibregl.Map({
      container,
      style,
      center: [0, 20],
      zoom: 1.5,
      attributionControl: { compact: true },
      // Keeps the WebGL buffer readable after a frame, for PNG export.
      canvasContextAttributes: { preserveDrawingBuffer: true }
    })
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')

    this.map.on('load', () => {
      this.addSourcesAndLayers()
      this.dimBasemapRoads()
      void this.refreshNow()
    })
    this.map.on('moveend', () => this.scheduleRefresh())
  }

  /** Swap the basemap style, then re-add our sources/layers on top of it. */
  async setBasemap(styleUrl: string): Promise<void> {
    const style = await resolveStyle(styleUrl)
    if (this.destroyed) return
    this.map.setStyle(style)
    this.map.once('styledata', () => {
      if (this.destroyed) return
      this.addSourcesAndLayers()
      this.dimBasemapRoads()
      void this.refreshNow()
    })
  }

  /**
   * Streets in the stock Carto styles are bright enough to compete with
   * tracks. Both carto themes are OpenMapTiles schemas, so dim every line
   * layer of the `transportation` source-layer; a no-op for styles that
   * organize roads differently (and for the offline fallback).
   */
  private dimBasemapRoads(): void {
    if (this.roadDimOpacity >= 1) return
    for (const layer of this.map.getStyle().layers ?? []) {
      if (layer.type !== 'line') continue
      if (!('source-layer' in layer) || layer['source-layer'] !== 'transportation') continue
      try {
        this.map.setPaintProperty(layer.id, 'line-opacity', this.roadDimOpacity)
      } catch {
        // Defensive: never let one odd basemap layer break the app.
      }
    }
  }

  destroy(): void {
    this.destroyed = true
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.map.remove()
  }

  private addSourcesAndLayers(): void {
    if (this.map.getSource(TRACKS_SOURCE)) return // already present (theme re-add)
    this.map.addSource(TRACKS_SOURCE, { type: 'geojson', data: EMPTY_FC })
    this.map.addSource(PLACES_SOURCE, { type: 'geojson', data: EMPTY_FC })

    // Insert below the basemap's labels so place names stay readable.
    const beforeId = this.firstSymbolLayerId()
    this.map.addLayer(
      {
        id: TRACKS_LAYER,
        type: 'line',
        source: TRACKS_SOURCE,
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
          'line-sort-key': this.sortKeyExpression()
        },
        paint: {
          'line-color': this.colorExpression(),
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1, 12, 2, 16, 3.5],
          'line-opacity': 0.85
        }
      } as LayerSpecification,
      beforeId
    )
    this.map.addLayer({
      id: PLACES_LAYER,
      type: 'circle',
      source: PLACES_SOURCE,
      paint: {
        'circle-color': WAYPOINT_COLOR,
        'circle-opacity': 0.7,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2, 14, 5],
        'circle-stroke-color': '#000000',
        'circle-stroke-width': 0.5
      }
    } as LayerSpecification)

    // Editing overlay: the working line plus draggable vertex handles, on top
    // of all our layers. Vertices drag to move (alt-click deletes, shift-click
    // splits); clicking the line itself inserts a point between two vertices.
    this.map.addSource(EDIT_LINE_SOURCE, { type: 'geojson', data: EMPTY_FC })
    this.map.addSource(EDIT_VERTEX_SOURCE, { type: 'geojson', data: EMPTY_FC })
    this.map.addLayer({
      id: EDIT_LINE_LAYER,
      type: 'line',
      source: EDIT_LINE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      // Per-feature color so the split tool can paint each half by its type;
      // the unsplit working line falls back to the editor yellow.
      paint: {
        'line-color': ['case', ['has', 'color'], ['get', 'color'], '#ffd166'] as unknown as ExpressionSpecification,
        'line-width': 3,
        'line-opacity': 0.95
      }
    } as LayerSpecification)
    this.map.addLayer({
      id: EDIT_VERTEX_LAYER,
      type: 'circle',
      source: EDIT_VERTEX_SOURCE,
      paint: {
        'circle-color': [
          'case',
          ['boolean', ['get', 'edited'], false],
          '#f97316',
          '#ffffff'
        ] as unknown as ExpressionSpecification,
        // A touch larger than before, so the grab target reads clearly.
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 5, 16, 7] as unknown as ExpressionSpecification,
        'circle-stroke-color': '#000000',
        'circle-stroke-width': 1
      }
    } as LayerSpecification)
    // Split-tool preview: a ring at the slider's chosen split point.
    this.map.addSource(EDIT_SPLIT_SOURCE, { type: 'geojson', data: EMPTY_FC })
    this.map.addLayer({
      id: EDIT_SPLIT_LAYER,
      type: 'circle',
      source: EDIT_SPLIT_SOURCE,
      paint: {
        'circle-color': 'rgba(0,0,0,0)',
        'circle-radius': 9,
        'circle-stroke-color': '#e879f9',
        'circle-stroke-width': 3
      }
    } as LayerSpecification)

    // Reroute tool: the previewed road route (cyan, dashed), the range-boundary
    // markers (start green / end red), then the draggable via pins on top.
    this.map.addSource(EDIT_ROUTE_SOURCE, { type: 'geojson', data: EMPTY_FC })
    this.map.addSource(EDIT_RANGE_SOURCE, { type: 'geojson', data: EMPTY_FC })
    this.map.addSource(EDIT_VIA_SOURCE, { type: 'geojson', data: EMPTY_FC })
    this.map.addLayer({
      id: EDIT_ROUTE_LAYER,
      type: 'line',
      source: EDIT_ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#22d3ee', 'line-width': 4, 'line-opacity': 0.95, 'line-dasharray': [2, 1] }
    } as LayerSpecification)
    this.map.addLayer({
      id: EDIT_RANGE_LAYER,
      type: 'circle',
      source: EDIT_RANGE_SOURCE,
      paint: {
        'circle-color': ['get', 'color'] as unknown as ExpressionSpecification,
        'circle-radius': 6,
        'circle-stroke-color': '#000000',
        'circle-stroke-width': 1.5
      }
    } as LayerSpecification)
    this.map.addLayer({
      id: EDIT_VIA_LAYER,
      type: 'circle',
      source: EDIT_VIA_SOURCE,
      paint: {
        'circle-color': '#fb7185',
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 6, 16, 8] as unknown as ExpressionSpecification,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5
      }
    } as LayerSpecification)

    // Merge highlights: redraw the candidate / selected segments from the
    // tracks source, filtered by segment id, hidden until merge mode turns
    // them on. Selected paints over candidates.
    this.map.addLayer({
      id: MERGE_CAND_LAYER,
      type: 'line',
      source: TRACKS_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
      filter: matchIds([]),
      paint: { 'line-color': '#4f7ccf', 'line-width': 3, 'line-opacity': 0.9 }
    } as LayerSpecification)
    this.map.addLayer({
      id: MERGE_SEL_LAYER,
      type: 'line',
      source: TRACKS_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
      filter: matchIds([]),
      paint: { 'line-color': '#ffd166', 'line-width': 5, 'line-opacity': 1 }
    } as LayerSpecification)
    // Bulk-selection highlight (the similar tracks), redrawn from the tracks
    // source filtered by id; orange so it reads against the dimmed base tracks.
    this.map.addLayer({
      id: BULK_HL_LAYER,
      type: 'line',
      source: TRACKS_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
      filter: matchIds([]),
      paint: { 'line-color': '#fb923c', 'line-width': 4, 'line-opacity': 0.95 }
    } as LayerSpecification)

    // Place highlight rings (stats inspection / merge-places selection), drawn
    // at place centroids on their own source so off-screen places still ring.
    this.map.addSource(PLACE_HL_SOURCE, { type: 'geojson', data: EMPTY_FC })
    this.map.addLayer({
      id: PLACE_HL_LAYER,
      type: 'circle',
      source: PLACE_HL_SOURCE,
      layout: { visibility: 'none' },
      paint: {
        'circle-color': 'rgba(0,0,0,0)',
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 7, 14, 12] as unknown as ExpressionSpecification,
        'circle-stroke-color': '#ffd166',
        'circle-stroke-width': 3
      }
    } as LayerSpecification)
    this.bindEditHandlers()

    this.applyTypeFilter()
    this.applyWaypointVisibility()
    this.applyEditEmphasis()
    // Theme switches re-add everything; restore an in-flight edit session and
    // any merge / place highlights.
    if (this.editingId !== null) this.updateEditLayers()
    this.setMergeHighlight(this.mergeCandidateIds, this.mergeSelectedIds)
    this.setBulkHighlight(this.bulkHighlightIds)
    this.setPlaceHighlight(this.placeHighlight)
    this.updateSplitPreview()
    this.updateRerouteLayers()
  }

  /**
   * Delegated listeners survive layer re-adds (they resolve by id at event
   * time), so bind them once — a basemap switch must not duplicate. All
   * point-edit hit-testing (grab a vertex vs insert on the line) happens on the
   * map's own mousedown in pixel space, not via layer events: that lets the
   * vertex grab radius be larger than the rendered circle and win over inserts.
   */
  private bindEditHandlers(): void {
    if (this.editHandlersBound) return
    this.editHandlersBound = true
    this.map.on('click', TRACKS_LAYER, (e) => this.handleTrackClick(e))
    // Place picks use the map's own click (not a layer event) so the padded
    // hit area in placeFeatureAt makes the tiny dots reliably clickable.
    this.map.on('click', (e) => this.handlePlaceClick(e))
    this.map.on('mousedown', (e) => this.handleMapDown(e))
    this.map.on('mousemove', (e) => this.updateEditCursor(e))
    // Clicking off the edited track (empty map) commits and deselects it.
    this.map.on('click', (e) => this.handleEmptyClick(e))
  }

  private firstSymbolLayerId(): string | undefined {
    for (const layer of this.map.getStyle().layers ?? []) {
      if (layer.type === 'symbol') return layer.id
    }
    return undefined
  }

  private colorExpression(): ExpressionSpecification | string {
    if (this.colorMode === 'year') {
      if (this.yearsInView.length === 0) return UNDATED_YEAR_COLOR
      const [min, max] = this.yearExtent ?? [undefined, undefined]
      const expr: unknown[] = ['match', ['get', 'year']]
      for (const y of this.yearsInView) {
        expr.push(y, colorForYear(y, min, max))
      }
      expr.push(UNDATED_YEAR_COLOR)
      return expr as unknown as ExpressionSpecification
    }
    if (this.categories.length === 0) return '#888888'
    const expr: unknown[] = ['match', ['get', 'type']]
    for (const c of this.categories) {
      expr.push(c.name, c.color)
    }
    expr.push('#888888')
    return expr as unknown as ExpressionSpecification
  }

  /**
   * Z-order within the tracks layer follows the panel's type order: the
   * first listed type paints on top. Higher sort keys draw above lower ones.
   */
  private sortKeyExpression(): ExpressionSpecification | number {
    const active = this.categories.filter((c) => !c.ignored)
    if (active.length === 0) return 0
    const expr: unknown[] = ['match', ['get', 'type']]
    active.forEach((c, i) => {
      expr.push(c.name, active.length - i)
    })
    expr.push(0)
    return expr as unknown as ExpressionSpecification
  }

  private applyTypeFilter(): void {
    if (!this.map.getLayer(TRACKS_LAYER)) return
    const visible = this.categories.filter((c) => c.visible && !c.ignored).map((c) => c.name)
    // No category info yet (fresh DB): show everything that arrives.
    const base: ExpressionSpecification =
      this.categories.length === 0
        ? (['literal', true] as unknown as ExpressionSpecification)
        : (['in', ['get', 'type'], ['literal', visible]] as unknown as ExpressionSpecification)
    // While editing, the original line hides under the editable copy.
    const filter: ExpressionSpecification =
      this.editingId !== null
        ? (['all', base, ['!=', ['id'], this.editingId]] as unknown as ExpressionSpecification)
        : base
    this.map.setFilter(TRACKS_LAYER, filter)
  }

  private applyWaypointVisibility(): void {
    if (!this.map.getLayer(PLACES_LAYER)) return
    this.map.setLayoutProperty(PLACES_LAYER, 'visibility', this.showWaypoints ? 'visible' : 'none')
  }

  /** Visibility/order/color changes re-style existing layers — no re-query. */
  setCategories(categories: CategoryInfo[]): void {
    this.categories = categories
    if (!this.map.isStyleLoaded() || !this.map.getLayer(TRACKS_LAYER)) return
    this.map.setPaintProperty(TRACKS_LAYER, 'line-color', this.colorExpression())
    this.map.setLayoutProperty(TRACKS_LAYER, 'line-sort-key', this.sortKeyExpression())
    this.applyTypeFilter()
  }

  setDateRange(startTsMs: number | null, endTsMs: number | null): void {
    this.startTsMs = startTsMs
    this.endTsMs = endTsMs
    this.scheduleRefresh(50)
  }

  setShowWaypoints(show: boolean): void {
    this.showWaypoints = show
    this.applyWaypointVisibility()
  }

  setDetailMode(mode: DetailMode): void {
    if (mode === this.detailMode) return
    this.detailMode = mode
    this.scheduleRefresh(0)
  }

  setAverageRail(on: boolean): void {
    if (on === this.averageRail) return
    this.averageRail = on
    this.scheduleRefresh(0)
  }

  setSnapRail(on: boolean): void {
    if (on === this.snapRail) return
    this.snapRail = on
    this.scheduleRefresh(0)
  }

  setSnapRoad(on: boolean): void {
    if (on === this.snapRoad) return
    this.snapRoad = on
    this.scheduleRefresh(0)
  }

  /** Pure repaint — year is already in feature properties, no re-query. */
  setColorMode(mode: TrackColorMode): void {
    if (mode === this.colorMode) return
    this.colorMode = mode
    if (!this.map.isStyleLoaded() || !this.map.getLayer(TRACKS_LAYER)) return
    this.map.setPaintProperty(TRACKS_LAYER, 'line-color', this.colorExpression())
  }

  /** Dataset year span for the gradient; repaints if year mode is active. */
  setYearExtent(min: number | null, max: number | null): void {
    const next = min != null && max != null ? ([min, max] as [number, number]) : null
    if (next?.[0] === this.yearExtent?.[0] && next?.[1] === this.yearExtent?.[1]) return
    this.yearExtent = next
    if (this.colorMode !== 'year') return
    if (!this.map.isStyleLoaded() || !this.map.getLayer(TRACKS_LAYER)) return
    this.map.setPaintProperty(TRACKS_LAYER, 'line-color', this.colorExpression())
  }

  /** Receives editor session changes for the sidebar panel. */
  setEditListener(cb: (s: EditSessionInfo | null) => void): void {
    this.editListener = cb
  }

  /** Asks the host (App) to confirm + run a split at the given segment/seq. */
  setSplitRequestListener(cb: (segmentId: number, seq: number) => void): void {
    this.splitRequestListener = cb
  }

  /** Receives the segment clicked as a merge anchor (merge tool only). */
  setMergeAnchorListener(cb: (segmentId: number) => void): void {
    this.mergeAnchorListener = cb
  }

  /** Receives the segment clicked as the "find similar" anchor (bulk tool only). */
  setBulkAnchorListener(cb: (segmentId: number) => void): void {
    this.bulkAnchorListener = cb
  }

  /** Highlight the bulk-selected (similar) tracks by id; gated to the bulk tool. */
  setBulkHighlight(ids: number[]): void {
    this.bulkHighlightIds = ids
    if (!this.map.getLayer(BULK_HL_LAYER)) return
    const show = this.editMode && this.editTool === 'bulk'
    this.map.setFilter(BULK_HL_LAYER, matchIds(ids))
    this.map.setLayoutProperty(BULK_HL_LAYER, 'visibility', show ? 'visible' : 'none')
  }

  /** Notified after a permanent/structural change so React can refresh stats. */
  setDatasetChangeListener(cb: () => void): void {
    this.datasetChangeListener = cb
  }

  /** How a click-off auto-save commits: 'permanent' in skip-confirm mode. */
  setLeaveSaveMode(mode: EditSaveMode): void {
    this.leaveSaveMode = mode
  }

  /**
   * Toggle edit mode. Edit mode de-emphasizes the base tracks so the editing
   * overlay (point handles or merge highlights) stands out; leaving it discards
   * any unsaved session and clears highlights.
   */
  setEditMode(on: boolean): void {
    if (on === this.editMode) return
    this.editMode = on
    if (!on) {
      this.closeEditSession()
      this.setMergeHighlight([], [])
      this.setBulkHighlight([])
      this.setPlaceHighlight([])
    }
    this.applyEditEmphasis()
  }

  /** Switch editing sub-tool; the other tool's session/selection is cleared. */
  setEditTool(tool: EditTool): void {
    if (tool === this.editTool) return
    this.editTool = tool
    this.closeEditSession()
    this.setMergeHighlight([], [])
    this.setBulkHighlight([])
    this.setPlaceHighlight([])
    this.applyEditEmphasis()
  }

  /** Dim base tracks while editing so the working overlay reads clearly. */
  private applyEditEmphasis(): void {
    if (!this.map.getLayer(TRACKS_LAYER)) return
    this.map.setPaintProperty(TRACKS_LAYER, 'line-opacity', this.editMode ? 0.4 : 0.85)
  }

  /** Highlight the merge candidate / selected segments by id on the map. */
  setMergeHighlight(candidateIds: number[], selectedIds: number[]): void {
    this.mergeCandidateIds = candidateIds
    this.mergeSelectedIds = selectedIds
    if (!this.map.getLayer(MERGE_CAND_LAYER)) return
    const show = this.editMode && this.editTool === 'merge'
    // Candidates layer shows only the not-yet-selected ones (selected paints
    // over them in its own color), so the two never double-draw.
    const selSet = new Set(selectedIds)
    this.map.setFilter(MERGE_CAND_LAYER, matchIds(candidateIds.filter((id) => !selSet.has(id))))
    this.map.setFilter(MERGE_SEL_LAYER, matchIds(selectedIds))
    for (const id of [MERGE_CAND_LAYER, MERGE_SEL_LAYER]) {
      this.map.setLayoutProperty(id, 'visibility', show ? 'visible' : 'none')
    }
  }

  /** Receives a place clicked in the merge-places tool (toggle its selection). */
  setPlaceSelectListener(cb: (p: PlacePick) => void): void {
    this.placeSelectListener = cb
  }

  /** Receives a place clicked in stats mode (inspect its visit stats). */
  setStatsPlaceListener(cb: (p: PlacePick) => void): void {
    this.statsPlaceListener = cb
  }

  /** Receives a track clicked in the merge-places tool (fold it into a place). */
  setTrackToPlaceListener(cb: (segmentId: number) => void): void {
    this.trackToPlaceListener = cb
  }

  /** True when place dots are clickable: stats mode or the merge-places tool. */
  private placePickActive(): boolean {
    return this.statsMode || (this.editMode && this.editTool === 'mergePlaces')
  }

  /**
   * The nearest place dot within a forgiving box of a screen point, or null.
   * The rendered dots are only a few px wide, so a pixel-perfect layer click is
   * easy to miss — query a padded box and take the closest so places are
   * reliably clickable. Closest by the dot's own stored centroid.
   */
  private placeFeatureAt(point: { x: number; y: number }): MapGeoJSONFeature | null {
    if (!this.map.getLayer(PLACES_LAYER)) return null
    const pad = PLACE_PICK_PAD_PX
    const box: [PointLike, PointLike] = [
      [point.x - pad, point.y - pad],
      [point.x + pad, point.y + pad]
    ]
    let best: MapGeoJSONFeature | null = null
    let bestD = Infinity
    for (const f of this.map.queryRenderedFeatures(box, { layers: [PLACES_LAYER] })) {
      const props = f.properties ?? {}
      if (typeof props.lon !== 'number' || typeof props.lat !== 'number') {
        if (!best) best = f
        continue
      }
      const p = this.map.project([props.lon, props.lat])
      const d = Math.hypot(point.x - p.x, point.y - p.y)
      if (d < bestD) {
        bestD = d
        best = f
      }
    }
    return best
  }

  /**
   * A place dot clicked: report it (with a backend ref and its centroid) for
   * stats inspection or merge-places selection. A merged pin carries a
   * `placeId`; an un-merged one is referenced by its representative visit id.
   * Bound on the map's own click (not a layer event) so the forgiving hit area
   * in `placeFeatureAt` applies.
   */
  private handlePlaceClick(e: MapMouseEvent): void {
    if (!this.placePickActive()) return
    const f = this.placeFeatureAt(e.point)
    if (!f) return
    const rawId = f.id
    const dotId = typeof rawId === 'number' ? rawId : Number(rawId)
    if (!Number.isInteger(dotId)) return
    const props = f.properties ?? {}
    const placeId = typeof props.placeId === 'number' ? props.placeId : null
    const ref: PlaceRef = placeId != null ? { placeId } : { waypointId: dotId }
    const name = typeof props.name === 'string' && props.name.length > 0 ? props.name : null
    const lat = typeof props.lat === 'number' ? props.lat : e.lngLat.lat
    const lon = typeof props.lon === 'number' ? props.lon : e.lngLat.lng
    const pick: PlacePick = { dotId, ref, name, lat, lon }
    if (this.statsMode) this.statsPlaceListener?.(pick)
    else this.placeSelectListener?.(pick)
  }

  /** Enter/leave stats mode (place dots become clickable for inspection). */
  setStatsMode(on: boolean): void {
    if (on === this.statsMode) return
    this.statsMode = on
    this.setPlaceHighlight(on ? this.placeHighlight : [])
  }

  /**
   * Ring the given place centroids (the inspected place in stats; the selected
   * places in merge-places). Its own source, so off-screen places still ring.
   */
  setPlaceHighlight(coords: Array<[number, number]>): void {
    this.placeHighlight = coords
    const src = this.map.getSource(PLACE_HL_SOURCE) as GeoJSONSource | undefined
    if (!src) return
    src.setData({
      type: 'FeatureCollection',
      features: coords.map(([lon, lat]) => ({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: [lon, lat] }
      }))
    })
    if (this.map.getLayer(PLACE_HL_LAYER)) {
      this.map.setLayoutProperty(
        PLACE_HL_LAYER,
        'visibility',
        this.placePickActive() && coords.length > 0 ? 'visible' : 'none'
      )
    }
  }

  /** Center the map on a place (e.g. one picked from the top-places list). */
  flyToPlace(lat: number, lon: number): void {
    this.map.flyTo({ center: [lon, lat], zoom: Math.max(this.map.getZoom(), 13), duration: 600 })
  }

  /**
   * Preview the precise-split point at an editPts index (the split slider),
   * or clear it with null. Index is clamped to the editable range.
   */
  setSplitPreview(index: number | null, firstType?: string, secondType?: string): void {
    this.splitPreviewIndex =
      index === null || this.editingId === null
        ? null
        : Math.max(0, Math.min(this.editPts.length - 1, Math.round(index)))
    // Color each half by its chosen type so the split reads at a glance, on the
    // map line as well as the panel slider.
    this.splitColors =
      this.splitPreviewIndex !== null && firstType && secondType
        ? { first: this.colorForType(firstType), second: this.colorForType(secondType) }
        : null
    this.updateEditLayers()
    this.updateSplitPreview()
  }

  /** The display color for an activity type (custom if set, else palette default). */
  private colorForType(type: string): string {
    return this.categories.find((c) => c.name === type)?.color ?? colorForCategory(type)
  }

  // --- Reroute tool ---------------------------------------------------------

  /** Receives reroute status (vias/preview/errors) for the panel; null = closed. */
  setRerouteListener(cb: (info: RerouteInfo | null) => void): void {
    this.rerouteListener = cb
  }

  /** True while the reroute tool owns the map (its range is set). */
  private get rerouteActive(): boolean {
    return this.rerouteRange !== null && this.editingId !== null
  }

  /**
   * Open/refresh the reroute tool over an [startIdx, endIdx] span of the
   * editable points, or close it with null. The span comes from the panel's
   * whole-track checkbox or its start/end sliders; opening draws the boundary
   * markers and kicks off a preview.
   */
  setRerouteRange(range: { startIdx: number; endIdx: number } | null): void {
    if (this.editingId === null || range === null) {
      this.resetRerouteState()
      this.updateRerouteLayers()
      this.notifyReroute()
      return
    }
    const last = this.editPts.length - 1
    const startIdx = Math.max(0, Math.min(last - 1, Math.round(range.startIdx)))
    const endIdx = Math.max(startIdx + 1, Math.min(last, Math.round(range.endIdx)))
    this.rerouteRange = { startIdx, endIdx }
    this.reroutePreview = null
    this.rerouteError = null
    // A new span gets a fresh GPS-guided initial estimate.
    this.rerouteGuideConsumed = false
    this.updateRerouteLayers()
    this.notifyReroute()
    this.schedulePreview(0)
  }

  /** Reset all reroute state (close / tool switch / session end). */
  private resetRerouteState(): void {
    if (this.rerouteTimer) {
      clearTimeout(this.rerouteTimer)
      this.rerouteTimer = null
    }
    this.reroutePreviewToken++ // invalidate any in-flight preview
    this.rerouteRange = null
    this.rerouteGuideConsumed = false
    this.rerouteVias = []
    this.reroutePreview = null
    this.rerouteBusy = false
    this.rerouteError = null
  }

  /** Drop the via pins and re-estimate from the GPS corridor (a fresh start). */
  clearRerouteVias(): void {
    if (!this.rerouteActive) return
    this.rerouteVias = []
    this.rerouteGuideConsumed = false
    this.updateRerouteLayers()
    this.notifyReroute()
    this.schedulePreview(0)
  }

  /** Mark the GPS corridor consumed (the user is now steering with vias). */
  private consumeGuide(): void {
    this.rerouteGuideConsumed = true
  }

  /** Corridor to send: the span for the initial estimate, empty once consumed. */
  private currentCorridor(): { guide: RoutePoint[]; use: boolean } {
    return { guide: this.rerouteGuide(), use: !this.rerouteGuideConsumed }
  }

  private notifyReroute(): void {
    this.rerouteListener?.(
      this.rerouteRange === null
        ? null
        : {
            active: true,
            viaCount: this.rerouteVias.length,
            previewing: this.rerouteBusy,
            hasPreview: this.reroutePreview !== null,
            error: this.rerouteError
          }
    )
  }

  /** The ordered waypoints to route: range start, the vias, range end. */
  private rerouteWaypoints(): RoutePoint[] | null {
    if (!this.rerouteRange) return null
    const a = this.editPts[this.rerouteRange.startIdx]
    const b = this.editPts[this.rerouteRange.endIdx]
    if (!a || !b) return null
    return [{ lat: a.lat, lon: a.lon }, ...this.rerouteVias, { lat: b.lat, lon: b.lon }]
  }

  /**
   * The original track points across the span — the loose corridor the route
   * follows directionally (the router uses them as bias, never as hard points).
   */
  private rerouteGuide(): RoutePoint[] {
    if (!this.rerouteRange) return []
    const out: RoutePoint[] = []
    for (let i = this.rerouteRange.startIdx; i <= this.rerouteRange.endIdx; i++) {
      const p = this.editPts[i]
      if (p) out.push({ lat: p.lat, lon: p.lon })
    }
    return out
  }

  /** Debounced re-preview, so dragging a via re-routes live without flooding IPC. */
  private schedulePreview(delayMs = 110): void {
    if (this.rerouteTimer) clearTimeout(this.rerouteTimer)
    this.rerouteTimer = setTimeout(() => void this.runPreview(), delayMs)
  }

  private async runPreview(): Promise<void> {
    const waypoints = this.rerouteWaypoints()
    if (!waypoints) return
    const { guide, use } = this.currentCorridor()
    const token = ++this.reroutePreviewToken
    this.rerouteBusy = true
    this.notifyReroute()
    const res = await window.api.previewRoadRoute(waypoints, guide, use, this.editType)
    if (token !== this.reroutePreviewToken || this.destroyed) return
    this.rerouteBusy = false
    if (res.ok && res.coords && res.coords.length >= 4) {
      this.reroutePreview = res.coords
      this.rerouteError = null
    } else {
      this.reroutePreview = null
      this.rerouteError = res.error ?? 'could not compute a route'
    }
    this.updateRerouteLayers()
    this.notifyReroute()
  }

  /**
   * Apply the previewed route: splice it into the editable points as overlay
   * inserts/deletes (the two boundaries kept) and persist as a draft — so it's
   * revertible and raw points survive. Closes the tool; saving refreshes the map.
   */
  async applyReroute(): Promise<{ ok: boolean; error?: string }> {
    if (this.editingId === null || !this.rerouteRange) return { ok: false, error: 'reroute not open' }
    const waypoints = this.rerouteWaypoints()
    if (!waypoints) return { ok: false, error: 'reroute not open' }
    const { guide, use } = this.currentCorridor()
    const { startIdx, endIdx } = this.rerouteRange

    // Recompute for the *current* via positions (and corridor state) rather than
    // trusting the debounced preview — a drop that lands between debounce ticks
    // would otherwise apply the route through where the pin used to be. Using the
    // same corridor state keeps this identical to what's shown.
    this.rerouteBusy = true
    this.notifyReroute()
    const res = await window.api.previewRoadRoute(waypoints, guide, use, this.editType)
    if (this.destroyed) return { ok: false }
    this.rerouteBusy = false
    if (!res.ok || !res.coords || res.coords.length < 4) {
      this.rerouteError = res.error ?? 'could not compute a route'
      if (res.ok) this.reroutePreview = null
      this.notifyReroute()
      return { ok: false, error: this.rerouteError }
    }

    // Snapshot so a failed save never strands a phantom routed line in the
    // session (which a later click-off could silently commit).
    const prevPts = this.editPts
    const prevDeleted = new Map(this.deletedSeqs)
    const prevDirty = this.editDirty
    let spliced
    try {
      spliced = spliceRoute(this.editPts, startIdx, endIdx, res.coords)
    } catch (err) {
      this.notifyReroute()
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    this.editPts = spliced.points
    for (const d of spliced.deleted) this.deletedSeqs.set(d.seq, { lat: d.lat, lon: d.lon })
    this.editDirty = true
    this.resetRerouteState()
    this.updateRerouteLayers()
    this.updateEditLayers()
    this.notifyReroute()
    this.notifyEdit()

    const saved = await this.saveEdits('draft')
    if (!saved.ok && !this.destroyed) {
      // Nothing persisted — roll the session back to before the splice.
      this.editPts = prevPts
      this.deletedSeqs = prevDeleted
      this.editDirty = prevDirty
      this.updateEditLayers()
      this.notifyEdit()
    }
    return saved
  }

  private updateRerouteLayers(): void {
    const routeSrc = this.map.getSource(EDIT_ROUTE_SOURCE) as GeoJSONSource | undefined
    const viaSrc = this.map.getSource(EDIT_VIA_SOURCE) as GeoJSONSource | undefined
    const rangeSrc = this.map.getSource(EDIT_RANGE_SOURCE) as GeoJSONSource | undefined
    routeSrc?.setData(
      this.reroutePreview && this.reroutePreview.length >= 4
        ? {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {},
                geometry: { type: 'LineString', coordinates: pairs(this.reroutePreview) }
              }
            ]
          }
        : EMPTY_FC
    )
    viaSrc?.setData({
      type: 'FeatureCollection',
      features: this.rerouteVias.map((v, i) => ({
        type: 'Feature',
        id: i,
        properties: { idx: i },
        geometry: { type: 'Point', coordinates: [v.lon, v.lat] }
      }))
    })
    const markers: Feature[] = []
    const range = this.rerouteRange
    if (range) {
      const a = this.editPts[range.startIdx]
      const b = this.editPts[range.endIdx]
      if (a) markers.push(rangeMarker(a.lon, a.lat, '#34d399'))
      if (b) markers.push(rangeMarker(b.lon, b.lat, '#f87171'))
    }
    rangeSrc?.setData({ type: 'FeatureCollection', features: markers })
  }

  /**
   * Mousedown while the reroute tool is open: grab a via pin (alt-click removes
   * it, else drag — which re-routes live), or, when the click lands on the
   * working line or the previewed route, drop a new must-pass via there and
   * start dragging it. Clicks in empty space fall through to map panning.
   */
  private handleRerouteDown(e: MapMouseEvent): void {
    const v = this.nearestVia(e.point)
    if (v && v.distPx <= VERTEX_GRAB_TOLERANCE_PX) {
      e.preventDefault()
      this.suppressClickOff = true
      if (e.originalEvent.altKey) this.removeVia(v.idx)
      else this.beginViaDrag(v.idx)
      return
    }
    const onLine = this.nearestEditSegment(e.point)
    const onRoute = this.nearestPreviewPoint(e.point)
    const lineD = onLine?.distPx ?? Infinity
    const routeD = onRoute?.distPx ?? Infinity
    if (Math.min(lineD, routeD) > LINE_INSERT_TOLERANCE_PX) return
    e.preventDefault()
    this.suppressClickOff = true
    const at = routeD <= lineD ? onRoute! : onLine!
    this.beginViaDrag(this.addViaOrdered(at.lng, at.lat))
  }

  /** Nearest via pin to a screen point, in pixels (grab / cursor feedback). */
  private nearestVia(point: { x: number; y: number }): { idx: number; distPx: number } | null {
    let best: { idx: number; distPx: number } | null = null
    for (let i = 0; i < this.rerouteVias.length; i++) {
      const p = this.map.project([this.rerouteVias[i]!.lon, this.rerouteVias[i]!.lat])
      const distPx = Math.hypot(point.x - p.x, point.y - p.y)
      if (!best || distPx < best.distPx) best = { idx: i, distPx }
    }
    return best
  }

  /** Nearest point on the previewed route to a screen point, in pixels. */
  private nearestPreviewPoint(
    point: { x: number; y: number }
  ): { lng: number; lat: number; distPx: number } | null {
    const flat = this.reroutePreview
    if (!flat || flat.length < 4) return null
    let best: { lng: number; lat: number; distPx: number } | null = null
    for (let i = 0; i + 3 < flat.length; i += 2) {
      const a = this.map.project([flat[i]!, flat[i + 1]!])
      const b = this.map.project([flat[i + 2]!, flat[i + 3]!])
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len2 = dx * dx + dy * dy
      let t = len2 === 0 ? 0 : ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2
      t = Math.max(0, Math.min(1, t))
      const cx = a.x + t * dx
      const cy = a.y + t * dy
      const distPx = Math.hypot(point.x - cx, point.y - cy)
      if (!best || distPx < best.distPx) {
        const ll = this.map.unproject([cx, cy])
        best = { lng: ll.lng, lat: ll.lat, distPx }
      }
    }
    return best
  }

  /**
   * Add a via at lng/lat, inserted into the sequence at the nearest leg of the
   * current waypoint chain so multiple vias stay in travel order (the route
   * passes start → vias → end in list order). Returns the new via's index.
   */
  private addViaOrdered(lng: number, lat: number): number {
    const wps = this.rerouteWaypoints() ?? []
    const click = this.map.project([lng, lat])
    let bestLeg = this.rerouteVias.length
    let bestD = Infinity
    for (let i = 0; i < wps.length - 1; i++) {
      const a = this.map.project([wps[i]!.lon, wps[i]!.lat])
      const b = this.map.project([wps[i + 1]!.lon, wps[i + 1]!.lat])
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len2 = dx * dx + dy * dy
      let t = len2 === 0 ? 0 : ((click.x - a.x) * dx + (click.y - a.y) * dy) / len2
      t = Math.max(0, Math.min(1, t))
      const d = Math.hypot(click.x - (a.x + t * dx), click.y - (a.y + t * dy))
      if (d < bestD) {
        bestD = d
        bestLeg = i
      }
    }
    this.rerouteVias.splice(bestLeg, 0, { lat, lon: lng })
    this.consumeGuide() // the user is steering now — drop the GPS corridor
    this.updateRerouteLayers()
    this.notifyReroute()
    this.schedulePreview(0)
    return bestLeg
  }

  private beginViaDrag(idx: number): void {
    const onMove = (ev: MapMouseEvent): void => {
      const v = this.rerouteVias[idx]
      if (!v) return
      v.lon = ev.lngLat.lng
      v.lat = ev.lngLat.lat
      this.consumeGuide() // dragging takes priority over the GPS corridor
      this.updateRerouteLayers()
      this.schedulePreview() // live re-route while dragging
    }
    const onUp = (): void => {
      this.map.off('mousemove', onMove)
      this.schedulePreview(0) // settle on a final route at drop
    }
    this.map.on('mousemove', onMove)
    this.map.once('mouseup', onUp)
  }

  private removeVia(idx: number): void {
    this.rerouteVias.splice(idx, 1)
    this.consumeGuide()
    this.updateRerouteLayers()
    this.notifyReroute()
    this.schedulePreview(0)
  }

  private updateSplitPreview(): void {
    const src = this.map.getSource(EDIT_SPLIT_SOURCE) as GeoJSONSource | undefined
    if (!src) return
    const i = this.splitPreviewIndex
    const p = i === null ? undefined : this.editPts[i]
    src.setData(
      !p
        ? EMPTY_FC
        : {
            type: 'FeatureCollection',
            features: [
              { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } }
            ]
          }
    )
  }

  /**
   * Commit the working overlay, then split at the previewed point into two
   * segments with the given per-half types. Caller (App) confirms first and
   * refreshes dataset stats after.
   */
  async commitSplitAt(
    index: number,
    firstType: string,
    secondType: string
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.editingId === null) return { ok: false, error: 'no segment selected' }
    const p = this.editPts[index]
    if (!p) return { ok: false, error: 'invalid split point' }
    const segmentId = this.editingId
    const saved = await window.api.saveSegmentEdits(segmentId, this.buildOverlay(), 'draft')
    if (!saved.ok) return saved
    const res = await window.api.splitSegmentTyped(segmentId, p.seq, firstType, secondType)
    if (res.ok && !this.destroyed) {
      this.closeEditSession()
      this.scheduleRefresh(0)
    }
    return res
  }

  /** Drop the in-memory session (saved drafts stay in the database). */
  closeEditSession(): void {
    this.editingId = null
    this.editPts = []
    this.deletedSeqs.clear()
    this.editDirty = false
    this.editHasDraft = false
    this.editType = ''
    this.splitPreviewIndex = null
    this.splitColors = null
    this.resetRerouteState()
    this.updateEditLayers()
    this.updateSplitPreview()
    this.updateRerouteLayers()
    this.applyTypeFilter()
    this.map.getCanvas().style.cursor = ''
    this.notifyEdit()
    this.notifyReroute()
  }

  /** The complete overlay for the current session (moves, inserts, deletes). */
  private buildOverlay(): SegmentEditInput[] {
    const overlay: SegmentEditInput[] = []
    for (const p of this.editPts) {
      if (p.edit !== null) overlay.push({ seq: p.seq, lat: p.lat, lon: p.lon, kind: p.edit })
    }
    for (const [seq, c] of this.deletedSeqs) {
      overlay.push({ seq, lat: c.lat, lon: c.lon, kind: 'delete' })
    }
    return overlay
  }

  /** Persist the session's overlay (draft or permanent) and refresh the map. */
  async saveEdits(mode: EditSaveMode): Promise<{ ok: boolean; error?: string }> {
    if (this.editingId === null) return { ok: false, error: 'no segment selected' }
    const res = await window.api.saveSegmentEdits(this.editingId, this.buildOverlay(), mode)
    if (res.ok && !this.destroyed) {
      this.closeEditSession()
      this.scheduleRefresh(0)
    }
    return res
  }

  /** Delete the segment's draft edits and restore its original geometry. */
  async revertEdits(): Promise<{ ok: boolean; error?: string }> {
    if (this.editingId === null) return { ok: false, error: 'no segment selected' }
    const res = await window.api.revertSegmentEdits(this.editingId)
    if (res.ok && !this.destroyed) {
      this.closeEditSession()
      this.scheduleRefresh(0)
    }
    return res
  }

  /**
   * Settle the open point-edit session before a bulk drafts action: when
   * committing, first persist any unsaved in-session changes as a draft (so the
   * bulk commit includes the track being edited), then close the session either
   * way. A no-op outside an active point session. Returns the draft-save result
   * so the caller can abort a commit whose flush failed (session kept open).
   */
  async settleEditSessionForBulk(commit: boolean): Promise<{ ok: boolean; error?: string }> {
    if (this.editingId !== null && commit && this.editDirty) {
      const res = await window.api.saveSegmentEdits(this.editingId, this.buildOverlay(), 'draft')
      if (this.destroyed) return { ok: false }
      if (!res.ok) return res
    }
    this.closeEditSession()
    return { ok: true }
  }

  /**
   * Commit the working overlay, then split the segment at `seq` into two. The
   * caller (App) confirms first and refreshes dataset stats after — splitting
   * changes point counts. Returns the result so the host can surface errors.
   */
  async commitSplit(segmentId: number, seq: number): Promise<{ ok: boolean; error?: string }> {
    if (this.editingId !== segmentId) return { ok: false, error: 'segment no longer being edited' }
    const saved = await window.api.saveSegmentEdits(segmentId, this.buildOverlay(), 'draft')
    if (!saved.ok) return saved
    const res = await window.api.splitSegment(segmentId, seq)
    if (res.ok && !this.destroyed) {
      this.closeEditSession()
      this.scheduleRefresh(0)
    }
    return res
  }

  private notifyEdit(): void {
    this.editListener?.(
      this.editingId === null
        ? null
        : {
            segmentId: this.editingId,
            type: this.editType,
            pointCount: this.editPts.length,
            dirty: this.editDirty,
            hasDraft: this.editHasDraft
          }
    )
  }

  private handleTrackClick(e: MapLayerMouseEvent): void {
    if (!this.editMode) return
    // While rerouting, clicks place/grab via pins — never switch the track.
    if (this.rerouteActive) return
    const raw = e.features?.[0]?.id
    const id = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isInteger(id)) return
    if (this.editTool === 'merge') {
      // Clicking a track anchors the merge window on it; selection happens in
      // the panel, so this is a fresh anchor each time.
      this.mergeAnchorListener?.(id)
      return
    }
    if (this.editTool === 'bulk') {
      // Clicking a track anchors the "find similar" search on it.
      this.bulkAnchorListener?.(id)
      return
    }
    if (this.editTool === 'mergePlaces') {
      // A place dot over the track wins (it's a place selection, not assign);
      // use the same forgiving hit area place clicks do, so a near-miss on a
      // dot doesn't get treated as a track assignment.
      if (this.placeFeatureAt(e.point)) return
      this.trackToPlaceListener?.(id)
      return
    }
    // Point tool: switching tracks auto-saves the current one (click-off save).
    // But if the map-down handler already consumed this gesture as an edit on
    // the current track (vertex grab / line insert), stay put — an overlapping
    // foreign track must not steal the click away from the track being edited.
    if (this.suppressClickOff) return
    if (id === this.editingId) return
    void this.commitAndLeave(id)
  }

  /**
   * Leave the current edit session, auto-saving it first if dirty (draft, or
   * permanent in skip-confirm mode), then optionally open another track. The
   * non-destructive default means clicking away never silently loses work.
   */
  private async commitAndLeave(nextSegmentId: number | null): Promise<void> {
    const leaving = this.editingId
    if (leaving !== null && this.editDirty) {
      const res = await window.api.saveSegmentEdits(leaving, this.buildOverlay(), this.leaveSaveMode)
      if (this.destroyed) return
      if (!res.ok) return // keep the session open so the work isn't lost
      if (this.leaveSaveMode === 'permanent') this.datasetChangeListener?.()
    }
    if (leaving !== null) this.closeEditSession()
    if (nextSegmentId !== null && nextSegmentId !== leaving) {
      await this.loadSegmentForEdit(nextSegmentId)
    }
    this.scheduleRefresh(0)
  }

  /** A plain click off the edited track (empty map) commits + deselects it. */
  private handleEmptyClick(e: MapMouseEvent): void {
    if (!this.editMode || this.editTool !== 'points' || this.editingId === null) return
    // The reroute tool consumes clicks itself; never commit-leave underneath it.
    if (this.rerouteActive) return
    if (this.suppressClickOff) {
      this.suppressClickOff = false
      return
    }
    // A click on the edited geometry is editing; a click on a track switches
    // (handleTrackClick). Only genuine empty space commits + deselects.
    if ((this.nearestEditVertex(e.point)?.distPx ?? Infinity) <= VERTEX_GRAB_TOLERANCE_PX) return
    if ((this.nearestEditSegment(e.point)?.distPx ?? Infinity) <= LINE_INSERT_TOLERANCE_PX) return
    if (this.map.queryRenderedFeatures(e.point, { layers: [TRACKS_LAYER] }).length > 0) return
    void this.commitAndLeave(null)
  }

  /** Change the edited track's type (persisted immediately, re-snapped). */
  async setSegmentType(type: string): Promise<{ ok: boolean; error?: string }> {
    if (this.editingId === null) return { ok: false, error: 'no segment selected' }
    const res = await window.api.setSegmentType(this.editingId, type)
    if (res.ok && !this.destroyed) {
      this.editType = type
      this.notifyEdit()
      this.datasetChangeListener?.()
      this.scheduleRefresh(0)
    }
    return res
  }

  /** Delete the edited track entirely and close the session. */
  async deleteSegment(): Promise<{ ok: boolean; error?: string }> {
    if (this.editingId === null) return { ok: false, error: 'no segment selected' }
    const res = await window.api.deleteSegment(this.editingId)
    if (res.ok && !this.destroyed) {
      this.closeEditSession()
      this.datasetChangeListener?.()
      this.scheduleRefresh(0)
    }
    return res
  }

  private async loadSegmentForEdit(segmentId: number): Promise<void> {
    const state = await window.api.getSegmentEditState(segmentId)
    if (!state || state.points.length < 2 || this.destroyed || !this.editMode) return
    this.editingId = state.segmentId
    this.editType = state.type
    this.editHasDraft = state.hasDraft
    this.editDirty = false
    this.editPts = state.points
    this.splitPreviewIndex = null
    // Re-loading a draft: keep its deletes so a re-save round-trips them
    // (coords are unused for delete rows).
    this.deletedSeqs = new Map(state.deletedSeqs.map((seq) => [seq, { lat: 0, lon: 0 }]))
    this.applyTypeFilter()
    this.updateEditLayers()
    this.updateSplitPreview()
    this.notifyEdit()
  }

  /**
   * Mousedown while editing, resolved by pixel distance with the vertex grab
   * winning over a line insert: a click within the (larger) grab radius of an
   * existing point grabs it — shift splits there, alt deletes, otherwise a
   * move-drag; only a click clearly on the line between points inserts. Clicks
   * away from both fall through to normal map panning.
   */
  private handleMapDown(e: MapMouseEvent): void {
    this.suppressClickOff = false
    if (!this.editMode || this.editingId === null) return
    // Reroute tool owns map gestures while open (via pins, not vertex edits).
    if (this.rerouteActive) {
      this.handleRerouteDown(e)
      return
    }
    const v = this.nearestEditVertex(e.point)
    if (v && v.distPx <= VERTEX_GRAB_TOLERANCE_PX) {
      e.preventDefault()
      this.suppressClickOff = true // this mousedown is an edit, not a click-off
      this.grabVertex(v.idx, e.originalEvent)
      return
    }
    const hit = this.nearestEditSegment(e.point)
    if (!hit || hit.distPx > LINE_INSERT_TOLERANCE_PX) return
    e.preventDefault()
    this.suppressClickOff = true
    const idx = this.insertOnSegment(hit)
    if (idx !== null) this.beginVertexDrag(idx)
  }

  /** Act on a grabbed vertex: shift = split, alt = delete, else move-drag. */
  private grabVertex(idx: number, oe: MouseEvent): void {
    if (oe.shiftKey) {
      this.requestSplitAt(idx)
      return
    }
    if (oe.altKey) {
      this.deleteVertex(idx)
      return
    }
    this.beginVertexDrag(idx)
  }

  /** Nearest editable vertex to a screen point, in pixels (for grab/cursor). */
  private nearestEditVertex(point: { x: number; y: number }): { idx: number; distPx: number } | null {
    let best: { idx: number; distPx: number } | null = null
    for (let i = 0; i < this.editPts.length; i++) {
      const p = this.map.project([this.editPts[i]!.lon, this.editPts[i]!.lat])
      const distPx = Math.hypot(point.x - p.x, point.y - p.y)
      if (!best || distPx < best.distPx) best = { idx: i, distPx }
    }
    return best
  }

  /**
   * Insert a vertex on the segment between editPts[i] and editPts[i+1] at the
   * projected click. seq and timestamp are interpolated by the same fraction
   * along that segment, so the new point is correctly ordered in time between
   * its neighbors. Returns the new index, or null if it coincides with a
   * vertex.
   */
  private insertOnSegment(hit: { i: number; t: number; lng: number; lat: number }): number | null {
    const a = this.editPts[hit.i]
    const b = this.editPts[hit.i + 1]
    if (!a || !b) return null
    const seq = a.seq + hit.t * (b.seq - a.seq)
    if (seq <= a.seq || seq >= b.seq) return null
    const tsMs =
      a.tsMs !== null && b.tsMs !== null ? Math.round(a.tsMs + hit.t * (b.tsMs - a.tsMs)) : null
    this.editPts.splice(hit.i + 1, 0, { seq, lat: hit.lat, lon: hit.lng, tsMs, edit: 'insert' })
    this.editDirty = true
    this.updateEditLayers()
    this.notifyEdit()
    return hit.i + 1
  }

  /** Nearest point on the editable polyline to a screen point, in pixels. */
  private nearestEditSegment(
    point: { x: number; y: number }
  ): { i: number; t: number; lng: number; lat: number; distPx: number } | null {
    let best: { i: number; t: number; lng: number; lat: number; distPx: number } | null = null
    for (let i = 0; i < this.editPts.length - 1; i++) {
      const a = this.map.project([this.editPts[i]!.lon, this.editPts[i]!.lat])
      const b = this.map.project([this.editPts[i + 1]!.lon, this.editPts[i + 1]!.lat])
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len2 = dx * dx + dy * dy
      let t = len2 === 0 ? 0 : ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2
      t = Math.max(0, Math.min(1, t))
      const cx = a.x + t * dx
      const cy = a.y + t * dy
      const distPx = Math.hypot(point.x - cx, point.y - cy)
      if (!best || distPx < best.distPx) {
        const ll = this.map.unproject([cx, cy])
        best = { i, t, lng: ll.lng, lat: ll.lat, distPx }
      }
    }
    return best
  }

  /** Remove a vertex; raw/moved points record a delete so the overlay drops them. */
  private deleteVertex(idx: number): void {
    if (this.editPts.length <= 2) return // a track must keep at least two points
    const p = this.editPts[idx]
    if (!p) return
    this.editPts.splice(idx, 1)
    if (p.edit !== 'insert') this.deletedSeqs.set(p.seq, { lat: p.lat, lon: p.lon })
    this.editDirty = true
    this.updateEditLayers()
    this.notifyEdit()
  }

  /** Ask the host to split here — only at an interior original (raw) point. */
  private requestSplitAt(idx: number): void {
    const p = this.editPts[idx]
    if (!p || this.editingId === null) return
    if (p.edit === 'insert' || !Number.isInteger(p.seq)) return
    if (idx < 1 || idx > this.editPts.length - 2) return
    this.splitRequestListener?.(this.editingId, p.seq)
  }

  private beginVertexDrag(idx: number): void {
    const onMove = (ev: MapMouseEvent): void => {
      const p = this.editPts[idx]
      if (!p) return
      p.lon = ev.lngLat.lng
      p.lat = ev.lngLat.lat
      if (p.edit === null) p.edit = 'move'
      if (!this.editDirty) {
        this.editDirty = true
        this.notifyEdit()
      }
      this.updateEditLayers()
    }
    const onUp = (): void => {
      this.map.off('mousemove', onMove)
    }
    this.map.on('mousemove', onMove)
    this.map.once('mouseup', onUp)
  }

  /**
   * Cursor feedback in edit mode, matching the same vertex-first hit-test the
   * click uses: move over a grabbable point, copy where a click would insert.
   */
  private updateEditCursor(e: MapMouseEvent): void {
    if (!this.editMode) return
    const canvas = this.map.getCanvas()
    if (this.rerouteActive) {
      // Move over a via pin; copy where a click would drop one (line / route).
      const v = this.nearestVia(e.point)
      if (v && v.distPx <= VERTEX_GRAB_TOLERANCE_PX) {
        canvas.style.cursor = 'move'
        return
      }
      const lineD = this.nearestEditSegment(e.point)?.distPx ?? Infinity
      const routeD = this.nearestPreviewPoint(e.point)?.distPx ?? Infinity
      canvas.style.cursor = Math.min(lineD, routeD) <= LINE_INSERT_TOLERANCE_PX ? 'copy' : ''
      return
    }
    if (this.editingId !== null) {
      const v = this.nearestEditVertex(e.point)
      if (v && v.distPx <= VERTEX_GRAB_TOLERANCE_PX) {
        canvas.style.cursor = 'move'
        return
      }
      const hit = this.nearestEditSegment(e.point)
      if (hit && hit.distPx <= LINE_INSERT_TOLERANCE_PX) {
        canvas.style.cursor = 'copy'
        return
      }
    }
    const onTrack = this.map.queryRenderedFeatures(e.point, { layers: [TRACKS_LAYER] }).length > 0
    canvas.style.cursor = onTrack ? 'pointer' : ''
  }

  private updateEditLayers(): void {
    const line = this.map.getSource(EDIT_LINE_SOURCE) as GeoJSONSource | undefined
    const verts = this.map.getSource(EDIT_VERTEX_SOURCE) as GeoJSONSource | undefined
    if (!line || !verts) return
    if (this.editingId === null) {
      line.setData(EMPTY_FC)
      verts.setData(EMPTY_FC)
      return
    }
    line.setData({ type: 'FeatureCollection', features: this.editLineFeatures() })
    verts.setData({
      type: 'FeatureCollection',
      features: this.editPts.map((p, i) => ({
        type: 'Feature',
        id: i,
        properties: { idx: i, edited: p.edit !== null },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] }
      }))
    })
    // Keep the split marker on its point as edits move the geometry.
    this.updateSplitPreview()
  }

  /**
   * The working line as GeoJSON: one yellow line normally, or two type-colored
   * halves when the split tool is previewing (the split point is shared, so the
   * halves meet cleanly at it — same partition splitSegmentTyped will write).
   */
  private editLineFeatures(): Feature[] {
    const coords = this.editPts.map((p) => [p.lon, p.lat])
    const idx = this.splitPreviewIndex
    if (this.splitColors && idx !== null && idx > 0 && idx < coords.length - 1) {
      return [
        {
          type: 'Feature',
          properties: { color: this.splitColors.first },
          geometry: { type: 'LineString', coordinates: coords.slice(0, idx + 1) }
        },
        {
          type: 'Feature',
          properties: { color: this.splitColors.second },
          geometry: { type: 'LineString', coordinates: coords.slice(idx) }
        }
      ]
    }
    return [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }]
  }

  /** The lat/lon box currently on screen (e.g. to fetch OSM rail for it). */
  getViewBounds(): { minLat: number; minLon: number; maxLat: number; maxLon: number } {
    const b = this.map.getBounds()
    return {
      minLat: b.getSouth(),
      minLon: b.getWest(),
      maxLat: b.getNorth(),
      maxLon: b.getEast()
    }
  }

  /** Current map view (basemap + tracks + places) as a PNG data URL. */
  exportPng(): string {
    this.map.redraw()
    return this.map.getCanvas().toDataURL('image/png')
  }

  async fitToData(): Promise<void> {
    const b = await window.api.getDataBounds()
    if (!b || this.destroyed) return
    this.map.fitBounds(
      [[b.minLon, b.minLat], [b.maxLon, b.maxLat]],
      { padding: 60, duration: 600, maxZoom: 14 }
    )
  }

  scheduleRefresh(delayMs = 200): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      void this.refreshNow()
    }, delayMs)
  }

  private async refreshNow(): Promise<void> {
    if (this.destroyed || !this.map.getSource(TRACKS_SOURCE)) return
    const token = ++this.queryToken

    const bounds = this.map.getBounds()
    const latPad = (bounds.getNorth() - bounds.getSouth()) * 0.15
    const lonPad = (bounds.getEast() - bounds.getWest()) * 0.15
    const zoom = this.map.getZoom()

    const result = await window.api.queryViewport({
      minLat: Math.max(-90, bounds.getSouth() - latPad),
      maxLat: Math.min(90, bounds.getNorth() + latPad),
      minLon: Math.max(-180, bounds.getWest() - lonPad),
      maxLon: Math.min(180, bounds.getEast() + lonPad),
      zoom,
      startTsMs: this.startTsMs,
      endTsMs: this.endTsMs,
      detailMode: this.detailMode,
      averageRail: this.averageRail,
      snapRail: this.snapRail,
      snapRoad: this.snapRoad
    })
    // A newer query superseded this one while we awaited.
    if (token !== this.queryToken || this.destroyed) return

    const tDecode = performance.now()
    const decoded = decodeGeometry(result.buffer)
    const years = new Set<number>()
    const features: Feature[] = []
    for (const s of decoded.segments) {
      // Matched geometry may carry NaN break sentinels — deliberate gaps
      // where connecting two fixes would draw a path that never happened.
      const parts: number[][][] = []
      let part: number[][] = []
      const total = s.coords.length / 2
      for (let i = 0; i < total; i++) {
        const lon = s.coords[i * 2]!
        if (Number.isNaN(lon)) {
          if (part.length >= 2) parts.push(part)
          part = []
          continue
        }
        part.push([lon, s.coords[i * 2 + 1]!])
      }
      if (part.length >= 2) parts.push(part)
      if (parts.length === 0) continue
      years.add(s.year)
      features.push({
        type: 'Feature',
        id: s.id,
        properties: { type: decoded.typeTable[s.typeIndex]!, year: s.year },
        geometry:
          parts.length > 1
            ? { type: 'MultiLineString', coordinates: parts }
            : { type: 'LineString', coordinates: parts[0]! }
      })
    }
    this.yearsInView = [...years].sort((a, b) => a - b)
    const placeFeatures: Feature[] = result.waypoints.map((w) => ({
      type: 'Feature',
      id: w.id,
      properties: { name: w.name ?? '', placeId: w.placeId, lat: w.lat, lon: w.lon },
      geometry: { type: 'Point', coordinates: [w.lon, w.lat] }
    }))
    const decodeMs = performance.now() - tDecode

    const tRender = performance.now()
    const tracksSource = this.map.getSource(TRACKS_SOURCE) as GeoJSONSource | undefined
    const placesSource = this.map.getSource(PLACES_SOURCE) as GeoJSONSource | undefined
    tracksSource?.setData({ type: 'FeatureCollection', features })
    placesSource?.setData({ type: 'FeatureCollection', features: placeFeatures })
    // Year mode's match expression depends on the years now in view.
    if (this.colorMode === 'year' && this.map.getLayer(TRACKS_LAYER)) {
      this.map.setPaintProperty(TRACKS_LAYER, 'line-color', this.colorExpression())
    }

    this.map.once('idle', () => {
      if (this.destroyed) return
      this.onStats({
        ...result.meta,
        decodeMs,
        renderMs: performance.now() - tRender
      })
    })
  }
}
