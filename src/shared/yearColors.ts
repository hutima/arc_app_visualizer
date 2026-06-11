/**
 * Sequential color for the "color tracks by year" mode: a perceptual-ish
 * gradient (plasma-derived) running from a dim cool tone for the oldest year
 * to bright yellow for the newest, so recency reads as brightness at a glance.
 *
 * Unlike a categorical/divergent palette, colors here depend on the dataset's
 * [minYear, maxYear] so the whole span maps across the ramp. Legend and map
 * share this function, so they never drift.
 */

/** Tracks whose segments carry no timestamp ("undated"). */
export const UNDATED_YEAR_COLOR = '#7d8590'

// Plasma control stops (sRGB). We sample the brighter 0.35..1.0 of the ramp
// so even the oldest year stays legible on a dark basemap.
const PLASMA: ReadonlyArray<readonly [number, number, number]> = [
  [13, 8, 135],
  [126, 3, 168],
  [204, 71, 120],
  [248, 149, 64],
  [240, 249, 33]
]
const RAMP_START = 0.35

function plasma(t: number): [number, number, number] {
  const u = Math.min(1, Math.max(0, t)) * (PLASMA.length - 1)
  const i = Math.min(PLASMA.length - 2, Math.floor(u))
  const f = u - i
  const a = PLASMA[i]!
  const b = PLASMA[i + 1]!
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f)
  ]
}

const toHex = (rgb: [number, number, number]): string =>
  '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('')

/**
 * Gradient color for a year. With a known [minYear, maxYear] the year is
 * placed along the ramp (newest brightest); without one (or a single-year
 * dataset) it returns the brightest end.
 */
export function colorForYear(year: number, minYear?: number, maxYear?: number): string {
  if (!Number.isFinite(year) || year <= 0) return UNDATED_YEAR_COLOR
  let t = 1 // lone year / unknown extent → newest-brightest end
  if (minYear != null && maxYear != null && maxYear > minYear) {
    t = (year - minYear) / (maxYear - minYear)
  }
  return toHex(plasma(RAMP_START + (1 - RAMP_START) * t))
}

/** Inclusive UTC year range of a dataset, oldest first; [] when undated. */
export function yearRange(startTsMs: number | null, endTsMs: number | null): number[] {
  if (startTsMs == null || endTsMs == null) return []
  const first = new Date(startTsMs).getUTCFullYear()
  const last = new Date(endTsMs).getUTCFullYear()
  if (last < first) return []
  const years: number[] = []
  for (let y = first; y <= last; y++) years.push(y)
  return years
}
