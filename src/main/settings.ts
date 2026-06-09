/**
 * User-adjustable settings, stored as JSON in Electron's userData directory
 * (outside any git repository). Written with defaults on first launch so the
 * file is discoverable and editable.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CLEANING, type CleaningConfig } from './importer/clean'

export interface AppSettings {
  /** MapLibre style URL. Tile requests go to this host while panning. */
  basemapStyleUrl: string
  cleaning: CleaningConfig
  queryLimits: {
    segments: number
    waypoints: number
  }
}

export const CARTO_DARK_STYLE_URL =
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

export const DEFAULT_SETTINGS: AppSettings = {
  basemapStyleUrl: CARTO_DARK_STYLE_URL,
  cleaning: DEFAULT_CLEANING,
  queryLimits: {
    segments: 20000,
    waypoints: 5000
  }
}

export function settingsPath(userDataDir: string): string {
  return join(userDataDir, 'settings.json')
}

export function loadSettings(userDataDir: string): AppSettings {
  const path = settingsPath(userDataDir)
  if (!existsSync(path)) {
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(path, JSON.stringify(DEFAULT_SETTINGS, null, 2))
    return DEFAULT_SETTINGS
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AppSettings>
    return {
      basemapStyleUrl: parsed.basemapStyleUrl ?? DEFAULT_SETTINGS.basemapStyleUrl,
      cleaning: {
        maxSpeedMpsDefault:
          parsed.cleaning?.maxSpeedMpsDefault ?? DEFAULT_CLEANING.maxSpeedMpsDefault,
        maxSpeedMpsByType: {
          ...DEFAULT_CLEANING.maxSpeedMpsByType,
          ...(parsed.cleaning?.maxSpeedMpsByType ?? {})
        }
      },
      queryLimits: {
        segments: parsed.queryLimits?.segments ?? DEFAULT_SETTINGS.queryLimits.segments,
        waypoints: parsed.queryLimits?.waypoints ?? DEFAULT_SETTINGS.queryLimits.waypoints
      }
    }
  } catch {
    // Unreadable settings should not brick the app.
    return DEFAULT_SETTINGS
  }
}
