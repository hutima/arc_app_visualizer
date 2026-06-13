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
  EditSaveMode,
  MergeCandidate,
  OsmLayer,
  RailCoverage,
  RailMatchProgress,
  RailTuning
} from '../../shared/types'
import { colorForCategory } from '../../shared/categories'
import { yearRange } from '../../shared/yearColors'
import {
  MapController,
  type EditSessionInfo,
  type EditTool,
  type RenderStats
} from './map/MapController'
import { ImportPanel } from './components/ImportPanel'
import { BasemapControl } from './components/BasemapControl'
import { CategoryPanel } from './components/CategoryPanel'
import { CleaningControl } from './components/CleaningControl'
import { ColorModeControl } from './components/ColorModeControl'
import { DateFilter } from './components/DateFilter'
import { DetailControl } from './components/DetailControl'
import { StatsPanel } from './components/StatsPanel'
import { TrackEditPanel } from './components/TrackEditPanel'
import { MergePanel } from './components/MergePanel'

type AppMode = 'display' | 'edit'

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
  const [appMode, setAppMode] = useState<AppMode>('display')
  const [editTool, setEditTool] = useState<EditTool>('points')
  const [editSession, setEditSession] = useState<EditSessionInfo | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [mergeCandidates, setMergeCandidates] = useState<MergeCandidate[]>([])
  const [mergeSelected, setMergeSelected] = useState<number[]>([])
  const [mergeType, setMergeType] = useState('')
  const [mergeBusy, setMergeBusy] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)

  const mapDivRef = useRef<HTMLDivElement | null>(null)
  const controllerRef = useRef<MapController | null>(null)
  const hadDataOnLoadRef = useRef(false)

  const refreshData = useCallback(async (): Promise<void> => {
    const [cats, sum] = await Promise.all([window.api.getCategories(), window.api.getSummary()])
    setCategories(cats)
    setSummary(sum)
    controllerRef.current?.setCategories(cats)
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
      // Splitting is destructive (commits edits, restructures): confirm here,
      // then refresh dataset stats since point counts change.
      controller.setSplitRequestListener((segmentId, seq) => {
        if (
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
      await refreshData()
      void window.api.getRailCoverage().then((cov) => {
        if (!disposed) setRailCoverage(cov)
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

  // Wipe all fetched OSM data and cached geometry.
  const handleClearRail = useCallback((): void => {
    void window.api.clearRailNetwork().then(() => {
      setRailCoverage(null)
      setRailError(null)
      setSnapRail(false)
      controllerRef.current?.setSnapRail(false)
      setSnapRoad(false)
      controllerRef.current?.setSnapRoad(false)
      controllerRef.current?.scheduleRefresh(0)
    })
  }, [])

  const clearMerge = useCallback((): void => {
    setMergeCandidates([])
    setMergeSelected([])
    setMergeType('')
    setMergeError(null)
    controllerRef.current?.setMergeHighlight([], [])
  }, [])

  // Switch between the Display view and the Edit view. Edit view focuses the
  // map on the active editing tool; Display restores the normal panels.
  const handleAppMode = useCallback(
    (mode: AppMode): void => {
      setAppMode(mode)
      setEditError(null)
      clearMerge()
      const controller = controllerRef.current
      if (!controller) return
      controller.setEditMode(mode === 'edit')
      if (mode === 'edit') controller.setEditTool(editTool)
    },
    [clearMerge, editTool]
  )

  const handleEditTool = useCallback(
    (tool: EditTool): void => {
      setEditTool(tool)
      setEditError(null)
      clearMerge()
      controllerRef.current?.setEditTool(tool)
    },
    [clearMerge]
  )

  // Keep the merge map highlight in sync with the candidate/selection state.
  useEffect(() => {
    controllerRef.current?.setMergeHighlight(
      mergeCandidates.map((c) => c.segmentId),
      mergeSelected
    )
  }, [mergeCandidates, mergeSelected])

  // Default the merged type to the longest selected leg, unless the user has
  // picked a type that's still among the selection.
  useEffect(() => {
    setMergeType((cur) => {
      const selectedTypes = new Set(
        mergeCandidates.filter((c) => mergeSelected.includes(c.segmentId)).map((c) => c.type)
      )
      return selectedTypes.has(cur) ? cur : defaultMergeType(mergeSelected, mergeCandidates)
    })
  }, [mergeSelected, mergeCandidates])

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
      } else {
        setMergeError(res.error ?? 'merge failed')
      }
    })
  }, [mergeSelected, mergeType, clearMerge, refreshData])

  const handleSaveEdits = useCallback(
    (mode: EditSaveMode): void => {
      const controller = controllerRef.current
      if (!controller) return
      if (
        mode === 'permanent' &&
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

  const handleCloseEdit = useCallback((): void => {
    setEditError(null)
    controllerRef.current?.closeEditSession()
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
              onChangeAverage={handleAverageRail}
              onChangeSnap={handleSnapRail}
              onChangeSnapRoad={handleSnapRoad}
              onFetchRail={handleFetchRail}
              onClearRail={handleClearRail}
              onApplyTuning={handleApplyTuning}
            />
            {config && <BasemapControl theme={config.basemapTheme} onChange={handleBasemapTheme} />}
          </>
        ) : (
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
            </div>
            {editTool === 'points' ? (
              <TrackEditPanel
                session={editSession}
                busy={editBusy}
                error={editError}
                onSave={handleSaveEdits}
                onRevert={handleRevertEdits}
                onClose={handleCloseEdit}
              />
            ) : (
              <MergePanel
                candidates={mergeCandidates}
                selected={mergeSelected}
                mergeType={mergeType}
                busy={mergeBusy}
                error={mergeError}
                onPickDate={handleMergeByDate}
                onToggleSelect={handleToggleMergeSelect}
                onTypeChange={setMergeType}
                onMerge={handleMerge}
                onClear={clearMerge}
              />
            )}
          </>
        )}

        <StatsPanel
          summary={summary}
          lastImport={lastImport}
          renderStats={renderStats}
          config={config}
        />
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
