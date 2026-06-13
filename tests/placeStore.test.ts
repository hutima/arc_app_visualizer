/**
 * Persistent places: resolving the cluster behind a clicked pin, merging
 * places under a chosen name (non-destructive, regardless of distance/name),
 * folding a track into a place as a stationary visit (and deleting the track),
 * per-place visit stats, and the dataset-wide summary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/main/db/db'
import {
  resolvePlace,
  mergePlaces,
  assignTrackToPlace,
  getPlaceStats
} from '../src/main/db/placeStore'
import { queryViewportWaypoints, getDatasetStats } from '../src/main/db/queries'
import type { ViewportQuery } from '../src/shared/types'

let db: DatabaseSync
let fileId: number
let nextHash = 0

beforeEach(() => {
  db = openDb(':memory:')
  fileId = Number(
    db.prepare(`
      INSERT INTO imported_files (filename, source_path, file_hash, file_size, imported_at_ms)
      VALUES ('synthetic', '/dev/null', ?, 0, 0)
    `).run(`hash-${nextHash++}`).lastInsertRowid
  )
})

afterEach(() => db.close())

const WORLD: ViewportQuery = {
  minLat: -90, maxLat: 90, minLon: -180, maxLon: 180,
  zoom: 5, startTsMs: null, endTsMs: null
}
const DAY = 86_400_000
const T0 = Date.parse('2022-06-15T08:00:00Z')

const addWaypoint = (name: string | null, tsMs: number | null, lat: number, lon: number): number =>
  Number(
    db.prepare('INSERT INTO waypoints (file_id, name, ts_ms, lat, lon) VALUES (?, ?, ?, ?, ?)')
      .run(fileId, name, tsMs, lat, lon).lastInsertRowid
  )

/** A synthetic segment with the given (lat, lon) points; timestamps optional. */
function seedSegment(type: string, pts: Array<[number, number]>, startTs: number | null): number {
  const trackId = Number(
    db.prepare('INSERT INTO tracks (file_id, type) VALUES (?, ?)').run(fileId, type).lastInsertRowid
  )
  const segId = Number(
    db.prepare(`
      INSERT INTO segments
        (track_id, file_id, type, start_ts_ms, end_ts_ms, point_count, clean_point_count,
         min_lat, min_lon, max_lat, max_lon)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)
    `).run(trackId, fileId, type, startTs, startTs, pts.length, pts.length).lastInsertRowid
  )
  const ins = db.prepare(
    'INSERT INTO points (segment_id, seq, ts_ms, lat, lon, ele, flags) VALUES (?, ?, ?, ?, ?, NULL, 0)'
  )
  pts.forEach(([lat, lon], i) => ins.run(segId, i, startTs, lat, lon))
  return segId
}

const placeIdOf = (waypointId: number): number | null =>
  (db.prepare('SELECT place_id AS p FROM waypoints WHERE id = ?').get(waypointId) as { p: number | null }).p
const waypointCount = (): number =>
  (db.prepare('SELECT COUNT(*) AS c FROM waypoints').get() as { c: number }).c
const placesCount = (): number =>
  (db.prepare('SELECT COUNT(*) AS c FROM places').get() as { c: number }).c

describe('resolvePlace', () => {
  it('recovers the name+proximity cluster a visit belongs to, not a far same-name one', () => {
    const near = [addWaypoint('Cafe', T0, 10, 10), addWaypoint('Cafe', T0 + DAY, 10.0005, 10.0005)]
    addWaypoint('Cafe', T0, 50, 50) // a different "Cafe" entirely
    const place = resolvePlace(db, { waypointId: near[0]! })
    expect(place).not.toBeNull()
    expect(place!.name).toBe('Cafe')
    expect(place!.placeId).toBeNull()
    expect(place!.members.map((m) => m.id).sort((a, b) => a - b)).toEqual(near.sort((a, b) => a - b))
  })

  it('treats an unnamed visit as its own one-member place', () => {
    const id = addWaypoint(null, T0, 30, 30)
    const place = resolvePlace(db, { waypointId: id })
    expect(place!.members).toHaveLength(1)
    expect(place!.name).toBeNull()
  })

  it('returns null for an orphaned place id', () => {
    expect(resolvePlace(db, { placeId: 999 })).toBeNull()
  })
})

describe('mergePlaces', () => {
  it('merges differently-named, far-apart places into one pin with the chosen name', () => {
    const home = [addWaypoint('Home', T0, 10, 10), addWaypoint('Home', T0 + DAY, 10.0005, 10)]
    const house = [addWaypoint('House', T0, 60, 60), addWaypoint('House', T0 + DAY, 60.0005, 60)]
    const placeId = mergePlaces(db, [{ waypointId: home[0]! }, { waypointId: house[0]! }], 'Home')

    for (const id of [...home, ...house]) expect(placeIdOf(id)).toBe(placeId)
    const { waypoints, totalCount } = queryViewportWaypoints(db, WORLD, 1000)
    expect(totalCount).toBe(1) // four visits, two names, far apart → a single place
    expect(waypoints[0]!.name).toBe('Home')
    expect(waypoints[0]!.placeId).toBe(placeId)
    expect(waypoints[0]!.lat).toBeCloseTo(35, 1) // mean of the in-view members
  })

  it('keeps the chosen name even when it matches neither place', () => {
    const a = addWaypoint('A', T0, 0, 0)
    const b = addWaypoint('B', T0, 5, 5)
    const placeId = mergePlaces(db, [{ waypointId: a }, { waypointId: b }], 'Combined')
    expect((db.prepare('SELECT name FROM places WHERE id = ?').get(placeId) as { name: string }).name).toBe(
      'Combined'
    )
  })

  it('rejects a merge of fewer than two distinct places', () => {
    const a = addWaypoint('A', T0, 0, 0)
    expect(() => mergePlaces(db, [{ waypointId: a }, { waypointId: a }], 'X')).toThrow(/two distinct/)
  })

  it('rejects an empty name', () => {
    const a = addWaypoint('A', T0, 0, 0)
    const b = addWaypoint('B', T0, 5, 5)
    expect(() => mergePlaces(db, [{ waypointId: a }, { waypointId: b }], '   ')).toThrow(/name/)
  })

  it('reuses an existing place id and prunes the orphaned one', () => {
    const a = addWaypoint('A', T0, 0, 0)
    const b = addWaypoint('B', T0, 5, 5)
    const c = addWaypoint('C', T0, 10, 10)
    const d = addWaypoint('D', T0, 15, 15)
    const p1 = mergePlaces(db, [{ waypointId: a }, { waypointId: b }], 'AB')
    const p2 = mergePlaces(db, [{ waypointId: c }, { waypointId: d }], 'CD')
    expect(placesCount()).toBe(2)
    const merged = mergePlaces(db, [{ placeId: p1 }, { placeId: p2 }], 'All')
    expect(merged).toBe(Math.min(p1, p2)) // lowest existing id survives
    expect(placesCount()).toBe(1) // the other place row is pruned
    for (const id of [a, b, c, d]) expect(placeIdOf(id)).toBe(merged)
  })
})

