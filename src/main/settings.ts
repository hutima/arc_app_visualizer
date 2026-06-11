/**
 * User-adjustable settings, stored as JSON in Electron's userData directory
 * (outside any git repository). Written with defaults on first launch so the
 * file is discoverable and editable.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CLEANING, type CleaningConfig } from './importer/clean'

export type BasemapTheme = 'dark' | 'light'

export interface AppSettings {
  /** MapLibre style URL for the dark theme. Tile requests go to this host. */
  basemapStyleUrl: string
  /** MapLibre style URL for the light theme. */
  basemapStyleUrlLight: string
  /** Which of the two styles loads; switchable from the sidebar. */
  basemapTheme: BasemapTheme
  /**
   * line-opacity applied to the basemap's road layers so streets never
   * compete with tracks. 1 disables dimming.
   */
  roadDimOpacity: number
  cleaning: CleaningConfig
  queryLimits: {
    /** Hard segment cap per viewport query (safety valve). */
    segments: number
    waypoints: number
    /**
     * Soft point budget per viewport query. Overflowing viewports are served
     * coarser/thinned lines rather than dropping whole routes; raise this to
     * see more points at once.
     */
    points: number
  }
}

export const CARTO_DARK_STYLE_URL =
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
export const CARTO_LIGHT_STYLE_URL =
  'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'

export const DEFAULT_SETTINGS: AppSettings = {
  basemapStyleUrl: CARTO_DARK_STYLE_URL,
  basemapStyleUrlLight: CARTO_LIGHT_STYLE_URL,
  basemapTheme: 'dark',
  roadDimOpacity: 0.35,
  cleaning: DEFAULT_CLEANING,
  queryLimits: {
    segments: 20000,
    waypoints: 5000,
    points: 300000
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
      basemapStyleUrlLight:
        parsed.basemapStyleUrlLight ?? DEFAULT_SETTINGS.basemapStyleUrlLight,
      basemapTheme: parsed.basemapTheme === 'light' ? 'light' : 'dark',
      roadDimOpacity: clamp01(parsed.roadDimOpacity ?? DEFAULT_SETTINGS.roadDimOpacity),
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
        waypoints: parsed.queryLimits?.waypoints ?? DEFAULT_SETTINGS.queryLimits.waypoints,
        points: parsed.queryLimits?.points ?? DEFAULT_SETTINGS.queryLimits.points
      }
    }
  } catch {
    // Unreadable settings should not brick the app.
    return DEFAULT_SETTINGS
  }
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1)

/** Persist in-memory settings (e.g. after a theme switch from the UI). */
export function saveSettings(path: string, settings: AppSettings): void {
  writeFileSync(path, JSON.stringify(settings, null, 2))
}
