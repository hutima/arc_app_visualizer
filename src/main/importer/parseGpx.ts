/**
 * Arc Timeline GPX parsing. Schema documented in docs/arc-gpx-schema.md:
 *   gpx > trk > (name, type, trkseg > trkpt[lat,lon] > (ele, time))
 *   gpx > wpt[lat,lon] > (time, name)
 *
 * Tolerant of messy real-world exports: empty trksegs, multi-trkseg tracks,
 * missing ele/time, unparsable coordinates (kept as NaN so the cleaning pass
 * can flag rather than silently drop them).
 */
import { XMLParser } from 'fast-xml-parser'

export interface ParsedPoint {
  /** NaN when the source value was missing/unparsable — flagged by cleaning. */
  lat: number
  lon: number
  tsMs: number | null
  ele: number | null
}

export interface ParsedTrack {
  name: string | null
  type: string
  segments: ParsedPoint[][]
}

export interface ParsedWaypoint {
  lat: number
  lon: number
  tsMs: number | null
  name: string | null
}

export interface ParsedGpx {
  tracks: ParsedTrack[]
  waypoints: ParsedWaypoint[]
}

const ARRAY_TAGS = new Set(['trk', 'trkseg', 'trkpt', 'wpt'])

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (tagName) => ARRAY_TAGS.has(tagName),
  // Keep values as strings; numeric/timestamp coercion is done explicitly so
  // odd values become NaN/null instead of surprising auto-conversions.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true
})

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v : [v]
}

function toNumber(v: unknown): number {
  if (typeof v !== 'string' || v === '') return NaN
  return Number(v)
}

function toNumberOrNull(v: unknown): number | null {
  const n = toNumber(v)
  return Number.isFinite(n) ? n : null
}

function toTimestampMs(v: unknown): number | null {
  if (typeof v !== 'string' || v === '') return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

function toText(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

interface XmlNode {
  [key: string]: unknown
}

function parsePoint(pt: XmlNode): ParsedPoint {
  return {
    lat: toNumber(pt['@_lat']),
    lon: toNumber(pt['@_lon']),
    tsMs: toTimestampMs(pt['time']),
    ele: toNumberOrNull(pt['ele'])
  }
}

export function parseGpx(xml: string): ParsedGpx {
  const doc = parser.parse(xml) as XmlNode
  const gpx = doc['gpx'] as XmlNode | undefined
  if (!gpx || typeof gpx !== 'object') {
    throw new Error('not a GPX document: missing <gpx> root')
  }

  const tracks: ParsedTrack[] = []
  for (const trk of asArray(gpx['trk'] as XmlNode | XmlNode[] | undefined)) {
    if (!trk || typeof trk !== 'object') continue
    const segments: ParsedPoint[][] = []
    for (const seg of asArray(trk['trkseg'])) {
      // An empty <trkseg> parses as "" — normalize to an empty segment.
      if (!seg || typeof seg !== 'object') {
        segments.push([])
        continue
      }
      const pts = asArray((seg as XmlNode)['trkpt']).filter(
        (p): p is XmlNode => !!p && typeof p === 'object'
      )
      segments.push(pts.map(parsePoint))
    }
    const rawType = toText(trk['type'])
    tracks.push({
      name: toText(trk['name']),
      type: rawType ? rawType.toLowerCase() : 'unknown',
      segments
    })
  }

  const waypoints: ParsedWaypoint[] = []
  for (const wpt of asArray(gpx['wpt'] as XmlNode | XmlNode[] | undefined)) {
    if (!wpt || typeof wpt !== 'object') continue
    const lat = toNumber(wpt['@_lat'])
    const lon = toNumber(wpt['@_lon'])
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    waypoints.push({
      lat,
      lon,
      tsMs: toTimestampMs(wpt['time']),
      name: toText(wpt['name'])
    })
  }

  return { tracks, waypoints }
}
