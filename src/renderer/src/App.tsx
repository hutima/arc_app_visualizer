import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppConfig,
  CategoryInfo,
  DatasetSummary,
  ImportProgress,
  ImportStats,
  TrackColorMode
} from '../../shared/types'
import type { DetailMode } from '../../shared/displayDetail'
import type {
  BulkRerouteResult,
  DatasetStats,
  EditSaveMode,
  MergeCandidate,
  OsmLayer,
  PlaceMember,
  PlaceRef,
  PlaceStats,
  RailCoverage,
  RailMatchProgress,
  RailTuning,
  RouteCoverage,
  SimilarMode
} from '../../shared/types'
import { colorForCategory } from '../../shared/categories'
import { yearRange } from '../../shared/yearColors'
import {
  MapController,
  type EditSessionInfo,
  type EditTool,
  type PlacePick,
  type RenderStats,
  type RerouteInfo
} from './map/MapController'
import { ImportPanel } from './components/ImportPanel'
import { BasemapControl } from './components/BasemapControl'
import { CategoryPanel } from './components/CategoryPanel'
import { CleaningControl } from './components/CleaningControl'
import { ColorModeControl } from './components/ColorModeControl'
import { DateFilter } from './components/DateFilter'
import { DetailControl } from './components/DetailControl'
import { StatsPanel } from './components/StatsPanel'
import { StatsView } from './components/StatsView'
import { TrackEditPanel } from './components/TrackEditPanel'
import { DraftsPanel } from './components/DraftsPanel'
import { MergePanel } from './components/MergePanel'
import { MergePlacesPanel } from './components/MergePlacesPanel'
import { PlaceDetailPanel } from './components/PlaceDetailPanel'
import { BulkPanel } from './components/BulkPanel'

type AppMode = 'display' | 'edit' | 'stats'

/** A place selected for merging: the map pick plus its fetched visit count. */
interface SelectedPlace extends PlacePick {
  visitCount: number
}

/** The merged track defaults to the type of its longest (most-points) leg. */
function defaultMergeType(selectedIds: number[], candidates: MergeCandidate[]): string {
  let best: MergeCandidate | null = null
  for (const c of candidates) {
    if (!selectedIds.includes(c.segmentId)) continue
    if (!best || c.pointCount > best.pointCount) best = c
  }
  return best?.type ?? ''
}

