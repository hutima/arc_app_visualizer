/**
 * Iterative Douglas–Peucker polyline simplification over degree-space
 * coordinates. Returns the kept indices so callers can carry timestamps or
 * other per-point data alongside the geometry.
 */

/** Squared perpendicular distance from point p to segment a–b (degrees²). */
function perpDistSq(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number
): number {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) {
    const ex = px - ax
    const ey = py - ay
    return ex * ex + ey * ey
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx
  const cy = ay + t * dy
  const ex = px - cx
  const ey = py - cy
  return ex * ex + ey * ey
}

/**
 * @param lons longitude per point (x)
 * @param lats latitude per point (y)
 * @param toleranceDeg max deviation in degrees
 * @returns ascending indices of points to keep (always includes first & last)
 */
export function simplifyIndices(
  lons: ArrayLike<number>,
  lats: ArrayLike<number>,
  toleranceDeg: number
): number[] {
  const n = lons.length
  if (n <= 2) {
    return n === 2 ? [0, 1] : n === 1 ? [0] : []
  }
  const tolSq = toleranceDeg * toleranceDeg
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1

  const stack: Array<[number, number]> = [[0, n - 1]]
  while (stack.length > 0) {
    const [first, last] = stack.pop()!
    let maxDistSq = tolSq
    let maxIdx = -1
    for (let i = first + 1; i < last; i++) {
      const d = perpDistSq(
        lons[i]!, lats[i]!,
        lons[first]!, lats[first]!,
        lons[last]!, lats[last]!
      )
      if (d > maxDistSq) {
        maxDistSq = d
        maxIdx = i
      }
    }
    if (maxIdx !== -1) {
      keep[maxIdx] = 1
      if (maxIdx - first > 1) stack.push([first, maxIdx])
      if (last - maxIdx > 1) stack.push([maxIdx, last])
    }
  }

  const out: number[] = []
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(i)
  }
  return out
}
