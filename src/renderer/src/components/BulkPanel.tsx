import type { BulkApplyResult, BulkRerouteResult, SimilarMode } from '../../../shared/types'

interface Props {
  /** The anchor track clicked (null = none yet). It is also the archetype. */
  anchorId: number | null
  /** How many similar tracks are selected (includes the anchor). */
  count: number
  radiusM: number
  mode: SimilarMode
  busy: boolean
  error: string | null
  result: BulkRerouteResult | null
  applyResult: BulkApplyResult | null
  hasRouteCoverage: boolean
  routeFetching: boolean
  onRadiusChange: (m: number) => void
  onModeChange: (m: SimilarMode) => void
  onApplyArchetype: () => void
  onRerouteAll: () => void
  onDeleteAll: () => void
  onFetchRoads: () => void
  onClear: () => void
}

/**
 * Bulk cleaning: click a track to select every similar track (same type, shared
 * start/end). The clicked track becomes an editable *archetype* — drag/insert/
 * delete its points like a single track — and "Apply shape to all" stamps that
 * one cleaned shape onto the whole batch, timing each copy from its own points
 * so every trip keeps its real speed. Geometry/selection lives in MapController;
 * this is the controls + summary.
 */
export function BulkPanel({
  anchorId,
  count,
  radiusM,
  mode,
  busy,
  error,
  result,
  applyResult,
  hasRouteCoverage,
  routeFetching,
  onRadiusChange,
  onModeChange,
  onApplyArchetype,
  onRerouteAll,
  onDeleteAll,
  onFetchRoads,
  onClear
}: Props): React.JSX.Element {
  return (
    <section className="panel">
      <h2>Bulk clean</h2>
      <p className="hint">
        Click a track to select every similar track (same type). The one you
        click becomes an editable archetype — fix its shape, then apply it to the
        whole batch at once.
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
        <>
          <p className="hint">
            <strong>{count.toLocaleString()}</strong> similar track{count === 1 ? '' : 's'} selected
            (including the archetype).
          </p>
          <p className="hint">
            Drag the archetype’s points to clean it up; click any orange match to
            drop it from the batch. Then apply the shape — each track keeps its
            own timing.
          </p>
        </>
      )}

      {anchorId !== null && (
        <>
          <div className="edit-actions">
            <button type="button" disabled={busy || count === 0} onClick={onApplyArchetype}>
              {busy ? 'Working…' : `Apply shape to all ${count.toLocaleString()}`}
            </button>
            <button type="button" disabled={busy} onClick={onClear}>
              Clear
            </button>
          </div>
          {applyResult && (
            <p className="hint status-line">
              Applied to <strong>{applyResult.applied}</strong> as drafts
              {applyResult.skipped > 0 ? `, skipped ${applyResult.skipped}` : ''}
              {applyResult.failed > 0 ? `, ${applyResult.failed} failed` : ''}. Review or discard
              them in the drafts panel above.
            </p>
          )}

          {!hasRouteCoverage ? (
            <p className="hint">
              Or reroute the batch to clean road routes (needs the drivable road network here).{' '}
              <button type="button" className="link-button" disabled={routeFetching} onClick={onFetchRoads}>
                {routeFetching ? 'Fetching…' : 'Fetch roads in view'}
              </button>
            </p>
          ) : (
            <div className="edit-actions">
              <button type="button" disabled={busy || count === 0} onClick={onRerouteAll}>
                Reroute all to roads
              </button>
            </div>
          )}
          {result && (
            <p className="hint status-line">
              Rerouted <strong>{result.rerouted}</strong> as drafts
              {result.skipped > 0 ? `, skipped ${result.skipped}` : ''}
              {result.failed > 0 ? `, ${result.failed} failed` : ''}. Review or discard them in the
              drafts panel above.
            </p>
          )}

          <div className="edit-actions">
            <button type="button" className="danger" disabled={busy || count === 0} onClick={onDeleteAll}>
              Delete all {count.toLocaleString()}
            </button>
          </div>
        </>
      )}

      {error && <p className="hint status-line error">{error}</p>}
    </section>
  )
}