export function App(): React.JSX.Element {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [categories, setCategories] = useState<CategoryInfo[]>([])
  const [summary, setSummary] = useState<DatasetSummary | null>(null)
  const [renderStats, setRenderStats] = useState<RenderStats | null>(null)
  const [lastImport, setLastImport] = useState<ImportStats | null>(null)
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null)
  const [showWaypoints, setShowWaypoints] = useState(true)
  const [detailMode, setDetailMode] = useState<DetailMode>('auto')
  const [colorMode, setColorMode] = useState<TrackColorMode>('type')
  const [averageRail, setAverageRail] = useState(false)
  const [snapRail, setSnapRail] = useState(false)
  const [snapRoad, setSnapRoad] = useState(false)
  const [railCoverage, setRailCoverage] = useState<RailCoverage | null>(null)
  const [railFetching, setRailFetching] = useState(false)
  const [railRebuilding, setRailRebuilding] = useState(false)
  const [railProgress, setRailProgress] = useState<RailMatchProgress | null>(null)
  const [railError, setRailError] = useState<string | null>(null)
  // Drivable road network + reroute tool (Edit → Edit points → road route).
  const [routeCoverage, setRouteCoverage] = useState<RouteCoverage | null>(null)
  const [routeFetching, setRouteFetching] = useState(false)
  const [routeError, setRouteError] = useState<string | null>(null)
  const [rerouteInfo, setRerouteInfo] = useState<RerouteInfo | null>(null)
  // Bulk-clean tool: an anchor track → its similar set, plus a road-route/delete op.
  const [bulkAnchorId, setBulkAnchorId] = useState<number | null>(null)
  const [bulkRadiusM, setBulkRadiusM] = useState(100)
  const [bulkMode, setBulkMode] = useState<SimilarMode>('endpoints')
  const [bulkSelection, setBulkSelection] = useState<number[]>([])
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkError, setBulkError] = useState<string | null>(null)
  const [bulkResult, setBulkResult] = useState<BulkRerouteResult | null>(null)
  const [appMode, setAppMode] = useState<AppMode>('display')
  const [editTool, setEditTool] = useState<EditTool>('points')
  const [editSession, setEditSession] = useState<EditSessionInfo | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  // Tracks carrying a draft edit (for the bulk confirm-all / discard-all panel).
  const [draftCount, setDraftCount] = useState(0)
  // Skip confirmations; also makes a click-off auto-save permanently (vs draft).
  const [skipConfirm, setSkipConfirm] = useState(false)
  const skipConfirmRef = useRef(false)
  const [mergeCandidates, setMergeCandidates] = useState<MergeCandidate[]>([])
  const [mergeSelected, setMergeSelected] = useState<number[]>([])
  const [mergeType, setMergeType] = useState('')
  const [mergeBusy, setMergeBusy] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)
  // Merge-places tool: a selection of place pins, the name to keep, status.
  const [placeSelection, setPlaceSelection] = useState<SelectedPlace[]>([])
  const [mergePlaceName, setMergePlaceName] = useState('')
  // True once the user types a name, so re-deriving the most-frequent default
  // never clobbers their choice (and lets selection order stop deciding it).
  const [mergeNameTouched, setMergeNameTouched] = useState(false)
  const [placeBusy, setPlaceBusy] = useState(false)
  const [placeError, setPlaceError] = useState<string | null>(null)
  // Place-detail editor (one place selected): its visits, rename field, and the
  // visits ticked for separation.
  const [placeMembers, setPlaceMembers] = useState<PlaceMember[] | null>(null)
  const [placeMembersLoading, setPlaceMembersLoading] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [separateSelection, setSeparateSelection] = useState<number[]>([])
  // Stats tab: dataset-wide summary + the place currently inspected.
  const [datasetStats, setDatasetStats] = useState<DatasetStats | null>(null)
  const [statsPlace, setStatsPlace] = useState<PlaceStats | null>(null)
  const [statsPlaceLoading, setStatsPlaceLoading] = useState(false)

  const mapDivRef = useRef<HTMLDivElement | null>(null)
  const controllerRef = useRef<MapController | null>(null)
  const hadDataOnLoadRef = useRef(false)
  // Last edit session "key" seen, so the draft count only refetches when a
  // session opens/closes/switches (covers click-off draft saves), not per drag.
  const prevEditKeyRef = useRef('')
  // Monotonic token so overlapping draft-count refetches resolve latest-wins
  // (the session-change effect and a bulk op can both fire one).
  const draftCountReqRef = useRef(0)
  // Latest selection, read synchronously by map-click listeners (toggle / assign).
  const placeSelectionRef = useRef<SelectedPlace[]>([])
  // Map-click callbacks behind refs so the once-bound listeners always call the
  // latest closure (state setters + skip-confirm) without rebinding.
  const placeSelectCbRef = useRef<(p: PlacePick) => void>(() => {})
  const trackToPlaceCbRef = useRef<(segmentId: number) => void>(() => {})
  const inspectPlaceCbRef = useRef<(ref: PlaceRef) => void>(() => {})

  const refreshData = useCallback(async (): Promise<void> => {
    const [cats, sum] = await Promise.all([window.api.getCategories(), window.api.getSummary()])
    setCategories(cats)
    setSummary(sum)
    controllerRef.current?.setCategories(cats)
  }, [])

  const refreshDraftCount = useCallback((): void => {
    const req = ++draftCountReqRef.current
    void window.api.countDraftSegments().then((n) => {
      if (req === draftCountReqRef.current) setDraftCount(n)
    })
  }, [])

  // Bootstrap: config → map → initial data. The controller outlives renders;
  // geometry lives in it, never in React state.
  useEffect(() => {
    let disposed = false
    void (async () => {
      const cfg = await window.api.getConfig()
      if (disposed) return
      setConfig(cfg)
      if (!mapDivRef.current) return
      const controller = await MapController.create(
        mapDivRef.current,
        cfg.basemapStyleUrl,
        cfg.roadDimOpacity,
        (s) => setRenderStats(s)
      )
      if (disposed) {
        controller.destroy()
        return
      }
      controllerRef.current = controller
      controller.setEditListener((s) => setEditSession(s))
      controller.setRerouteListener((info) => setRerouteInfo(info))
      controller.setBulkAnchorListener((segmentId) => {
        setBulkResult(null)
        setBulkError(null)
        setBulkAnchorId(segmentId)
      })
      // Permanent/structural changes (incl. a permanent click-off save) change
      // counts/types, so refresh the dataset stats afterward.
      controller.setDatasetChangeListener(() => void refreshData())
      // Splitting is destructive (commits edits, restructures): confirm here,
      // then refresh dataset stats since point counts change.
      controller.setSplitRequestListener((segmentId, seq) => {
        if (
          !skipConfirmRef.current &&
          !window.confirm(
            'Split this track into two at the selected point? This commits the current edits and cannot be undone.'
          )
        ) {
          return
        }
        setEditBusy(true)
        setEditError(null)
        void controller.commitSplit(segmentId, seq).then((res) => {
          setEditBusy(false)
          if (res.ok) void refreshData()
          else setEditError(res.error ?? 'split failed')
        })
      })
      // Merge tool: clicking a track anchors the 24h candidate window on it
      // and preselects it; the rest of the selection happens in the panel.
      controller.setMergeAnchorListener((segmentId) => {
        void window.api.listMergeCandidates({ segmentId }).then((cands) => {
          if (disposed) return
          setMergeError(null)
          setMergeCandidates(cands)
          setMergeSelected(cands.some((c) => c.segmentId === segmentId) ? [segmentId] : [])
        })
      })
      // Place interactions (merge-places selection / assign, stats inspection)
      // route through refs so these once-bound listeners call the latest handler.
      controller.setPlaceSelectListener((pick) => placeSelectCbRef.current(pick))
      controller.setTrackToPlaceListener((segmentId) => trackToPlaceCbRef.current(segmentId))
      controller.setStatsPlaceListener((pick) => inspectPlaceCbRef.current(pick.ref))
      await refreshData()
      void window.api.getRailCoverage().then((cov) => {
        if (!disposed) setRailCoverage(cov)
      })
      void window.api.getRouteCoverage().then((cov) => {
        if (!disposed) setRouteCoverage(cov)
      })
      const sum = await window.api.getSummary()
      if (!disposed && sum.pointCount > 0) {
        hadDataOnLoadRef.current = true
        void controller.fitToData()
      }
    })()
    return () => {
      disposed = true
      controllerRef.current?.destroy()
      controllerRef.current = null
    }
  }, [refreshData])

  // Skip-confirm drives two things: a ref the confirm sites read, and the
  // mode a click-off auto-save commits in (permanent when skipping, else draft).
  useEffect(() => {
    skipConfirmRef.current = skipConfirm
    controllerRef.current?.setLeaveSaveMode(skipConfirm ? 'permanent' : 'draft')
  }, [skipConfirm])

  // Refetch the draft count whenever a point-edit session opens, closes, or
  // switches segments — that's when a draft may have been added/removed
  // (including a click-off auto-save), but not on every drag (key is unchanged).
  useEffect(() => {
    if (appMode !== 'edit') return
    const key = editSession ? `${editSession.segmentId}:${editSession.hasDraft}` : 'none'
    if (key === prevEditKeyRef.current) return
    prevEditKeyRef.current = key
    refreshDraftCount()
  }, [editSession, appMode, refreshDraftCount])

  // Feed the dataset's year span to the gradient whenever the summary changes.
  useEffect(() => {
    const years = yearRange(summary?.startTsMs ?? null, summary?.endTsMs ?? null)
    controllerRef.current?.setYearExtent(
      years.length ? years[0]! : null,
      years.length ? years[years.length - 1]! : null
    )
  }, [summary])

  // Import progress events: small objects only; map refresh happens on done.
  useEffect(() => {
    const unsubscribe = window.api.onImportProgress((p) => {
      setImportProgress(p)
      if (p.kind === 'done') {
        setLastImport(p.stats)
        void refreshData().then(() => {
          controllerRef.current?.scheduleRefresh(0)
          if (!hadDataOnLoadRef.current && p.stats.pointCount > 0) {
            hadDataOnLoadRef.current = true
            void controllerRef.current?.fitToData()
          }
        })
      }
    })
    return unsubscribe
  }, [refreshData])

  const handleToggleCategory = useCallback(
    (name: string, visible: boolean): void => {
      setCategories((prev) => {
        const next = prev.map((c) => (c.name === name ? { ...c, visible } : c))
        controllerRef.current?.setCategories(next)
        return next
      })
      void window.api.setCategoryVisible(name, visible)
    },
    []
  )

  const handleDateRange = useCallback((startTsMs: number | null, endTsMs: number | null): void => {
    controllerRef.current?.setDateRange(startTsMs, endTsMs)
  }, [])

  // Reorder active types to the dragged sequence; persists as priority.
  const handleReorderCategories = useCallback((orderedNames: string[]): void => {
    setCategories((prev) => {
      const rank = new Map(orderedNames.map((n, i) => [n, i]))
      const activeList = prev
        .filter((c) => !c.ignored && c.segmentCount > 0)
        .sort((a, b) => (rank.get(a.name) ?? 0) - (rank.get(b.name) ?? 0))
      const rest = prev.filter((c) => c.ignored || c.segmentCount === 0)
      const next = [...activeList, ...rest]
      controllerRef.current?.setCategories(next)
      void window.api.setCategoryOrder(orderedNames)
      return next
    })
  }, [])

  const handleToggleAllCategories = useCallback((visible: boolean): void => {
    setCategories((prev) => {
      const next = prev.map((c) =>
        !c.ignored && c.segmentCount > 0 ? { ...c, visible } : c
      )
      controllerRef.current?.setCategories(next)
      for (const c of prev) {
        if (!c.ignored && c.segmentCount > 0) void window.api.setCategoryVisible(c.name, visible)
      }
      return next
    })
  }, [])

  // Optimistic: the default color is derivable locally via colorForCategory.
  const handleColorChange = useCallback((name: string, color: string | null): void => {
    setCategories((prev) => {
      const next = prev.map((c) =>
        c.name === name
          ? { ...c, color: color ?? colorForCategory(name), custom: color !== null }
          : c
      )
      controllerRef.current?.setCategories(next)
      return next
    })
    void window.api.setCategoryColor(name, color)
  }, [])

  const handleToggleWaypoints = useCallback((show: boolean): void => {
    setShowWaypoints(show)
    controllerRef.current?.setShowWaypoints(show)
  }, [])

  const handleDetailMode = useCallback((mode: DetailMode): void => {
    setDetailMode(mode)
    controllerRef.current?.setDetailMode(mode)
  }, [])

  const handleColorMode = useCallback((mode: TrackColorMode): void => {
    setColorMode(mode)
    controllerRef.current?.setColorMode(mode)
  }, [])

  const handleAverageRail = useCallback((on: boolean): void => {
    setAverageRail(on)
    controllerRef.current?.setAverageRail(on)
  }, [])

  // Enabling a snap toggle with coverage but no cached matches (e.g. a fetch
  // from an older version): build them now so the toggle shows something.
  const ensureMatchesBuilt = useCallback((): void => {
    if (!railCoverage || railCoverage.matchedRides > 0 || railRebuilding || railFetching) return
    setRailRebuilding(true)
    setRailError(null)
    setRailProgress(null)
    void window.api.rebuildRailMatches().then((res) => {
      setRailRebuilding(false)
      setRailProgress(null)
      if (res.ok && res.coverage) {
        setRailCoverage(res.coverage)
        controllerRef.current?.scheduleRefresh(0)
      } else if (res.error) {
        setRailError(res.error)
      }
    })
  }, [railCoverage, railRebuilding, railFetching])

  const handleSnapRail = useCallback(
    (on: boolean): void => {
      setSnapRail(on)
      controllerRef.current?.setSnapRail(on)
      if (on) ensureMatchesBuilt()
    },
    [ensureMatchesBuilt]
  )

  const handleSnapRoad = useCallback(
    (on: boolean): void => {
      setSnapRoad(on)
      controllerRef.current?.setSnapRoad(on)
      if (on) ensureMatchesBuilt()
    },
    [ensureMatchesBuilt]
  )

  // Stream of the post-fetch map-matching pass.
  useEffect(() => window.api.onRailProgress((p) => setRailProgress(p)), [])

  // Persist new matcher ranges, then re-match everything with them.
  const handleApplyTuning = useCallback((t: RailTuning): void => {
    setRailRebuilding(true)
    setRailError(null)
    setRailProgress(null)
    void window.api.setRailTuning(t).then((res) => {
      setRailRebuilding(false)
      setRailProgress(null)
      setConfig((prev) => (prev ? { ...prev, railTuning: t } : prev))
      if (res.ok && res.coverage) {
        setRailCoverage(res.coverage)
        controllerRef.current?.scheduleRefresh(0)
      } else if (res.error) {
        setRailError(res.error)
      }
    })
  }, [])

  // Fetch one layer for the area on screen (regions accumulate per layer),
  // then cache its matched geometry; both phases report through
  // railFetching / railProgress.
  const handleFetchRail = useCallback((layer: OsmLayer): void => {
    const view = controllerRef.current?.getViewBounds()
    if (!view) return
    setRailFetching(true)
    setRailError(null)
    setRailProgress(null)
    void window.api.fetchRailNetwork(view, layer).then((res) => {
      setRailFetching(false)
      setRailProgress(null)
      if (res.ok && res.coverage) {
        setRailCoverage(res.coverage)
        // Turn on the toggle for the layer just fetched, so the result shows.
        if (layer === 'road') {
          setSnapRoad(true)
          controllerRef.current?.setSnapRoad(true)
        } else {
          setSnapRail(true)
          controllerRef.current?.setSnapRail(true)
        }
        controllerRef.current?.scheduleRefresh(0) // new area snaps immediately
      } else {
        setRailError(res.error ?? 'fetch failed')
      }
    })
  }, [])

  // Clear fetched OSM data. keepMatched drops the bulky network but keeps the
  // cached snapped geometry, so snapped rides keep rendering from cache.
  const handleClearRail = useCallback((keepMatched?: boolean): void => {
    void window.api.clearRailNetwork(keepMatched).then(() => {
      void window.api.getRailCoverage().then((cov) => setRailCoverage(cov))
      setRailError(null)
      if (!keepMatched) {
        setSnapRail(false)
        controllerRef.current?.setSnapRail(false)
        setSnapRoad(false)
        controllerRef.current?.setSnapRoad(false)
      }
      controllerRef.current?.scheduleRefresh(0)
    })
  }, [])

  // Fetch the drivable road network for the current view (manual reroute tool).
  const handleFetchRoute = useCallback((): void => {
    const view = controllerRef.current?.getViewBounds()
    if (!view) return
    setRouteFetching(true)
    setRouteError(null)
    void window.api.fetchRouteNetwork(view).then((res) => {
      setRouteFetching(false)
      if (res.ok && res.coverage) setRouteCoverage(res.coverage)
      else setRouteError(res.error ?? 'fetch failed')
    })
  }, [])

  const handleClearRoute = useCallback((): void => {
    void window.api.clearRouteNetwork().then(() => {
      setRouteCoverage(null)
      setRouteError(null)
    })
  }, [])

  // Reroute tool wiring: the map owns the geometry (range markers, via pins,
  // preview); these just forward intent to the controller.
  const handleRerouteRange = useCallback(
    (range: { startIdx: number; endIdx: number } | null): void => {
      controllerRef.current?.setRerouteRange(range)
    },
    []
  )

  const handleClearVias = useCallback((): void => {
    controllerRef.current?.clearRerouteVias()
  }, [])

  // Applying a previewed route writes a revertible draft (raw points survive),
  // so no confirm — the user already reviewed the preview on the map.
  const handleApplyReroute = useCallback((): void => {
    const controller = controllerRef.current
    if (!controller) return
    setEditBusy(true)
    setEditError(null)
    void controller.applyReroute().then((res) => {
      setEditBusy(false)
      if (!res.ok) setEditError(res.error ?? 'apply failed')
    })
  }, [])

  const clearMerge = useCallback((): void => {
    setMergeCandidates([])
    setMergeSelected([])
    setMergeType('')
    setMergeError(null)
    controllerRef.current?.setMergeHighlight([], [])
  }, [])

  const clearBulk = useCallback((): void => {
    setBulkAnchorId(null)
    setBulkSelection([])
    setBulkError(null)
    setBulkResult(null)
    controllerRef.current?.setBulkHighlight([])
  }, [])

  // Find the anchor's similar tracks (debounced for radius typing) and highlight
  // them. Re-runs when the anchor, radius, or match mode changes.
  useEffect(() => {
    if (appMode !== 'edit' || editTool !== 'bulk' || bulkAnchorId === null) return
    let cancelled = false
    const handle = setTimeout(() => {
      void window.api.findSimilarSegments(bulkAnchorId, bulkRadiusM, bulkMode).then((ids) => {
        // Guard the in-flight query too: a slower earlier anchor must not
        // overwrite a newer one's selection (latest-wins).
        if (cancelled) return
        setBulkSelection(ids)
        controllerRef.current?.setBulkHighlight(ids)
      })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [appMode, editTool, bulkAnchorId, bulkRadiusM, bulkMode])

  // Reroute every selected track to its own clean road route (revertible drafts).
  const handleBulkRerouteAll = useCallback((): void => {
    if (bulkSelection.length === 0) return
    if (
      !skipConfirmRef.current &&
      !window.confirm(
        `Reroute ${bulkSelection.length} track${bulkSelection.length === 1 ? '' : 's'} to clean road routes? They're saved as drafts you can review or discard.`
      )
    ) {
      return
    }
    setBulkBusy(true)
    setBulkError(null)
    setBulkResult(null)
    void window.api.bulkRerouteSegments(bulkSelection).then((res) => {
      setBulkBusy(false)
      if (res.ok && res.result) {
        setBulkResult(res.result)
        controllerRef.current?.scheduleRefresh(0)
        refreshDraftCount()
      } else {
        setBulkError(res.error ?? 'bulk reroute failed')
      }
    })
  }, [bulkSelection, refreshDraftCount])

  // Delete every selected track (destructive) after a confirm.
  const handleBulkDeleteAll = useCallback((): void => {
    if (bulkSelection.length === 0) return
    if (
      !skipConfirmRef.current &&
      !window.confirm(
        `Delete ${bulkSelection.length} track${bulkSelection.length === 1 ? '' : 's'} for good? This cannot be undone.`
      )
    ) {
      return
    }
    setBulkBusy(true)
    setBulkError(null)
    void window.api.bulkDeleteSegments(bulkSelection).then((res) => {
      setBulkBusy(false)
      if (res.ok) {
        clearBulk()
        controllerRef.current?.scheduleRefresh(0)
        void refreshData()
      } else {
        setBulkError(res.error ?? 'bulk delete failed')
      }
    })
  }, [bulkSelection, clearBulk, refreshData])

  // --- Places: merge & stats -------------------------------------------------

  const clearPlaceSelection = useCallback((): void => {
    setPlaceSelection([])
    setMergePlaceName('')
    setMergeNameTouched(false)
    setSeparateSelection([])
    setPlaceMembers(null)
    setRenameValue('')
    setPlaceError(null)
    controllerRef.current?.setPlaceHighlight([])
  }, [])

  // Toggle a clicked place in/out of the merge selection; on add, fetch its
  // visit count + canonical name for the panel. The ref gives the once-bound
  // click listener the current selection synchronously.
  const handlePlaceSelect = useCallback((pick: PlacePick): void => {
    const cur = placeSelectionRef.current
    if (cur.some((p) => p.dotId === pick.dotId)) {
      setPlaceSelection(cur.filter((p) => p.dotId !== pick.dotId))
      return
    }
    void window.api.getPlaceStats(pick.ref).then((stats) => {
      setPlaceSelection((prev) =>
        prev.some((p) => p.dotId === pick.dotId)
          ? prev
          : [...prev, { ...pick, name: stats?.name ?? pick.name, visitCount: stats?.visitCount ?? 0 }]
      )
    })
  }, [])

  const handleRemovePlace = useCallback((dotId: number): void => {
    setPlaceSelection((prev) => prev.filter((p) => p.dotId !== dotId))
  }, [])

  // User typing the kept name marks it touched so the frequency default stops.
  const handleMergeNameChange = useCallback((name: string): void => {
    setMergeNameTouched(true)
    setMergePlaceName(name)
  }, [])

  const handleToggleVisit = useCallback((id: number): void => {
    setSeparateSelection((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }, [])

  const handleSelectOutliers = useCallback((): void => {
    setSeparateSelection((placeMembers ?? []).filter((m) => m.outlier).map((m) => m.id))
  }, [placeMembers])

  // Rename the one selected place; reflect the new name in the selection so the
  // detail editor reloads (and the merged-name default stays sensible).
  const handleRenamePlace = useCallback((): void => {
    const sel = placeSelectionRef.current
    const name = renameValue.trim()
    if (sel.length !== 1 || name.length === 0) return
    const target = sel[0]!
    setPlaceBusy(true)
    setPlaceError(null)
    void window.api.renamePlace(target.ref, name).then((res) => {
      setPlaceBusy(false)
      if (res.ok) {
        setPlaceSelection((prev) =>
          prev.map((p) => (p.dotId === target.dotId ? { ...p, name } : p))
        )
        controllerRef.current?.scheduleRefresh(0)
        void refreshData()
      } else {
        setPlaceError(res.error ?? 'rename failed')
      }
    })
  }, [renameValue, refreshData])

  // Separate the ticked visits into their own unnamed sites, then deselect (the
  // place's membership changed) and redraw.
  const handleSeparateVisits = useCallback((): void => {
    const ids = separateSelection
    if (ids.length === 0) return
    if (
      !skipConfirmRef.current &&
      !window.confirm(
        `Separate ${ids.length} visit${ids.length === 1 ? '' : 's'} into ${
          ids.length === 1 ? 'its' : 'their'
        } own unnamed site${ids.length === 1 ? '' : 's'}? The location is kept — you can re-merge later.`
      )
    ) {
      return
    }
    setPlaceBusy(true)
    setPlaceError(null)
    void window.api.separateVisits(ids).then((res) => {
      setPlaceBusy(false)
      if (res.ok) {
        clearPlaceSelection()
        controllerRef.current?.scheduleRefresh(0)
        void refreshData()
      } else {
        setPlaceError(res.error ?? 'separate failed')
      }
    })
  }, [separateSelection, clearPlaceSelection, refreshData])

  // Non-destructive (only regroups visits under one identity) — no confirm.
  const handleMergePlaces = useCallback((): void => {
    if (placeSelection.length < 2 || mergePlaceName.trim().length === 0) return
    setPlaceBusy(true)
    setPlaceError(null)
    void window.api.mergePlaces(placeSelection.map((p) => p.ref), mergePlaceName.trim()).then((res) => {
      setPlaceBusy(false)
      if (res.ok) {
        clearPlaceSelection()
        controllerRef.current?.scheduleRefresh(0)
        void refreshData()
      } else {
        setPlaceError(res.error ?? 'merge failed')
      }
    })
  }, [placeSelection, mergePlaceName, clearPlaceSelection, refreshData])

  // With exactly one place selected, a track click folds it into that place as
  // a stationary visit and deletes the track — destructive, so confirm.
  const handleTrackToPlace = useCallback((segmentId: number): void => {
    const sel = placeSelectionRef.current
    if (sel.length !== 1) {
      setPlaceError('Select exactly one place first, then click a track to add it.')
      return
    }
    const target = sel[0]!
    if (
      !skipConfirmRef.current &&
      !window.confirm(
        `Add this track to “${target.name ?? 'this place'}” as a stationary visit? The track is removed and this cannot be undone.`
      )
    ) {
      return
    }
    setPlaceBusy(true)
    setPlaceError(null)
    void window.api.assignTrackToPlace(segmentId, target.ref).then((res) => {
      setPlaceBusy(false)
      if (res.ok) {
        clearPlaceSelection()
        controllerRef.current?.scheduleRefresh(0)
        void refreshData()
        refreshDraftCount() // the folded-in track may have carried a draft
      } else {
        setPlaceError(res.error ?? 'assign failed')
      }
    })
  }, [clearPlaceSelection, refreshData, refreshDraftCount])

  const refreshDatasetStats = useCallback((): void => {
    void window.api.getDatasetStats().then((s) => setDatasetStats(s))
  }, [])

  const inspectPlace = useCallback((ref: PlaceRef): void => {
    setStatsPlaceLoading(true)
    void window.api.getPlaceStats(ref).then((s) => {
      setStatsPlace(s)
      setStatsPlaceLoading(false)
    })
  }, [])

  const handlePickTopPlace = useCallback(
    (ref: PlaceRef, lat: number, lon: number): void => {
      controllerRef.current?.flyToPlace(lat, lon)
      inspectPlace(ref)
    },
    [inspectPlace]
  )

  // Keep the click-listener refs pointing at the latest handler + selection.
  useEffect(() => {
    placeSelectionRef.current = placeSelection
  }, [placeSelection])
  useEffect(() => {
    placeSelectCbRef.current = handlePlaceSelect
  }, [handlePlaceSelect])
  useEffect(() => {
    trackToPlaceCbRef.current = handleTrackToPlace
  }, [handleTrackToPlace])
  useEffect(() => {
    inspectPlaceCbRef.current = inspectPlace
  }, [inspectPlace])

  // Default the kept name to the most *frequent* name across the selection (sum
  // of visits per name), re-derived as the selection changes — so selection
  // order never decides it. A name the user has typed is never clobbered.
  useEffect(() => {
    if (mergeNameTouched) return
    const totals = new Map<string, number>()
    for (const p of placeSelection) {
      if (p.name) totals.set(p.name, (totals.get(p.name) ?? 0) + p.visitCount)
    }
    let bestName = ''
    let bestTotal = -1
    for (const [name, total] of totals) {
      if (total > bestTotal) {
        bestTotal = total
        bestName = name
      }
    }
    setMergePlaceName(bestName)
  }, [placeSelection, mergeNameTouched])

  // Drive the place ring(s): the inspected place in Stats; in the merge-places
  // tool, the selected places — but when exactly one is selected for detailed
  // editing, ring its outlier *visits* instead so they stand out for exclusion.
  useEffect(() => {
    const controller = controllerRef.current
    if (!controller) return
    if (appMode === 'stats') {
      controller.setPlaceHighlight(
        statsPlace ? [[statsPlace.lon, statsPlace.lat] as [number, number]] : []
      )
    } else if (appMode === 'edit' && editTool === 'mergePlaces') {
      if (placeSelection.length === 1 && placeMembers) {
        controller.setPlaceHighlight(
          placeMembers.filter((m) => m.outlier).map((m) => [m.lon, m.lat] as [number, number])
        )
      } else {
        controller.setPlaceHighlight(placeSelection.map((p) => [p.lon, p.lat] as [number, number]))
      }
    }
  }, [appMode, editTool, statsPlace, placeSelection, placeMembers])

  // Load the selected single place's visits (for the detail editor + outlier
  // rings); clear when the selection isn't exactly one place.
  useEffect(() => {
    if (appMode !== 'edit' || editTool !== 'mergePlaces' || placeSelection.length !== 1) {
      setPlaceMembers(null)
      setPlaceMembersLoading(false)
      setSeparateSelection([])
      return
    }
    const place = placeSelection[0]!
    setRenameValue(place.name ?? '')
    setPlaceMembersLoading(true)
    let cancelled = false
    void window.api.getPlaceMembers(place.ref).then((members) => {
      if (cancelled) return
      setPlaceMembers(members)
      setPlaceMembersLoading(false)
      // Drop any ticked visits that are no longer present.
      setSeparateSelection((prev) => prev.filter((id) => (members ?? []).some((m) => m.id === id)))
    })
    return () => {
      cancelled = true
    }
  }, [appMode, editTool, placeSelection])

  // Switch between Display, Edit, and Stats. Edit focuses the map on the active
  // editing tool; Stats makes places clickable for inspection; Display restores
  // the normal panels.
  const handleAppMode = useCallback(
    (mode: AppMode): void => {
      setAppMode(mode)
      setEditError(null)
      clearMerge()
      clearPlaceSelection()
      clearBulk()
      setStatsPlace(null)
      const controller = controllerRef.current
      if (!controller) return
      controller.setEditMode(mode === 'edit')
      controller.setStatsMode(mode === 'stats')
      if (mode === 'edit') {
        controller.setEditTool(editTool)
        refreshDraftCount()
      }
      if (mode === 'stats') refreshDatasetStats()
    },
    [clearMerge, clearPlaceSelection, clearBulk, editTool, refreshDatasetStats, refreshDraftCount]
  )

  const handleEditTool = useCallback(
    (tool: EditTool): void => {
      setEditTool(tool)
      setEditError(null)
      clearMerge()
      clearPlaceSelection()
      clearBulk()
      controllerRef.current?.setEditTool(tool)
    },
    [clearMerge, clearPlaceSelection, clearBulk]
  )

  // Keep the merge map highlight in sync with the candidate/selection state.
  useEffect(() => {
    controllerRef.current?.setMergeHighlight(
      mergeCandidates.map((c) => c.segmentId),
      mergeSelected
    )
  }, [mergeCandidates, mergeSelected])

  // Default the merged type to the longest selected leg; keep a still-valid
  // type the user picked (any existing category is allowed, not just a leg's).
  useEffect(() => {
    setMergeType((cur) =>
      categories.some((c) => c.name === cur) ? cur : defaultMergeType(mergeSelected, mergeCandidates)
    )
  }, [mergeSelected, mergeCandidates, categories])

  const handleMergeByDate = useCallback((dateStr: string): void => {
    const ts = Date.parse(`${dateStr}T12:00:00Z`)
    if (!Number.isFinite(ts)) return
    void window.api.listMergeCandidates({ tsMs: ts }).then((cands) => {
      setMergeError(null)
      setMergeCandidates(cands)
      setMergeSelected([])
    })
  }, [])

  const handleToggleMergeSelect = useCallback((segmentId: number): void => {
    setMergeSelected((prev) =>
      prev.includes(segmentId) ? prev.filter((id) => id !== segmentId) : [...prev, segmentId]
    )
  }, [])

  const handleMerge = useCallback((): void => {
    if (mergeSelected.length < 2 || !mergeType) return
    if (
      !skipConfirmRef.current &&
      !window.confirm(
        `Merge ${mergeSelected.length} tracks into one ${mergeType} track? The separate tracks are replaced and this cannot be undone.`
      )
    ) {
      return
    }
    setMergeBusy(true)
    setMergeError(null)
    void window.api.mergeSegments(mergeSelected, mergeType).then((res) => {
      setMergeBusy(false)
      if (res.ok) {
        clearMerge()
        controllerRef.current?.scheduleRefresh(0)
        void refreshData()
        refreshDraftCount() // a merged-away segment may have carried a draft
      } else {
        setMergeError(res.error ?? 'merge failed')
      }
    })
  }, [mergeSelected, mergeType, clearMerge, refreshData, refreshDraftCount])

  const handleSaveEdits = useCallback(
    (mode: EditSaveMode): void => {
      const controller = controllerRef.current
      if (!controller) return
      if (
        mode === 'permanent' &&
        !skipConfirmRef.current &&
        !window.confirm(
          "Permanently rewrite this track's original points with the edited line? This cannot be undone."
        )
      ) {
        return
      }
      setEditBusy(true)
      setEditError(null)
      void controller.saveEdits(mode).then((res) => {
        setEditBusy(false)
        if (!res.ok) {
          setEditError(res.error ?? 'save failed')
          return
        }
        // Permanent saves change point counts; keep the stats panel honest.
        if (mode === 'permanent') void refreshData()
      })
    },
    [refreshData]
  )

  const handleRevertEdits = useCallback((): void => {
    const controller = controllerRef.current
    if (!controller) return
    setEditBusy(true)
    setEditError(null)
    void controller.revertEdits().then((res) => {
      setEditBusy(false)
      if (!res.ok) setEditError(res.error ?? 'revert failed')
    })
  }, [])

  // Bulk "save all": flush the open session to a draft so it's included, then
  // bake every draft into its track for good.
  const handleCommitAllDrafts = useCallback((): void => {
    if (
      !skipConfirmRef.current &&
      !window.confirm(
        'Permanently bake all draft edits into their tracks? This rewrites those tracks’ points and cannot be undone.'
      )
    ) {
      return
    }
    setEditBusy(true)
    setEditError(null)
    void (async () => {
      const settled = await controllerRef.current?.settleEditSessionForBulk(true)
      if (settled && !settled.ok) {
        setEditBusy(false)
        setEditError(settled.error ?? 'save failed')
        return
      }
      const res = await window.api.commitAllDrafts()
      setEditBusy(false)
      if (res.ok) {
        controllerRef.current?.scheduleRefresh(0)
        refreshDraftCount()
        void refreshData()
      } else {
        setEditError(res.error ?? 'commit failed')
      }
    })()
  }, [refreshData, refreshDraftCount])

  // Bulk "discard all": drop the open session and every saved draft, restoring
  // the original tracks.
  const handleRevertAllDrafts = useCallback((): void => {
    if (
      !skipConfirmRef.current &&
      !window.confirm('Discard all draft edits and restore the original tracks? This cannot be undone.')
    ) {
      return
    }
    setEditBusy(true)
    setEditError(null)
    void (async () => {
      await controllerRef.current?.settleEditSessionForBulk(false)
      const res = await window.api.revertAllDrafts()
      setEditBusy(false)
      if (res.ok) {
        controllerRef.current?.scheduleRefresh(0)
        refreshDraftCount()
      } else {
        setEditError(res.error ?? 'discard failed')
      }
    })()
  }, [refreshDraftCount])

  const handleCloseEdit = useCallback((): void => {
    setEditError(null)
    controllerRef.current?.closeEditSession()
  }, [])

  const handleSplitPreview = useCallback(
    (index: number | null, firstType?: string, secondType?: string): void => {
      controllerRef.current?.setSplitPreview(index, firstType, secondType)
    },
    []
  )

  // Precise slider split with per-half types — structural, so confirm first.
  const handleSplit = useCallback(
    (index: number, firstType: string, secondType: string): void => {
      const controller = controllerRef.current
      if (!controller) return
      const into =
        firstType === secondType
          ? `into two ${firstType} tracks`
          : `into a ${firstType} track and a ${secondType} track`
      if (
        !skipConfirmRef.current &&
        !window.confirm(`Split this track ${into}? This commits the current edits and cannot be undone.`)
      ) {
        return
      }
      setEditBusy(true)
      setEditError(null)
      void controller.commitSplitAt(index, firstType, secondType).then((res) => {
        setEditBusy(false)
        if (res.ok) void refreshData()
        else setEditError(res.error ?? 'split failed')
      })
    },
    [refreshData]
  )

  const handleChangeType = useCallback((type: string): void => {
    const controller = controllerRef.current
    if (!controller) return
    setEditBusy(true)
    setEditError(null)
    void controller.setSegmentType(type).then((res) => {
      setEditBusy(false)
      if (!res.ok) setEditError(res.error ?? 'type change failed')
    })
  }, [])

  const handleDeleteTrack = useCallback((): void => {
    const controller = controllerRef.current
    if (!controller) return
    if (
      !skipConfirmRef.current &&
      !window.confirm('Delete this entire track? This removes it for good and cannot be undone.')
    ) {
      return
    }
    setEditBusy(true)
    setEditError(null)
    void controller.deleteSegment().then((res) => {
      setEditBusy(false)
      if (!res.ok) setEditError(res.error ?? 'delete failed')
    })
  }, [])

  const handleBasemapTheme = useCallback((theme: 'dark' | 'light'): void => {
    setConfig((prev) => {
      if (!prev) return prev
      void controllerRef.current?.setBasemap(prev.basemapStyles[theme])
      return { ...prev, basemapTheme: theme, basemapStyleUrl: prev.basemapStyles[theme] }
    })
    void window.api.setBasemapTheme(theme)
  }, [])

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>Arc Visualizer</h1>
        <div className="mode-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={appMode === 'display'}
            className={appMode === 'display' ? 'active' : ''}
            onClick={() => handleAppMode('display')}
          >
            Display
          </button>
          <button
            role="tab"
            aria-selected={appMode === 'edit'}
            className={appMode === 'edit' ? 'active' : ''}
            onClick={() => handleAppMode('edit')}
          >
            Edit
          </button>
          <button
            role="tab"
            aria-selected={appMode === 'stats'}
            className={appMode === 'stats' ? 'active' : ''}
            onClick={() => handleAppMode('stats')}
          >
            Stats
          </button>
        </div>

        {appMode === 'display' ? (
          <>
            <ImportPanel progress={importProgress} />
            <DateFilter summary={summary} onChange={handleDateRange} />
            <CategoryPanel
              categories={categories}
              showWaypoints={showWaypoints}
              onToggle={handleToggleCategory}
              onToggleWaypoints={handleToggleWaypoints}
              onColorChange={handleColorChange}
              onReorder={handleReorderCategories}
              onToggleAll={handleToggleAllCategories}
            />
            <ColorModeControl mode={colorMode} summary={summary} onChange={handleColorMode} />
            <DetailControl mode={detailMode} onChange={handleDetailMode} />
            <CleaningControl
              averageRail={averageRail}
              snapRail={snapRail}
              snapRoad={snapRoad}
              railCoverage={railCoverage}
              railFetching={railFetching}
              railRebuilding={railRebuilding}
              railProgress={railProgress}
              railError={railError}
              railTuning={config?.railTuning ?? null}
              routeCoverage={routeCoverage}
              routeFetching={routeFetching}
              routeError={routeError}
              onChangeAverage={handleAverageRail}
              onChangeSnap={handleSnapRail}
              onChangeSnapRoad={handleSnapRoad}
              onFetchRail={handleFetchRail}
              onClearRail={handleClearRail}
              onApplyTuning={handleApplyTuning}
              onFetchRoute={handleFetchRoute}
              onClearRoute={handleClearRoute}
            />
            {config && <BasemapControl theme={config.basemapTheme} onChange={handleBasemapTheme} />}
          </>
        ) : appMode === 'edit' ? (
          <>
            <div className="mode-tabs sub" role="tablist">
              <button
                role="tab"
                aria-selected={editTool === 'points'}
                className={editTool === 'points' ? 'active' : ''}
                onClick={() => handleEditTool('points')}
              >
                Edit points
              </button>
              <button
                role="tab"
                aria-selected={editTool === 'merge'}
                className={editTool === 'merge' ? 'active' : ''}
                onClick={() => handleEditTool('merge')}
              >
                Merge tracks
              </button>
              <button
                role="tab"
                aria-selected={editTool === 'mergePlaces'}
                className={editTool === 'mergePlaces' ? 'active' : ''}
                onClick={() => handleEditTool('mergePlaces')}
              >
                Merge places
              </button>
              <button
                role="tab"
                aria-selected={editTool === 'bulk'}
                className={editTool === 'bulk' ? 'active' : ''}
                onClick={() => handleEditTool('bulk')}
              >
                Bulk clean
              </button>
            </div>
            <label className="color-mode-option" title="Also bakes a click-off save permanently">
              <input
                type="checkbox"
                checked={skipConfirm}
                onChange={(e) => setSkipConfirm(e.target.checked)}
              />
              <span>Skip confirmations (click-off saves permanently)</span>
            </label>
            <DraftsPanel
              count={draftCount}
              busy={editBusy}
              error={editTool === 'points' ? null : editError}
              onCommitAll={handleCommitAllDrafts}
              onRevertAll={handleRevertAllDrafts}
            />
            {editTool === 'points' ? (
              <TrackEditPanel
                session={editSession}
                busy={editBusy}
                error={editError}
                categoryNames={categories.map((c) => c.name)}
                categoryColors={Object.fromEntries(categories.map((c) => [c.name, c.color]))}
                reroute={rerouteInfo}
                hasRouteCoverage={routeCoverage !== null}
                routeFetching={routeFetching}
                routeError={routeError}
                onSave={handleSaveEdits}
                onRevert={handleRevertEdits}
                onClose={handleCloseEdit}
                onSplitPreview={handleSplitPreview}
                onSplit={handleSplit}
                onChangeType={handleChangeType}
                onDeleteTrack={handleDeleteTrack}
                onRerouteRange={handleRerouteRange}
                onClearVias={handleClearVias}
                onApplyReroute={handleApplyReroute}
                onFetchRoads={handleFetchRoute}
              />
            ) : editTool === 'merge' ? (
              <MergePanel
                candidates={mergeCandidates}
                selected={mergeSelected}
                mergeType={mergeType}
                categoryNames={categories.map((c) => c.name)}
                busy={mergeBusy}
                error={mergeError}
                onPickDate={handleMergeByDate}
                onToggleSelect={handleToggleMergeSelect}
                onTypeChange={setMergeType}
                onMerge={handleMerge}
                onClear={clearMerge}
              />
            ) : editTool === 'mergePlaces' ? (
              <>
                <MergePlacesPanel
                  selected={placeSelection}
                  mergeName={mergePlaceName}
                  busy={placeBusy}
                  error={placeError}
                  onNameChange={handleMergeNameChange}
                  onMerge={handleMergePlaces}
                  onClear={clearPlaceSelection}
                  onRemove={handleRemovePlace}
                />
                {placeSelection.length === 1 && (
                  <PlaceDetailPanel
                    members={placeMembers}
                    loading={placeMembersLoading}
                    busy={placeBusy}
                    renameValue={renameValue}
                    selectedVisitIds={separateSelection}
                    onRenameChange={setRenameValue}
                    onRename={handleRenamePlace}
                    onToggleVisit={handleToggleVisit}
                    onSelectOutliers={handleSelectOutliers}
                    onSeparate={handleSeparateVisits}
                  />
                )}
              </>
            ) : (
              <BulkPanel
                anchorId={bulkAnchorId}
                count={bulkSelection.length}
                radiusM={bulkRadiusM}
                mode={bulkMode}
                busy={bulkBusy}
                error={bulkError}
                result={bulkResult}
                hasRouteCoverage={routeCoverage !== null}
                routeFetching={routeFetching}
                onRadiusChange={setBulkRadiusM}
                onModeChange={setBulkMode}
                onRerouteAll={handleBulkRerouteAll}
                onDeleteAll={handleBulkDeleteAll}
                onFetchRoads={handleFetchRoute}
                onClear={clearBulk}
              />
            )}
          </>
        ) : (
          <StatsView
            dataset={datasetStats}
            place={statsPlace}
            placeLoading={statsPlaceLoading}
            categories={categories}
            onPickTopPlace={handlePickTopPlace}
            onClearPlace={() => setStatsPlace(null)}
          />
        )}

        {appMode !== 'stats' && (
          <StatsPanel
            summary={summary}
            lastImport={lastImport}
            renderStats={renderStats}
            config={config}
          />
        )}
        <button
          className="fit-button"
          onClick={() => void controllerRef.current?.fitToData()}
        >
          Fit map to data
        </button>
        <button
          className="fit-button"
          onClick={() => {
            const dataUrl = controllerRef.current?.exportPng()
            if (dataUrl) void window.api.exportMapPng(dataUrl)
          }}
        >
          Export current view as PNG
        </button>
      </aside>
      <main className="map-wrap">
        <div ref={mapDivRef} className="map" />
      </main>
    </div>
  )
}
