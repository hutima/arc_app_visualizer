/**
 * User track editing: moved/inserted/deleted vertices stored as an overlay on
 * raw points (`segment_edits`), keyed by seq — moves reuse the raw point's
 * integer seq, inserts take a fractional seq between their neighbors, deletes
 * mark an integer seq for removal — so the overlay merges back
 * deterministically without renumbering anything.
 *
 * Two save modes:
 * - draft: only the overlay changes; raw points stay untouched and a revert
 *   restores the original track exactly.
 * - permanent: the overlay is baked into `points` (renumbered, flagged
 *   points preserved in place) and cleared. The one sanctioned mutation of
 *   raw points, and only ever on the user's explicit request.
 *
 * Splitting a track is a structural permanent change: it commits the overlay
 * and divides the segment's effective points into two segments.
 *
 * Either way the segment's display geometry and bounds are rebuilt and its
 * cached matched geometry is dropped, and `prepareEffectivePoints` is the
 * read path for both display ('all points' mode) and the rail/road match
 * pass — so edits always apply before snapping.
 */
import type { DatabaseSync } from 'node:sqlite'
import { simplifyIndices } from '../importer/simplify'
import { DETAIL_LEVELS } from '../../shared/displayDetail'
import { emptyBounds, extendBounds, boundsValid } from '../../shared/geo'
import {
  MERGE_WINDOW_MS,
  type EditablePoint,
  type EditKind,
  type EditSaveMode,
  type MergeCandidate,
  type SegmentEditInput,
  type SegmentEditState
} from '../../shared/types'

const KIND_MOVE = 0
const KIND_INSERT = 1
const KIND_DELETE = 2

const kindToInt = (kind: EditKind): number =>
  kind === 'insert' ? KIND_INSERT : kind === 'delete' ? KIND_DELETE : KIND_MOVE

export interface CleanPoint {
  seq: number
  lon: number
  lat: number
  tsMs: number | null
}

interface EditRow {
  seq: number
  kind: number
  lat: number
  lon: number
}

/** Raw point row with the columns baking/splitting must preserve. */
interface RawRow {
  seq: number
  tsMs: number | null
  lat: number | null
  lon: number | null
  ele: number | null
  flags: number
}

/** A raw row after the overlay is applied; `inserted` drives ts interpolation. */
interface MergedRow extends RawRow {
  inserted: boolean
}

/**
 * Merge a segment's clean raw points with its edit overlay. A move overrides
 * the point at its seq, a delete drops it, and remaining inserts become new
 * vertices timestamped by interpolation so the matcher's time-plausibility
 * gates keep working on edited rides.
 */
export function applyEdits(points: CleanPoint[], edits: EditRow[]): EditablePoint[] {
  if (edits.length === 0) {
    return points.map((p) => ({ seq: p.seq, lat: p.lat, lon: p.lon, tsMs: p.tsMs, edit: null }))
  }
  const bySeq = new Map(edits.map((e) => [e.seq, e]))
  const out: EditablePoint[] = []
  for (const p of points) {
    const e = bySeq.get(p.seq)
    if (e) {
      bySeq.delete(p.seq)
      if (e.kind === KIND_DELETE) continue
      if (e.kind === KIND_MOVE) {
        out.push({ seq: p.seq, lat: e.lat, lon: e.lon, tsMs: p.tsMs, edit: 'move' })
        continue
      }
    }
    out.push({ seq: p.seq, lat: p.lat, lon: p.lon, tsMs: p.tsMs, edit: null })
  }
  // Anything left is an insert (a stray delete/move on a missing seq is inert).
  for (const e of bySeq.values()) {
    if (e.kind === KIND_INSERT) {
      out.push({ seq: e.seq, lat: e.lat, lon: e.lon, tsMs: null, edit: 'insert' })
    }
  }
  out.sort((a, b) => a.seq - b.seq)
  interpolateInsertTimes(out)
  return out
}

/** Linear seq-weighted timestamps for inserted vertices (null at the fringes). */
function interpolateInsertTimes(pts: EditablePoint[]): void {
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!
    if (p.edit !== 'insert' || p.tsMs !== null) continue
    const ts = lerpTime(pts, i)
    if (ts !== null) p.tsMs = ts
  }
}

