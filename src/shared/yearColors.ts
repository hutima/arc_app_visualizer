/**
 * Stable color per calendar year for the "color tracks by year" mode.
 *
 * Golden-angle hue stepping: consecutive years land far apart on the wheel,
 * the mapping never depends on what range of data is loaded, and the same
 * year renders the same color forever (legend and map share this function).
 */

/** Tracks whose segments carry no timestamp ("undated"). */
export const UNDATED_YEAR_COLOR = '#7d8590'

export function colorForYear(year: number): string {
  if (!Number.isFinite(year) || year <= 0) return UNDATED_YEAR_COLOR
  const hue = (year * 137.508) % 360
  return `hsl(${hue.toFixed(1)}, 70%, 60%)`
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
