interface Props {
  /** Tracks that currently carry a draft (unsaved) edit. */
  count: number
  busy: boolean
  error: string | null
  onCommitAll: () => void
  onRevertAll: () => void
}

/**
 * Bulk control for the draft edits that accumulate across tracks (each "Save
 * draft" / click-off save leaves one). Confirm them all at once — bake every
 * draft into its track permanently — or remove them all, restoring originals.
 * Always visible in Edit mode since drafts span the whole dataset, not one tool.
 */
export function DraftsPanel({
  count,
  busy,
  error,
  onCommitAll,
  onRevertAll
}: Props): React.JSX.Element {
  const has = count > 0
  return (
    <section className="panel">
      <h2>Draft edits</h2>
      <p className="hint">
        {has
          ? `${count.toLocaleString()} track${count === 1 ? '' : 's'} ${
              count === 1 ? 'has' : 'have'
            } unsaved draft edits.`
          : 'No tracks have unsaved draft edits.'}
      </p>
      <div className="edit-actions">
        <button type="button" disabled={busy || !has} onClick={onCommitAll}>
          Save all permanently
        </button>
        <button type="button" className="danger" disabled={busy || !has} onClick={onRevertAll}>
          Discard all drafts
        </button>
      </div>
      <p className="hint">
        Drafts keep your edits beside the untouched originals. Saving bakes every
        draft into its track for good; discarding restores every original.
      </p>
      {error && <p className="hint status-line error">{error}</p>}
    </section>
  )
}
