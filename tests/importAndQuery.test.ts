/**
 * End-to-end pipeline test: import the synthetic fixture into a temp SQLite
 * database, then exercise dedupe, viewport queries, cleaning effects, and
 * summary stats — exactly the code paths the Electron app uses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { runImport } from '../src/main/importer/importFiles'
import { openDb } from '../src/main/db/db'
import {
  queryViewportSegments,
  queryViewportWaypoints,
  getCategories,
  setCategoryColor,
  setCategoryOrder,
  getSummary,
  getDataBounds,
  type ViewportSegmentRow
} from '../src/main/db/queries'
import {
  POINT_FLAG_DUPLICATE,
  POINT_FLAG_INVALID_COORD,
  POINT_FLAG_SPEED_SPIKE
} from '../src/main/importer/clean'
import { KNOWN_CATEGORY_COLORS, colorForCategory } from '../src/shared/categories'
import type { ImportProgress, ViewportQuery } from '../src/shared/types'

const FIXTURE = fileURLToPath(new URL('../fixtures/2000-W01-synthetic.gpx', import.meta.url))

const VIEWPORT_ALL: ViewportQuery = {
  minLat: -1, maxLat: 1, minLon: -1, maxLon: 1,
  zoom: 14, // detail 2
  startTsMs: null,
  endTsMs: null
}

/** Generous defaults so tests exercise filtering, not limiting. */
const LIMITS = { segments: 1000, points: 100000 }

const totalPoints = (rows: ViewportSegmentRow[]): number =>
  rows.reduce((sum, r) => sum + r.point_count, 0)

const coordsView = (r: ViewportSegmentRow): Float32Array =>
  new Float32Array(r.coords.buffer.slice(r.coords.byteOffset, r.coords.byteOffset + r.coords.byteLength))

let dir: string
let dbPath: string
let db: DatabaseSync

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arcviz-test-'))
  dbPath = join(dir, 'test.db')
  await runImport({ dbPath, paths: [FIXTURE] })
  db = openDb(dbPath)
})

