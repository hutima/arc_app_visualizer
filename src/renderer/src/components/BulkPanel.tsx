import type { BulkApplyResult, SimilarMode } from '../../../shared/types'
import type { EditSessionInfo, RerouteInfo } from '../map/MapController'
import { RerouteTool } from './TrackEditPanel'

interface Props {
  /** The anchor track clicked (null = none yet). It is also the archetype. */
  anchorId: number | null
  /** How many similar tracks are selected (includes the anchor). */
  count: number
  radiusM: number
  mode: SimilarMode
  busy: boolean
  error: string | null
  applyResult: BulkApplyResult | null
  /** False = picking/deselecting matches; true = editing the lone archetype. */
  confirmed: boolean
  /** The archetype's edit session (drives the reroute tool), when open. */
  session: EditSessionInfo | null
  reroute: RerouteInfo | null
  hasRouteCoverage: boolean
  routeFetching: boolean
  routeError: string | null
  onRadiusChange: (m: number) => void
  onModeChange: (m: SimilarMode) => void
  onConfirm: () => void
  onReselect: () => void
  onRerouteRange: (range: { startIdx: number; endIdx: number } | null) => void
  onClearVias: () => void
  onApplyReroute: () => void
  onApplyArchetype: () => void
  onDeleteAll: () => void
  onCommitAll: () => void
  onFetchRoads: () => void
  onClear: () => void
}

/**
 * Bulk cleaning, two phases. Phase 1: click a track to select every similar
 * track (same type, shared start/end); click any orange match to drop an
 * inadvertent one. Confirm hides the matches so only the clicked track — the
 * **archetype** — remains. Phase 2: edit/reroute that one archetype like a
 * single track, then "Apply shape to all" stamps it onto the whole batch as
 * drafts, timing each copy from its own points so every trip keeps its real
 * speed. One reroute (the archetype) instead of hundreds. Geometry/selection
 * lives in MapController; this is the controls + summary.
 */
export function BulkPanel({
  anchorId,
  count,
  radiusM,
  mode,
  busy,
  error,
  applyResult,
  confirmed,
  session,
  reroute,
  hasRouteCoverage,
  routeFetching,
  routeError,
  onRadiusChange,
  onModeChange,
  onConfirm,
  onReselect,
  onRerouteRange,
  onClearVias,
  onApplyReroute,
  onApplyArchetype,
  onDeleteAll,
  onCommitAll,
  onFetchRoads,
  onClear
}: Props): React.JSX.Element {
  return (
    <section className="panel">
      <h2>Bulk clean</h2>

      {!confirmed ? (
        <>
          <p className="hint">
            Click a track to select every similar track (same type). The one you
            click is the archetype you’ll clean; click any orange match to drop it
            from the batch.
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
                <strong>{count.toLocaleString()}</strong> similar track{count === 1 ? '' : 's'}{' '}
                selected (including the archetype).
              </p>
              <div className="edit-actions">
                <button type="button" disabled={busy || count === 0} onClick={onConfirm}>
                  Confirm {count.toLocaleString()} &rarr; edit archetype
                </button>
                <button type="button" disabled={busy} onClick={onClear}>
                  Clear
                </button>
              </div>
              <div className="edit-actions">
                <button
                  type="button"
                  className="danger"
                  disabled={busy || count === 0}
                  onClick={onDeleteAll}
                >
                  Delete all {count.toLocaleString()}
                </button>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <p className="hint">
            Editing the <strong>archetype</strong> only — the other{' '}
            {(count - 1).toLocaleString()} match{count - 1 === 1 ? '' : 'es'} are hidden.{' '}
            <strong>Drag</strong> a point, <strong>click the line</strong> to insert,{' '}
            <strong>alt-click</strong> to delete, or snap it to roads below. Then apply the
            shape to the whole batch — each track keeps its own timing.
          </p>
          {session && (
            <RerouteTool
              session={session}
              reroute={reroute}
              hasRouteCoverage={hasRouteCoverage}
              routeFetching={routeFetching}
              routeError={routeError}
              busy={busy}
              onRerouteRange={onRerouteRange}
              onClearVias={onClearVias}
              onApply={onApplyReroute}
              onFetchRoads={onFetchRoads}
            />
          )}
          <div className="edit-actions">
            <button type="button" disabled={busy || count === 0} onClick={onApplyArchetype}>
              {busy ? 'Working…' : `Apply shape to all ${count.toLocaleString()}`}
            </button>
            <button type="button" disabled={busy} onClick={onReselect}>
              &larr; Reselect
            </button>
          </div>
          {applyResult && (
            <>
              <p className="hint status-line">
                Applied to <strong>{applyResult.applied}</strong> as drafts
                {applyResult.skipped > 0 ? `, skipped ${applyResult.skipped}` : ''}
                {applyResult.failed > 0 ? `, ${applyResult.failed} failed` : ''}.
              </p>
              <div className="edit-actions">
                <button type="button" disabled={busy} onClick={onCommitAll}>
                  Save all permanently
                </button>
                <button type="button" disabled={busy} onClick={onClear}>
                  Done
                </button>
              </div>
            </>
          )}
        </>
      )}

      {error && <p className="hint status-line error">{error}</p>}
    </section>
  )
}
