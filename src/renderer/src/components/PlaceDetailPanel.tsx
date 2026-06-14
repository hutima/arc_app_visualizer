import type { PlaceMember } from '../../../shared/types'

interface Props {
  /** Visits of the single selected place, farthest-from-centre first, or null. */
  members: PlaceMember[] | null
  loading: boolean
  busy: boolean
  renameValue: string
  /** Visit ids ticked for separation. */
  selectedVisitIds: number[]
  onRenameChange: (name: string) => void
  onRename: () => void
  onToggleVisit: (id: number) => void
  onSelectOutliers: () => void
  onSeparate: () => void
}

const fmtDate = (tsMs: number | null): string =>
  tsMs == null
    ? 'undated'
    : new Date(tsMs).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

const fmtDist = (m: number): string => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`)

/**
 * Detailed editing for the one place currently selected in the merge-places
 * tool: rename it, and inspect its individual visits. Visits far from the
 * place's centre are flagged as outliers (and ringed on the map) — likely real
 * locations joined to the wrong site — and can be separated out into their own
 * unnamed sites so they stop dragging the averaged pin off.
 */
export function PlaceDetailPanel({
  members,
  loading,
  busy,
  renameValue,
  selectedVisitIds,
  onRenameChange,
  onRename,
  onToggleVisit,
  onSelectOutliers,
  onSeparate
}: Props): React.JSX.Element {
  const outlierCount = members?.filter((m) => m.outlier).length ?? 0
  return (
    <section className="panel">
      <h2>Edit place</h2>
      <label className="merge-type-pick">
        <span>Name</span>
        <input
          type="text"
          className="detail-select"
          value={renameValue}
          placeholder="(unnamed)"
          disabled={busy}
          onChange={(e) => onRenameChange(e.target.value)}
        />
      </label>
      <div className="edit-actions">
        <button type="button" disabled={busy || renameValue.trim().length === 0} onClick={onRename}>
          Rename place
        </button>
      </div>

      {loading ? (
        <p className="hint">Loading visits…</p>
      ) : !members || members.length === 0 ? (
        <p className="hint">No visits to show.</p>
      ) : (
        <>
          <p className="hint">
            {members.length.toLocaleString()} visit{members.length === 1 ? '' : 's'} in this place
            {outlierCount > 0 ? ` — ${outlierCount} far from the centre` : ''}.
          </p>
          <ul className="place-list">
            {members.map((m) => (
              <li key={m.id} className={m.outlier ? 'outlier' : ''}>
                <label>
                  <input
                    type="checkbox"
                    checked={selectedVisitIds.includes(m.id)}
                    disabled={busy}
                    onChange={() => onToggleVisit(m.id)}
                  />
                  <span className="member-meta">{fmtDate(m.tsMs)}</span>
                  <span className="category-count">{fmtDist(m.distM)}</span>
                  {m.outlier && <span className="outlier-tag">outlier</span>}
                </label>
              </li>
            ))}
          </ul>
          <div className="edit-actions">
            <button type="button" disabled={busy || outlierCount === 0} onClick={onSelectOutliers}>
              Select outliers
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy || selectedVisitIds.length === 0}
              onClick={onSeparate}
            >
              {selectedVisitIds.length > 0 ? `Separate ${selectedVisitIds.length}` : 'Separate selected'}
            </button>
          </div>
          <p className="hint">
            Outliers are visits far from the place&apos;s centre — likely real
            locations joined to the wrong site. Separating turns each into its own
            unnamed site; re-merge it elsewhere to re-home it.
          </p>
        </>
      )}
    </section>
  )
}
