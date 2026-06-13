import { useState } from 'react'
import type {
  ImportOverlapAnalysis,
  ImportProgress,
  OverwriteWindow
} from '../../../shared/types'

/** Date helpers mirror DateFilter: UTC day bounds, YYYY-MM-DD inputs. */
const toDateInput = (tsMs: number): string => new Date(tsMs).toISOString().slice(0, 10)
const startOfDayUtc = (s: string): number | null => {
  const t = Date.parse(`${s}T00:00:00Z`)
  return Number.isFinite(t) ? t : null
}
const endOfDayUtc = (s: string): number | null => {
  const t = Date.parse(`${s}T23:59:59.999Z`)
  return Number.isFinite(t) ? t : null
}

interface DateWindow {
  start: string
  end: string
}

export function ImportPanel({ progress }: { progress: ImportProgress | null }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [overwriteMode, setOverwriteMode] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  // The pending overwrite review: which files overlap, the editable windows.
  const [analysis, setAnalysis] = useState<ImportOverlapAnalysis | null>(null)
  const [pendingPaths, setPendingPaths] = useState<string[] | null>(null)
  const [windows, setWindows] = useState<Record<string, DateWindow>>({})

  const launch = async (paths: string[], overwrite?: OverwriteWindow[]): Promise<void> => {
    const res = await window.api.startImport(paths, overwrite)
    if (!res.started) setError(res.reason ?? 'import could not start')
  }

  const closeReview = (): void => {
    setAnalysis(null)
    setPendingPaths(null)
    setWindows({})
  }

  const begin = async (kind: 'files' | 'folder'): Promise<void> => {
    setError(null)
    closeReview()
    const paths = await window.api.selectPaths(kind)
    if (!paths || paths.length === 0) return
    if (!overwriteMode) {
      await launch(paths)
      return
    }
    // Overwrite: scan for date overlaps and let the user review the windows.
    setAnalyzing(true)
    try {
      const a = await window.api.analyzeImportOverlap(paths)
      if (a.overlaps.length === 0) {
        await launch(paths) // nothing overlaps — a normal import
        return
      }
      setAnalysis(a)
      setPendingPaths(paths)
      setWindows(
        Object.fromEntries(
          a.overlaps.map((o) => [
            o.path,
            { start: toDateInput(o.overlapStartTsMs), end: toDateInput(o.overlapEndTsMs) }
          ])
        )
      )
    } finally {
      setAnalyzing(false)
    }
  }

  const setWin = (path: string, field: keyof DateWindow, value: string): void => {
    setWindows((prev) => ({ ...prev, [path]: { ...(prev[path] ?? { start: '', end: '' }), [field]: value } }))
  }

  const confirmOverwrite = (): void => {
    if (!analysis || !pendingPaths) return
    const wins: OverwriteWindow[] = []
    for (const o of analysis.overlaps) {
      const w = windows[o.path]
      const s = w ? startOfDayUtc(w.start) : null
      const e = w ? endOfDayUtc(w.end) : null
      if (s !== null && e !== null && e >= s) wins.push({ startTsMs: s, endTsMs: e })
    }
    const paths = pendingPaths
    closeReview()
    void launch(paths, wins)
  }

  const importWithout = (): void => {
    if (!pendingPaths) return
    const paths = pendingPaths
    closeReview()
    void launch(paths)
  }

  const running = progress !== null && progress.kind !== 'done' && progress.kind !== 'error'
  const reviewing = analysis !== null
  const busy = running || analyzing || reviewing

  let statusLine: string | null = null
  let pct = 0
  if (analyzing) {
    statusLine = 'Scanning for date overlaps…'
  } else if (progress?.kind === 'started') {
    statusLine = `Scanning… ${progress.totalFiles} file(s) found`
  } else if (progress?.kind === 'file') {
    pct = progress.totalFiles > 0 ? ((progress.index + 1) / progress.totalFiles) * 100 : 0
    const verb = progress.failed ? 'failed' : progress.skipped ? 'skipped (already imported)' : 'imported'
    statusLine = `${progress.index + 1}/${progress.totalFiles} ${verb}: ${progress.filename}`
  } else if (progress?.kind === 'done') {
    const s = progress.stats
    statusLine = `Done: ${s.filesProcessed} imported, ${s.filesSkipped} skipped, ${s.filesFailed} failed in ${(s.durationMs / 1000).toFixed(1)}s`
    pct = 100
  } else if (progress?.kind === 'error') {
    statusLine = `Import error: ${progress.error}`
  }

  return (
    <section className="panel">
      <h2>Import</h2>
      <div className="button-row">
        <button disabled={busy} onClick={() => void begin('files')}>
          Import files…
        </button>
        <button disabled={busy} onClick={() => void begin('folder')}>
          Import folder…
        </button>
      </div>
      <label className="color-mode-option" title="Replace existing data on overlapping dates instead of duplicating it">
        <input
          type="checkbox"
          checked={overwriteMode}
          disabled={running || analyzing}
          onChange={(e) => setOverwriteMode(e.target.checked)}
        />
        <span>Overwrite overlapping dates</span>
      </label>

      {reviewing && analysis && (
        <div className="overlap-review">
          <p className="hint">
            {analysis.overlaps.length} of {analysis.totalFiles} file(s) overlap existing data. Adjust
            each window to overwrite (existing data in that range is replaced; other dates are kept).
          </p>
          <ul className="overlap-list">
            {analysis.overlaps.map((o) => {
              const w = windows[o.path] ?? { start: '', end: '' }
              return (
                <li key={o.path}>
                  <div className="overlap-file" title={o.path}>
                    {o.filename}
                  </div>
                  <div className="hint">
                    {o.overlapSegmentCount.toLocaleString()} tracks, {o.overlapVisitCount.toLocaleString()}{' '}
                    visits in range
                  </div>
                  <div className="date-row">
                    <input
                      type="date"
                      aria-label={`${o.filename} overwrite start`}
                      value={w.start}
                      onChange={(e) => setWin(o.path, 'start', e.target.value)}
                    />
                    <span>→</span>
                    <input
                      type="date"
                      aria-label={`${o.filename} overwrite end`}
                      value={w.end}
                      onChange={(e) => setWin(o.path, 'end', e.target.value)}
                    />
                  </div>
                </li>
              )
            })}
          </ul>
          <div className="button-row">
            <button onClick={confirmOverwrite}>Overwrite &amp; import</button>
            <button onClick={importWithout}>Import without overwriting</button>
            <button className="link-button" onClick={closeReview}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {running && (
        <div className="progress-track">
          <div className="progress-bar" style={{ width: `${pct}%` }} />
        </div>
      )}
      {statusLine && <p className="status-line">{statusLine}</p>}
      {error && <p className="status-line error">{error}</p>}
      <p className="hint">
        Files are parsed in a background thread and indexed into a local database;
        already-imported files are skipped by content hash. Overwrite mode replaces
        existing data on the dates a file covers, so re-exports don&apos;t duplicate.
      </p>
    </section>
  )
}
