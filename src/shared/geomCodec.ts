/**
 * Compact binary encoding for viewport track geometry sent over IPC.
 *
 * Structured-cloning one ArrayBuffer across the bridge is far cheaper than
 * cloning deeply nested GeoJSON, and it keeps large geometry out of React
 * state — the renderer decodes straight into Float32Array views.
 *
 * Layout (little-endian, every field 4-byte aligned):
 *   u32 magic 'ARC1' (0x41524331)
 *   u32 segmentCount
 *   u32 typeTableByteLength            (UTF-8 JSON string[], unpadded length)
 *   u8[typeTableByteLength]            (+ zero padding to a 4-byte boundary)
 *   repeat segmentCount times:
 *     u32 segmentId
 *     u32 typeIndex                    (into the type table)
 *     u32 pointCount
 *     f32[2 * pointCount]              (lon, lat pairs)
 */

export const GEOM_MAGIC = 0x41524331

export interface EncodedSegment {
  id: number
  typeIndex: number
  /** Interleaved [lon, lat, lon, lat, ...] */
  coords: Float32Array
}

export interface DecodedGeometry {
  typeTable: string[]
  segments: EncodedSegment[]
  totalPoints: number
}

const pad4 = (n: number): number => (n + 3) & ~3

export function encodeGeometry(typeTable: string[], segments: EncodedSegment[]): ArrayBuffer {
  const typeJson = new TextEncoder().encode(JSON.stringify(typeTable))
  const typeLenPadded = pad4(typeJson.byteLength)
  let total = 12 + typeLenPadded
  for (const s of segments) total += 12 + s.coords.byteLength

  const buffer = new ArrayBuffer(total)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  view.setUint32(0, GEOM_MAGIC, true)
  view.setUint32(4, segments.length, true)
  // Store the unpadded length; padding bytes must never reach JSON.parse.
  view.setUint32(8, typeJson.byteLength, true)
  bytes.set(typeJson, 12)

  let offset = 12 + typeLenPadded
  for (const s of segments) {
    view.setUint32(offset, s.id, true)
    view.setUint32(offset + 4, s.typeIndex, true)
    view.setUint32(offset + 8, s.coords.length / 2, true)
    bytes.set(new Uint8Array(s.coords.buffer, s.coords.byteOffset, s.coords.byteLength), offset + 12)
    offset += 12 + s.coords.byteLength
  }
  return buffer
}

export function decodeGeometry(buffer: ArrayBuffer): DecodedGeometry {
  const view = new DataView(buffer)
  if (view.getUint32(0, true) !== GEOM_MAGIC) {
    throw new Error('geomCodec: bad magic — payload is not ARC1 geometry')
  }
  const segmentCount = view.getUint32(4, true)
  const typeLen = view.getUint32(8, true)
  const typeJson = new TextDecoder().decode(new Uint8Array(buffer, 12, typeLen))
  const typeTable: string[] = JSON.parse(typeJson)

  const segments: EncodedSegment[] = []
  let totalPoints = 0
  let offset = 12 + pad4(typeLen)
  for (let i = 0; i < segmentCount; i++) {
    const id = view.getUint32(offset, true)
    const typeIndex = view.getUint32(offset + 4, true)
    const pointCount = view.getUint32(offset + 8, true)
    const coords = new Float32Array(buffer, offset + 12, pointCount * 2)
    segments.push({ id, typeIndex, coords })
    totalPoints += pointCount
    offset += 12 + pointCount * 8
  }
  return { typeTable, segments, totalPoints }
}
