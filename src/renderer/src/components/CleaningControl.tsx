interface Props {
  averageRail: boolean
  onChange: (on: boolean) => void
}

/**
 * Display-time cleaning toggles. Nothing here ever touches raw points —
 * each option re-queries and transforms what the map shows.
 */
export function CleaningControl({ averageRail, onChange }: Props): React.JSX.Element {
  return (
    <section className="panel">
      <h2>Cleaning</h2>
      <label className="color-mode-option">
        <input
          type="checkbox"
          checked={averageRail}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>Average repeat metro/tram rides</span>
      </label>
      <p className="hint">
        Rides of the same type between the same two places merge into one
        averaged track (either direction). Rides without a nearby place at
        both ends are left as-is. Display only — raw data is untouched.
      </p>
    </section>
  )
}
