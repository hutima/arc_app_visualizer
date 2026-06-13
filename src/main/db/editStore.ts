/**
 * User track editing: moved/inserted vertices stored as an overlay on raw
 * points (`segment_edits`), keyed by seq — moves reuse the raw point's
 * integer seq, inserts take a fractional seq between their neighbors, so the
 * overlay merges back deterministically without renumbering anything.
 *
 * Two save modes:
 * - draft: only the overlay changes; raw points stay untouched and a revert
 *   restores the original track exactly.
 * - permanent: the overlay is baked into `points` (renumbered, flagged
 *   points preserved in place) and cleared. The one sanctioned mutation of
 *   raw points, and only ever on the user's explicit request.
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
import type {
  EditablePoint,
  EditSaveMode,
  SegmentEditInput,
  SegmentEditState
} from '../../shared/types'

const KIND_MOVE = 0
const KIND_INSERT = 1

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

/**
 * Merge a segment's clean raw points with its edit overlay. An edit landing
 * exactly on a raw seq overrides that point regardless of its stored kind
 * (defensive — insert seqs are always strictly between existing ones);
 * remaining edits become inserted vertices, timestamped by interpolation so
 * the matcher's time-plausibility gates keep working on edited rides.
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
      out.push({ seq: p.seq, lat: e.lat, lon: e.lon, tsMs: p.tsMs, edit: 'move' })
      bySeq.delete(p.seq)
    } else {
      out.push({ seq: p.seq, lat: p.lat, lon: p.lon, tsMs: p.tsMs, edit: null })
    }
  }
  for (const e of bySeq.values()) {
    out.push({ seq: e.seq, lat: e.lat, lon: e.lon, tsMs: null, edit: 'insert' })
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
    let prev: EditablePoint | null = null
    for (let j = i - 1; j >= 0; j--) {
      if (pts[j]!.tsMs !== null) {
        prev = pts[j]!
        break
      }
    }
    let next: EditablePoint | null = null
    for (let j = i + 1; j < pts.length; j++) {
      if (pts[j]!.tsMs !== null) {
        next = pts[j]!
        break
      }
    }
    if (prev && next && next.seq !== prev.seq) {
      const f = (p.seq - prev.seq) / (next.seq - prev.seq)
      p.tsMs = Math.round(prev.tsMs! + (next.tsMs! - prev.tsMs!) * f)
    }
  }
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
  const draft = db
    .prepare('SELECT COUNT(*) AS n FROM segment_edits WHERE segment_id = ?')
    .get(segmentId) as { n: number }
  return { segmentId, type: seg.type, points, hasDraft: draft.n > 0 }
}

function validOverlay(edits: SegmentEditInput[]): boolean {
  return edits.every(
    (e) =>
      Number.isFinite(e.seq) &&
      Number.isFinite(e.lat) && Math.abs(e.lat) <= 90 &&
      Number.isFinite(e.lon) && Math.abs(e.lon) <= 180 &&
      (e.kind === 'move' || e.kind === 'insert')
  )
}

/**
 * Replace a segment's edit overlay with the given rows (the renderer always
 * sends the complete overlay, so re-saving a re-edited draft round-trips).
 * Permanent mode then bakes the overlay into the raw points.
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
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM segment_edits WHERE segment_id = ?').run(segmentId)
    const ins = db.prepare(
      'INSERT INTO segment_edits (segment_id, seq, kind, lat, lon, edited_at_ms) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const now = Date.now()
    for (const e of edits) {
      ins.run(segmentId, e.seq, e.kind === 'insert' ? KIND_INSERT : KIND_MOVE, e.lat, e.lon, now)
    }
    if (mode === 'permanent') bakeEditsIntoPoints(db, segmentId)
    rebuildDerivedGeometry(db, segmentId)
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
 * Rewrite the segment's points with the overlay applied: moves replace
 * coordinates in place, inserts are interleaved by seq, flagged (cleaned)
 * points survive at their original relative position, and the result is
 * renumbered 0..n-1. Inserted points get the interpolated timestamps the
 * matcher already sees.
 */
function bakeEditsIntoPoints(db: DatabaseSync, segmentId: number): void {
  const overlay = db
    .prepare('SELECT seq, kind, lat, lon FROM segment_edits WHERE segment_id = ?')
    .all(segmentId) as unknown as EditRow[]
  if (overlay.length === 0) return
  const raw = db.prepare(`
    SELECT seq, ts_ms AS tsMs, lat, lon, ele, flags FROM points
    WHERE segment_id = ? ORDER BY seq
  `).all(segmentId) as unknown as Array<{
    seq: number
    tsMs: number | null
    lat: number | null
    lon: number | null
    ele: number | null
    flags: number
  }>

  const clean: CleanPoint[] = []
  for (const r of raw) {
    if (r.flags === 0 && r.lat !== null && r.lon !== null) {
      clean.push({ seq: r.seq, lat: r.lat, lon: r.lon, tsMs: r.tsMs })
    }
  }
  const tsBySeq = new Map(applyEdits(clean, overlay).map((p) => [p.seq, p.tsMs]))

  const bySeq = new Map(overlay.map((e) => [e.seq, e]))
  const merged = raw.map((r) => {
    const e = bySeq.get(r.seq)
    if (!e) return r
    bySeq.delete(r.seq)
    // A user-placed point is clean by definition.
    return { ...r, lat: e.lat, lon: e.lon, flags: 0 }
  })
  for (const e of bySeq.values()) {
    merged.push({ seq: e.seq, tsMs: tsBySeq.get(e.seq) ?? null, lat: e.lat, lon: e.lon, ele: null, flags: 0 })
  }
  merged.sort((a, b) => a.seq - b.seq)

  db.prepare('DELETE FROM points WHERE segment_id = ?').run(segmentId)
  const ins = db.prepare(
    'INSERT INTO points (segment_id, seq, ts_ms, lat, lon, ele, flags) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  merged.forEach((r, i) => ins.run(segmentId, i, r.tsMs, r.lat, r.lon, r.ele, r.flags))
  db.prepare('DELETE FROM segment_edits WHERE segment_id = ?').run(segmentId)
  const cleanCount = merged.filter((r) => r.flags === 0 && r.lat !== null && r.lon !== null).length
  db.prepare('UPDATE segments SET point_count = ?, clean_point_count = ? WHERE id = ?')
    .run(merged.length, cleanCount, segmentId)
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
