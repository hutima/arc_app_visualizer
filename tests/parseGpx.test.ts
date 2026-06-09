import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseGpx } from '../src/main/importer/parseGpx'

const FIXTURE = fileURLToPath(new URL('../fixtures/2000-W01-synthetic.gpx', import.meta.url))

describe('parseGpx (synthetic fixture only)', () => {
  const gpx = parseGpx(readFileSync(FIXTURE, 'utf8'))

  it('parses all tracks and waypoints', () => {
    expect(gpx.tracks).toHaveLength(10)
    expect(gpx.waypoints).toHaveLength(3)
  })

  it('extracts track name, type, and points', () => {
    const walk = gpx.tracks[0]!
    expect(walk.name).toBe('Synthetic morning walk')
    expect(walk.type).toBe('walking')
    expect(walk.segments).toHaveLength(1)
    expect(walk.segments[0]).toHaveLength(17)
    const p0 = walk.segments[0]![0]!
    expect(p0.lat).toBeCloseTo(0.001, 9)
    expect(p0.lon).toBeCloseTo(0.001, 9)
    expect(p0.ele).toBeCloseTo(10.1, 9)
    expect(p0.tsMs).toBe(Date.parse('2000-01-03T08:00:00Z'))
  })

  it('preserves an empty trkseg as an empty segment (occurs in real exports)', () => {
    const emptyTrack = gpx.tracks[2]!
    expect(emptyTrack.segments).toEqual([[]])
  })

  it('handles multi-segment tracks', () => {
    const car = gpx.tracks[3]!
    expect(car.type).toBe('car')
    expect(car.segments).toHaveLength(2)
    expect(car.segments[0]).toHaveLength(5)
    expect(car.segments[1]).toHaveLength(3)
  })

  it('keeps out-of-range coordinates for the cleaning pass to flag', () => {
    const cycling = gpx.tracks[7]!
    expect(cycling.segments[0]![2]!.lat).toBe(95)
  })

  it('tolerates points without ele/time', () => {
    const hovercraft = gpx.tracks[9]!
    const bare = hovercraft.segments[0]![1]!
    expect(bare.ele).toBeNull()
    expect(bare.tsMs).toBeNull()
    expect(Number.isFinite(bare.lat)).toBe(true)
  })

  it('parses waypoints with name and time', () => {
    const w = gpx.waypoints[0]!
    expect(w.name).toBe('Synthetic Place Alpha')
    expect(w.tsMs).toBe(Date.parse('2000-01-03T07:59:00Z'))
  })

  it('defaults missing type to "unknown" and lowercases types', () => {
    const xml = `<?xml version="1.0"?>
      <gpx version="1.1" creator="Arc Timeline">
        <trk><name>No type</name><trkseg>
          <trkpt lat="0.001" lon="0.002"><time>2000-01-03T00:00:00Z</time></trkpt>
        </trkseg></trk>
        <trk><type>WALKING</type><trkseg></trkseg></trk>
      </gpx>`
    const parsed = parseGpx(xml)
    expect(parsed.tracks[0]!.type).toBe('unknown')
    expect(parsed.tracks[1]!.type).toBe('walking')
  })

  it('rejects non-GPX documents', () => {
    expect(() => parseGpx('<foo/>')).toThrow(/missing <gpx> root/)
  })
})
