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
  getSummary,
  getDataBounds
} from '../src/main/db/queries'
import {
  POINT_FLAG_DUPLICATE,
  POINT_FLAG_INVALID_COORD,
  POINT_FLAG_SPEED_SPIKE
} from '../src/main/importer/clean'
import type { ImportProgress, ViewportQuery } from '../src/shared/types'

const FIXTURE = fileURLToPath(new URL('../fixtures/2000-W01-synthetic.gpx', import.meta.url))

const VIEWPORT_ALL: ViewportQuery = {
  minLat: -1, maxLat: 1, minLon: -1, maxLon: 1,
  zoom: 14, // detail 2
  startTsMs: null,
  endTsMs: null
}

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
    const { rows, truncated } = queryViewportSegments(db, VIEWPORT_ALL, 1000)
    expect(truncated).toBe(false)
    // 11 segments − bogus (ignored) − empty walking segment (no geometry) = 9
    expect(rows).toHaveLength(9)
    expect(rows.map((r) => r.type)).not.toContain('bogus')
  })

  it('excludes flagged points from display geometry (teleport spike gone)', () => {
    const { rows } = queryViewportSegments(db, VIEWPORT_ALL, 1000)
    const metro = rows.find((r) => r.type === 'metro')!
    const coords = new Float32Array(
      metro.coords.buffer.slice(metro.coords.byteOffset, metro.coords.byteOffset + metro.coords.byteLength)
    )
    for (let i = 1; i < coords.length; i += 2) {
      expect(Math.abs(coords[i]!)).toBeLessThan(0.1) // spike at lat 0.5 excluded
    }
    // 5 raw points − 1 spike = 4 clean; simplification may keep ≤ 4.
    expect(metro.point_count).toBeGreaterThanOrEqual(2)
    expect(metro.point_count).toBeLessThanOrEqual(4)
  })

  it('serves coarser geometry at low zoom', () => {
    const low = queryViewportSegments(db, { ...VIEWPORT_ALL, zoom: 3 }, 1000)
    expect(low.detail).toBe(0)
    const high = queryViewportSegments(db, VIEWPORT_ALL, 1000)
    expect(high.detail).toBe(2)
    const sum = (rows: Array<{ point_count: number }>): number =>
      rows.reduce((a, r) => a + r.point_count, 0)
    expect(sum(low.rows)).toBeLessThanOrEqual(sum(high.rows))
  })

  it('filters by time range', () => {
    const jan4 = queryViewportSegments(
      db,
      {
        ...VIEWPORT_ALL,
        startTsMs: Date.parse('2000-01-04T00:00:00Z'),
        endTsMs: Date.parse('2000-01-05T00:00:00Z')
      },
      1000
    )
    // Only bus, cycling, and hovercraft are on Jan 4.
    expect(jan4.rows.map((r) => r.type).sort()).toEqual(['bus', 'cycling', 'hovercraft'])

    const nothing = queryViewportSegments(
      db,
      { ...VIEWPORT_ALL, startTsMs: Date.parse('2001-01-01T00:00:00Z'), endTsMs: null },
      1000
    )
    expect(nothing.rows).toHaveLength(0)
  })

  it('filters by bounding box', () => {
    const offWorld = queryViewportSegments(
      db,
      { ...VIEWPORT_ALL, minLat: 50, maxLat: 60, minLon: 50, maxLon: 60 },
      1000
    )
    expect(offWorld.rows).toHaveLength(0)
  })

  it('returns waypoints in the viewport', () => {
    const wpts = queryViewportWaypoints(db, VIEWPORT_ALL, 100)
    expect(wpts).toHaveLength(3)
    expect(wpts.map((w) => w.name)).toContain('Synthetic Place Alpha')
  })

  it('truncates and reports when the segment limit is hit', () => {
    const { rows, truncated } = queryViewportSegments(db, VIEWPORT_ALL, 2)
    expect(rows).toHaveLength(2)
    expect(truncated).toBe(true)
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
