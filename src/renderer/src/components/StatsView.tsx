import type {
  CategoryInfo,
  DatasetStats,
  PlaceRef,
  PlaceStats,
  YearCount
} from '../../../shared/types'

interface Props {
  dataset: DatasetStats | null
  /** The place currently inspected (clicked on the map or in the list). */
  place: PlaceStats | null
  placeLoading: boolean
  /** For the activity-type breakdown (counts + colors). */
  categories: CategoryInfo[]
  onPickTopPlace: (ref: PlaceRef, lat: number, lon: number) => void
  onClearPlace: () => void
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const num = (n: number): string => n.toLocaleString()
const fmtDate = (ms: number | null): string =>
  ms === null
    ? '—'
    : new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

/**
 * The Stats tab. Two parts: a dataset-wide summary (always shown) and a
 * per-place drill-down (when a place is selected on the map or picked from the
 * most-visited list). Charts are plain CSS bars — no chart dependency, keeping
 * the app offline and lean.
 */
export function StatsView({
  dataset,
  place,
  placeLoading,
  categories,
  onPickTopPlace,
  onClearPlace
}: Props): React.JSX.Element {
  return (
    <section className="panel stats-view">
      <h2>Stats</h2>
      {place ? (
        <PlaceBlock place={place} onClear={onClearPlace} />
      ) : (
        <p className="hint">
          {placeLoading
            ? 'Loading place…'
            : 'Click a place pin on the map (or one below) to see its visit stats.'}
        </p>
      )}
      {dataset && <DatasetBlock dataset={dataset} categories={categories} onPickTopPlace={onPickTopPlace} />}
    </section>
  )
}

function PlaceBlock({ place, onClear }: { place: PlaceStats; onClear: () => void }): React.JSX.Element {
  const name = place.name && place.name.length > 0 ? place.name : '(unnamed place)'
  return (
    <div className="stats-place">
      <div className="stats-place-head">
        <strong>{name}</strong>
        <button type="button" className="link-button" onClick={onClear}>
          Clear
        </button>
      </div>
      <dl className="stats">
        <dt>Visits</dt>
        <dd>{num(place.visitCount)}</dd>
        <dt>First</dt>
        <dd>{fmtDate(place.firstTsMs)}</dd>
        <dt>Last</dt>
        <dd>{fmtDate(place.lastTsMs)}</dd>
      </dl>
      <Histogram title="Visits by hour of day" counts={place.hourCounts} label={(i) => (i % 6 === 0 ? String(i) : '')} />
      <Histogram title="Visits by day of week" counts={place.dowCounts} label={(i) => DOW[i] ?? ''} />
      {place.yearCounts.length > 1 && (
        <BarRows
          title="Visits by year"
          rows={place.yearCounts.map((y) => ({ key: String(y.year), label: String(y.year), count: y.count }))}
        />
      )}
    </div>
  )
}

function DatasetBlock({
  dataset,
  categories,
  onPickTopPlace
}: {
  dataset: DatasetStats
  categories: CategoryInfo[]
  onPickTopPlace: (ref: PlaceRef, lat: number, lon: number) => void
}): React.JSX.Element {
  const span =
    dataset.startTsMs != null && dataset.endTsMs != null
      ? `${fmtDate(dataset.startTsMs)} – ${fmtDate(dataset.endTsMs)}`
      : '—'
  const typeRows = categories
    .filter((c) => !c.ignored && c.segmentCount > 0)
    .map((c) => ({ key: c.name, label: c.name, count: c.segmentCount, color: c.color }))

  return (
    <div className="stats-dataset">
      <h3 className="stats-subhead">Dataset</h3>
      <dl className="stats">
        <dt>Span</dt>
        <dd>{span}</dd>
        <dt>Tracks</dt>
        <dd>{num(dataset.segmentCount)}</dd>
        <dt>Visits</dt>
        <dd>{num(dataset.visitCount)}</dd>
        <dt>Places</dt>
        <dd>{num(dataset.placeCount)}</dd>
      </dl>
      {dataset.segmentsByYear.length > 0 && (
        <BarRows title="Tracks by year" rows={yearRows(dataset.segmentsByYear)} />
      )}
      {typeRows.length > 0 && (
        <BarRows title="Tracks by type" rows={typeRows} colorOf={(key) => typeRows.find((r) => r.key === key)?.color} />
      )}
      {dataset.topPlaces.length > 0 && (
        <div className="bar-block">
          <div className="histogram-title">Most-visited places</div>
          <ul className="bar-rows">
            {dataset.topPlaces.map((p, i) => {
              const max = dataset.topPlaces[0]!.visitCount || 1
              const name = p.name && p.name.length > 0 ? p.name : '(unnamed)'
              return (
                <li
                  key={`${name}-${i}`}
                  className="clickable"
                  onClick={() => onPickTopPlace(p.ref, p.lat, p.lon)}
                >
                  <span className="bar-row-label" title={name}>
                    {name}
                  </span>
                  <span className="bar-row-track">
                    <span className="bar-row-fill" style={{ width: `${(p.visitCount / max) * 100}%` }} />
                  </span>
                  <span className="bar-row-count">{num(p.visitCount)}</span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

const yearRows = (years: YearCount[]): BarRow[] =>
  years.map((y) => ({ key: String(y.year), label: String(y.year), count: y.count }))

/** Vertical bar chart (fixed-width buckets like an hour-of-day histogram). */
function Histogram({
  title,
  counts,
  label
}: {
  title: string
  counts: number[]
  label: (i: number) => string
}): React.JSX.Element {
  const max = Math.max(1, ...counts)
  return (
    <div className="bar-block">
      <div className="histogram-title">{title}</div>
      <div className="histogram">
        {counts.map((c, i) => (
          <div key={i} className="histogram-bar" title={`${label(i) || i}: ${c}`}>
            <div className="histogram-fill" style={{ height: `${(c / max) * 100}%` }} />
            <span className="histogram-label">{label(i)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

interface BarRow {
  key: string
  label: string
  count: number
  color?: string
}

/** Horizontal labelled bars (years, types) — counts normalized to the max. */
function BarRows({
  title,
  rows,
  colorOf
}: {
  title: string
  rows: BarRow[]
  colorOf?: (key: string) => string | undefined
}): React.JSX.Element {
  const max = Math.max(1, ...rows.map((r) => r.count))
  return (
    <div className="bar-block">
      <div className="histogram-title">{title}</div>
      <ul className="bar-rows">
        {rows.map((r) => (
          <li key={r.key}>
            <span className="bar-row-label">{r.label}</span>
            <span className="bar-row-track">
              <span
                className="bar-row-fill"
                style={{ width: `${(r.count / max) * 100}%`, background: colorOf?.(r.key) }}
              />
            </span>
            <span className="bar-row-count">{num(r.count)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
