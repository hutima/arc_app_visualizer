/**
 * Activity categories observed in Arc Timeline exports, with dark-basemap
 * friendly colors grouped by mode family so similar transit reads as similar:
 *
 * - human-powered  → greens/teals (walking, running, cycling, skiing)
 * - private motor  → taxi-yellow/orange family (car, taxi, motorcycle,
 *                    scooter) — warm hues, deliberately far from transit
 * - mass transit   → violet→pink family (bus, metro, tram, train)
 * - water          → blue (boat)
 * - air            → red (airplane) — its own color, nothing else is red
 *
 * Unknown categories get a deterministic fallback color so future Arc types
 * render sensibly without a schema change.
 */

export const KNOWN_CATEGORY_COLORS: Record<string, string> = {
  // human-powered
  walking: '#4fc97e',
  running: '#a3e635',
  cycling: '#2dd4bf',
  skiing: '#93c5fd',
  // private motor vehicles: car sits beside taxi-yellow, distinct from transit
  car: '#f59e0b',
  taxi: '#facc15',
  motorcycle: '#fb923c',
  scooter: '#fdba74',
  // shared / mass transit
  bus: '#a78bfa',
  metro: '#c084fc',
  tram: '#e879f9',
  train: '#f472b6',
  // water and air
  boat: '#38bdf8',
  airplane: '#ef4444',
  // non-movement
  stationary: '#9ca3af',
  unknown: '#7d8590',
  bogus: '#6b7280'
}

/** Arc's own junk label; imported for transparency but hidden from queries. */
export const IGNORED_BY_DEFAULT = new Set(['bogus'])

/** Neutral so place dots never read as a (yellow) car/taxi track. */
export const WAYPOINT_COLOR = '#f8fafc'

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
