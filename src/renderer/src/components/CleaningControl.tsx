import { useEffect, useState } from 'react'
import { DEFAULT_RAIL_TUNING } from '../../../shared/types'
import type { OsmLayer, RailCoverage, RailMatchProgress, RailTuning } from '../../../shared/types'

interface Props {
  averageRail: boolean
  snapRail: boolean
  railCoverage: RailCoverage | null
  railFetching: boolean
  railRebuilding: boolean
  railProgress: RailMatchProgress | null
  railError: string | null
  railTuning: RailTuning | null
  onChangeAverage: (on: boolean) => void
  onChangeSnap: (on: boolean) => void
  onFetchRail: (layer: OsmLayer) => void
  onClearRail: () => void
  onApplyTuning: (t: RailTuning) => void
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
  railTuning,
  onChangeAverage,
  onChangeSnap,
  onFetchRail,
  onClearRail,
  onApplyTuning
}: Props): React.JSX.Element {
  const hasNetwork = railCoverage !== null
  const busy = railFetching || railRebuilding
  const railAreas = railCoverage?.regions.filter((r) => r.layer === 'rail').length ?? 0
  const roadAreas = railCoverage?.regions.filter((r) => r.layer === 'road').length ?? 0

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
          disabled={!hasNetwork || busy}
          onChange={(e) => onChangeSnap(e.target.checked)}
        />
        <span>Snap rail to OSM tracks</span>
      </label>
      <p className="hint">
        Map-matches metro/tram/train rides onto real OpenStreetMap rail geometry,
        routing through tunnels and across transfers — fixing the spots where GPS
        is worst. Each mode matches only its own track kind (metro→subway,
        train→commuter rail, tram→tram/light-rail). Car/taxi/bus trips stay raw
        except long GPS gaps (&gt;~200 m) whose ends sit near a mapped road
        tunnel — bridged through the tunnel instead of a straight jump across
        downtown. <strong>Transit rail</strong> and <strong>road tunnels</strong>
        {' '}are fetched separately; load the area on screen, pan to each city and
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
      {railCoverage && !busy && (
        <p className="hint">
          OSM: <strong>{railAreas}</strong> rail{railAreas === 1 ? ' area' : ' areas'},{' '}
          <strong>{roadAreas}</strong> road-tunnel{roadAreas === 1 ? ' area' : ' areas'} —{' '}
          {fmt(railCoverage.edgeCount)} segments; <strong>{fmt(railCoverage.matchedRides)} rides
          matched</strong> (updated {fmtDate(railCoverage.lastFetchedAtMs)}).{' '}
          <button type="button" className="link-button" onClick={onClearRail}>
            Clear OSM tracks
          </button>
        </p>
      )}
      {railError && <p className="hint status-line error">{railError}</p>}

      {hasNetwork && (
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
