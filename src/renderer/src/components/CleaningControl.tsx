import { useEffect, useState } from 'react'
import { DEFAULT_RAIL_TUNING } from '../../../shared/types'
import type {
  OsmLayer,
  RailCoverage,
  RailMatchProgress,
  RailTuning,
  RouteCoverage
} from '../../../shared/types'

interface Props {
  averageRail: boolean
  snapRail: boolean
  snapRoad: boolean
  railCoverage: RailCoverage | null
  railFetching: boolean
  railRebuilding: boolean
  railProgress: RailMatchProgress | null
  railError: string | null
  railTuning: RailTuning | null
  /** Drivable road network for the manual reroute tool (separate fetch). */
  routeCoverage: RouteCoverage | null
  routeFetching: boolean
  routeError: string | null
  onChangeAverage: (on: boolean) => void
  onChangeSnap: (on: boolean) => void
  onChangeSnapRoad: (on: boolean) => void
  onFetchRail: (layer: OsmLayer) => void
  /** keepMatched drops the network but keeps cached snapped geometry. */
  onClearRail: (keepMatched?: boolean) => void
  onApplyTuning: (t: RailTuning) => void
  onFetchRoute: () => void
  onClearRoute: () => void
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
  snapRoad,
  railCoverage,
  railFetching,
  railRebuilding,
  railProgress,
  railError,
  railTuning,
  routeCoverage,
  routeFetching,
  routeError,
  onChangeAverage,
  onChangeSnap,
  onChangeSnapRoad,
  onFetchRail,
  onClearRail,
  onApplyTuning,
  onFetchRoute,
  onClearRoute
}: Props): React.JSX.Element {
  const busy = railFetching || railRebuilding
  const railAreas = railCoverage?.regions.filter((r) => r.layer === 'rail').length ?? 0
  const roadAreas = railCoverage?.regions.filter((r) => r.layer === 'road').length ?? 0
  const matchedRides = railCoverage?.matchedRides ?? 0
  // Network present vs. cleared-but-cached: with the network gone (regions
  // empty) the snap toggles still work from cached matched geometry, but
  // re-matching / tuning needs a re-fetch, so those are hidden.
  const hasRegions = (railCoverage?.regions.length ?? 0) > 0
  const routeAreas = routeCoverage?.regions.length ?? 0

  // Range inputs are local drafts; Apply persists + re-matches.
  const [snapM, setSnapM] = useState(String(railTuning?.snapRadiusM ?? DEFAULT_RAIL_TUNING.snapRadiusM))
  const [transferM, setTransferM] = useState(
    String(railTuning?.transferRadiusM ?? DEFAULT_RAIL_TUNING.transferRadiusM)
  )
  useEffect(() => {
    if (railTuning) {
      setSnapM(String(railTuning.snapRadiusM))
      setTransferM(String(railTuning.transferRadiusM))
    }
  }, [railTuning])
  const draft: RailTuning = {
    snapRadiusM: Number(snapM),
    transferRadiusM: Number(transferM)
  }
  const draftValid = Number.isFinite(draft.snapRadiusM) && Number.isFinite(draft.transferRadiusM)
  const draftChanged =
    railTuning !== null &&
    (draft.snapRadiusM !== railTuning.snapRadiusM ||
      draft.transferRadiusM !== railTuning.transferRadiusM)
  return (
    <section className="panel">
      <h2>Cleaning</h2>

      <label className="color-mode-option">
        <input
          type="checkbox"
          checked={snapRail}
          disabled={(railAreas === 0 && matchedRides === 0) || busy}
          onChange={(e) => onChangeSnap(e.target.checked)}
        />
        <span>Snap rail to OSM tracks</span>
      </label>
      <label className="color-mode-option">
        <input
          type="checkbox"
          checked={snapRoad}
          disabled={(roadAreas === 0 && matchedRides === 0) || busy}
          onChange={(e) => onChangeSnapRoad(e.target.checked)}
        />
        <span>Bridge road tunnels (car/taxi/bus)</span>
      </label>
      <p className="hint">
        Rail: map-matches metro/tram/train rides onto real OpenStreetMap rail
        geometry, routing through tunnels and across transfers; each mode
        matches only its own track kind (metro→subway, train→commuter rail,
        tram→tram/light-rail), rides prefer one contiguous track, and a fill
        that doesn&apos;t fit the elapsed time is left disconnected rather than
        drawn as a jump that never happened. Road: car/taxi/bus trips stay raw
        except GPS dropouts that are anomalous for that trip and end near a
        mapped tunnel — bridged through it, with mid-dropout scatter hidden.
        The two layers are fetched and toggled separately; pan to each city and
        fetch — areas add up and matching is cached so panning stays fast.
      </p>
      <div className="rail-fetch-actions">
        <button type="button" onClick={() => onFetchRail('rail')} disabled={busy}>
          {railFetching
            ? 'Fetching…'
            : `${railAreas > 0 ? 'Add' : 'Fetch'} transit rail in view`}
        </button>
        <button type="button" onClick={() => onFetchRail('road')} disabled={busy}>
          {railFetching ? 'Fetching…' : `${roadAreas > 0 ? 'Add' : 'Fetch'} road tunnels in view`}
        </button>
      </div>
      {(railFetching || railRebuilding) && (
        <p className="hint status-line">
          {railProgress
            ? `Matching… ${fmt(railProgress.done)}/${fmt(railProgress.total)} (${fmt(
                railProgress.matched
              )} done)`
            : railFetching
              ? 'Fetching from OpenStreetMap…'
              : 'Matching rides…'}
        </p>
      )}
      {railCoverage && hasRegions && !busy && (
        <p className="hint">
          OSM: <strong>{railAreas}</strong> rail{railAreas === 1 ? ' area' : ' areas'},{' '}
          <strong>{roadAreas}</strong> road-tunnel{roadAreas === 1 ? ' area' : ' areas'} —{' '}
          {fmt(railCoverage.edgeCount)} segments; <strong>{fmt(matchedRides)} rides
          matched</strong> (updated {fmtDate(railCoverage.lastFetchedAtMs)}).{' '}
          <button type="button" className="link-button" onClick={() => onClearRail(false)}>
            Clear all
          </button>{' · '}
          <button type="button" className="link-button" onClick={() => onClearRail(true)}>
            Clear network, keep snapped
          </button>
        </p>
      )}
      {railCoverage && !hasRegions && matchedRides > 0 && !busy && (
        <p className="hint">
          OSM network cleared — <strong>{fmt(matchedRides)} rides still snapped</strong> from
          cache. Re-fetch an area to update or match more.{' '}
          <button type="button" className="link-button" onClick={() => onClearRail(false)}>
            Clear cached snapping
          </button>
        </p>
      )}
      {railError && <p className="hint status-line error">{railError}</p>}

      {hasRegions && (
        <div className="rail-tuning">
          <label>
            <span>Snap within (m)</span>
            <input
              type="number"
              min={20}
              max={1000}
              step={10}
              value={snapM}
              disabled={busy}
              onChange={(e) => setSnapM(e.target.value)}
            />
          </label>
          <label>
            <span>Transfer within (m)</span>
            <input
              type="number"
              min={0}
              max={500}
              step={5}
              value={transferM}
              disabled={busy}
              onChange={(e) => setTransferM(e.target.value)}
            />
          </label>
          <div className="rail-tuning-actions">
            <button
              type="button"
              disabled={busy || !draftValid || !draftChanged}
              onClick={() => onApplyTuning(draft)}
            >
              Apply &amp; re-match
            </button>
            <button
              type="button"
              disabled={busy}
              title="Reset ranges to defaults"
              onClick={() => {
                setSnapM(String(DEFAULT_RAIL_TUNING.snapRadiusM))
                setTransferM(String(DEFAULT_RAIL_TUNING.transferRadiusM))
              }}
            >
              ↺
            </button>
          </div>
          <p className="hint">
            Snap: how far a GPS point may sit from a track and still match —
            raise it if noisy rides stay raw, lower it if rides grab the wrong
            nearby line. Transfer: how far apart two lines may be while still
            routable as an interchange.
          </p>
        </div>
      )}

      <div className="cleaning-divider">
        <p className="hint">
          <strong>Road routing</strong> — drivable roads for the manual reroute
          tool (Edit → Edit points → “Snap part to road route”). Fetch an area,
          then route on it offline; applied reroutes are kept even if you clear
          the roads. Roads are dense, so fetch a small area at a time.
        </p>
        <div className="rail-fetch-actions">
          <button type="button" onClick={onFetchRoute} disabled={routeFetching}>
            {routeFetching ? 'Fetching…' : `${routeAreas > 0 ? 'Add' : 'Fetch'} roads in view`}
          </button>
        </div>
        {routeCoverage && (
          <p className="hint">
            Roads: <strong>{routeAreas}</strong> {routeAreas === 1 ? 'area' : 'areas'} —{' '}
            {fmt(routeCoverage.edgeCount)} segments (updated{' '}
            {fmtDate(routeCoverage.lastFetchedAtMs)}).{' '}
            <button type="button" className="link-button" onClick={onClearRoute}>
              Clear roads
            </button>
          </p>
        )}
        {routeError && <p className="hint status-line error">{routeError}</p>}
      </div>

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
