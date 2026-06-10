/**
 * Zoom-dependent geometry detail levels. Import precomputes one simplified
 * polyline per level per segment; the renderer requests the level matching
 * the current zoom so dense tracks never ship every raw point to the map.
 *
 * The user can override this with a detail mode: 'auto' (default) follows
 * zoom, 'low'/'medium'/'high' pin one precomputed level, and 'all' bypasses
 * simplification entirely, serving every clean raw point from the database.
 *
 * Tolerances are in degrees (≈ 1e-5 deg ≈ 1.1 m at the equator). Degree-space
 * simplification slightly over-simplifies longitude at high latitudes, which
 * is acceptable for display geometry (raw points stay in the database).
 */
export const DETAIL_LEVELS = [
  { detail: 0, toleranceDeg: 1e-3 }, // world / country zooms
  { detail: 1, toleranceDeg: 1e-4 }, // city zooms
  { detail: 2, toleranceDeg: 1e-5 } // street zooms, near-raw
] as const

export type DetailMode = 'auto' | 'low' | 'medium' | 'high' | 'all'

/** A detail choice after zoom resolution: a precomputed level, or raw points. */
export type ResolvedDetail = number | 'raw'

export function detailForZoom(zoom: number): number {
  if (zoom < 8) return 0
  if (zoom < 13) return 1
  return 2
}

export function resolveDetail(mode: DetailMode | undefined, zoom: number): ResolvedDetail {
  switch (mode) {
    case 'low':
      return 0
    case 'medium':
      return 1
    case 'high':
      return 2
    case 'all':
      return 'raw'
    default:
      return detailForZoom(zoom)
  }
}
