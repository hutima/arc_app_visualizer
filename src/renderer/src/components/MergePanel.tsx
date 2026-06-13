import type { MergeCandidate } from '../../../shared/types'

interface Props {
  candidates: MergeCandidate[]
  selected: number[]
  mergeType: string
  busy: boolean
  error: string | null
  onPickDate: (dateStr: string) => void
  onToggleSelect: (segmentId: number) => void
  onTypeChange: (type: string) => void
  onMerge: () => void
  onClear: () => void
}

const fmtTime = (ms: number | null): string =>
  ms === null
    ? '—'
    : new Date(ms).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })

/**
 * Merge tracks: anchor a 24h window (click a track on the map, or pick a date),
 * then tick the sequential pieces to stitch into one track. The actual merge
 * runs in the main process; this panel only manages the selection and the
 * resulting type. Merging is permanent — the separate tracks are replaced.
 */
export function MergePanel({
  candidates,
  selected,
  mergeType,
  busy,
  error,
  onPickDate,
  onToggleSelect,
  onTypeChange,
  onMerge,
  onClear
}: Props): React.JSX.Element {
  const selectedCands = candidates.filter((c) => selected.includes(c.segmentId))
  const selectedTypes = [...new Set(selectedCands.map((c) => c.type))]
  const canMerge = selected.length >= 2 && mergeType.length > 0

  return (
    <section className="panel">
      <h2>Merge tracks</h2>
      <p className="hint">
        Click a track on the map (or pick a date) to load the day&apos;s tracks,
        then tick the sequential pieces and merge them into one.
      </p>
      <div className="date-row">
        <input
          type="date"
          aria-label="anchor date"
          disabled={busy}
          onChange={(e) => e.target.value && onPickDate(e.target.value)}
        />
        {candidates.length > 0 && (
          <button type="button" className="link-button" disabled={busy} onClick={onClear}>
            Clear
          </button>
        )}
      </div>

      {candidates.length === 0 ? (
        <p className="hint">No anchor yet — click a track or pick a date.</p>
      ) : (
        <ul className="merge-list">
          {candidates.map((c) => {
            const checked = selected.includes(c.segmentId)
            return (
              <li key={c.segmentId} className={checked ? 'selected' : ''}>
                <label>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={busy}
                    onChange={() => onToggleSelect(c.segmentId)}
                  />
                  <span className="merge-time">{fmtTime(c.startTsMs)}</span>
                  <span className="merge-type">{c.type}</span>
                  <span className="category-count">{c.pointCount.toLocaleString()}</span>
                </label>
              </li>
            )
          })}
        </ul>
      )}

      {selected.length > 0 && (
        <div className="merge-actions">
          <label className="merge-type-pick">
            <span>Merge as</span>
            <select
              className="detail-select"
              value={mergeType}
              disabled={busy}
              onChange={(e) => onTypeChange(e.target.value)}
            >
              {selectedTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={busy || !canMerge} onClick={onMerge}>
            {`Merge ${selected.length} track${selected.length === 1 ? '' : 's'}`}
          </button>
        </div>
      )}
      {selected.length === 1 && (
        <p className="hint">Select at least one more track to merge.</p>
      )}
      {error && <p className="hint status-line error">{error}</p>}
    </section>
  )
}
