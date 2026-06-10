import type { DetailMode } from '../../../shared/displayDetail'

const OPTIONS: Array<{ value: DetailMode; label: string }> = [
  { value: 'auto', label: 'Auto (match zoom)' },
  { value: 'low', label: 'Low — overview' },
  { value: 'medium', label: 'Medium — city' },
  { value: 'high', label: 'High — street' },
  { value: 'all', label: 'All points (raw)' }
]

const HINTS: Record<DetailMode, string> = {
  auto: 'Simplification follows the zoom level.',
  low: 'Pinned to the coarsest level, regardless of zoom.',
  medium: 'Pinned to city-level detail, regardless of zoom.',
  high: 'Pinned to street-level detail, regardless of zoom.',
  all: 'Every clean raw point — heavier on large archives.'
}

interface Props {
  mode: DetailMode
  onChange: (mode: DetailMode) => void
}

/** Lets the user pin a geometry detail level or opt into every raw point. */
export function DetailControl({ mode, onChange }: Props): React.JSX.Element {
  return (
    <section className="panel">
      <h2>Track detail</h2>
      <select
        className="detail-select"
        value={mode}
        onChange={(e) => onChange(e.target.value as DetailMode)}
        aria-label="track detail"
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <p className="hint">
        {HINTS[mode]} Overly busy viewports thin lines evenly instead of dropping routes.
      </p>
    </section>
  )
}
