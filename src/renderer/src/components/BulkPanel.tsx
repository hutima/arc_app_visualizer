import type { BulkRerouteResult, SimilarMode } from '../../../shared/types'

interface Props {
  /** The anchor track clicked (null = none yet). */
  anchorId: number | null
  /** How many similar tracks are selected (includes the anchor). */
  count: number
  radiusM: number
  mode: SimilarMode
  busy: boolean
  error: string | null
  result: BulkRerouteResult | null
  hasRouteCoverage: boolean
  routeFetching: boolean
  onRadiusChange: (m: number) => void
  onModeChange: (m: SimilarMode) => void
  onRerouteAll: () => void
  onDeleteAll: () => void
  onFetchRoads: () => void
  onClear: () => void
}

/**
 * Bulk cleaning: click a track, find others of the same type that share its
 * start and end (direction-aware), then reroute or delete them all at once.
 * Geometry/selection lives in MapController; this is the controls + summary.
 */
export function BulkPanel({
  anchorId,
  count,
  radiusM,
  mode,
  busy,
  error,
  result,
  hasRouteCoverage,
  routeFetching,
  onRadiusChange,
  onModeChange,
  onRerouteAll,
  onDeleteAll,
  onFetchRoads,
  onClear
}: Props): React.JSX.Element {
  return (
    <section className="panel">
      <h2>Bulk clean</h2>
      <p className="hint">
        Click a track to select every similar track (same type) for cleaning in
        bulk — then reroute them all to clean road routes, or delete them.
      </p>

      <div className="rail-tuning">
        <label>
          <span>Match within (m)</span>
          <input
            type="number"
            min={10}
            max={5000}
            step={10}
            value={radiusM}
            disabled={busy}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v) && v > 0) onRadiusChange(v)
            }}
          />
        </label>
      </div>
      <div className="color-mode-row" role="radiogroup" aria-label="similarity mode">
        <label className="color-mode-option">
          <input
            type="radio"
            name="bulk-mode"
            checked={mode === 'endpoints'}
            disabled={busy}
            onChange={() => onModeChange('endpoints')}
          />
          <span>Same start &amp; end</span>
        </label>
        <label className="color-mode-option">
          <input
            type="radio"
            name="bulk-mode"
            checked={mode === 'passthrough'}
            disabled={busy}
            onChange={() => onModeChange('passthrough')}
          />
          <span>Passes through both</span>
        </label>
      </div>
      <p className="hint">
        {mode === 'endpoints'
          ? 'Tracks that start and end within the radius of this track’s start and end.'
          : 'Longer tracks that pass through both this track’s start and end (e.g. a shared highway).'}
      </p>

      {anchorId === null ? (
        <p className="hint">No track selected yet.</p>
      ) : (
        <p className="hint">
          <strong>{count.toLocaleString()}</strong> similar track{count === 1 ? '' : 's'} selected
          (including this one).
        </p>
      )}

      {anchorId !== null && !hasRouteCoverage && (
        <p className="hint">
          Rerouting needs the drivable road network for this area.{' '}
          <button type="button" className="link-button" disabled={routeFetching} onClick={onFetchRoads}>
            {routeFetching ? 'Fetching…' : 'Fetch roads in view'}
          </button>
        </p>
      )}

      {anchorId !== null && (
        <>
          <div className="edit-actions">
            <button
              type="button"
              disabled={busy || count === 0 || !hasRouteCoverage}
              onClick={onRerouteAll}
            >
              {busy ? 'Working…' : 'Reroute all to roads'}
            </button>
            <button type="button" disabled={busy} onClick={onClear}>
              Clear
            </button>
          </div>
          <div className="edit-actions">
            <button type="button" className="danger" disabled={busy || count === 0} onClick={onDeleteAll}>
              Delete all {count.toLocaleString()}
            </button>
          </div>
        </>
      )}

      {result && (
        <p className="hint status-line">
          Rerouted <strong>{result.rerouted}</strong> as drafts
          {result.skipped > 0 ? `, skipped ${result.skipped}` : ''}
          {result.failed > 0 ? `, ${result.failed} failed` : ''}. Review or discard them in the
          drafts panel above.
        </p>
      )}
      {error && <p className="hint status-line error">{error}</p>}
    </section>
  )
}
