import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSettings, settingsPath, DEFAULT_SETTINGS } from '../src/main/settings'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arcviz-settings-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('settings', () => {
  it('writes discoverable defaults on first launch', () => {
    expect(loadSettings(dir)).toEqual(DEFAULT_SETTINGS)
    expect(existsSync(settingsPath(dir))).toBe(true)
  })

  it('lifts the legacy 20000 segment cap (it hid most of large archives)', () => {
    writeFileSync(settingsPath(dir), JSON.stringify({ queryLimits: { segments: 20000 } }))
    expect(loadSettings(dir).queryLimits.segments).toBe(DEFAULT_SETTINGS.queryLimits.segments)
  })

  it('respects a genuinely customized segment cap', () => {
    writeFileSync(settingsPath(dir), JSON.stringify({ queryLimits: { segments: 1234 } }))
    expect(loadSettings(dir).queryLimits.segments).toBe(1234)
  })

  it('keeps the chosen theme and clamps road dimming into [0, 1]', () => {
    writeFileSync(
      settingsPath(dir),
      JSON.stringify({ basemapTheme: 'light', roadDimOpacity: 7 })
    )
    const s = loadSettings(dir)
    expect(s.basemapTheme).toBe('light')
    expect(s.roadDimOpacity).toBe(1)
  })

  it('falls back to defaults when the file is unreadable', () => {
    writeFileSync(settingsPath(dir), '{not json')
    expect(loadSettings(dir)).toEqual(DEFAULT_SETTINGS)
  })
})
