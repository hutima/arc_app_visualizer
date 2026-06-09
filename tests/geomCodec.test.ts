import { describe, it, expect } from 'vitest'
import { encodeGeometry, decodeGeometry } from '../src/shared/geomCodec'

describe('geomCodec', () => {
  it('round-trips segments and the type table', () => {
    const typeTable = ['walking', 'métro 🚇'] // exercise multi-byte UTF-8
    const segments = [
      { id: 1, typeIndex: 0, coords: new Float32Array([0.001, 0.002, 0.003, 0.004]) },
      { id: 999999, typeIndex: 1, coords: new Float32Array([10.5, -20.25]) }
    ]
    const buffer = encodeGeometry(typeTable, segments)
    const decoded = decodeGeometry(buffer)

    expect(decoded.typeTable).toEqual(typeTable)
    expect(decoded.segments).toHaveLength(2)
    expect(decoded.totalPoints).toBe(3)
    expect(decoded.segments[0]!.id).toBe(1)
    expect(decoded.segments[0]!.typeIndex).toBe(0)
    expect([...decoded.segments[0]!.coords]).toEqual([
      new Float32Array([0.001])[0]!,
      new Float32Array([0.002])[0]!,
      new Float32Array([0.003])[0]!,
      new Float32Array([0.004])[0]!
    ])
    expect(decoded.segments[1]!.id).toBe(999999)
    expect([...decoded.segments[1]!.coords]).toEqual([10.5, -20.25])
  })

  it('round-trips an empty result', () => {
    const decoded = decodeGeometry(encodeGeometry([], []))
    expect(decoded.segments).toEqual([])
    expect(decoded.totalPoints).toBe(0)
  })

  it('rejects buffers with a bad magic number', () => {
    expect(() => decodeGeometry(new ArrayBuffer(16))).toThrow(/bad magic/)
  })

  it('works with unaligned source views (copies survive)', () => {
    const typeTable = ['a']
    const coords = new Float32Array([1.5, 2.5, 3.5, 4.5])
    const buffer = encodeGeometry(typeTable, [{ id: 7, typeIndex: 0, coords }])
    // Decoding must not depend on external alignment assumptions.
    const copy = buffer.slice(0)
    const decoded = decodeGeometry(copy)
    expect([...decoded.segments[0]!.coords]).toEqual([1.5, 2.5, 3.5, 4.5])
  })
})
