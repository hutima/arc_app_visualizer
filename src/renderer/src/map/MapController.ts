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
  MapLayerMouseEvent,
  MapMouseEvent,
  StyleSpecification
} from 'maplibre-gl'
import type { Feature, FeatureCollection } from 'geojson'
import { decodeGeometry } from '../../../shared/geomCodec'
import { WAYPOINT_COLOR } from '../../../shared/categories'
import { colorForYear, UNDATED_YEAR_COLOR } from '../../../shared/yearColors'
import type { DetailMode } from '../../../shared/displayDetail'
import type {
  CategoryInfo,
  EditablePoint,
  EditSaveMode,
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
// Merge-mode highlights ride on the tracks source (filtered by segment id).
const MERGE_CAND_LAYER = 'arc-merge-candidates-line'
const MERGE_SEL_LAYER = 'arc-merge-selected-line'

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

/** Editing sub-tool: per-point vertex editing vs stitching tracks together. */
export type EditTool = 'points' | 'merge'

const EMPTY_FC: FeatureCollection = { type: 'FeatureCollection', features: [] }

/** A MapLibre filter matching features whose id is in `ids` (empty ⇒ none). */
const matchIds = (ids: number[]): ExpressionSpecification =>
  ['in', ['id'], ['literal', ids]] as unknown as ExpressionSpecification

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
  /** How a click-off auto-save commits the session ('permanent' in skip mode). */
  private leaveSaveMode: EditSaveMode = 'draft'
  /** A mousedown that grabbed/inserted suppresses the click-off it precedes. */
  private suppressClickOff = false
  private editHandlersBound = false
  private editListener: ((s: EditSessionInfo | null) => void) | null = null
  private splitRequestListener: ((segmentId: number, seq: number) => void) | null = null
  private mergeAnchorListener: ((segmentId: number) => void) | null = null
  /** Notified after a permanent/structural change so React can refresh stats. */
  private datasetChangeListener: (() => void) | null = null
  /** Last merge highlight ids, so a theme re-add can restore them. */
  private mergeCandidateIds: number[] = []
  private mergeSelectedIds: number[] = []
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
      paint: { 'line-color': '#ffd166', 'line-width': 3, 'line-opacity': 0.95 }
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
    this.bindEditHandlers()

    this.applyTypeFilter()
    this.applyWaypointVisibility()
    this.applyEditEmphasis()
    // Theme switches re-add everything; restore an in-flight edit session and
    // any merge highlights.
    if (this.editingId !== null) this.updateEditLayers()
    this.setMergeHighlight(this.mergeCandidateIds, this.mergeSelectedIds)
    this.updateSplitPreview()
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
    }
    this.applyEditEmphasis()
  }

  /** Switch editing sub-tool; the other tool's session/selection is cleared. */
  setEditTool(tool: EditTool): void {
    if (tool === this.editTool) return
    this.editTool = tool
    this.closeEditSession()
    this.setMergeHighlight([], [])
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

  /**
   * Preview the precise-split point at an editPts index (the split slider),
   * or clear it with null. Index is clamped to the editable range.
   */
  setSplitPreview(index: number | null): void {
    this.splitPreviewIndex =
      index === null || this.editingId === null
        ? null
        : Math.max(0, Math.min(this.editPts.length - 1, Math.round(index)))
    this.updateSplitPreview()
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
    this.updateEditLayers()
    this.updateSplitPreview()
    this.applyTypeFilter()
    this.map.getCanvas().style.cursor = ''
    this.notifyEdit()
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
    const raw = e.features?.[0]?.id
    const id = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isInteger(id)) return
    if (this.editTool === 'merge') {
      // Clicking a track anchors the merge window on it; selection happens in
      // the panel, so this is a fresh anchor each time.
      this.mergeAnchorListener?.(id)
      return
    }
    // Point tool: switching tracks auto-saves the current one (click-off save).
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
    line.setData({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: this.editPts.map((p) => [p.lon, p.lat])
          }
        }
      ]
    })
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
      properties: { name: w.name ?? '' },
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
