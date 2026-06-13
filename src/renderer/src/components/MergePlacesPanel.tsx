/** A place selected for merging (the panel only renders these few fields). */
export interface SelectedPlace {
  dotId: number
  name: string | null
  visitCount: number
}

interface Props {
  selected: SelectedPlace[]
  /** The name the merged place will keep. */
  mergeName: string
  busy: boolean
  error: string | null
  onNameChange: (name: string) => void
  onMerge: () => void
  onClear: () => void
  onRemove: (dotId: number) => void
}

const label = (name: string | null): string => (name && name.length > 0 ? name : '(unnamed)')

/**
 * Merge places: click stationary-place pins on the map to select them, pick
 * which name to keep, and combine them into one pin — useful when the same
 * place was logged under two names, or its visits scattered into separate dots.
 * With exactly one place selected, clicking a track instead folds that track
 * into the place as a stationary visit (and removes the track). Both run in the
 * main process; this panel only manages the selection and chosen name.
 */
export function MergePlacesPanel({
  selected,
  mergeName,
  busy,
  error,
  onNameChange,
  onMerge,
  onClear,
  onRemove
}: Props): React.JSX.Element {
  // Offer each distinct selected (named) place as the name to keep.
  const nameOptions = [...new Set(selected.map((p) => p.name).filter((n): n is string => !!n))]
  const canMerge = selected.length >= 2 && mergeName.trim().length > 0

  return (
    <section className="panel">
      <h2>Merge places</h2>
      <p className="hint">
        Click place pins on the map to select them, then merge them into one and
        keep a single name. With one place selected, click a track to add it as a
        stationary visit instead.
      </p>

      {selected.length === 0 ? (
        <p className="hint">No places selected — click a pin on the map.</p>
      ) : (
        <ul className="place-list">
          {selected.map((p) => (
            <li key={p.dotId}>
              <span className="merge-type">{label(p.name)}</span>
              <span className="category-count">{p.visitCount.toLocaleString()} visits</span>
              <button
                type="button"
                className="link-button"
                disabled={busy}
                aria-label={`remove ${label(p.name)}`}
                onClick={() => onRemove(p.dotId)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected.length === 1 && (
        <p className="hint">Click a track on the map to add it to this place, or select another place to merge.</p>
      )}

      {selected.length >= 2 && (
        <div className="merge-actions">
          <label className="merge-type-pick">
            <span>Keep name</span>
            <input
              type="text"
              className="detail-select"
              list="merge-place-names"
              value={mergeName}
              disabled={busy}
              onChange={(e) => onNameChange(e.target.value)}
            />
            <datalist id="merge-place-names">
              {nameOptions.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </label>
          <button type="button" disabled={busy || !canMerge} onClick={onMerge}>
            {`Merge ${selected.length} places`}
          </button>
        </div>
      )}

      {selected.length > 0 && (
        <button type="button" className="link-button" disabled={busy} onClick={onClear}>
          Clear selection
        </button>
      )}
      {error && <p className="hint status-line error">{error}</p>}
    </section>
  )
}
