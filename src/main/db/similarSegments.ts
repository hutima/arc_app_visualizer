/**
 * Find tracks "similar" to an anchor track, for bulk cleaning (e.g. a commute
 * logged hundreds of times). Always the same activity type and *direction
 * aware* — a candidate's start must match the anchor's start and its end the
 * anchor's end, so a reverse trip never matches.
 */
import type { DatabaseSync } from 'node:sqlite'
import { haversineMeters } from '../../shared/geo'
import type { SimilarMode } from '../../shared/types'

export type { SimilarMode }

interface Pt {
  lat: number
  lon: number
}

const M_PER_DEG = 111320

const CLEAN_WHERE = 'segment_id = ? AND flags = 0 AND lat IS NOT NULL AND lon IS NOT NULL'

/** Prepared statements reused across every candidate (the loop can be large). */
interface PointStmts {
  first: ReturnType<DatabaseSync['prepare']>
  last: ReturnType<DatabaseSync['prepare']>
  all: ReturnType<DatabaseSync['prepare']>
}

function preparePointStmts(db: DatabaseSync): PointStmts {
  const base = `SELECT lat, lon FROM points WHERE ${CLEAN_WHERE} ORDER BY seq`
  return {
    first: db.prepare(`${base} LIMIT 1`),
    last: db.prepare(`${base} DESC LIMIT 1`),
    all: db.prepare(base)
  }
}

function firstLastClean(stmts: PointStmts, segId: number): { start: Pt; end: Pt } | null {
  const start = stmts.first.get(segId) as Pt | undefined
  const end = stmts.last.get(segId) as Pt | undefined
  return start && end ? { start, end } : null
}

/** True if `pts` reaches within radius of S and then, later in order, of E. */
function passesThrough(pts: Pt[], S: Pt, E: Pt, near: (p: Pt, q: Pt) => boolean): boolean {
  let i = 0
  while (i < pts.length && !near(pts[i]!, S)) i++
  if (i >= pts.length) return false
  for (let j = i + 1; j < pts.length; j++) if (near(pts[j]!, E)) return true
  return false
}

/** Segment ids similar to the anchor (the anchor itself included), per `mode`. */
export function findSimilarSegments(
  db: DatabaseSync,
  segmentId: number,
  radiusM: number,
  mode: SimilarMode
): number[] {
  const seg = db.prepare('SELECT type FROM segments WHERE id = ?').get(segmentId) as
    | { type: string }
    | undefined
  if (!seg) return []
  const stmts = preparePointStmts(db)
  const anchor = firstLastClean(stmts, segmentId)
  if (!anchor) return []
  const { start: S, end: E } = anchor
  const rDeg = radiusM / M_PER_DEG
  // A degree of longitude shrinks with latitude, so the radius spans more
  // longitude-degrees away from the equator; widen the lon half-width by
  // 1/cos(lat) or the prefilter box is too narrow and drops valid candidates.
  const lonPad = (lat: number): number => rDeg / Math.max(0.05, Math.cos((lat * Math.PI) / 180))

  // Coarse, indexed prefilter: same type, bbox reaching within the radius of
  // BOTH endpoints — a necessary (superset) condition for either mode. The
  // precise haversine checks below winnow the candidates.
  const cands = db.prepare(`
    SELECT id FROM segments
    WHERE type = ?
      AND max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?
      AND max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?
  `).all(
    seg.type,
    S.lat - rDeg, S.lat + rDeg, S.lon - lonPad(S.lat), S.lon + lonPad(S.lat),
    E.lat - rDeg, E.lat + rDeg, E.lon - lonPad(E.lat), E.lon + lonPad(E.lat)
  ) as Array<{ id: number }>

  const near = (p: Pt, q: Pt): boolean => haversineMeters(p.lat, p.lon, q.lat, q.lon) <= radiusM
  const result: number[] = []
  for (const c of cands) {
    if (mode === 'endpoints') {
      const ep = c.id === segmentId ? anchor : firstLastClean(stmts, c.id)
      if (ep && near(ep.start, S) && near(ep.end, E)) result.push(c.id)
    } else if (passesThrough(stmts.all.all(c.id) as unknown as Pt[], S, E, near)) {
      result.push(c.id)
    }
  }
  return result
}
