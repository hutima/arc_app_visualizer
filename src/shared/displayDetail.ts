/**
 * Zoom-dependent geometry detail levels. Import precomputes one simplified
 * polyline per level per segment; the renderer requests the level matching
 * the current zoom so dense tracks never ship every raw point to the map.
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

export function detailForZoom(zoom: number): number {
  if (zoom < 8) return 0
  if (zoom < 13) return 1
  return 2
}
