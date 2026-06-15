/**
 * Sequential color for the "color tracks by year" mode: an HSL ramp that
 * auto-scales to the dataset's [minYear, maxYear]. The newest year is a
 * saturated blue; going older rotates the hue through cyan/green to a
 * desaturated yellow and drops saturation — so recency reads as a vivid blue
 * and each year in the span gets a distinct hue (no two adjacent years
 * collide, however many years there are). Legend and map share this function,
 * so they never drift.
 */

/** Tracks whose segments carry no timestamp ("undated"). */
export const UNDATED_YEAR_COLOR = '#7d8590'

// Ramp endpoints in HSL. Recent = saturated blue; oldest = soft, desaturated
// yellow. Hue spans 48°→215° so an N-year dataset gets N evenly-spaced,
// distinguishable hues; saturation rises toward recent so it also reads as
// "most saturated = newest". Lightness stays in a legible band on dark maps.
const OLDEST = { h: 48, s: 48, l: 62 }
const RECENT = { h: 215, s: 85, l: 55 }

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * Gradient color for a year, placed across [minYear, maxYear] (newest = blue).
 * Without a known extent (or a single-year dataset) it returns the recent end.
 */
export function colorForYear(year: number, minYear?: number, maxYear?: number): string {
  if (!Number.isFinite(year) || year <= 0) return UNDATED_YEAR_COLOR
  let t = 1 // lone year / unknown extent → newest (saturated blue) end
  if (minYear != null && maxYear != null && maxYear > minYear) {
    t = (year - minYear) / (maxYear - minYear)
  }
  t = Math.min(1, Math.max(0, t))
  const h = Math.round(lerp(OLDEST.h, RECENT.h, t))
  const s = Math.round(lerp(OLDEST.s, RECENT.s, t))
  const l = Math.round(lerp(OLDEST.l, RECENT.l, t))
  return `hsl(${h}, ${s}%, ${l}%)`
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