/** Interpolate a timestamp at index i from the nearest dated neighbors by seq. */
function lerpTime(
  pts: ReadonlyArray<{ seq: number; tsMs: number | null }>,
  i: number
): number | null {
  let prev: { seq: number; tsMs: number | null } | null = null
  for (let j = i - 1; j >= 0; j--) {
    if (pts[j]!.tsMs !== null) {
      prev = pts[j]!
      break
    }
  }
  let next: { seq: number; tsMs: number | null } | null = null
  for (let j = i + 1; j < pts.length; j++) {
    if (pts[j]!.tsMs !== null) {
      next = pts[j]!
      break
    }
  }
  if (!prev || !next || next.seq === prev.seq) return null
  const f = (pts[i]!.seq - prev.seq) / (next.seq - prev.seq)
  return Math.round(prev.tsMs! + (next.tsMs! - prev.tsMs!) * f)
}

/**
 * Effective-point loader with statements prepared once — callers that loop
 * over many segments (the match pass, raw-detail queries) reuse it.
 */
export function prepareEffectivePoints(
  db: DatabaseSync
): (segmentId: number) => EditablePoint[] {
  const pointsStmt = db.prepare(`
    SELECT seq, lon, lat, ts_ms AS tsMs FROM points
    WHERE segment_id = ? AND flags = 0 AND lat IS NOT NULL AND lon IS NOT NULL
    ORDER BY seq
  `)
  const editsStmt = db.prepare(
    'SELECT seq, kind, lat, lon FROM segment_edits WHERE segment_id = ? ORDER BY seq'
  )
  return (segmentId) => {
    const pts = pointsStmt.all(segmentId) as unknown as CleanPoint[]
    const edits = editsStmt.all(segmentId) as unknown as EditRow[]
    return applyEdits(pts, edits)
  }
}

export function getSegmentEditState(db: DatabaseSync, segmentId: number): SegmentEditState | null {
  const seg = db.prepare('SELECT id, type FROM segments WHERE id = ?').get(segmentId) as
    | { id: number; type: string }
    | undefined
  if (!seg) return null
  const points = prepareEffectivePoints(db)(segmentId)
  const overlay = db
    .prepare('SELECT seq, kind FROM segment_edits WHERE segment_id = ?')
    .all(segmentId) as unknown as Array<{ seq: number; kind: number }>
  const deletedSeqs = overlay.filter((e) => e.kind === KIND_DELETE).map((e) => e.seq)
  return { segmentId, type: seg.type, points, hasDraft: overlay.length > 0, deletedSeqs }
}

function validOverlay(edits: SegmentEditInput[]): boolean {
  return edits.every((e) => {
    if (!Number.isFinite(e.seq)) return false
    if (e.kind === 'delete') return true // coords irrelevant; only the seq matters
    if (e.kind !== 'move' && e.kind !== 'insert') return false
    return (
      Number.isFinite(e.lat) && Math.abs(e.lat) <= 90 &&
      Number.isFinite(e.lon) && Math.abs(e.lon) <= 180
    )
  })
}

const toEditRow = (e: SegmentEditInput): EditRow => ({
  seq: e.seq,
  kind: kindToInt(e.kind),
  lat: e.lat,
  lon: e.lon
})

function loadCleanPoints(db: DatabaseSync, segmentId: number): CleanPoint[] {
  return db.prepare(`
    SELECT seq, lon, lat, ts_ms AS tsMs FROM points
    WHERE segment_id = ? AND flags = 0 AND lat IS NOT NULL AND lon IS NOT NULL
    ORDER BY seq
  `).all(segmentId) as unknown as CleanPoint[]
}

function loadRawRows(db: DatabaseSync, segmentId: number): RawRow[] {
  return db.prepare(`
    SELECT seq, ts_ms AS tsMs, lat, lon, ele, flags FROM points
    WHERE segment_id = ? ORDER BY seq
  `).all(segmentId) as unknown as RawRow[]
}

function loadOverlay(db: DatabaseSync, segmentId: number): EditRow[] {
  return db
    .prepare('SELECT seq, kind, lat, lon FROM segment_edits WHERE segment_id = ?')
    .all(segmentId) as unknown as EditRow[]
}

/**
 * Replace a segment's edit overlay with the given rows (the renderer always
 * sends the complete overlay, so re-saving a re-edited draft round-trips).
 * Rejected if it would leave fewer than two drawable points. Permanent mode
 * then bakes the overlay into the raw points.
 */
