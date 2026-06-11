import type { RailCoverage } from '../../../shared/types'

interface Props {
  averageRail: boolean
  snapRail: boolean
  railCoverage: RailCoverage | null
  railFetching: boolean
  railError: string | null
  onChangeAverage: (on: boolean) => void
  onChangeSnap: (on: boolean) => void
  onFetchRail: () => void
}

const fmtDate = (ms: number): string => new Date(ms).toLocaleDateString()

/**
 * Display-time cleaning toggles. Nothing here ever touches raw points — each
 * option re-queries and transforms what the map shows.
 */
export function CleaningControl({
  averageRail,
  snapRail,
  railCoverage,
  railFetching,
  railError,
  onChangeAverage,
  onChangeSnap,
  onFetchRail
}: Props): React.JSX.Element {
  const hasNetwork = railCoverage !== null
  return (
    <section className="panel">
      <h2>Cleaning</h2>

      <label className="color-mode-option">
        <input
          type="checkbox"
          checked={snapRail}
          disabled={!hasNetwork}
          onChange={(e) => onChangeSnap(e.target.checked)}
        />
        <span>Snap rail to OSM tracks</span>
      </label>
      <p className="hint">
        Matches metro/tram/train rides onto real OpenStreetMap rail geometry and
        routes through tunnels — fixing the spots where GPS is worst. Needs a
        one-time network fetch; everything after is offline.
      </p>
      <button type="button" onClick={onFetchRail} disabled={railFetching}>
        {railFetching
          ? 'Fetching rail network…'
          : hasNetwork
            ? 'Re-fetch rail network'
            : 'Fetch rail network for my data'}
      </button>
      {railCoverage && (
        <p className="hint">
          OSM rail: {railCoverage.edgeCount.toLocaleString()} segments,{' '}
          {railCoverage.nodeCount.toLocaleString()} nodes (fetched{' '}
          {fmtDate(railCoverage.fetchedAtMs)}).
        </p>
      )}
      {railError && <p className="hint status-line error">{railError}</p>}

      <label className="color-mode-option cleaning-divider">
        <input
          type="checkbox"
          checked={averageRail}
          onChange={(e) => onChangeAverage(e.target.checked)}
        />
        <span>Average repeat rides (no OSM)</span>
      </label>
      <p className="hint">
        Fallback when no rail network is fetched: rides of the same type between
        the same two places merge into one best-fit track at ~50 m resolution.
      </p>
    </section>
  )
}
