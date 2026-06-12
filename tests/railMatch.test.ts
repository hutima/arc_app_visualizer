/**
 * The cached map-matching pass end to end: a noisy metro ride + an OSM rail
 * line → rebuildRailMatches stores cleaned geometry → the viewport query swaps
 * it in only when snap is on.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/main/db/db'
import { addRailNetwork, matchedRideCount } from '../src/main/db/railStore'
import { rebuildRailMatches } from '../src/main/rail/buildMatches'
import { RAIL_KIND } from '../src/main/rail/snapRail'
import { queryViewportSegments, type ViewportSegmentRow } from '../src/main/db/queries'
import type { ViewportQuery } from '../src/shared/types'

const LIMITS = { segments: 100000, points: 300000 }
const VIEW: ViewportQuery = {
  minLat: -1, maxLat: 1, minLon: -1, maxLon: 1, zoom: 14, startTsMs: null, endTsMs: null
}
const lats = (r: ViewportSegmentRow): number[] => {
  const f = new Float32Array(r.coords.slice().buffer)
  return [...f].filter((_, i) => i % 2 === 1)
}

/** A noisy metro ride along lat≈0, lon 0..0.04, with raw points + display geom. */
function seedRide(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = OFF')
  db.prepare(
    `INSERT INTO imported_files (id, filename, source_path, file_hash, file_size, imported_at_ms)
     VALUES (1, 'f', 'f', 'h', 0, 0)`
  ).run()
  db.prepare("INSERT INTO tracks (id, file_id, type) VALUES (1, 1, 'metro')").run()
  db.prepare(
    `INSERT INTO segments (id, track_id, file_id, type, point_count, clean_point_count,
                           min_lat, max_lat, min_lon, max_lon)
     VALUES (1, 1, 1, 'metro', 5, 5, -0.001, 0.001, 0, 0.04)`
  ).run()
  const noisy = [0, 0.0004, 0.01, -0.0005, 0.02, 0.0004, 0.03, -0.0003, 0.04, 0.0005]
  const insPt = db.prepare('INSERT INTO points (segment_id, seq, lat, lon, flags) VALUES (1, ?, ?, ?, 0)')
  for (let i = 0; i < 5; i++) insPt.run(i, noisy[i * 2 + 1]!, noisy[i * 2]!)
  const blob = new Uint8Array(new Float32Array(noisy).buffer)
  for (const detail of [0, 1, 2]) {
    db.prepare(
      'INSERT INTO display_geometries (segment_id, detail, point_count, coords) VALUES (1, ?, 5, ?)'
    ).run(detail, blob)
  }
}

const railLine = {
  nodes: Array.from({ length: 5 }, (_, i) => ({ id: 10 + i, lat: 0, lon: i * 0.01 })),
  edges: Array.from({ length: 4 }, (_, i) => ({ a: 10 + i, b: 11 + i }))
}
const railBox = { minLat: -0.1, minLon: -0.1, maxLat: 0.1, maxLon: 0.1 }

describe('cached rail matching', () => {
  let db: DatabaseSync
  beforeEach(() => {
    db = openDb(':memory:')
    seedRide(db)
  })

  it('builds matched geometry and swaps it in only under snap mode', async () => {
    addRailNetwork(db, railLine, railBox)
    const { matched } = await rebuildRailMatches(db)
    expect(matched).toBe(1)
    expect(matchedRideCount(db)).toBe(1)

    // Snap off: the raw, noisy display geometry (lat ≠ 0).
    const off = queryViewportSegments(db, { ...VIEW, snapRail: false }, LIMITS).rows[0]!
    expect(off._matched).toBeFalsy()
    expect(lats(off).some((lat) => lat !== 0)).toBe(true)

    // Snap on: cleaned geometry riding the rail (every point exactly on lat 0).
    const on = queryViewportSegments(db, { ...VIEW, snapRail: true }, LIMITS).rows[0]!
    expect(on._matched).toBe(1)
    expect(lats(on).every((lat) => lat === 0)).toBe(true)
  })

  it('rebuilds from scratch — coverage removed leaves nothing matched', async () => {
    addRailNetwork(db, railLine, railBox)
    await rebuildRailMatches(db)
    expect(matchedRideCount(db)).toBe(1)

    db.exec('DELETE FROM rail_coverage')
    const { matched } = await rebuildRailMatches(db)
    expect(matched).toBe(0)
    expect(matchedRideCount(db)).toBe(0)
    // With nothing matched, snap mode falls back to the raw display geometry.
    const on = queryViewportSegments(db, { ...VIEW, snapRail: true }, LIMITS).rows[0]!
    expect(on._matched).toBeFalsy()
  })

  // The seeded ride is a 'metro'. Type-constrained matching means it snaps to
  // subway/light-rail track but not to a parallel commuter-rail line.
  const withKind = (kind: number): typeof railLine => ({
    nodes: railLine.nodes,
    edges: railLine.edges.map((e) => ({ ...e, kind }))
  })

  it('matches a metro ride when the nearby track is subway', async () => {
    addRailNetwork(db, withKind(RAIL_KIND.subway), railBox)
    expect((await rebuildRailMatches(db)).matched).toBe(1)
  })

  it('will not snap a metro ride to a commuter-rail (kind rail) line', async () => {
    addRailNetwork(db, withKind(RAIL_KIND.rail), railBox)
    expect((await rebuildRailMatches(db)).matched).toBe(0)
    expect(matchedRideCount(db)).toBe(0)
  })

  it('bridges a car trip GPS gap through a road tunnel; rail never uses it', async () => {
    // Car trip: one fix before the tunnel mouth, the next past the far portal.
    db.prepare(
      `INSERT INTO segments (id, track_id, file_id, type, point_count, clean_point_count,
                             min_lat, max_lat, min_lon, max_lon)
       VALUES (2, 1, 1, 'car', 2, 2, -0.001, 0.001, 0.009, 0.031)`
    ).run()
    const insPt = db.prepare(
      'INSERT INTO points (segment_id, seq, lat, lon, flags) VALUES (2, ?, ?, ?, 0)'
    )
    insPt.run(0, 0.0001, 0.009)
    insPt.run(1, -0.0001, 0.031)

    // Network contains ONLY a road tunnel (lon 0.01..0.03 at lat 0).
    addRailNetwork(
      db,
      {
        nodes: [0.01, 0.015, 0.02, 0.025, 0.03].map((lon, i) => ({ id: 50 + i, lat: 0, lon })),
        edges: [50, 51, 52, 53].map((a) => ({ a, b: a + 1, kind: RAIL_KIND.road_tunnel }))
      },
      railBox
    )
    const r = await rebuildRailMatches(db)
    // The car trip bridged; the metro ride (seg 1) must not touch road edges.
    expect(r.railSegments).toBe(2)
    expect(r.matched).toBe(1)
    const row = db.prepare(
      'SELECT point_count FROM rail_matched_geom WHERE segment_id = 2 AND detail = 2'
    ).get() as { point_count: number }
    expect(row.point_count).toBeGreaterThan(2) // tunnel alignment spliced in
  })
})
