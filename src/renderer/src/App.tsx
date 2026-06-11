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
import { colorForCategory } from '../../shared/categories'
import { yearRange } from '../../shared/yearColors'
import { MapController, type RenderStats } from './map/MapController'
import { ImportPanel } from './components/ImportPanel'
import { BasemapControl } from './components/BasemapControl'
import { CategoryPanel } from './components/CategoryPanel'
import { CleaningControl } from './components/CleaningControl'
import { ColorModeControl } from './components/ColorModeControl'
import { DateFilter } from './components/DateFilter'
import { DetailControl } from './components/DetailControl'
import { StatsPanel } from './components/StatsPanel'

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
      await refreshData()
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
        <CleaningControl averageRail={averageRail} onChange={handleAverageRail} />
        {config && <BasemapControl theme={config.basemapTheme} onChange={handleBasemapTheme} />}
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
          Export map as PNG
        </button>
      </aside>
      <main className="map-wrap">
        <div ref={mapDivRef} className="map" />
      </main>
    </div>
  )
}
