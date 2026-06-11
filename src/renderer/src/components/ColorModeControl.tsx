import type { DatasetSummary, TrackColorMode } from '../../../shared/types'
import { colorForYear, yearRange } from '../../../shared/yearColors'

interface Props {
  mode: TrackColorMode
  summary: DatasetSummary | null
  onChange: (mode: TrackColorMode) => void
}

/**
 * Switches track coloring between activity type and calendar year. Type
 * visibility checkboxes keep filtering in either mode — year only changes
 * the paint, not what is queried.
 */
export function ColorModeControl({ mode, summary, onChange }: Props): React.JSX.Element {
  const years = mode === 'year' ? yearRange(summary?.startTsMs ?? null, summary?.endTsMs ?? null) : []
  return (
    <section className="panel">
      <h2>Color tracks by</h2>
      <div className="color-mode-row" role="radiogroup" aria-label="track color mode">
        {(['type', 'year'] as const).map((m) => (
          <label key={m} className="color-mode-option">
            <input
              type="radio"
              name="color-mode"
              checked={mode === m}
              onChange={() => onChange(m)}
            />
            <span>{m}</span>
          </label>
        ))}
      </div>
      {mode === 'year' && years.length > 0 && (
        <ul className="year-legend">
          {years.map((y) => (
            <li key={y}>
              <span className="swatch" style={{ backgroundColor: colorForYear(y) }} />
              <span className="category-name">{y}</span>
            </li>
          ))}
        </ul>
      )}
      {mode === 'year' && (
        <p className="hint">Type checkboxes above still filter which tracks show.</p>
      )}
    </section>
  )
}
