import type { ArcApi } from '../../shared/types'

declare global {
  interface Window {
    /** Exposed by src/preload/index.ts via contextBridge. */
    api: ArcApi
  }
}

export {}
