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
const EDIT_MID_SOURCE = 'arc-edit-midpoints'
const EDIT_MID_LAYER = 'arc-edit-midpoints-circle'
const EDIT_VERTEX_SOURCE = 'arc-edit-vertices'
const EDIT_VERTEX_LAYER = 'arc-edit-vertices-circle'

const EMPTY_FC: FeatureCollection = { type: 'FeatureCollection', features: [] }

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
  private editingId: number | null = null
  private editType = ''
  private editHasDraft = false
  private editDirty = false
  private editPts: EditablePoint[] = []
  private editHandlersBound = false
  private editListener: ((s: EditSessionInfo | null) => void) | null = null
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

    // Editing overlay: the working line plus drag handles, on top of all our
    // layers. Midpoint dots insert a vertex; vertex circles move one.
    this.map.addSource(EDIT_LINE_SOURCE, { type: 'geojson', data: EMPTY_FC })
    this.map.addSource(EDIT_MID_SOURCE, { type: 'geojson', data: EMPTY_FC })
    this.map.addSource(EDIT_VERTEX_SOURCE, { type: 'geojson', data: EMPTY_FC })
    this.map.addLayer({
      id: EDIT_LINE_LAYER,
      type: 'line',
      source: EDIT_LINE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffd166', 'line-width': 3, 'line-opacity': 0.95 }
    } as LayerSpecification)
    this.map.addLayer({
      id: EDIT_MID_LAYER,
      type: 'circle',
      source: EDIT_MID_SOURCE,
      paint: {
        'circle-color': '#ffd166',
        'circle-opacity': 0.45,
        'circle-radius': 3.5,
        'circle-stroke-color': '#000000',
        'circle-stroke-width': 0.5
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
        'circle-radius': 5,
        'circle-stroke-color': '#000000',
        'circle-stroke-width': 1
      }
    } as LayerSpecification)
    this.bindEditHandlers()

    this.applyTypeFilter()
    this.applyWaypointVisibility()
    // Theme switches re-add everything; restore an in-flight edit overlay.
    if (this.editingId !== null) this.updateEditLayers()
  }

  /**
   * Delegated layer listeners survive layer re-adds (they resolve by id at
   * event time), so bind them once — a basemap switch must not duplicate.
   */
  private bindEditHandlers(): void {
    if (this.editHandlersBound) return
    this.editHandlersBound = true
    this.map.on('click', TRACKS_LAYER, (e) => this.handleTrackClick(e))
    this.map.on('mousedown', EDIT_VERTEX_LAYER, (e) => this.handleHandleDown(e, false))
    this.map.on('mousedown', EDIT_MID_LAYER, (e) => this.handleHandleDown(e, true))
    const cursor = (c: string) => () => {
      this.map.getCanvas().style.cursor = c
    }
    this.map.on('mouseenter', EDIT_VERTEX_LAYER, cursor('move'))
    this.map.on('mouseleave', EDIT_VERTEX_LAYER, cursor(''))
    this.map.on('mouseenter', EDIT_MID_LAYER, cursor('copy'))
    this.map.on('mouseleave', EDIT_MID_LAYER, cursor(''))
    this.map.on('mouseenter', TRACKS_LAYER, () => {
      if (this.editMode) this.map.getCanvas().style.cursor = 'pointer'
    })
    this.map.on('mouseleave', TRACKS_LAYER, () => {
      if (this.editMode) this.map.getCanvas().style.cursor = ''
    })
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

  /** Toggle edit mode; leaving it discards any unsaved session. */
  setEditMode(on: boolean): void {
    if (on === this.editMode) return
    this.editMode = on
    if (!on) this.closeEditSession()
  }

  /** Drop the in-memory session (saved drafts stay in the database). */
  closeEditSession(): void {
    this.editingId = null
    this.editPts = []
    this.editDirty = false
    this.editHasDraft = false
    this.editType = ''
    this.updateEditLayers()
    this.applyTypeFilter()
    this.notifyEdit()
  }

  /** Persist the session's overlay (draft or permanent) and refresh the map. */
  async saveEdits(mode: EditSaveMode): Promise<{ ok: boolean; error?: string }> {
    if (this.editingId === null) return { ok: false, error: 'no segment selected' }
    const overlay: SegmentEditInput[] = []
    for (const p of this.editPts) {
      if (p.edit !== null) overlay.push({ seq: p.seq, lat: p.lat, lon: p.lon, kind: p.edit })
    }
    const res = await window.api.saveSegmentEdits(this.editingId, overlay, mode)
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
    // An unsaved session must be saved or closed before switching tracks.
    if (this.editingId !== null && this.editDirty) return
    const raw = e.features?.[0]?.id
    const id = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isInteger(id)) return
    void this.loadSegmentForEdit(id)
  }

  private async loadSegmentForEdit(segmentId: number): Promise<void> {
    const state = await window.api.getSegmentEditState(segmentId)
    if (!state || state.points.length < 2 || this.destroyed || !this.editMode) return
    this.editingId = state.segmentId
    this.editType = state.type
    this.editHasDraft = state.hasDraft
    this.editDirty = false
    this.editPts = state.points
    this.applyTypeFilter()
    this.updateEditLayers()
    this.notifyEdit()
  }

  /**
   * Drag start on a handle. Midpoint handles first insert a vertex at a seq
   * halfway between its neighbors (always unique: raw seqs are integers and
   * neighbors are adjacent), then drag it like any vertex.
   */
  private handleHandleDown(e: MapLayerMouseEvent, isMid: boolean): void {
    if (this.editingId === null) return
    const f = e.features?.[0]
    if (!f) return
    e.preventDefault() // keep dragPan off while dragging a handle
    let idx: number
    if (isMid) {
      const after = Number(f.properties?.after)
      if (!Number.isInteger(after) || after < 0 || after >= this.editPts.length - 1) return
      const a = this.editPts[after]!
      const b = this.editPts[after + 1]!
      const seq = (a.seq + b.seq) / 2
      if (seq === a.seq || seq === b.seq) return // float precision exhausted here
      this.editPts.splice(after + 1, 0, {
        seq,
        lat: e.lngLat.lat,
        lon: e.lngLat.lng,
        tsMs: a.tsMs !== null && b.tsMs !== null ? Math.round((a.tsMs + b.tsMs) / 2) : null,
        edit: 'insert'
      })
      idx = after + 1
      this.editDirty = true
      this.updateEditLayers()
      this.notifyEdit()
    } else {
      idx = Number(f.properties?.idx)
      if (!Number.isInteger(idx) || idx < 0 || idx >= this.editPts.length) return
    }

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

  private updateEditLayers(): void {
    const line = this.map.getSource(EDIT_LINE_SOURCE) as GeoJSONSource | undefined
    const verts = this.map.getSource(EDIT_VERTEX_SOURCE) as GeoJSONSource | undefined
    const mids = this.map.getSource(EDIT_MID_SOURCE) as GeoJSONSource | undefined
    if (!line || !verts || !mids) return
    if (this.editingId === null) {
      line.setData(EMPTY_FC)
      verts.setData(EMPTY_FC)
      mids.setData(EMPTY_FC)
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
    const midFeatures: Feature[] = []
    for (let i = 0; i < this.editPts.length - 1; i++) {
      const a = this.editPts[i]!
      const b = this.editPts[i + 1]!
      midFeatures.push({
        type: 'Feature',
        properties: { after: i },
        geometry: { type: 'Point', coordinates: [(a.lon + b.lon) / 2, (a.lat + b.lat) / 2] }
      })
    }
    mids.setData({ type: 'FeatureCollection', features: midFeatures })
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
