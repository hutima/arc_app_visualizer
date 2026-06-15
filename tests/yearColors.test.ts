import { describe, it, expect } from 'vitest'
import { colorForYear, yearRange, UNDATED_YEAR_COLOR } from '../src/shared/yearColors'

/** Parse an `hsl(h, s%, l%)` string. */
const parseHsl = (c: string): { h: number; s: number; l: number } => {
  const m = /^hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)$/.exec(c)
  if (!m) throw new Error(`expected hsl(), got ${c}`)
  return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) }
}

describe('yearColors', () => {
  it('paints the newest year a saturated blue and the oldest a desaturated yellow', () => {
    const recent = parseHsl(colorForYear(2025, 2015, 2025))
    const oldest = parseHsl(colorForYear(2015, 2015, 2025))
    expect(recent.h).toBeGreaterThan(180) // blue end
    expect(oldest.h).toBeLessThan(90) // yellow end
    expect(recent.s).toBeGreaterThan(oldest.s) // most saturated = newest
  })

  it('rotates the hue monotonically across the span (a distinct color per year)', () => {
    let prev = -1
    for (let y = 2015; y <= 2025; y++) {
      const { h } = parseHsl(colorForYear(y, 2015, 2025))
      expect(h).toBeGreaterThan(prev)
      prev = h
    }
  })

  it('is stable for a fixed extent (legend and map agree)', () => {
    expect(colorForYear(2020, 2015, 2025)).toBe(colorForYear(2020, 2015, 2025))
  })

  it('returns the recent (blue) end for a single-year dataset', () => {
    expect(colorForYear(2020, 2020, 2020)).toBe(colorForYear(2025, 2015, 2025))
    expect(colorForYear(2020, 2020, 2020)).toMatch(/^hsl\(/)
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
