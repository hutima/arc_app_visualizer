/**
 * Persistent place operations, the waypoint-side counterpart to editStore's
 * track operations.
 *
 * A "place" is the pin the map draws for a set of stationary visits. Most are
 * implicit — a name+proximity cluster of `waypoints` (see placeCluster) — and
 * have no row of their own. The user can promote/combine these into an explicit
 * `places` row with a chosen name; member visits then carry its `place_id`,
 * which overrides the display-time clustering so far-apart or differently-named
 * visits render (and count) as one place.
 *
 * Operations:
 * - mergePlaces: combine several places under one name. Non-destructive — only
 *   regroups visits (sets place_id); no waypoint is removed, so re-merging
 *   undoes it.
 * - assignTrackToPlace: reinterpret a track as a stationary stay — add one
 *   visit at its centroid to the place, then delete the track. Permanent and
 *   structural, like a track merge/split.
 * - getPlaceStats: a place's visit count and time-of-day / day-of-week / yearly
 *   histograms, for the Stats tab.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { PlaceMember, PlaceRef, PlaceStats, YearCount } from '../../shared/types'
import { clusterByProximity } from './placeCluster'
import { deleteSegmentData, prepareEffectivePoints } from './editStore'

/**
 * Visit-level outlier flagging for the place-detail editor. A visit is far
 * enough to suggest excluding it when its distance from the place centroid
 * clears an absolute floor AND a robust multiple of the members' median
 * distance. Judged per *visit* (one dot each), never per GPS point, so ordinary
 * indoor location scatter inside a stay never trips it.
 */
const PLACE_OUTLIER_FACTOR = 3
const PLACE_OUTLIER_FLOOR_M = 150

/** One visit of a place, with what the stats and centroid need. */
interface MemberRow {
  id: number
  lat: number
  lon: number
  tsMs: number | null
  name: string | null
}

/** A place resolved from a ref: its identity, name, and member visits. */
export interface ResolvedPlace {
  /** Set when the place is an explicit `places` row; null for a name cluster. */
  placeId: number | null
  name: string | null
  members: MemberRow[]
}

const membersByPlaceId = (db: DatabaseSync, placeId: number): MemberRow[] =>
  db.prepare(
    'SELECT id, lat, lon, ts_ms AS tsMs, name FROM waypoints WHERE place_id = ?'
  ).all(placeId) as unknown as MemberRow[]

/**
 * Resolve a place reference to its members. A `placeId` ref reads the explicit
 * group; a `waypointId` ref resolves to whatever that visit belongs to — its
 * `place_id` group if merged, else (for a named visit) the name+proximity
 * cluster it sits in, recovered exactly as the renderer draws it, else (unnamed)
 * the lone visit. Returns null if nothing resolves (e.g. an orphaned place).
 */
export function resolvePlace(db: DatabaseSync, ref: PlaceRef): ResolvedPlace | null {
  if ('placeId' in ref) {
    if (!Number.isInteger(ref.placeId)) return null
    const nameRow = db.prepare('SELECT name FROM places WHERE id = ?').get(ref.placeId) as
      | { name: string }
      | undefined
    const members = membersByPlaceId(db, ref.placeId)
    if (members.length === 0) return null
    return { placeId: ref.placeId, name: nameRow?.name ?? null, members }
  }

  if (!Number.isInteger(ref.waypointId)) return null
  const wp = db.prepare(
    'SELECT id, lat, lon, ts_ms AS tsMs, name, place_id AS placeId FROM waypoints WHERE id = ?'
  ).get(ref.waypointId) as (MemberRow & { placeId: number | null }) | undefined
  if (!wp) return null
  if (wp.placeId != null) return resolvePlace(db, { placeId: wp.placeId })
  if (!wp.name) {
    return { placeId: null, name: null, members: [stripPlace(wp)] }
  }
  // Recover the name cluster containing this visit from all un-merged visits of
  // the same name (same primitive the renderer uses, so membership matches).
  const sameName = db.prepare(
    'SELECT id, lat, lon, ts_ms AS tsMs, name FROM waypoints WHERE name = ? AND place_id IS NULL'
  ).all(wp.name) as unknown as MemberRow[]
  for (const cluster of clusterByProximity(sameName)) {
    if (cluster.some((m) => m.id === wp.id)) {
      return { placeId: null, name: wp.name, members: cluster }
    }
  }
  return { placeId: null, name: wp.name, members: [stripPlace(wp)] }
}

const stripPlace = (wp: MemberRow): MemberRow => ({
  id: wp.id, lat: wp.lat, lon: wp.lon, tsMs: wp.tsMs, name: wp.name
})

