import type { EditSaveMode } from '../../../shared/types'
import type { EditSessionInfo } from '../map/MapController'

interface Props {
  session: EditSessionInfo | null
  busy: boolean
  error: string | null
  onSave: (mode: EditSaveMode) => void
  onRevert: () => void
  onClose: () => void
}

/**
 * Per-point track editing (the 'points' edit tool). Geometry manipulation
 * happens in MapController; this panel only renders the small session summary
 * and the save/revert actions. Draft saves keep the original points
 * (revertible forever); permanent saves rewrite them.
 */
export function TrackEditPanel({
  session,
  busy,
  error,
  onSave,
  onRevert,
  onClose
}: Props): React.JSX.Element {
  const canSave = session !== null && session.dirty
  const canCommit = session !== null && (session.dirty || session.hasDraft)
  return (
    <section className="panel">
      <h2>Edit points</h2>
      {!session && (
        <p className="hint">
          Click a track on the map to select it for editing.
        </p>
      )}
      {session && (
        <>
          <p className="hint">
            Editing segment <strong>#{session.segmentId}</strong> ({session.type}),{' '}
            {session.pointCount.toLocaleString()} points
            {session.dirty
              ? ' — unsaved changes'
              : session.hasDraft
                ? ' — saved draft'
                : ''}
          </p>
          <p className="hint">
            <strong>Drag</strong> a point to move it. <strong>Click the line</strong>{' '}
            between two points to add one (placed in time between them).{' '}
            <strong>Alt-click</strong> a point to delete it. <strong>Shift-click</strong>{' '}
            a point to split the track into two there.
          </p>
          <div className="edit-actions">
            <button type="button" disabled={busy || !canSave} onClick={() => onSave('draft')}>
              Save draft
            </button>
            <button type="button" disabled={busy || !canCommit} onClick={() => onSave('permanent')}>
              Save permanently
            </button>
          </div>
          <div className="edit-actions">
            <button type="button" disabled={busy || !canCommit} onClick={onRevert}>
              Revert to original
            </button>
            <button type="button" disabled={busy} onClick={onClose}>
              Close
            </button>
          </div>
          <p className="hint">
            Draft keeps the edits beside the untouched original (revertible any
            time); permanent rewrites the track&apos;s points for good. Either way
            the edited line is what gets drawn and fed into rail/road snapping —
            re-run matching from the Cleaning panel to re-snap an edited ride.
          </p>
        </>
      )}
      {error && <p className="hint status-line error">{error}</p>}
    </section>
  )
}
