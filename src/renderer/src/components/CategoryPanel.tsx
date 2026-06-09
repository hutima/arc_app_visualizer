import type { CategoryInfo } from '../../../shared/types'

interface Props {
  categories: CategoryInfo[]
  showWaypoints: boolean
  onToggle: (name: string, visible: boolean) => void
  onToggleWaypoints: (show: boolean) => void
}

export function CategoryPanel({
  categories,
  showWaypoints,
  onToggle,
  onToggleWaypoints
}: Props): React.JSX.Element {
  // Only show categories that exist in the data; ignored ones (e.g. `bogus`)
  // are listed separately so it's transparent what is being excluded.
  const active = categories.filter((c) => !c.ignored && c.segmentCount > 0)
  const ignored = categories.filter((c) => c.ignored && c.segmentCount > 0)

  return (
    <section className="panel">
      <h2>Types</h2>
      {active.length === 0 && <p className="hint">Import data to see activity types.</p>}
      <ul className="category-list">
        {active.map((c) => (
          <li key={c.name}>
            <label>
              <input
                type="checkbox"
                checked={c.visible}
                onChange={(e) => onToggle(c.name, e.target.checked)}
              />
              <span className="swatch" style={{ backgroundColor: c.color }} />
              <span className="category-name">{c.name}</span>
              <span className="category-count">{c.segmentCount.toLocaleString()}</span>
            </label>
          </li>
        ))}
        <li>
          <label>
            <input
              type="checkbox"
              checked={showWaypoints}
              onChange={(e) => onToggleWaypoints(e.target.checked)}
            />
            <span className="swatch swatch-circle" />
            <span className="category-name">places (waypoints)</span>
          </label>
        </li>
      </ul>
      {ignored.length > 0 && (
        <p className="hint">
          Ignored categories (hidden from queries):{' '}
          {ignored.map((c) => `${c.name} (${c.segmentCount})`).join(', ')}
        </p>
      )}
    </section>
  )
}
