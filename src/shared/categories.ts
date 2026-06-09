/**
 * Activity categories observed in Arc Timeline exports, with dark-basemap
 * friendly colors. Unknown categories get a deterministic fallback color so
 * future Arc types render sensibly without a schema change.
 */

export const KNOWN_CATEGORY_COLORS: Record<string, string> = {
  walking: '#4fc97e',
  running: '#a3e635',
  cycling: '#f59e0b',
  car: '#60a5fa',
  taxi: '#facc15',
  bus: '#f97316',
  tram: '#e879f9',
  metro: '#c084fc',
  train: '#f472b6',
  airplane: '#38bdf8',
  boat: '#2dd4bf',
  motorcycle: '#fb7185',
  scooter: '#d9f99d',
  skiing: '#93c5fd',
  stationary: '#9ca3af',
  unknown: '#7d8590',
  bogus: '#6b7280'
}

/** Arc's own junk label; imported for transparency but hidden from queries. */
export const IGNORED_BY_DEFAULT = new Set(['bogus'])

export const WAYPOINT_COLOR = '#eab308'

/** Deterministic, reasonably bright color for categories we have not seen. */
export function colorForCategory(name: string): string {
  const known = KNOWN_CATEGORY_COLORS[name]
  if (known) return known
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  const hue = ((hash % 360) + 360) % 360
  return `hsl(${hue}, 65%, 60%)`
}
