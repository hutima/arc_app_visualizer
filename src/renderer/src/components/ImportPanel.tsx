import { useState } from 'react'
import type { ImportProgress } from '../../../shared/types'

export function ImportPanel({ progress }: { progress: ImportProgress | null }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)

  const startImport = async (kind: 'files' | 'folder'): Promise<void> => {
    setError(null)
    const paths = await window.api.selectPaths(kind)
    if (!paths || paths.length === 0) return
    const res = await window.api.startImport(paths)
    if (!res.started) setError(res.reason ?? 'import could not start')
  }

  const running =
    progress !== null && progress.kind !== 'done' && progress.kind !== 'error'

  let statusLine: string | null = null
  let pct = 0
  if (progress?.kind === 'started') {
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
        <button disabled={running} onClick={() => void startImport('files')}>
          Import files…
        </button>
        <button disabled={running} onClick={() => void startImport('folder')}>
          Import folder…
        </button>
      </div>
      {running && (
        <div className="progress-track">
          <div className="progress-bar" style={{ width: `${pct}%` }} />
        </div>
      )}
      {statusLine && <p className="status-line">{statusLine}</p>}
      {error && <p className="status-line error">{error}</p>}
      <p className="hint">
        Files are parsed in a background thread and indexed into a local
        database; already-imported files are skipped by content hash.
      </p>
    </section>
  )
}