describe('assignTrackToPlace', () => {
  it('adds the track centroid as a stationary visit and deletes the track', () => {
    const park = addWaypoint('Park', T0, 5, 5)
    const segId = seedSegment('walking', [[5.01, 5.0], [5.03, 5.04]], T0 + DAY)
    const before = waypointCount()

    assignTrackToPlace(db, segId, { waypointId: park })

    expect(db.prepare('SELECT 1 FROM segments WHERE id = ?').get(segId)).toBeUndefined()
    expect(db.prepare('SELECT 1 FROM points WHERE segment_id = ?').get(segId)).toBeUndefined()
    expect(waypointCount()).toBe(before + 1)

    // The implicit place was materialized; the new visit joined it.
    const place = resolvePlace(db, { waypointId: park })
    expect(place!.placeId).not.toBeNull()
    expect(place!.members).toHaveLength(2)
    const added = place!.members.find((m) => m.id !== park)!
    expect(added.lat).toBeCloseTo(5.02, 6) // centroid of the two track points
    expect(added.lon).toBeCloseTo(5.02, 6)
    expect(added.tsMs).toBe(T0 + DAY)
  })

  it('rejects an unknown segment or place', () => {
    const id = addWaypoint('P', T0, 1, 1)
    expect(() => assignTrackToPlace(db, 12345, { waypointId: id })).toThrow(/unknown segment/)
    const segId = seedSegment('walking', [[0, 0], [0, 0.1]], T0)
    expect(() => assignTrackToPlace(db, segId, { placeId: 999 })).toThrow(/unknown place/)
  })
})

describe('getPlaceStats', () => {
  it('counts visits and builds time-of-day / day-of-week / yearly histograms', () => {
    const dated = [T0, T0 + DAY, T0 + 2 * DAY, T0 + 400 * DAY] // last one in the next year
    const first = addWaypoint('Gym', dated[0]!, 20, 20)
    for (const ts of dated.slice(1)) addWaypoint('Gym', ts, 20.0005, 20)
    addWaypoint('Gym', null, 20, 20.0005) // undated: counts as a visit, not in histograms

    const stats = getPlaceStats(db, { waypointId: first })!
    expect(stats.visitCount).toBe(5)
    expect(stats.firstTsMs).toBe(dated[0])
    expect(stats.lastTsMs).toBe(dated[3])
    const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0)
    expect(sum(stats.hourCounts)).toBe(4) // only dated visits
    expect(sum(stats.dowCounts)).toBe(4)
    expect(sum(stats.yearCounts.map((y) => y.count))).toBe(4)
    expect(stats.yearCounts.length).toBe(2) // spans two calendar years
    // The bucket for a known visit lines up with local-time interpretation.
    expect(stats.hourCounts[new Date(dated[0]!).getHours()]).toBeGreaterThanOrEqual(1)
  })

  it('returns null for an unknown place', () => {
    expect(getPlaceStats(db, { placeId: 4242 })).toBeNull()
  })
})

describe('getDatasetStats', () => {
  it('summarizes totals, per-year counts, and most-visited places', () => {
    // Two visits to one merged place (far apart) + a singleton; tracks in 2022.
    const a = addWaypoint('Home', T0, 0, 0)
    const b = addWaypoint('Casa', T0 + DAY, 40, 40)
    mergePlaces(db, [{ waypointId: a }, { waypointId: b }], 'Home')
    addWaypoint('Solo', T0 + 365 * DAY, 1, 1) // next year
    seedSegment('walking', [[0, 0], [0, 0.1]], T0)
    seedSegment('cycling', [[1, 1], [1, 1.1]], T0 + 365 * DAY)

    const s = getDatasetStats(db)
    expect(s.fileCount).toBe(1)
    expect(s.segmentCount).toBe(2)
    expect(s.visitCount).toBe(3)
    // One merged place + one un-merged named cluster ("Solo").
    expect(s.placeCount).toBe(2)
    expect(s.segmentsByYear).toEqual([
      { year: 2022, count: 1 },
      { year: 2023, count: 1 }
    ])
    expect(s.visitsByYear.find((y) => y.year === 2022)!.count).toBe(2)
    expect(s.topPlaces[0]!.name).toBe('Home') // 2 visits, ahead of Solo's 1
    expect(s.topPlaces[0]!.visitCount).toBe(2)
    expect(s.topPlaces.map((p) => p.name)).toContain('Solo')
  })
})
