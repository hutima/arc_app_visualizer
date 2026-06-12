import type { RailCoverage, RailMatchProgress } from '../../../shared/types'

interface Props {
  averageRail: boolean
  snapRail: boolean
  railCoverage: RailCoverage | null
  railFetching: boolean
  railRebuilding: boolean
  railProgress: RailMatchProgress | null
  railError: string | null
  onChangeAverage: (on: boolean) => void
  onChangeSnap: (on: boolean) => void
  onFetchRail: () => void
}

const fmtDate = (ms: number): string => new Date(ms).toLocaleDateString()
const fmt = (n: number): string => n.toLocaleString()

/**
 * Display-time cleaning toggles. Nothing here ever touches raw points — each
 * option re-queries and transforms what the map shows.
 */
export function CleaningControl({
  averageRail,
  snapRail,
  railCoverage,
  railFetching,
  railRebuilding,
  railProgress,
  railError,
  onChangeAverage,
  onChangeSnap,
  onFetchRail
}: Props): React.JSX.Element {
  const hasNetwork = railCoverage !== null
  const busy = railFetching || railRebuilding
  return (
    <section className="panel">
      <h2>Cleaning</h2>

      <label className="color-mode-option">
        <input
          type="checkbox"
          checked={snapRail}
          disabled={!hasNetwork || busy}
          onChange={(e) => onChangeSnap(e.target.checked)}
        />
        <span>Snap rail to OSM tracks</span>
      </label>
      <p className="hint">
        Map-matches metro/tram/train rides onto real OpenStreetMap rail geometry,
        routing through tunnels and across transfers — fixing the spots where GPS
        is worst. Fetch loads the area on screen; pan to each city and fetch it —
        areas add up, and matching is cached so panning stays fast. Rides keep
        their raw GPS wherever they leave fetched areas or wander off the rails.
      </p>
      <button type="button" onClick={onFetchRail} disabled={busy}>
        {railFetching
          ? railProgress
            ? `Matching rides… ${fmt(railProgress.done)}/${fmt(railProgress.total)}`
            : 'Fetching rail in view…'
          : hasNetwork
            ? 'Add rail in current view'
            : 'Fetch rail in current view'}
      </button>
      {railRebuilding && (
        <p className="hint status-line">
          {railProgress
            ? `Matching rides… ${fmt(railProgress.done)}/${fmt(railProgress.total)} (${fmt(
                railProgress.matched
              )} snapped)`
            : 'Matching rides to rail…'}
        </p>
      )}
      {railCoverage && !busy && (
        <p className="hint">
          OSM rail: {railCoverage.regions.length}{' '}
          {railCoverage.regions.length === 1 ? 'area' : 'areas'} — {fmt(railCoverage.edgeCount)}{' '}
          segments; <strong>{fmt(railCoverage.matchedRides)} rides snapped</strong> (updated{' '}
          {fmtDate(railCoverage.lastFetchedAtMs)}).
        </p>
      )}
      {railError && <p className="hint status-line error">{railError}</p>}

      <label className="color-mode-option cleaning-divider">
        <input
          type="checkbox"
          checked={averageRail && !snapRail}
          disabled={snapRail}
          onChange={(e) => onChangeAverage(e.target.checked)}
        />
        <span>Average repeat rides (no OSM)</span>
      </label>
      <p className="hint">
        {snapRail
          ? 'Superseded while snapping is on — snapped rides already coincide on the real alignment.'
          : 'Fallback when no rail network is fetched: rides of the same type between the same two places merge into one best-fit track at ~50 m resolution.'}
      </p>
    </section>
  )
}
