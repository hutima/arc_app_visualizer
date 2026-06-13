/**
 * Spatial clustering of place visits, shared by the render path (queries.ts,
 * which draws one pin per cluster) and the persistent place operations
 * (placeStore.ts, which recovers a cluster's members to merge / inspect them).
 * Keeping the membership rule in one place guarantees the dot a user clicks is
 * exactly the set of visits an operation acts on.
 */

/** Same-name visits within this radius of each other merge (~275 m). */
export const PLACE_MERGE_RADIUS_DEG = 0.0025

export interface ClusterPoint {
  id: number
  lat: number
  lon: number
}

interface Cluster<T> {
  latSum: number
  lonSum: number
  members: T[]
}

/**
 * Greedy running-mean clustering: each item joins the first existing cluster
 * whose current centroid is within `radiusDeg`, else starts its own. Callers
 * sort by id first so membership is deterministic regardless of scan order
 * (the running mean otherwise depends on arrival order).
 */
export function clusterByProximity<T extends ClusterPoint>(
  items: T[],
  radiusDeg = PLACE_MERGE_RADIUS_DEG
): T[][] {
  const r2 = radiusDeg * radiusDeg
  const clusters: Cluster<T>[] = []
  for (const item of [...items].sort((a, b) => a.id - b.id)) {
    const near = clusters.find((c) => {
      const n = c.members.length
      const dLat = item.lat - c.latSum / n
      const dLon = item.lon - c.lonSum / n
      return dLat * dLat + dLon * dLon <= r2
    })
    if (near) {
      near.latSum += item.lat
      near.lonSum += item.lon
      near.members.push(item)
    } else {
      clusters.push({ latSum: item.lat, lonSum: item.lon, members: [item] })
    }
  }
  return clusters.map((c) => c.members)
}