export function saveSegmentEdits(
  db: DatabaseSync,
  segmentId: number,
  edits: SegmentEditInput[],
  mode: EditSaveMode
): void {
  if (!validOverlay(edits)) throw new Error('invalid edit payload')
  const seg = db.prepare('SELECT id FROM segments WHERE id = ?').get(segmentId)
  if (!seg) throw new Error(`unknown segment ${segmentId}`)
  // A track must stay drawable: never let edits strand it below two points.
  const effective = applyEdits(loadCleanPoints(db, segmentId), edits.map(toEditRow))
  if (effective.length < 2) throw new Error('edit would leave fewer than 2 points')

  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM segment_edits WHERE segment_id = ?').run(segmentId)
    const ins = db.prepare(
      'INSERT INTO segment_edits (segment_id, seq, kind, lat, lon, edited_at_ms) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const now = Date.now()
    for (const e of edits) ins.run(segmentId, e.seq, kindToInt(e.kind), e.lat, e.lon, now)
    // Permanent baking rewrites points and rebuilds; draft just rebuilds.
    if (mode === 'permanent') bakeEditsIntoPoints(db, segmentId)
    else rebuildDerivedGeometry(db, segmentId)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** Drop the overlay and rebuild derived geometry from the raw points. */
export function revertSegmentEdits(db: DatabaseSync, segmentId: number): void {
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM segment_edits WHERE segment_id = ?').run(segmentId)
    rebuildDerivedGeometry(db, segmentId)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/**
 * Split a segment into two at one of its effective points by seq. The seq must
 * be an original raw point (integer) — the quick shift-click gesture only ever
 * splits at an existing vertex. Both halves keep the original type.
 */
export function splitSegment(db: DatabaseSync, segmentId: number, atSeq: number): number {
  if (!Number.isInteger(atSeq)) throw new Error('split point must be an original track point')
  return performSplit(db, segmentId, atSeq, null, null)
}

/**
 * Precise split: divide a segment at any effective point (raw or a saved
 * inserted vertex, so the slider can land anywhere), optionally giving each
 * half its own activity type. Returns the new (second-half) segment's id.
 */
export function splitSegmentTyped(
  db: DatabaseSync,
  segmentId: number,
  atSeq: number,
  firstType: string,
  secondType: string
): number {
  return performSplit(db, segmentId, atSeq, firstType, secondType)
}

/**
 * The shared split body. The split point belongs to both halves so the lines
 * stay contiguous; the current overlay is committed in the process. A null
 * type leaves that half as the original type; a provided type must be a known
 * category. Effective points (raw + edits, flags + elevation preserved) are
 * partitioned by seq and written to the original (first half) and a new
 * segment (second half).
 */
function performSplit(
  db: DatabaseSync,
  segmentId: number,
  atSeq: number,
  firstType: string | null,
  secondType: string | null
): number {
  const seg = db.prepare('SELECT track_id, file_id, type FROM segments WHERE id = ?').get(segmentId) as
    | { track_id: number; file_id: number; type: string }
    | undefined
  if (!seg) throw new Error(`unknown segment ${segmentId}`)
  const ft = firstType ?? seg.type
  const st = secondType ?? seg.type
  if (firstType !== null && !categoryExists(db, ft)) throw new Error(`unknown type ${ft}`)
  if (secondType !== null && !categoryExists(db, st)) throw new Error(`unknown type ${st}`)

  db.exec('BEGIN')
  try {
    const merged = mergeOverlay(loadRawRows(db, segmentId), loadOverlay(db, segmentId))
    if (!merged.some((r) => r.seq === atSeq)) throw new Error('split point not found')
    // Shared boundary vertex: it ends the first half and starts the second.
    const first = merged.filter((r) => r.seq <= atSeq)
    const second = merged.filter((r) => r.seq >= atSeq)
    if (drawableCount(first) < 2 || drawableCount(second) < 2) {
      throw new Error('split would leave a piece with too few points')
    }
    const newRes = db.prepare(`
      INSERT INTO segments
        (track_id, file_id, type, start_ts_ms, end_ts_ms, point_count, clean_point_count,
         min_lat, min_lon, max_lat, max_lon, flags)
      VALUES (?, ?, ?, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, 0)
    `).run(seg.track_id, seg.file_id, st)
    const newId = Number(newRes.lastInsertRowid)
    if (ft !== seg.type) db.prepare('UPDATE segments SET type = ? WHERE id = ?').run(ft, segmentId)
    writeMergedRows(db, segmentId, first)
    writeMergedRows(db, newId, second)
    db.exec('COMMIT')
    return newId
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

const categoryExists = (db: DatabaseSync, name: string): boolean =>
  db.prepare('SELECT 1 FROM categories WHERE name = ?').get(name) !== undefined

/** True if a segment currently has cached snap/bridge geometry. */
export const hasMatchedGeom = (db: DatabaseSync, segmentId: number): boolean =>
  db.prepare('SELECT 1 FROM rail_matched_geom WHERE segment_id = ? LIMIT 1').get(segmentId) !==
  undefined

const drawableCount = (rows: RawRow[]): number =>
  rows.filter((r) => r.flags === 0 && r.lat !== null && r.lon !== null).length

/** A segment's start time, the reference point when it anchors a merge window. */
export function segmentStartTs(db: DatabaseSync, segmentId: number): number | null {
  const row = db.prepare('SELECT start_ts_ms AS ts FROM segments WHERE id = ?').get(segmentId) as
    | { ts: number | null }
    | undefined
  return row?.ts ?? null
}

/**
 * Tracks within `windowMs` of `anchorTsMs`, chronologically — the candidate
 * sequence for a merge. Undated segments can't be sequenced (excluded), and
 * ignored categories (bogus/unknown) are left out so the list stays useful.
 */
export function listMergeCandidates(
  db: DatabaseSync,
  anchorTsMs: number,
  windowMs: number = MERGE_WINDOW_MS
): MergeCandidate[] {
  return db.prepare(`
    SELECT id AS segmentId, type, start_ts_ms AS startTsMs, end_ts_ms AS endTsMs,
           clean_point_count AS pointCount
    FROM segments
    WHERE start_ts_ms IS NOT NULL AND start_ts_ms BETWEEN ? AND ?
      AND type NOT IN (SELECT name FROM categories WHERE ignored = 1)
    ORDER BY start_ts_ms, id
  `).all(anchorTsMs - windowMs, anchorTsMs + windowMs) as unknown as MergeCandidate[]
}

/**
 * Stitch several segments into one: concatenate their effective points (raw +
 * any edits, flagged points and elevation preserved) in time order, write them
 * to the earliest segment, and delete the rest. The merged track takes `type`
 * — any existing activity type, not only a constituent's. Permanent and
 * structural, like split. Returns the surviving segment's id.
 */
export function mergeSegments(db: DatabaseSync, segmentIds: number[], type: string): number {
  const ids = [...new Set(segmentIds)]
  if (ids.length < 2) throw new Error('merge needs at least two tracks')
  if (typeof type !== 'string' || type.length === 0) throw new Error('invalid merged type')
  if (!categoryExists(db, type)) throw new Error(`unknown type ${type}`)

  const segs = ids.map((id) => {
    const s = db.prepare('SELECT id, type, start_ts_ms AS startTsMs FROM segments WHERE id = ?').get(id) as
      | { id: number; type: string; startTsMs: number | null }
      | undefined
    if (!s) throw new Error(`unknown segment ${id}`)
    return s
  })
  // Chronological order = the order points are stitched; undated sink last.
  segs.sort((a, b) => (a.startTsMs ?? Infinity) - (b.startTsMs ?? Infinity) || a.id - b.id)
  const target = segs[0]!

  db.exec('BEGIN')
  try {
    const all: MergedRow[] = []
    for (const s of segs) {
      all.push(...mergeOverlay(loadRawRows(db, s.id), loadOverlay(db, s.id)))
    }
    for (const s of segs.slice(1)) deleteSegmentData(db, s.id)
    db.prepare('UPDATE segments SET type = ? WHERE id = ?').run(type, target.id)
    // Per-segment seqs collide across the concatenation; writeMergedRows
    // renumbers 0..n-1 by array order, which is already time-sorted here.
    writeMergedRows(db, target.id, all)
    db.exec('COMMIT')
    return target.id
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** Remove every row belonging to a segment (points has no cascade FK). */
function deleteSegmentData(db: DatabaseSync, segmentId: number): void {
  db.prepare('DELETE FROM points WHERE segment_id = ?').run(segmentId)
  db.prepare('DELETE FROM display_geometries WHERE segment_id = ?').run(segmentId)
  db.prepare('DELETE FROM rail_matched_geom WHERE segment_id = ?').run(segmentId)
  db.prepare('DELETE FROM segment_edits WHERE segment_id = ?').run(segmentId)
  db.prepare('DELETE FROM segments WHERE id = ?').run(segmentId)
}

/**
 * Apply the overlay to a segment's raw rows, preserving flags and elevation:
 * moves override coordinates in place, deletes drop the row, inserts are
 * interleaved by their fractional seq with an interpolated timestamp. Result
 * is sorted by seq (not yet renumbered).
 */
function mergeOverlay(raw: RawRow[], overlay: EditRow[]): MergedRow[] {
  const bySeq = new Map(overlay.map((e) => [e.seq, e]))
  const out: MergedRow[] = []
  for (const r of raw) {
    const e = bySeq.get(r.seq)
    if (e) {
      bySeq.delete(r.seq)
      if (e.kind === KIND_DELETE) continue
      if (e.kind === KIND_MOVE) {
        // A user-placed point is clean by definition.
        out.push({ ...r, lat: e.lat, lon: e.lon, flags: 0, inserted: false })
        continue
      }
    }
    out.push({ ...r, inserted: false })
  }
  for (const e of bySeq.values()) {
    if (e.kind === KIND_INSERT) {
      out.push({ seq: e.seq, tsMs: null, lat: e.lat, lon: e.lon, ele: null, flags: 0, inserted: true })
    }
  }
  out.sort((a, b) => a.seq - b.seq)
  for (let i = 0; i < out.length; i++) {
    if (out[i]!.inserted && out[i]!.tsMs === null) out[i]!.tsMs = lerpTime(out, i)
  }
  return out
}

/**
 * Rewrite a segment's points from merged rows: renumber 0..n-1, recompute
 * counts and the timestamp range, clear the overlay, and rebuild derived
 * geometry. Used by both permanent baking and splitting.
 */
function writeMergedRows(db: DatabaseSync, segmentId: number, rows: MergedRow[]): void {
  db.prepare('DELETE FROM points WHERE segment_id = ?').run(segmentId)
  db.prepare('DELETE FROM segment_edits WHERE segment_id = ?').run(segmentId)
  const ins = db.prepare(
    'INSERT INTO points (segment_id, seq, ts_ms, lat, lon, ele, flags) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  rows.forEach((r, i) => ins.run(segmentId, i, r.tsMs, r.lat, r.lon, r.ele, r.flags))

  let cleanCount = 0
  let start: number | null = null
  let end: number | null = null
  for (const r of rows) {
    if (r.flags !== 0 || r.lat === null || r.lon === null) continue
    cleanCount++
    if (r.tsMs === null) continue
    if (start === null || r.tsMs < start) start = r.tsMs
    if (end === null || r.tsMs > end) end = r.tsMs
  }
  db.prepare(
    'UPDATE segments SET point_count = ?, clean_point_count = ?, start_ts_ms = ?, end_ts_ms = ? WHERE id = ?'
  ).run(rows.length, cleanCount, start, end, segmentId)
  rebuildDerivedGeometry(db, segmentId)
}

/**
 * Rewrite the segment's points with the overlay applied (renumbered, flagged
 * points preserved). The one sanctioned raw-point mutation.
 */
function bakeEditsIntoPoints(db: DatabaseSync, segmentId: number): void {
  const overlay = loadOverlay(db, segmentId)
  if (overlay.length === 0) return
  writeMergedRows(db, segmentId, mergeOverlay(loadRawRows(db, segmentId), overlay))
}

/**
 * Rebuild what the viewport pipeline derives from a segment's points: the
 * per-zoom display polylines and the bbox columns (a dragged point may leave
 * the old box, and the bbox gates viewport queries). Cached matched geometry
 * was built from pre-edit points, so it's dropped; the next match pass
 * rebuilds it from the edited line.
 */
function rebuildDerivedGeometry(db: DatabaseSync, segmentId: number): void {
  const effective = prepareEffectivePoints(db)(segmentId)
  db.prepare('DELETE FROM display_geometries WHERE segment_id = ?').run(segmentId)
  db.prepare('DELETE FROM rail_matched_geom WHERE segment_id = ?').run(segmentId)

  if (effective.length >= 2) {
    const lons = new Float64Array(effective.length)
    const lats = new Float64Array(effective.length)
    for (let i = 0; i < effective.length; i++) {
      lons[i] = effective[i]!.lon
      lats[i] = effective[i]!.lat
    }
    const ins = db.prepare(
      'INSERT INTO display_geometries (segment_id, detail, point_count, coords) VALUES (?, ?, ?, ?)'
    )
    for (const level of DETAIL_LEVELS) {
      const kept = simplifyIndices(lons, lats, level.toleranceDeg)
      if (kept.length < 2) continue
      const coords = new Float32Array(kept.length * 2)
      for (let i = 0; i < kept.length; i++) {
        coords[i * 2] = lons[kept[i]!]!
        coords[i * 2 + 1] = lats[kept[i]!]!
      }
      ins.run(segmentId, level.detail, kept.length, new Uint8Array(coords.buffer))
    }
  }

  const b = emptyBounds()
  for (const p of effective) extendBounds(b, p.lat, p.lon)
  const has = boundsValid(b)
  db.prepare('UPDATE segments SET min_lat = ?, min_lon = ?, max_lat = ?, max_lon = ? WHERE id = ?')
    .run(has ? b.minLat : null, has ? b.minLon : null, has ? b.maxLat : null, has ? b.maxLon : null, segmentId)
}
