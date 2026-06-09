import { describe, it, expect } from 'vitest'
import {
  cleanSegment,
  DEFAULT_CLEANING,
  POINT_FLAG_INVALID_COORD,
  POINT_FLAG_DUPLICATE,
  POINT_FLAG_SPEED_SPIKE,
  POINT_FLAG_TIME_ANOMALY,
  SEGMENT_FLAG_EMPTY
} from '../src/main/importer/clean'
import type { ParsedPoint } from '../src/main/importer/parseGpx'

const T0 = Date.parse('2000-01-03T08:00:00Z')

function pt(lat: number, lon: number, secondsAfterT0: number | null): ParsedPoint {
  return { lat, lon, tsMs: secondsAfterT0 === null ? null : T0 + secondsAfterT0 * 1000, ele: null }
}

describe('cleanSegment', () => {
  it('leaves a plausible walking trace unflagged', () => {
    const pts = [pt(0.001, 0.001, 0), pt(0.0012, 0.001, 20), pt(0.0014, 0.001, 40)]
    const res = cleanSegment(pts, 'walking')
    expect([...res.flags]).toEqual([0, 0, 0])
    expect(res.cleanCount).toBe(3)
    expect(res.segmentFlags).toBe(0)
  })

  it('flags out-of-range and Null Island coordinates', () => {
    const pts = [pt(95, 0.001, 0), pt(0.001, 200, 10), pt(0, 0, 20), pt(NaN, 0.001, 30)]
    const res = cleanSegment(pts, 'walking')
    expect([...res.flags]).toEqual([
      POINT_FLAG_INVALID_COORD,
      POINT_FLAG_INVALID_COORD,
      POINT_FLAG_INVALID_COORD,
      POINT_FLAG_INVALID_COORD
    ])
    expect(res.cleanCount).toBe(0)
  })

  it('flags exact consecutive duplicates', () => {
    const pts = [pt(0.001, 0.001, 0), pt(0.001, 0.001, 0), pt(0.0012, 0.001, 20)]
    const res = cleanSegment(pts, 'walking')
    expect(res.flags[1]).toBe(POINT_FLAG_DUPLICATE)
    expect(res.cleanCount).toBe(2)
  })

  it('flags an impossible teleport but keeps the recovery point', () => {
    // ~55 km in 30 s ≈ 1800 m/s, far over the metro ceiling.
    const pts = [
      pt(0.005, 0.005, 0),
      pt(0.0054, 0.0054, 30),
      pt(0.5, 0.0056, 60),
      pt(0.0058, 0.0058, 90)
    ]
    const res = cleanSegment(pts, 'metro')
    expect(res.flags[2]).toBe(POINT_FLAG_SPEED_SPIKE)
    // Speed is measured against the last clean point, so the trace recovers.
    expect(res.flags[3]).toBe(0)
    expect(res.cleanCount).toBe(3)
  })

  it('respects per-type speed ceilings', () => {
    // ~80 m/s: fine for a car, impossible for walking.
    const pts = [pt(0, 0.001, 0), pt(0, 0.00873, 10)]
    expect(cleanSegment(pts, 'car').flags[1]).toBe(0)
    expect(cleanSegment(pts, 'walking').flags[1]).toBe(POINT_FLAG_SPEED_SPIKE)
  })

  it('uses the default ceiling for unknown types', () => {
    const fast = [pt(0, 0.001, 0), pt(0.5, 0.001, 10)] // ~5500 m/s
    expect(cleanSegment(fast, 'hovercraft').flags[1]).toBe(POINT_FLAG_SPEED_SPIKE)
    const ok = [pt(0, 0.001, 0), pt(0.001, 0.001, 10)]
    expect(cleanSegment(ok, 'hovercraft').flags[1]).toBe(0)
  })

  it('flags time anomalies (backwards or frozen clock with movement)', () => {
    const backwards = [pt(0.001, 0.001, 60), pt(0.002, 0.001, 0)]
    expect(cleanSegment(backwards, 'walking').flags[1]).toBe(POINT_FLAG_TIME_ANOMALY)
    const frozenMoved = [pt(0.001, 0.001, 0), pt(0.01, 0.001, 0)] // ~1 km, same ts
    expect(cleanSegment(frozenMoved, 'walking').flags[1]).toBe(POINT_FLAG_TIME_ANOMALY)
  })

  it('skips speed checks when timestamps are missing, keeping the points', () => {
    const pts = [pt(0.001, 0.001, null), pt(0.5, 0.001, null)]
    const res = cleanSegment(pts, 'walking')
    expect(res.cleanCount).toBe(2)
  })

  it('marks empty segments', () => {
    const res = cleanSegment([], 'walking', DEFAULT_CLEANING)
    expect(res.segmentFlags & SEGMENT_FLAG_EMPTY).toBe(SEGMENT_FLAG_EMPTY)
    expect(res.cleanCount).toBe(0)
  })
})
