import { useEffect, useState } from 'react'
import type { EditSaveMode } from '../../../shared/types'
import { colorForCategory } from '../../../shared/categories'
import type { EditSessionInfo, RerouteInfo } from '../map/MapController'

interface Props {
  session: EditSessionInfo | null
  busy: boolean
  error: string | null
  /** Every existing activity type (for changing type and per-half split). */
  categoryNames: string[]
  /** Type → display color, for the split slider's two-tone track. */
  categoryColors: Record<string, string>
  /** Reroute tool status (vias/preview), or null when it's closed. */
  reroute: RerouteInfo | null
  /** Whether any drivable road network has been fetched (gates rerouting). */
  hasRouteCoverage: boolean
  /** Road-network fetch in flight / its last error (the in-panel fetch button). */
  routeFetching: boolean
  routeError: string | null
  onSave: (mode: EditSaveMode) => void
  onRevert: () => void
  onClose: () => void
  /** Preview the split point at an editPts index (null clears the marker). */
  onSplitPreview: (index: number | null, firstType?: string, secondType?: string) => void
  onSplit: (index: number, firstType: string, secondType: string) => void
  onChangeType: (type: string) => void
  onDeleteTrack: () => void
  /** Open/refresh (or close, with null) the reroute span over the points. */
  onRerouteRange: (range: { startIdx: number; endIdx: number } | null) => void
  onClearVias: () => void
  onApplyReroute: () => void
  /** Fetch the drivable road network for the current view (reroute needs it). */
  onFetchRoads: () => void
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
  categoryColors,
  reroute,
  hasRouteCoverage,
  routeFetching,
  routeError,
  onSave,
  onRevert,
  onClose,
  onSplitPreview,
  onSplit,
  onChangeType,
  onDeleteTrack,
  onRerouteRange,
  onClearVias,
  onApplyReroute,
  onFetchRoads
}: Props): React.JSX.Element {
  const canSave = session !== null && session.dirty
  const canCommit = session !== null && (session.dirty || session.hasDraft)
  const typeOptions = session ? [...new Set([session.type, ...categoryNames])] : []
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
            a point to split the track into two there. Clicking off saves.
          </p>
          <label className="merge-type-pick">
            <span>Type</span>
            <select
              className="detail-select"
              value={session.type}
              disabled={busy}
              onChange={(e) => onChangeType(e.target.value)}
            >
              {typeOptions.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
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
          <div className="edit-actions">
            <button type="button" className="danger" disabled={busy} onClick={onDeleteTrack}>
              Delete track
            </button>
          </div>
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
          <SplitTool
            session={session}
            busy={busy}
            categoryNames={categoryNames}
            categoryColors={categoryColors}
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
  categoryColors: Record<string, string>
  onSplitPreview: (index: number | null, firstType?: string, secondType?: string) => void
  onSplit: (index: number, firstType: string, secondType: string) => void
}

/**
 * The precise split tool: a slider scrubs the split point along the track and
 * each resulting half gets its own activity type. The slider's track and the
 * on-map line are painted in the two halves' type colors so the split reads at
 * a glance. Splitting commits the current edits, like the shift-click split.
 * Only available with at least 3 points (each half keeps ≥2).
 */
function SplitTool({
  session,
  busy,
  categoryNames,
  categoryColors,
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

  // Drive the on-map preview marker + per-half coloring while the tool is open.
  useEffect(() => {
    onSplitPreview(open ? Math.min(index, maxIdx) : null, firstType, secondType)
    return () => onSplitPreview(null)
  }, [open, index, maxIdx, firstType, secondType, onSplitPreview])

  if (pointCount < 3) return null
  const clamped = Math.min(Math.max(1, index), maxIdx)
  // Any existing type for each half; the current type is always offered.
  const options = [...new Set([type, ...categoryNames])]
  const colorOf = (t: string): string => categoryColors[t] ?? colorForCategory(t)
  // Two-tone slider track: first-half color up to the thumb, second after.
  const frac = maxIdx > 1 ? (clamped - 1) / (maxIdx - 1) : 0
  const pct = `${(frac * 100).toFixed(1)}%`
  const splitGradient = `linear-gradient(to right, ${colorOf(firstType)} 0 ${pct}, ${colorOf(secondType)} ${pct} 100%)`

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
            style={{ ['--split-gradient' as string]: splitGradient }}
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

interface RerouteProps {
  session: EditSessionInfo
  reroute: RerouteInfo | null
  hasRouteCoverage: boolean
  routeFetching: boolean
  routeError: string | null
  busy: boolean
  onRerouteRange: (range: { startIdx: number; endIdx: number } | null) => void
  onClearVias: () => void
  onApply: () => void
  onFetchRoads: () => void
}

/**
 * The "snap to road route" tool: choose the span to replace (whole track, or a
 * start/end range), drop must-pass via pins on the map (drag them to re-route
 * live), and apply the previewed road route as a revertible draft. Routing is
 * local (over fetched OSM roads) and prefers arterials — so it only works where
 * roads have been fetched, and every route is reviewed before it's applied.
 */
function RerouteTool({
  session,
  reroute,
  hasRouteCoverage,
  routeFetching,
  routeError,
  busy,
  onRerouteRange,
  onClearVias,
  onApply,
  onFetchRoads
}: RerouteProps): React.JSX.Element | null {
  const { segmentId, pointCount } = session
  const last = pointCount - 1
  const [open, setOpen] = useState(false)
  const [whole, setWhole] = useState(true)
  const [startIdx, setStartIdx] = useState(0)
  const [endIdx, setEndIdx] = useState(last)

  // Reset whenever a different segment loads (indices are point positions).
  useEffect(() => {
    setOpen(false)
    setWhole(true)
    setStartIdx(0)
    setEndIdx(pointCount - 1)
  }, [segmentId, pointCount])

  // Push the active span to the map (it draws markers + previews). Held closed
  // until roads are fetched, so we don't preview into an error.
  useEffect(() => {
    if (!open || !hasRouteCoverage) {
      onRerouteRange(null)
      return
    }
    const s = whole ? 0 : Math.min(startIdx, last - 1)
    const e = whole ? last : Math.max(endIdx, s + 1)
    onRerouteRange({ startIdx: s, endIdx: e })
  }, [open, whole, startIdx, endIdx, last, hasRouteCoverage, onRerouteRange])

  if (pointCount < 2) return null
  const s = Math.min(startIdx, last - 1)
  const e = Math.max(endIdx, s + 1)

  return (
    <div className="split-tool reroute-tool">
      <label className="color-mode-option">
        <input type="checkbox" checked={open} disabled={busy} onChange={(ev) => setOpen(ev.target.checked)} />
        <span>Snap part to road route</span>
      </label>
      {open && !hasRouteCoverage && (
        <>
          <p className="hint">
            No roads fetched here yet — routing needs the drivable network for
            this area. It only fetches what&apos;s on screen.
          </p>
          <button type="button" disabled={busy || routeFetching} onClick={onFetchRoads}>
            {routeFetching ? 'Fetching…' : 'Fetch roads in view'}
          </button>
          {routeError && <p className="hint status-line error">{routeError}</p>}
        </>
      )}
      {open && hasRouteCoverage && (
        <>
          <label className="color-mode-option">
            <input type="checkbox" checked={whole} disabled={busy} onChange={(ev) => setWhole(ev.target.checked)} />
            <span>Whole track</span>
          </label>
          {!whole && (
            <div className="reroute-range">
              <label className="reroute-range-row">
                <span>From</span>
                <input
                  type="range"
                  min={0}
                  max={last - 1}
                  step={1}
                  value={s}
                  disabled={busy}
                  onChange={(ev) => setStartIdx(Number(ev.target.value))}
                />
              </label>
              <label className="reroute-range-row">
                <span>To</span>
                <input
                  type="range"
                  min={1}
                  max={last}
                  step={1}
                  value={e}
                  disabled={busy}
                  onChange={(ev) => setEndIdx(Number(ev.target.value))}
                />
              </label>
              <p className="hint">
                Replacing points {s + 1}–{e + 1} of {pointCount} (the two ends are kept).
              </p>
            </div>
          )}
          <p className="hint">
            Click the track or route to drop a <strong>via pin</strong> the route
            must pass through; drag pins to re-route live, alt-click to remove.
            {reroute?.viaCount ? ` ${reroute.viaCount} via point${reroute.viaCount === 1 ? '' : 's'}.` : ''}
          </p>
          <div className="edit-actions">
            <button
              type="button"
              disabled={busy || !reroute?.hasPreview || !!reroute?.previewing}
              onClick={onApply}
            >
              {reroute?.previewing ? 'Routing…' : 'Apply route (draft)'}
            </button>
            <button type="button" disabled={busy || !reroute?.viaCount} onClick={onClearVias}>
              Clear vias
            </button>
          </div>
          {reroute?.error && <p className="hint status-line error">{reroute.error}</p>}
          {routeError && <p className="hint status-line error">{routeError}</p>}
          <button
            type="button"
            className="link-button"
            disabled={busy || routeFetching}
            onClick={onFetchRoads}
          >
            {routeFetching ? 'Fetching roads…' : 'Fetch more roads in view'}
          </button>
        </>
      )}
    </div>
  )
}