/** A place's distinct identity, for de-duping a merge selection. */
const placeIdentity = (p: ResolvedPlace): string =>
  p.placeId != null ? `p:${p.placeId}` : `w:${Math.min(...p.members.map((m) => m.id))}`

/**
 * Merge the referenced places into one with `name`. Reuses the lowest existing
 * `places` id when any of them is already explicit (so its members keep their
 * id), else mints a new one; every member visit is pointed at it and orphaned
 * place rows are pruned. Returns the surviving place id.
 */
export function mergePlaces(db: DatabaseSync, refs: PlaceRef[], name: string): number {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (trimmed.length === 0) throw new Error('a merged place needs a name')
  const distinct = new Map<string, ResolvedPlace>()
  for (const ref of refs) {
    const p = resolvePlace(db, ref)
    if (p) distinct.set(placeIdentity(p), p)
  }
  if (distinct.size < 2) throw new Error('merge needs at least two distinct places')

  const memberIds = new Set<number>()
  const existingPlaceIds = new Set<number>()
  for (const p of distinct.values()) {
    for (const m of p.members) memberIds.add(m.id)
    if (p.placeId != null) existingPlaceIds.add(p.placeId)
  }

  db.exec('BEGIN')
  try {
    let targetId: number
    if (existingPlaceIds.size > 0) {
      targetId = Math.min(...existingPlaceIds)
      db.prepare('UPDATE places SET name = ? WHERE id = ?').run(trimmed, targetId)
    } else {
      targetId = Number(db.prepare('INSERT INTO places (name) VALUES (?)').run(trimmed).lastInsertRowid)
    }
    const setPlace = db.prepare('UPDATE waypoints SET place_id = ? WHERE id = ?')
    for (const id of memberIds) setPlace.run(targetId, id)
    pruneOrphanPlaces(db)
    db.exec('COMMIT')
    return targetId
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** Delete `places` rows no visit points at anymore (e.g. after a merge). */
function pruneOrphanPlaces(db: DatabaseSync): void {
  db.exec(
    'DELETE FROM places WHERE id NOT IN (SELECT place_id FROM waypoints WHERE place_id IS NOT NULL)'
  )
}

/**
 * Rename a place. An explicit place just updates its `places` row; an implicit
 * name+proximity cluster is materialized into an explicit place first (its
 * members take the new place_id, like a one-place merge) so the chosen name
 * sticks regardless of the per-visit names. Returns the place id.
 */
export function renamePlace(db: DatabaseSync, ref: PlaceRef, name: string): number {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (trimmed.length === 0) throw new Error('a place needs a name')
  const place = resolvePlace(db, ref)
  if (!place) throw new Error('unknown place')

  db.exec('BEGIN')
  try {
    let placeId = place.placeId
    if (placeId == null) {
      placeId = Number(db.prepare('INSERT INTO places (name) VALUES (?)').run(trimmed).lastInsertRowid)
      const setPlace = db.prepare('UPDATE waypoints SET place_id = ? WHERE id = ?')
      for (const m of place.members) setPlace.run(placeId, m.id)
    } else {
      db.prepare('UPDATE places SET name = ? WHERE id = ?').run(trimmed, placeId)
    }
    db.exec('COMMIT')
    return placeId
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/**
 * Separate visits out of their place into standalone **unnamed** sites: clear
 * both their `place_id` and `name` so each becomes its own pin that won't
 * re-cluster (unnamed visits never group, and clearing the name also detaches
 * it from a same-name proximity cluster). Used to drop a centroid-dragging
 * outlier — the visit's location is likely real but was joined to the wrong
 * site. The location is preserved (no visit deleted) and orphaned `places` rows
 * are pruned; re-merge a separated visit into the right place to re-home it.
 */
export function separateVisits(db: DatabaseSync, visitIds: number[]): void {
  const ids = [...new Set(visitIds)].filter((id) => Number.isInteger(id))
  if (ids.length === 0) throw new Error('no visits to separate')
  db.exec('BEGIN')
  try {
    const detach = db.prepare('UPDATE waypoints SET place_id = NULL, name = NULL WHERE id = ?')
    for (const id of ids) detach.run(id)
    pruneOrphanPlaces(db)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/**
 * A place's visits for the detail editor, each tagged with its distance from
 * the place's center and whether that makes it a visit-level outlier (an
 * exclusion candidate). Sorted farthest-first so the candidates lead.
 *
 * The center and threshold are deliberately **robust** (component-wise median
 * location, distance vs. a multiple of the median distance): the whole point is
 * to find the few visits dragging the *mean* centroid off, so the reference
 * must not itself be dragged by them. Judged per visit, not per GPS point.
 */
export function getPlaceMembers(db: DatabaseSync, ref: PlaceRef): PlaceMember[] | null {
  const place = resolvePlace(db, ref)
  if (!place) return null
  const { members } = place
  if (members.length === 0) return []

  const median = (vals: number[]): number => {
    const s = [...vals].sort((a, b) => a - b)
    const mid = s.length >> 1
    return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
  }
  const cLat = median(members.map((m) => m.lat))
  const cLon = median(members.map((m) => m.lon))
  const cosLat = Math.cos((cLat * Math.PI) / 180)
  // Equirectangular metres — fine at a single place's scale.
  const metresFrom = (lat: number, lon: number): number =>
    Math.hypot((lon - cLon) * cosLat * 111320, (lat - cLat) * 110540)

  const withDist = members.map((m) => ({ m, distM: metresFrom(m.lat, m.lon) }))
  const threshold = Math.max(
    PLACE_OUTLIER_FLOOR_M,
    PLACE_OUTLIER_FACTOR * median(withDist.map((d) => d.distM))
  )

  return withDist
    .map(({ m, distM }) => ({
      id: m.id,
      name: m.name,
      tsMs: m.tsMs,
      lat: m.lat,
      lon: m.lon,
      distM,
      outlier: distM > threshold
    }))
    .sort((a, b) => b.distM - a.distM)
}

/**
 * Reinterpret a track as a stationary stay at `ref`: add one visit at the
 * track's centroid (timestamped at its start) to the place, then delete the
 * track. If the target is still an implicit name cluster, it's materialized as
 * an explicit place first so the new visit joins it regardless of distance.
 */
export function assignTrackToPlace(db: DatabaseSync, segmentId: number, ref: PlaceRef): void {
  const seg = db.prepare(
    'SELECT file_id AS fileId, start_ts_ms AS startTsMs FROM segments WHERE id = ?'
  ).get(segmentId) as { fileId: number; startTsMs: number | null } | undefined
  if (!seg) throw new Error(`unknown segment ${segmentId}`)
  const place = resolvePlace(db, ref)
  if (!place) throw new Error('unknown place')

  const pts = prepareEffectivePoints(db)(segmentId)
  if (pts.length === 0) throw new Error('track has no points to place')
  let latSum = 0
  let lonSum = 0
  for (const p of pts) {
    latSum += p.lat
    lonSum += p.lon
  }
  const lat = latSum / pts.length
  const lon = lonSum / pts.length

  db.exec('BEGIN')
  try {
    let placeId = place.placeId
    if (placeId == null) {
      placeId = Number(
        db.prepare('INSERT INTO places (name) VALUES (?)').run(place.name ?? '').lastInsertRowid
      )
      const setPlace = db.prepare('UPDATE waypoints SET place_id = ? WHERE id = ?')
      for (const m of place.members) setPlace.run(placeId, m.id)
    }
    db.prepare(
      'INSERT INTO waypoints (file_id, name, ts_ms, lat, lon, place_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(seg.fileId, place.name ?? null, seg.startTsMs, lat, lon, placeId)
    deleteSegmentData(db, segmentId)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/**
 * Visit stats for one place: count, first/last visit, and local-time
 * histograms (hour-of-day, day-of-week, by year). Local time on purpose — the
 * question is "when in *my* day/week do I go here". Undated visits still count
 * toward the total but not the time histograms.
 */
export function getPlaceStats(db: DatabaseSync, ref: PlaceRef): PlaceStats | null {
  const place = resolvePlace(db, ref)
  if (!place) return null
  const { members } = place
  let latSum = 0
  let lonSum = 0
  let firstTsMs: number | null = null
  let lastTsMs: number | null = null
  const hourCounts = new Array<number>(24).fill(0)
  const dowCounts = new Array<number>(7).fill(0)
  const yearMap = new Map<number, number>()
  for (const m of members) {
    latSum += m.lat
    lonSum += m.lon
    if (m.tsMs == null) continue
    if (firstTsMs === null || m.tsMs < firstTsMs) firstTsMs = m.tsMs
    if (lastTsMs === null || m.tsMs > lastTsMs) lastTsMs = m.tsMs
    const d = new Date(m.tsMs)
    const h = d.getHours()
    const w = d.getDay()
    hourCounts[h] = hourCounts[h]! + 1
    dowCounts[w] = dowCounts[w]! + 1
    const y = d.getFullYear()
    yearMap.set(y, (yearMap.get(y) ?? 0) + 1)
  }
  const yearCounts: YearCount[] = [...yearMap.entries()]
    .map(([year, count]) => ({ year, count }))
    .sort((a, b) => a.year - b.year)
  return {
    placeId: place.placeId,
    name: place.name,
    lat: latSum / members.length,
    lon: lonSum / members.length,
    visitCount: members.length,
    firstTsMs,
    lastTsMs,
    hourCounts,
    dowCounts,
    yearCounts
  }
}
