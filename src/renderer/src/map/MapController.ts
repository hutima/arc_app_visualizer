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
  StyleSpecification
} from 'maplibre-gl'
import type { Feature, FeatureCollection } from 'geojson'
import { decodeGeometry } from '../../../shared/geomCodec'
import { WAYPOINT_COLOR } from '../../../shared/categories'
import { colorForYear, UNDATED_YEAR_COLOR } from '../../../shared/yearColors'
import type { DetailMode } from '../../../shared/displayDetail'
import type { CategoryInfo, TrackColorMode, ViewportResultMeta } from '../../../shared/types'

export interface RenderStats extends ViewportResultMeta {
  decodeMs: number
  renderMs: number
}

const TRACKS_SOURCE = 'arc-tracks'
const TRACKS_LAYER = 'arc-tracks-line'
const PLACES_SOURCE = 'arc-places'
const PLACES_LAYER = 'arc-places-circle'

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
  private averageRail = false
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
        layout: { 'line-cap': 'round', 'line-join': 'round' },
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
    this.applyTypeFilter()
    this.applyWaypointVisibility()
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
      const expr: unknown[] = ['match', ['get', 'year']]
      for (const y of this.yearsInView) {
        expr.push(y, colorForYear(y))
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

  private applyTypeFilter(): void {
    if (!this.map.getLayer(TRACKS_LAYER)) return
    const visible = this.categories.filter((c) => c.visible && !c.ignored).map((c) => c.name)
    // No category info yet (fresh DB): show everything that arrives.
    const filter: ExpressionSpecification =
      this.categories.length === 0
        ? (['literal', true] as unknown as ExpressionSpecification)
        : (['in', ['get', 'type'], ['literal', visible]] as unknown as ExpressionSpecification)
    this.map.setFilter(TRACKS_LAYER, filter)
  }

  private applyWaypointVisibility(): void {
    if (!this.map.getLayer(PLACES_LAYER)) return
    this.map.setLayoutProperty(PLACES_LAYER, 'visibility', this.showWaypoints ? 'visible' : 'none')
  }

  /** Visibility toggles re-filter existing layers — instant, no re-query. */
  setCategories(categories: CategoryInfo[]): void {
    this.categories = categories
    if (!this.map.isStyleLoaded() || !this.map.getLayer(TRACKS_LAYER)) return
    this.map.setPaintProperty(TRACKS_LAYER, 'line-color', this.colorExpression())
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

  /** Pure repaint — year is already in feature properties, no re-query. */
  setColorMode(mode: TrackColorMode): void {
    if (mode === this.colorMode) return
    this.colorMode = mode
    if (!this.map.isStyleLoaded() || !this.map.getLayer(TRACKS_LAYER)) return
    this.map.setPaintProperty(TRACKS_LAYER, 'line-color', this.colorExpression())
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
      averageRail: this.averageRail
    })
    // A newer query superseded this one while we awaited.
    if (token !== this.queryToken || this.destroyed) return

    const tDecode = performance.now()
    const decoded = decodeGeometry(result.buffer)
    const years = new Set<number>()
    const features: Feature[] = decoded.segments.map((s) => {
      const coordinates: number[][] = new Array(s.coords.length / 2)
      for (let i = 0; i < coordinates.length; i++) {
        coordinates[i] = [s.coords[i * 2]!, s.coords[i * 2 + 1]!]
      }
      years.add(s.year)
      return {
        type: 'Feature',
        id: s.id,
        properties: { type: decoded.typeTable[s.typeIndex]!, year: s.year },
        geometry: { type: 'LineString', coordinates }
      }
    })
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