afterAll(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('import pipeline', () => {
  it('indexes the fixture with full raw counts (nothing silently dropped)', () => {
    const summary = getSummary(db)
    expect(summary.fileCount).toBe(1)
    expect(summary.trackCount).toBe(10)
    expect(summary.segmentCount).toBe(11)
    expect(summary.pointCount).toBe(50)
    expect(summary.waypointCount).toBe(3)
    expect(summary.startTsMs).toBe(Date.parse('2000-01-03T08:00:00Z'))
  })

  it('labels the file with its ISO week from the filename', () => {
    const row = db.prepare('SELECT iso_year, iso_week, status FROM imported_files').get() as {
      iso_year: number
      iso_week: number
      status: string
    }
    expect(row.status).toBe('imported')
    expect(row.iso_year).toBe(2000)
    expect(row.iso_week).toBe(1)
  })

  it('skips already-imported files by content hash', async () => {
    const events: ImportProgress[] = []
    const stats = await runImport({ dbPath, paths: [FIXTURE], onProgress: (p) => events.push(p) })
    expect(stats.filesSkipped).toBe(1)
    expect(stats.filesProcessed).toBe(0)
    const fileEvent = events.find((e) => e.kind === 'file')
    expect(fileEvent && fileEvent.kind === 'file' && fileEvent.skipped).toBe(true)
    expect(getSummary(db).pointCount).toBe(50) // unchanged
  })

  it('flags rather than deletes suspicious points', () => {
    const flagged = db.prepare(
      'SELECT flags, lat FROM points WHERE flags != 0 ORDER BY flags'
    ).all() as Array<{ flags: number; lat: number | null }>
    const byFlag = (f: number): number => flagged.filter((r) => r.flags === f).length
    expect(byFlag(POINT_FLAG_INVALID_COORD)).toBe(1) // cycling lat=95
    expect(byFlag(POINT_FLAG_DUPLICATE)).toBe(1) // car duplicate
    expect(byFlag(POINT_FLAG_SPEED_SPIKE)).toBe(2) // metro teleport + bogus-track jump
  })

  it('registers unknown categories with generated colors and ignores bogus', () => {
    const cats = getCategories(db)
    const names = new Map(cats.map((c) => [c.name, c]))
    expect(names.get('hovercraft')?.color).toMatch(/^(#|hsl)/)
    expect(names.get('bogus')?.ignored).toBe(true)
    expect(names.get('walking')?.ignored).toBe(false)
  })
})

describe('viewport queries', () => {
  it('returns display geometry for clean segments, excluding ignored/bogus and empty ones', () => {
    const { rows, truncated } = queryViewportSegments(db, VIEWPORT_ALL, LIMITS)
    expect(truncated).toBe(false)
    // 11 segments − bogus (ignored) − empty walking segment (no geometry) = 9
    expect(rows).toHaveLength(9)
    expect(rows.map((r) => r.type)).not.toContain('bogus')
  })

  it('excludes flagged points from display geometry (teleport spike gone)', () => {
    const { rows } = queryViewportSegments(db, VIEWPORT_ALL, LIMITS)
    const metro = rows.find((r) => r.type === 'metro')!
    const coords = coordsView(metro)
    for (let i = 1; i < coords.length; i += 2) {
      expect(Math.abs(coords[i]!)).toBeLessThan(0.1) // spike at lat 0.5 excluded
    }
    // 5 raw points − 1 spike = 4 clean; simplification may keep ≤ 4.
    expect(metro.point_count).toBeGreaterThanOrEqual(2)
    expect(metro.point_count).toBeLessThanOrEqual(4)
  })

  it('serves coarser geometry at low zoom', () => {
    const low = queryViewportSegments(db, { ...VIEWPORT_ALL, zoom: 3 }, LIMITS)
    expect(low.detail).toBe(0)
    const high = queryViewportSegments(db, VIEWPORT_ALL, LIMITS)
    expect(high.detail).toBe(2)
    expect(totalPoints(low.rows)).toBeLessThanOrEqual(totalPoints(high.rows))
  })

  it('filters by time range', () => {
    const jan4 = queryViewportSegments(
      db,
      {
        ...VIEWPORT_ALL,
        startTsMs: Date.parse('2000-01-04T00:00:00Z'),
        endTsMs: Date.parse('2000-01-05T00:00:00Z')
      },
      LIMITS
    )
    // Only bus, cycling, and hovercraft are on Jan 4.
    expect(jan4.rows.map((r) => r.type).sort()).toEqual(['bus', 'cycling', 'hovercraft'])

    const nothing = queryViewportSegments(
      db,
      { ...VIEWPORT_ALL, startTsMs: Date.parse('2001-01-01T00:00:00Z'), endTsMs: null },
      LIMITS
    )
    expect(nothing.rows).toHaveLength(0)
  })

  it('filters by bounding box', () => {
    const offWorld = queryViewportSegments(
      db,
      { ...VIEWPORT_ALL, minLat: 50, maxLat: 60, minLon: 50, maxLon: 60 },
      LIMITS
    )
    expect(offWorld.rows).toHaveLength(0)
  })

  it('returns waypoints in the viewport', () => {
    const { waypoints, totalCount } = queryViewportWaypoints(db, VIEWPORT_ALL, 100)
    expect(waypoints).toHaveLength(3)
    expect(totalCount).toBe(3)
    expect(waypoints.map((w) => w.name)).toContain('Synthetic Place Alpha')
  })

  it('truncates biggest-geometry-first when the segment safety cap is hit', () => {
    const full = queryViewportSegments(db, VIEWPORT_ALL, LIMITS).rows
    const { rows, truncated } = queryViewportSegments(db, VIEWPORT_ALL, { ...LIMITS, segments: 2 })
    expect(rows).toHaveLength(2)
    expect(truncated).toBe(true)
    // The valve sheds point-dust, not whole eras: keeps the largest rows,
    // deterministically (never an arbitrary chronological prefix).
    const expected = [...full]
      .sort((a, b) => b.point_count - a.point_count || a.id - b.id)
      .slice(0, 2)
      .map((r) => r.id)
    expect(rows.map((r) => r.id)).toEqual(expected)
  })
})

describe('detail modes and point budget', () => {
  it('pins a fixed detail level regardless of zoom', () => {
    const pinned = queryViewportSegments(db, { ...VIEWPORT_ALL, zoom: 3, detailMode: 'high' }, LIMITS)
    expect(pinned.detail).toBe(2)
    const auto = queryViewportSegments(db, { ...VIEWPORT_ALL, zoom: 3 }, LIMITS)
    expect(auto.detail).toBe(0)
  })

  it("serves every clean raw point in 'all' mode, still excluding flagged/ignored data", () => {
    const raw = queryViewportSegments(db, { ...VIEWPORT_ALL, detailMode: 'all' }, LIMITS)
    expect(raw.detail).toBe('raw')
    expect(raw.downsampleStride).toBe(1)
    expect(raw.rows).toHaveLength(9) // same drawable segments as display geometry
    expect(raw.rows.map((r) => r.type)).not.toContain('bogus')
    // 46 clean points in the fixture minus the ignored bogus track's 1.
    expect(totalPoints(raw.rows)).toBe(45)

    const metro = raw.rows.find((r) => r.type === 'metro')!
    expect(metro.point_count).toBe(4) // 5 raw − teleport spike
    const coords = coordsView(metro)
    for (let i = 1; i < coords.length; i += 2) {
      expect(Math.abs(coords[i]!)).toBeLessThan(0.1)
    }

    // Strictly more than the finest precomputed level (collinear runs restored).
    const high = queryViewportSegments(db, VIEWPORT_ALL, LIMITS)
    expect(totalPoints(raw.rows)).toBeGreaterThan(totalPoints(high.rows))
  })

  it('downsamples lines over the point budget instead of dropping routes', () => {
    const thin = queryViewportSegments(
      db, { ...VIEWPORT_ALL, detailMode: 'all' }, { segments: 1000, points: 20 }
    )
    expect(thin.truncated).toBe(false)
    expect(thin.rows).toHaveLength(9) // every route still present
    expect(thin.downsampleStride).toBe(3) // ceil(45 / 20)
    expect(totalPoints(thin.rows)).toBeLessThan(45)
    for (const row of thin.rows) {
      expect(row.point_count).toBeGreaterThanOrEqual(2)
    }
  })

  it('keeps line endpoints when downsampling', () => {
    const full = queryViewportSegments(db, { ...VIEWPORT_ALL, detailMode: 'all' }, LIMITS)
    const thin = queryViewportSegments(
      db, { ...VIEWPORT_ALL, detailMode: 'all' }, { segments: 1000, points: 20 }
    )
    for (const row of thin.rows) {
      const a = coordsView(row)
      const b = coordsView(full.rows.find((r) => r.id === row.id)!)
      expect([a[0], a[1]]).toEqual([b[0], b[1]])
      expect([a[a.length - 2], a[a.length - 1]]).toEqual([b[b.length - 2], b[b.length - 1]])
    }
  })

  it('auto mode steps down to a coarser level before thinning', () => {
    const tiny = queryViewportSegments(db, VIEWPORT_ALL, { segments: 1000, points: 10 })
    expect(tiny.detail).toBe(0) // stepped down from zoom-implied 2
    expect(tiny.downsampleStride).toBeGreaterThan(1) // still over budget at 0
    expect(tiny.rows).toHaveLength(9) // no route went missing
  })

  it('pinned modes keep their level and rely on thinning alone', () => {
    const pinned = queryViewportSegments(
      db, { ...VIEWPORT_ALL, detailMode: 'high' }, { segments: 1000, points: 10 }
    )
    expect(pinned.detail).toBe(2)
    expect(pinned.downsampleStride).toBeGreaterThan(1)
    expect(pinned.rows).toHaveLength(9)
  })
})

describe('data bounds', () => {
  it('computes bounds from clean points only (spike and invalid excluded)', () => {
    const b = getDataBounds(db)!
    expect(b).not.toBeNull()
    expect(b.maxLat).toBeLessThan(0.05) // metro spike (0.5) and lat=95 excluded
    expect(b.minLat).toBeGreaterThan(0)
  })
})

describe('category draw order', () => {
  it('persists an explicit type order ahead of prominence ordering', () => {
    const activeNames = (): string[] =>
      getCategories(db)
        .filter((c) => !c.ignored && c.segmentCount > 0)
        .map((c) => c.name)
    const reversed = [...activeNames()].reverse()
    setCategoryOrder(db, reversed)
    expect(activeNames()).toEqual(reversed)
    // Never-ordered categories (NULL priority) stay after the ordered ones.
    const all = getCategories(db).filter((c) => !c.ignored)
    const lastOrdered = Math.max(...reversed.map((n) => all.findIndex((c) => c.name === n)))
    expect(lastOrdered).toBe(reversed.length - 1)
  })
})

// Keep last: reopens the shared db handle.
describe('category colors', () => {
  it('mode family colors: car+taxi de-emphasized grey, kayaking with boat, airplane unique', () => {
    const cats = new Map(getCategories(db).map((c) => [c.name, c.color]))
    expect(cats.get('car')).toBe(KNOWN_CATEGORY_COLORS.car)
    expect(KNOWN_CATEGORY_COLORS.car).toBe('#d1d5db') // eco de-emphasis: grey, not warm
    expect(KNOWN_CATEGORY_COLORS.taxi).toBe('#cbd5e1') // grey family beside car
    expect(KNOWN_CATEGORY_COLORS.kayaking).toBe('#7dd3fc') // water family beside boat
    expect(cats.get('bus')).toBe(KNOWN_CATEGORY_COLORS.bus)
    // Airplane's red is reserved: no other known category may use it.
    const reds = Object.entries(KNOWN_CATEGORY_COLORS)
      .filter(([, color]) => color === KNOWN_CATEGORY_COLORS.airplane)
      .map(([name]) => name)
    expect(reds).toEqual(['airplane'])
  })

  it('preserves generated colors for categories the palette does not know', () => {
    const hover = getCategories(db).find((c) => c.name === 'hovercraft')
    expect(hover?.color).toBe(colorForCategory('hovercraft'))
  })

  it('refreshes stale known-category colors on open (existing databases)', () => {
    db.prepare("UPDATE categories SET color = '#60a5fa' WHERE name = 'car'").run()
    db.close()
    db = openDb(dbPath)
    const car = getCategories(db).find((c) => c.name === 'car')
    expect(car?.color).toBe(KNOWN_CATEGORY_COLORS.car)
  })

  it('keeps user-customized colors across reopen, and reset restores the default', () => {
    setCategoryColor(db, 'car', '#123abc')
    db.close()
    db = openDb(dbPath) // palette refresh must not clobber a custom color
    let car = getCategories(db).find((c) => c.name === 'car')!
    expect(car.color).toBe('#123abc')
    expect(car.custom).toBe(true)

    setCategoryColor(db, 'car', null)
    car = getCategories(db).find((c) => c.name === 'car')!
    expect(car.color).toBe(KNOWN_CATEGORY_COLORS.car)
    expect(car.custom).toBe(false)
  })

  it('rejects malformed colors (picker only ever sends hex)', () => {
    setCategoryColor(db, 'car', 'red; DROP TABLE categories')
    expect(getCategories(db).find((c) => c.name === 'car')!.color).toBe(
      KNOWN_CATEGORY_COLORS.car
    )
  })
})
