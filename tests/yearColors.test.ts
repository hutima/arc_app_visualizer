import { describe, it, expect } from 'vitest'
import { colorForYear, yearRange, UNDATED_YEAR_COLOR } from '../src/shared/yearColors'

/** Rec. 601 luma of a #rrggbb string. */
const luma = (hex: string): number => {
  const n = parseInt(hex.slice(1), 16)
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)
}

describe('yearColors', () => {
  it('makes the newest year brighter than the oldest', () => {
    expect(luma(colorForYear(2025, 2015, 2025))).toBeGreaterThan(
      luma(colorForYear(2015, 2015, 2025))
    )
  })

  it('increases brightness monotonically across the range (a gradient)', () => {
    let prev = -1
    for (let y = 2015; y <= 2025; y++) {
      const l = luma(colorForYear(y, 2015, 2025))
      expect(l).toBeGreaterThan(prev)
      prev = l
    }
  })

  it('is stable for a fixed extent (legend and map agree)', () => {
    expect(colorForYear(2020, 2015, 2025)).toBe(colorForYear(2020, 2015, 2025))
  })

  it('returns the bright end for a single-year dataset', () => {
    expect(colorForYear(2020, 2020, 2020)).toMatch(/^#[0-9a-f]{6}$/)
    expect(colorForYear(2020, 2020, 2020)).toBe(colorForYear(2025, 2015, 2025))
  })

  it('maps undated (0) to the neutral color', () => {
    expect(colorForYear(0)).toBe(UNDATED_YEAR_COLOR)
    expect(colorForYear(0, 2015, 2025)).toBe(UNDATED_YEAR_COLOR)
  })

  it('computes inclusive UTC year ranges', () => {
    expect(
      yearRange(Date.parse('2019-12-31T23:00:00Z'), Date.parse('2022-01-01T01:00:00Z'))
    ).toEqual([2019, 2020, 2021, 2022])
    expect(yearRange(null, Date.parse('2022-01-01T00:00:00Z'))).toEqual([])
  })
})
