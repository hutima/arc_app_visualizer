/**
 * Rail ride averaging (the "cleaning" toggle): repeat metro/tram rides
 * between the same two places collapse into one consensus polyline; anything
 * unanchored, solo, looping, or non-rail passes through byte-identical.
 */
import { describe, it, expect } from 'vitest'
import { averageRailTracks } from '../src/main/db/railAverage'
import type { ViewportSegmentRow } from '../src/main/db/queries'
import type { ViewportWaypoint } from '../src/shared/types'

const place = (id: number, lat: number, lon: number, name = `P${id}`): ViewportWaypoint => ({
  id, lat, lon, tsMs: null, name
})

/** Station A at (0, 0), station B at (0, 0.1), C far away. */
const PLACES = [place(1, 0, 0), place(2, 0, 0.1), place(3, 5, 5)]

let nextId = 1
const row = (
  type: string,
  lonLat: number[],
  startTsMs: number | null = null,
  id = nextId++
): ViewportSegmentRow => ({
  id,
  type,
  start_ts_ms: startTsMs,
  point_count: lonLat.length / 2,
  coords: new Uint8Array(new Float32Array(lonLat).buffer)
})

const coordsOf = (r: ViewportSegmentRow): number[] => [
  ...new Float32Array(r.coords.buffer.slice(r.coords.byteOffset, r.coords.byteOffset + r.coords.byteLength))
]

