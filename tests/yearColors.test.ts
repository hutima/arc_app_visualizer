import { describe, it, expect } from 'vitest'
import { colorForYear, yearRange, UNDATED_YEAR_COLOR } from '../src/shared/yearColors'

describe('yearColors', () => {
  it('is deterministic and range-independent', () => {
    expect(colorForYear(2024)).toBe(colorForYear(2024))
  })

  it('separates consecutive years on the hue wheel', () => {
    const hue = (c: string): number => Number(/hsl\(([\d.]+)/.exec(c)![1])
    for (let y = 2014; y < 2026; y++) {
      let delta = Math.abs(hue(colorForYear(y + 1)) - hue(colorForYear(y)))
      if (delta > 180) delta = 360 - delta
      expect(delta).toBeGreaterThan(60) // golden-angle stepping, never neighbors
    }
  })

  it('maps undated (0) to the neutral color', () => {
    expect(colorForYear(0)).toBe(UNDATED_YEAR_COLOR)
  })

  it('computes inclusive UTC year ranges', () => {
    expect(
      yearRange(Date.parse('2019-12-31T23:00:00Z'), Date.parse('2022-01-01T01:00:00Z'))
    ).toEqual([2019, 2020, 2021, 2022])
    expect(yearRange(null, Date.parse('2022-01-01T00:00:00Z'))).toEqual([])
  })
})
