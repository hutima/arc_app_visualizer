/**
 * Cleaning pass: FLAG suspicious points, never delete them. Raw points are
 * stored with their flags so future rule changes can reprocess everything;
 * only display geometry (built from unflagged points) reflects cleaning.
 */
import { haversineMeters } from '../../shared/geo'
import type { ParsedPoint } from './parseGpx'

export const POINT_FLAG_INVALID_COORD = 1
export const POINT_FLAG_DUPLICATE = 2
export const POINT_FLAG_SPEED_SPIKE = 4
export const POINT_FLAG_TIME_ANOMALY = 8
export const SEGMENT_FLAG_EMPTY = 256

export interface CleaningConfig {
  /** Hard ceiling for types not listed below (m/s). */
  maxSpeedMpsDefault: number
  /**
   * Per-type speed ceilings (m/s), deliberately generous to avoid
   * over-cleaning; the goal is catching teleports, not grading commutes.
   */
  maxSpeedMpsByType: Record<string, number>
}

export const DEFAULT_CLEANING: CleaningConfig = {
  maxSpeedMpsDefault: 300,
  maxSpeedMpsByType: {
    walking: 12,
    running: 18,
    cycling: 30,
    scooter: 30,
    car: 90,
    taxi: 90,
    motorcycle: 90,
    bus: 60,
    tram: 40,
    metro: 50,
    train: 140,
    boat: 45,
    skiing: 50,
    stationary: 30,
    airplane: 400
  }
}

export interface CleanResult {
  /** One flag byte per input point; 0 = clean. */
  flags: Uint8Array
  /** OR of all point flags, plus SEGMENT_FLAG_EMPTY when there are no points. */
  segmentFlags: number
  cleanCount: number
}

function isInvalidCoord(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return true
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return true
  // Exact 0,0 ("Null Island") is a classic GPS failure value.
  if (lat === 0 && lon === 0) return true
  return false
}

export function cleanSegment(
  points: ParsedPoint[],
  type: string,
  cfg: CleaningConfig = DEFAULT_CLEANING
): CleanResult {
  const flags = new Uint8Array(points.length)
  let segmentFlags = points.length === 0 ? SEGMENT_FLAG_EMPTY : 0
  let cleanCount = 0
  const maxSpeed = cfg.maxSpeedMpsByType[type] ?? cfg.maxSpeedMpsDefault

  let lastClean = -1
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!
    let f = 0
    if (isInvalidCoord(p.lat, p.lon)) {
      f = POINT_FLAG_INVALID_COORD
    } else if (lastClean >= 0) {
      const q = points[lastClean]!
      if (p.lat === q.lat && p.lon === q.lon && p.tsMs === q.tsMs) {
        f = POINT_FLAG_DUPLICATE
      } else if (p.tsMs !== null && q.tsMs !== null) {
        const dtSec = (p.tsMs - q.tsMs) / 1000
        const distM = haversineMeters(q.lat, q.lon, p.lat, p.lon)
        if (dtSec < 0) {
          f = POINT_FLAG_TIME_ANOMALY
        } else if (dtSec === 0) {
          // Same timestamp but moved: speed is undefined; flag if it moved
          // further than plausible GPS jitter.
          if (distM > 50) f = POINT_FLAG_TIME_ANOMALY
        } else if (distM / dtSec > maxSpeed) {
          f = POINT_FLAG_SPEED_SPIKE
        }
      }
    }
    flags[i] = f
    segmentFlags |= f
    if (f === 0) {
      lastClean = i
      cleanCount++
    }
  }
  return { flags, segmentFlags, cleanCount }
}
