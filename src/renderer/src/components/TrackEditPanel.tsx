import { useEffect, useState } from 'react'
import type { EditSaveMode } from '../../../shared/types'
import type { EditSessionInfo } from '../map/MapController'

interface Props {
  session: EditSessionInfo | null
  busy: boolean
  error: string | null
  /** Activity types offered for the per-half split. */
  categoryNames: string[]
  onSave: (mode: EditSaveMode) => void
  onRevert: () => void
  onClose: () => void
  /** Preview the split point at an editPts index (null clears the marker). */
  onSplitPreview: (index: number | null) => void
  onSplit: (index: number, firstType: string, secondType: string) => void
}

/**
 * Per-point track editing (the 'points' edit tool). Geometry manipulation
 * happens in MapController; this panel renders the session summary, save/revert
 * actions, and the precise split tool (a slider that scrubs the split point,
 * with a type per half). Draft saves keep the original points (revertible
 * forever); permanent saves rewrite them.
 */
export function TrackEditPanel({
  session,
  busy,
  error,
  categoryNames,
  onSave,
  onRevert,
  onClose,
  onSplitPreview,
  onSplit
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
          <SplitTool
            session={session}
            busy={busy}
            categoryNames={categoryNames}
            onSplitPreview={onSplitPreview}
            onSplit={onSplit}
          />
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

interface SplitProps {
  session: EditSessionInfo
  busy: boolean
  categoryNames: string[]
  onSplitPreview: (index: number | null) => void
  onSplit: (index: number, firstType: string, secondType: string) => void
}

/**
 * The precise split tool: a slider scrubs the split point along the track
 * (a magenta ring previews it on the map), and each resulting half gets its
 * own activity type. Splitting commits the current edits, like the shift-click
 * split. Only available with at least 3 points (each half keeps ≥2).
 */
function SplitTool({
  session,
  busy,
  categoryNames,
  onSplitPreview,
  onSplit
}: SplitProps): React.JSX.Element | null {
  const { segmentId, pointCount, type } = session
  const maxIdx = pointCount - 2 // both halves keep ≥2 points (split point shared)
  const mid = Math.max(1, Math.floor(pointCount / 2))
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(mid)
  const [firstType, setFirstType] = useState(type)
  const [secondType, setSecondType] = useState(type)

  // Reset whenever a different segment is loaded (or its size changes).
  useEffect(() => {
    setOpen(false)
    setIndex(Math.max(1, Math.floor(pointCount / 2)))
    setFirstType(type)
    setSecondType(type)
  }, [segmentId, pointCount, type])

  // Drive the on-map preview marker while the tool is open.
  useEffect(() => {
    onSplitPreview(open ? Math.min(index, maxIdx) : null)
    return () => onSplitPreview(null)
  }, [open, index, maxIdx, onSplitPreview])

  if (pointCount < 3) return null
  const clamped = Math.min(Math.max(1, index), maxIdx)
  const options = categoryNames.length > 0 ? categoryNames : [type]

  return (
    <div className="split-tool">
      <label className="color-mode-option">
        <input type="checkbox" checked={open} disabled={busy} onChange={(e) => setOpen(e.target.checked)} />
        <span>Split this track</span>
      </label>
      {open && (
        <>
          <input
            type="range"
            className="split-slider"
            min={1}
            max={maxIdx}
            step={1}
            value={clamped}
            disabled={busy}
            onChange={(e) => setIndex(Number(e.target.value))}
          />
          <p className="hint">
            Split at point <strong>{clamped + 1}</strong> of {pointCount} —{' '}
            {clamped + 1} pts &amp; {pointCount - clamped} pts (the point is shared).
          </p>
          <div className="split-types">
            <label className="merge-type-pick">
              <span>1st</span>
              <select
                className="detail-select"
                value={firstType}
                disabled={busy}
                onChange={(e) => setFirstType(e.target.value)}
              >
                {options.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="merge-type-pick">
              <span>2nd</span>
              <select
                className="detail-select"
                value={secondType}
                disabled={busy}
                onChange={(e) => setSecondType(e.target.value)}
              >
                {options.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => onSplit(clamped, firstType, secondType)}
          >
            Split here
          </button>
        </>
      )}
    </div>
  )
}
