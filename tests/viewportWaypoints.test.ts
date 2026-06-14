/**
 * Viewport waypoint behavior: repeat visits of the same named place merge
 * into one averaged dot, and over-budget viewports thin places spatially —
 * never dropping whole regions. Regression for the bug where a bare LIMIT
 * with no ORDER BY served waypoints in import order, so every place visited
 * after the cap (e.g. all of New England in a Toronto–NYC–Boston dataset)
 * vanished.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/main/db/db'
import { queryViewportWaypoints } from '../src/main/db/queries'
import type { ViewportQuery } from '../src/shared/types'

const VIEWPORT: ViewportQuery = {
  minLat: 0, maxLat: 60, minLon: 0, maxLon: 60,
  zoom: 5,
  startTsMs: null,
  endTsMs: null
}

const T0 = Date.parse('2024-01-01T00:00:00Z')
const WEEK_MS = 7 * 24 * 3600 * 1000

let db: DatabaseSync

beforeAll(() => {
  db = openDb(':memory:')
  db.prepare(`
    INSERT INTO imported_files (filename, source_path, file_hash, file_size, imported_at_ms)
    VALUES ('synthetic', '/dev/null', 'hash-thinning-test', 0, ?)
  `).run(Date.now())
  const insert = db.prepare(
    'INSERT INTO waypoints (file_id, name, ts_ms, lat, lon) VALUES (1, ?, ?, ?, ?)'
  )
  // Two distant clusters, inserted strictly in chronological order: 200 early
  // visits around (10, 10), then 200 later visits around (50, 50) — mimicking
  // weekly Arc files where a newly visited region only appears in later rows.
  for (let i = 0; i < 200; i++) {
    insert.run(`early-${i}`, T0 + i * WEEK_MS, 10 + (i % 20) * 0.001, 10 + Math.floor(i / 20) * 0.001)
  }
  for (let i = 0; i < 200; i++) {
    insert.run(`late-${i}`, T0 + (200 + i) * WEEK_MS, 50 + (i % 20) * 0.001, 50 + Math.floor(i / 20) * 0.001)
  }
})

afterAll(() => {
  db.close()
})

describe('waypoint thinning', () => {
  it('returns everything when under the budget', () => {
    const { waypoints, totalCount } = queryViewportWaypoints(db, VIEWPORT, 1000)
    expect(waypoints).toHaveLength(400)
    expect(totalCount).toBe(400)
  })

  it('keeps every region represented when over budget (no import-order dropping)', () => {
    const { waypoints, totalCount } = queryViewportWaypoints(db, VIEWPORT, 10)
    expect(totalCount).toBe(400)
    expect(waypoints.length).toBeGreaterThan(0)
    expect(waypoints.length).toBeLessThanOrEqual(10)
    // The old LIMIT-based query returned only `early-*` rows here.
    expect(waypoints.some((w) => w.lat < 20)).toBe(true)
    expect(waypoints.some((w) => w.lat > 40)).toBe(true)
  })

  it("keeps a cell's most recent visit as its representative", () => {
    const { waypoints } = queryViewportWaypoints(db, VIEWPORT, 2)
    for (const w of waypoints) {
      // Latest visit in each cluster is its newest row.
      expect(w.name).toBe(w.lat < 20 ? 'early-199' : 'late-199')
    }
  })

  it('is deterministic across repeated queries', () => {
    const a = queryViewportWaypoints(db, VIEWPORT, 10)
    const b = queryViewportWaypoints(db, VIEWPORT, 10)
    expect(a.waypoints.map((w) => w.id)).toEqual(b.waypoints.map((w) => w.id))
  })

  it('applies the time filter before thinning', () => {
    const earlyOnly = queryViewportWaypoints(
      db,
      { ...VIEWPORT, startTsMs: null, endTsMs: T0 + 199 * WEEK_MS },
      10
    )
    expect(earlyOnly.totalCount).toBe(200)
    expect(earlyOnly.waypoints.every((w) => w.lat < 20)).toBe(true)
  })

  it('returns nothing for a non-positive budget but still reports the total', () => {
    const { waypoints, totalCount } = queryViewportWaypoints(db, VIEWPORT, 0)
    expect(waypoints).toHaveLength(0)
    expect(totalCount).toBe(400)
  })
})

describe('same-name place merging', () => {
  let mergeDb: DatabaseSync
  const DAY_MS = 24 * 3600 * 1000

  beforeAll(() => {
    mergeDb = openDb(':memory:')
    mergeDb.prepare(`
      INSERT INTO imported_files (filename, source_path, file_hash, file_size, imported_at_ms)
      VALUES ('synthetic', '/dev/null', 'hash-merging-test', 0, ?)
    `).run(Date.now())
    const insert = mergeDb.prepare(
      'INSERT INTO waypoints (file_id, name, ts_ms, lat, lon) VALUES (1, ?, ?, ?, ?)'
    )
    // 40 GPS-jittered visits of one place; offsets are symmetric so the true
    // mean is exactly (10, 10). ids 1–40, the most recent visit is id 40.
    for (let i = 0; i < 40; i++) {
      insert.run(
        'Home', T0 + i * DAY_MS,
        10 + ((i % 5) - 2) * 0.0002,
        10 + ((i % 4) - 1.5) * 0.0002
      )
    }
    // A chain: same name in two far-apart cities (ids 41–50).
    for (let i = 0; i < 5; i++) {
      insert.run('Coffee Chain', T0 + i * DAY_MS, 10 + i * 0.0001, 12 + i * 0.0001)
    }
    for (let i = 0; i < 5; i++) {
      insert.run('Coffee Chain', T0 + i * DAY_MS, 50 + i * 0.0001, 52 + i * 0.0001)
    }
    // Unnamed visits at one spot (ids 51–53).
    for (let i = 0; i < 3; i++) {
      insert.run(null, T0 + i * DAY_MS, 30, 30)
    }
  })

  afterAll(() => {
    mergeDb.close()
  })

  it('merges repeat visits of a place into one dot at the mean location', () => {
    const { waypoints, totalCount } = queryViewportWaypoints(mergeDb, VIEWPORT, 1000)
    const homes = waypoints.filter((w) => w.name === 'Home')
    expect(homes).toHaveLength(1)
    expect(homes[0]!.lat).toBeCloseTo(10, 6)
    expect(homes[0]!.lon).toBeCloseTo(10, 6)
    // totalCount counts merged places, not raw visit rows.
    expect(totalCount).toBe(1 + 2 + 3) // Home + two chain sites + 3 unnamed
  })

  it("keeps the most recent visit's identity on the merged dot", () => {
    const { waypoints } = queryViewportWaypoints(mergeDb, VIEWPORT, 1000)
    const home = waypoints.find((w) => w.name === 'Home')!
    expect(home.id).toBe(40)
    expect(home.tsMs).toBe(T0 + 39 * DAY_MS)
  })

  it('keeps same-name places in different cities separate (no phantom midpoint)', () => {
    const { waypoints } = queryViewportWaypoints(mergeDb, VIEWPORT, 1000)
    const chain = waypoints.filter((w) => w.name === 'Coffee Chain')
    expect(chain).toHaveLength(2)
    const lats = chain.map((w) => w.lat).sort((a, b) => a - b)
    expect(lats[0]).toBeCloseTo(10, 2)
    expect(lats[1]).toBeCloseTo(50, 2)
  })

  it('passes unnamed visits through unmerged', () => {
    const { waypoints } = queryViewportWaypoints(mergeDb, VIEWPORT, 1000)
    expect(waypoints.filter((w) => w.name === null)).toHaveLength(3)
  })

  it('merges within the time filter only', () => {
    const firstWeek = queryViewportWaypoints(
      mergeDb,
      { ...VIEWPORT, startTsMs: null, endTsMs: T0 + 6 * DAY_MS },
      1000
    )
    const home = firstWeek.waypoints.find((w) => w.name === 'Home')!
    expect(home.tsMs).toBe(T0 + 6 * DAY_MS) // newest visit in range, not overall
  })
})

/**
 * A place pin must sit at its full cluster's centroid regardless of which
 * members are on screen — otherwise it drifts toward the in-view subset as the
 * user zooms in, landing in the wrong spot. Regression for that zoom-dependent
 * drift (the displayed pin now matches what getPlaceStats / a click resolve).
 */