describe('averageRailTracks', () => {
  it('averages two jittered rides between the same places into one track', () => {
    // Both A→B; one bows north, the other south by the same amount.
    const up = row('metro', [0, 0, 0.05, 0.01, 0.1, 0], 1000)
    const down = row('metro', [0, 0, 0.05, -0.01, 0.1, 0], 2000)
    const { rows, collapsed } = averageRailTracks([up, down], PLACES)

    expect(collapsed).toBe(2)
    expect(rows).toHaveLength(1)
    const avg = rows[0]!
    expect(avg.type).toBe('metro')
    expect(avg.id).toBe(Math.min(up.id, down.id))
    expect(avg.start_ts_ms).toBe(2000) // most recent ride
    const c = coordsOf(avg)
    // Endpoints stay at the stations; the bows cancel to ~0 in the middle.
    expect(c[0]).toBeCloseTo(0, 5)
    expect(c[1]).toBeCloseTo(0, 5)
    expect(c[c.length - 2]!).toBeCloseTo(0.1, 5)
    expect(c[c.length - 1]!).toBeCloseTo(0, 5)
    const midLat = c[Math.floor(c.length / 4) * 2 + 1]!
    expect(Math.abs(midLat)).toBeLessThan(0.005)
  })

  it('merges opposite-direction rides by flipping one (A→B with B→A)', () => {
    const there = row('tram', [0, 0, 0.05, 0.01, 0.1, 0])
    const back = row('tram', [0.1, 0, 0.05, -0.01, 0, 0])
    const { rows, collapsed } = averageRailTracks([there, back], PLACES)
    expect(collapsed).toBe(2)
    expect(rows).toHaveLength(1)
    const c = coordsOf(rows[0]!)
    expect(c[0]).toBeCloseTo(0, 5) // oriented from the lower place id
    expect(c[c.length - 2]!).toBeCloseTo(0.1, 5)
    const midLat = c[Math.floor(c.length / 4) * 2 + 1]!
    expect(Math.abs(midLat)).toBeLessThan(0.005) // bows cancel after the flip
  })

  it('does not mix metro with tram between the same two places', () => {
    const m = [row('metro', [0, 0, 0.1, 0]), row('metro', [0, 0, 0.1, 0])]
    const t = [row('tram', [0, 0, 0.1, 0]), row('tram', [0, 0, 0.1, 0])]
    const { rows, collapsed } = averageRailTracks([...m, ...t], PLACES)
    expect(collapsed).toBe(4)
    expect(rows.map((r) => r.type).sort()).toEqual(['metro', 'tram'])
  })

  it('leaves rides untouched without a place at both ends', () => {
    const anchored = row('metro', [0, 0, 0.1, 0])
    const dangling = row('metro', [0, 0, 1, 1]) // far end near no place
    const { rows, collapsed } = averageRailTracks([anchored, dangling], PLACES)
    expect(collapsed).toBe(0)
    expect(rows).toHaveLength(2)
    expect(coordsOf(rows.find((r) => r.id === dangling.id)!)).toEqual(coordsOf(dangling))
  })

  it('leaves solo rides, loops, and non-rail types untouched', () => {
    const solo = row('metro', [0, 0, 0.1, 0])
    const loop = row('metro', [0, 0, 0.05, 0.02, 0.0001, 0.0001]) // A back to A
    const cars = [row('car', [0, 0, 0.1, 0]), row('car', [0, 0, 0.1, 0])]
    const { rows, collapsed } = averageRailTracks([solo, loop, ...cars], PLACES)
    expect(collapsed).toBe(0)
    expect(rows).toHaveLength(4)
    expect(rows.filter((r) => r.type === 'car')).toHaveLength(2)
  })

  it('samples the consensus at ~50 m resolution along the route', () => {
    // ~11.1 km between A and B → roughly one vertex per 50 m.
    const rides = [row('metro', [0, 0, 0.1, 0]), row('metro', [0, 0, 0.1, 0])]
    const long = averageRailTracks(rides, PLACES).rows[0]!
    expect(long.point_count).toBeGreaterThan(150)
    expect(long.point_count).toBeLessThan(300)

    // ~110 m hop → only a handful of vertices, never fewer than 2.
    const shortPlaces = [place(1, 0, 0), place(2, 0, 0.001)]
    const hops = [row('tram', [0, 0, 0.001, 0]), row('tram', [0, 0, 0.001, 0])]
    const short = averageRailTracks(hops, shortPlaces).rows[0]!
    expect(short.point_count).toBeGreaterThanOrEqual(2)
    expect(short.point_count).toBeLessThanOrEqual(5)
  })

  it('keeps endpoints pinned while smoothing the interior', () => {
    // One noisy zigzag ride + one straight ride.
    const zig = row('metro', [0, 0, 0.025, 0.004, 0.05, -0.004, 0.075, 0.004, 0.1, 0])
    const straight = row('metro', [0, 0, 0.1, 0])
    const avg = averageRailTracks([zig, straight], PLACES).rows[0]!
    const c = coordsOf(avg)
    expect(c[0]).toBeCloseTo(0, 6)
    expect(c[1]).toBeCloseTo(0, 6)
    expect(c[c.length - 2]!).toBeCloseTo(0.1, 6)
    expect(c[c.length - 1]!).toBeCloseTo(0, 6)
    // Interior stays within half the zigzag amplitude: averaged then smoothed.
    for (let i = 1; i < c.length / 2 - 1; i++) {
      expect(Math.abs(c[i * 2 + 1]!)).toBeLessThan(0.002)
    }
  })

  it('rejects a wild tunnel excursion instead of bending the consensus to it', () => {
    // Three rides hug the real A→B line; one spikes far north mid-route.
    const a = row('metro', [0, 0, 0.05, 0.001, 0.1, 0])
    const b = row('metro', [0, 0, 0.05, -0.001, 0.1, 0])
    const c = row('metro', [0, 0, 0.05, 0, 0.1, 0])
    const spur = row('metro', [0, 0, 0.05, 0.05, 0.1, 0]) // ~5.5 km off-route
    const { rows, collapsed } = averageRailTracks([a, b, c, spur], PLACES)

    // The three in agreement collapse; the excursion is kept as its own line.
    expect(collapsed).toBe(3)
    const avg = rows.find((r) => r.id === Math.min(a.id, b.id, c.id))!
    const mid = coordsOf(avg)[Math.floor(coordsOf(avg).length / 4) * 2 + 1]!
    expect(Math.abs(mid)).toBeLessThan(0.01) // consensus stays on the real path
    expect(rows.some((r) => r.id === spur.id)).toBe(true) // excursion still drawn
  })

  it('is deterministic regardless of input order', () => {
    const a = row('metro', [0, 0, 0.05, 0.01, 0.1, 0], 1000)
    const b = row('metro', [0, 0, 0.05, -0.01, 0.1, 0], 2000)
    const fwd = averageRailTracks([a, b], PLACES)
    const rev = averageRailTracks([b, a], PLACES)
    expect(coordsOf(fwd.rows[0]!)).toEqual(coordsOf(rev.rows[0]!))
    expect(fwd.rows[0]!.id).toBe(rev.rows[0]!.id)
  })

  it('passes everything through when no places are in view', () => {
    const a = row('metro', [0, 0, 0.1, 0])
    const { rows, collapsed } = averageRailTracks([a], [])
    expect(collapsed).toBe(0)
    expect(rows).toEqual([a])
  })
})
