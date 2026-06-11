import type { AppConfig, DatasetSummary, ImportStats } from '../../../shared/types'
import type { RenderStats } from '../map/MapController'

interface Props {
  summary: DatasetSummary | null
  lastImport: ImportStats | null
  renderStats: RenderStats | null
  config: AppConfig | null
}

const ms = (v: number): string => `${v.toFixed(1)} ms`

export function StatsPanel({ summary, lastImport, renderStats, config }: Props): React.JSX.Element {
  return (
    <section className="panel">
      <h2>Stats</h2>
      {summary && (
        <dl className="stats">
          <dt>Files</dt>
          <dd>{summary.fileCount.toLocaleString()}</dd>
          <dt>Tracks</dt>
          <dd>{summary.trackCount.toLocaleString()}</dd>
          <dt>Segments</dt>
          <dd>{summary.segmentCount.toLocaleString()}</dd>
          <dt>Points</dt>
          <dd>{summary.pointCount.toLocaleString()}</dd>
          <dt>Places</dt>
          <dd>{summary.waypointCount.toLocaleString()}</dd>
        </dl>
      )}
      {lastImport && (
        <p className="hint">
          Last import: {lastImport.filesProcessed} files / {lastImport.pointCount.toLocaleString()}{' '}
          points / {lastImport.segmentCount.toLocaleString()} segments in{' '}
          {(lastImport.durationMs / 1000).toFixed(1)}s ({lastImport.filesSkipped} skipped,{' '}
          {lastImport.filesFailed} failed)
        </p>
      )}
      {renderStats && (
        <p className="hint">
          Viewport: {renderStats.segmentCount.toLocaleString()} segments /{' '}
          {renderStats.pointCount.toLocaleString()} pts at detail{' '}
          {renderStats.detail === 'raw' ? 'raw (all points)' : renderStats.detail}
          {renderStats.downsampleStride > 1 ? `, thinned ×${renderStats.downsampleStride}` : ''}
          {renderStats.truncated ? ' (truncated)' : ''}
          {renderStats.railSnapped > 0 ? `, ${renderStats.railSnapped} rides snapped` : ''}
          {renderStats.railAveraged > 0 ? `, ${renderStats.railAveraged} rides averaged` : ''} /{' '}
          {renderStats.waypointCount.toLocaleString()}
          {renderStats.waypointTotal > renderStats.waypointCount
            ? ` of ${renderStats.waypointTotal.toLocaleString()}`
            : ''}{' '}
          places — query {ms(renderStats.queryMs)}, encode{' '}
          {ms(renderStats.encodeMs)}, decode {ms(renderStats.decodeMs)}, render{' '}
          {ms(renderStats.renderMs)}
        </p>
      )}
      {config && (
        <p className="hint path-hint" title={config.dbPath}>
          DB: {config.dbPath}
        </p>
      )}
    </section>
  )
}