describe('zoom-stable place pins', () => {
  let db: DatabaseSync

  beforeAll(() => {
    db = openDb(':memory:')
    db.prepare(`
      INSERT INTO imported_files (filename, source_path, file_hash, file_size, imported_at_ms)
      VALUES ('synthetic', '/dev/null', 'hash-stable-pins', 0, ?)
    `).run(Date.now())
    const insert = db.prepare(
      'INSERT INTO waypoints (file_id, name, ts_ms, lat, lon, place_id) VALUES (1, ?, ?, ?, ?, ?)'
    )
    // A user-merged place with members at the four corners of a square: full
    // centroid is (0.01, 0.01), well away from any single corner.
    db.prepare("INSERT INTO places (id, name) VALUES (1, 'Campus')").run()
    insert.run('a', T0, 0, 0, 1)
    insert.run('b', T0 + 1, 0, 0.02, 1)
    insert.run('c', T0 + 2, 0.02, 0, 1)
    insert.run('d', T0 + 3, 0.02, 0.02, 1)
    // A same-name proximity cluster (place_id NULL) spread over ~220 m along lon;
    // full centroid lon is 0.001, but a tiny viewport sees only the first two.
    for (let i = 0; i < 5; i++) insert.run('Cafe', T0 + i, 5, 5 + i * 0.0005, null)
  })

  afterAll(() => {
    db.close()
  })

  it('positions a merged place at the full centroid when only one member is in view', () => {
    // Viewport covers only corner (0, 0); the in-view-only mean would be (0, 0).
    const tiny: ViewportQuery = {
      minLat: -0.005, maxLat: 0.005, minLon: -0.005, maxLon: 0.005,
      zoom: 16, startTsMs: null, endTsMs: null
    }
    const { waypoints } = queryViewportWaypoints(db, tiny, 1000)
    const campus = waypoints.find((w) => w.placeId === 1)!
    expect(campus).toBeDefined()
    expect(campus.lat).toBeCloseTo(0.01, 9)
    expect(campus.lon).toBeCloseTo(0.01, 9)
  })

  it('does not move the merged pin as the viewport shrinks', () => {
    const wide = queryViewportWaypoints(db, VIEWPORT, 1000).waypoints.find((w) => w.placeId === 1)!
    const narrow = queryViewportWaypoints(
      db,
      { minLat: -0.005, maxLat: 0.025, minLon: -0.005, maxLon: 0.005, zoom: 15, startTsMs: null, endTsMs: null },
      1000
    ).waypoints.find((w) => w.placeId === 1)!
    expect(narrow.lat).toBeCloseTo(wide.lat, 9)
    expect(narrow.lon).toBeCloseTo(wide.lon, 9)
  })

  it('positions a name cluster at the full centroid even when partly off-screen', () => {
    // Only the first two Cafe visits (lon 5, 5.0005) are in view; full lon mean
    // is 5.001 across all five.
    const tiny: ViewportQuery = {
      minLat: 4.9, maxLat: 5.1, minLon: 4.9, maxLon: 5.0007, zoom: 16, startTsMs: null, endTsMs: null
    }
    const cafe = queryViewportWaypoints(db, tiny, 1000).waypoints.find((w) => w.name === 'Cafe')!
    expect(cafe).toBeDefined()
    expect(cafe.lon).toBeCloseTo(5.001, 9)
  })
})
