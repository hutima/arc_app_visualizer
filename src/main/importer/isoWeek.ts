export interface IsoWeek {
  year: number
  week: number
}

/** Matches Arc's weekly export naming, e.g. "2024-W07.gpx" or "2024-W07 2.gpx". */
export function isoWeekFromFilename(filename: string): IsoWeek | null {
  const m = /(\d{4})-W(\d{2})/.exec(filename)
  if (!m) return null
  const year = Number(m[1])
  const week = Number(m[2])
  if (week < 1 || week > 53) return null
  return { year, week }
}

/** ISO-8601 week from a UTC timestamp (Thursday-anchored algorithm). */
export function isoWeekFromTimestamp(tsMs: number): IsoWeek {
  const d = new Date(tsMs)
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  // Shift to the Thursday of this ISO week (ISO day: Mon=1..Sun=7).
  const isoDay = target.getUTCDay() === 0 ? 7 : target.getUTCDay()
  target.setUTCDate(target.getUTCDate() + 4 - isoDay)
  const isoYear = target.getUTCFullYear()
  const yearStart = Date.UTC(isoYear, 0, 1)
  const week = Math.ceil(((target.getTime() - yearStart) / 86400000 + 1) / 7)
  return { year: isoYear, week }
}
