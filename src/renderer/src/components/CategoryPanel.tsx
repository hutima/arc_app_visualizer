import { useState } from 'react'
import type { CategoryInfo } from '../../../shared/types'

interface Props {
  categories: CategoryInfo[]
  showWaypoints: boolean
  onToggle: (name: string, visible: boolean) => void
  onToggleWaypoints: (show: boolean) => void
  /** Hex color picked by the user; null reverts to the default. */
  onColorChange: (name: string, color: string | null) => void
  /** New active-type order (first = top of list = drawn on top). */
  onReorder: (orderedNames: string[]) => void
  /** Show or hide every active type at once. */
  onToggleAll: (visible: boolean) => void
}

/** `<input type="color">` only accepts #rrggbb; generated colors are hsl(). */
function toHexColor(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color
  const m = /^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i.exec(color)
  if (!m) return '#888888'
  const h = Number(m[1]) / 360
  const s = Number(m[2]) / 100
  const l = Number(m[3]) / 100
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t: number): string => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    let v = p
    if (t < 1 / 6) v = p + (q - p) * 6 * t
    else if (t < 1 / 2) v = q
    else if (t < 2 / 3) v = p + (q - p) * (2 / 3 - t) * 6
    return Math.round(v * 255).toString(16).padStart(2, '0')
  }
  return `#${channel(h + 1 / 3)}${channel(h)}${channel(h - 1 / 3)}`
}

export function CategoryPanel({
  categories,
  showWaypoints,
  onToggle,
  onToggleWaypoints,
  onColorChange,
  onReorder,
  onToggleAll
}: Props): React.JSX.Element {
  // Only show categories that exist in the data; ignored ones (e.g. `bogus`)
  // are listed separately so it's transparent what is being excluded.
  const active = categories.filter((c) => !c.ignored && c.segmentCount > 0)
  const ignored = categories.filter((c) => c.ignored && c.segmentCount > 0)

  const [dragIndex, setDragIndex] = useState<number | null>(null)

  const drop = (target: number): void => {
    if (dragIndex !== null && dragIndex !== target) {
      const next = [...active]
      const [moved] = next.splice(dragIndex, 1)
      next.splice(target, 0, moved!)
      onReorder(next.map((c) => c.name))
    }
    setDragIndex(null)
  }

  const allVisible = active.length > 0 && active.every((c) => c.visible)
  const noneVisible = active.every((c) => !c.visible)

  return (
    <section className="panel">
      <h2>Types</h2>
      {active.length === 0 && <p className="hint">Import data to see activity types.</p>}
      {active.length > 1 && (
        <>
          <label className="select-all">
            <input
              type="checkbox"
              checked={allVisible}
              ref={(el) => {
                if (el) el.indeterminate = !allVisible && !noneVisible
              }}
              onChange={(e) => onToggleAll(e.target.checked)}
            />
            <span className="category-name">Select all</span>
          </label>
          <p className="hint order-hint">Drag ⠿ to reorder; the top type draws on top.</p>
        </>
      )}
      <ul className="category-list">
        {active.map((c, i) => (
          <li
            key={c.name}
            className={dragIndex === i ? 'cat-row dragging' : 'cat-row'}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => drop(i)}
          >
            <span
              className="drag-handle"
              draggable
              onDragStart={() => setDragIndex(i)}
              onDragEnd={() => setDragIndex(null)}
              title="drag to reorder"
              aria-label={`reorder ${c.name}`}
            >
              ⠿
            </span>
            <label>
              <input
                type="checkbox"
                checked={c.visible}
                onChange={(e) => onToggle(c.name, e.target.checked)}
              />
              <input
                type="color"
                className="swatch-input"
                value={toHexColor(c.color)}
                onChange={(e) => onColorChange(c.name, e.target.value)}
                title={`change ${c.name} color`}
              />
              <span className="category-name">{c.name}</span>
              {c.custom && (
                <button
                  type="button"
                  className="color-reset"
                  title="reset to default color"
                  onClick={(e) => {
                    e.preventDefault() // keep the label's checkbox untouched
                    onColorChange(c.name, null)
                  }}
                >
                  ↺
                </button>
              )}
              <span className="category-count">{c.segmentCount.toLocaleString()}</span>
            </label>
          </li>
        ))}
        <li className="cat-row">
          <span className="drag-handle drag-handle-placeholder" />
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
