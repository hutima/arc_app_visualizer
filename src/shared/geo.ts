const EARTH_RADIUS_M = 6371000

export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = Math.PI / 180
  const dLat = (lat2 - lat1) * toRad
  const dLon = (lon2 - lon1) * toRad
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)))
}

export interface Bounds {
  minLat: number
  minLon: number
  maxLat: number
  maxLon: number
}

export function emptyBounds(): Bounds {
  return { minLat: Infinity, minLon: Infinity, maxLat: -Infinity, maxLon: -Infinity }
}

export function extendBounds(b: Bounds, lat: number, lon: number): void {
  if (lat < b.minLat) b.minLat = lat
  if (lat > b.maxLat) b.maxLat = lat
  if (lon < b.minLon) b.minLon = lon
  if (lon > b.maxLon) b.maxLon = lon
}

export function mergeBounds(into: Bounds, from: Bounds): void {
  if (from.minLat < into.minLat) into.minLat = from.minLat
  if (from.maxLat > into.maxLat) into.maxLat = from.maxLat
  if (from.minLon < into.minLon) into.minLon = from.minLon
  if (from.maxLon > into.maxLon) into.maxLon = from.maxLon
}

export function boundsValid(b: Bounds): boolean {
  return b.minLat <= b.maxLat && b.minLon <= b.maxLon
}
