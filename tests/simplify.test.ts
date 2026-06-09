import { describe, it, expect } from 'vitest'
import { simplifyIndices } from '../src/main/importer/simplify'

describe('simplifyIndices (Douglas–Peucker)', () => {
  it('handles degenerate inputs', () => {
    expect(simplifyIndices([], [], 1e-5)).toEqual([])
    expect(simplifyIndices([1], [1], 1e-5)).toEqual([0])
    expect(simplifyIndices([1, 2], [1, 2], 1e-5)).toEqual([0, 1])
  })

  it('collapses collinear points to the endpoints', () => {
    const lons = [0, 0.001, 0.002, 0.003, 0.004]
    const lats = [0, 0, 0, 0, 0]
    expect(simplifyIndices(lons, lats, 1e-5)).toEqual([0, 4])
  })

  it('keeps corners of a rectangle path', () => {
    // Dense points along two edges of a rectangle; the corner must survive.
    const lons: number[] = []
    const lats: number[] = []
    for (let i = 0; i <= 10; i++) {
      lons.push(0.001 * i)
      lats.push(0)
    }
    for (let i = 1; i <= 10; i++) {
      lons.push(0.01)
      lats.push(0.001 * i)
    }
    const kept = simplifyIndices(lons, lats, 1e-5)
    expect(kept[0]).toBe(0)
    expect(kept[kept.length - 1]).toBe(lons.length - 1)
    expect(kept).toContain(10) // the corner index
    expect(kept.length).toBeLessThan(lons.length)
  })

  it('keeps points that deviate more than the tolerance', () => {
    const lons = [0, 0.001, 0.002]
    const lats = [0, 0.0005, 0]
    expect(simplifyIndices(lons, lats, 1e-5)).toEqual([0, 1, 2])
    expect(simplifyIndices(lons, lats, 1e-2)).toEqual([0, 2])
  })
})
