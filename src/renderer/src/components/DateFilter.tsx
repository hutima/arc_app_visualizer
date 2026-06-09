import { useState } from 'react'
import type { DatasetSummary } from '../../../shared/types'

interface Props {
  summary: DatasetSummary | null
  onChange: (startTsMs: number | null, endTsMs: number | null) => void
}

const DAY_MS = 86400000
const WEEK_MS = 7 * DAY_MS

function toDateInput(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10)
}

function startOfDayUtc(dateStr: string): number | null {
  if (!dateStr) return null
  const t = Date.parse(`${dateStr}T00:00:00Z`)
  return Number.isFinite(t) ? t : null
}

function endOfDayUtc(dateStr: string): number | null {
  if (!dateStr) return null
  const t = Date.parse(`${dateStr}T23:59:59.999Z`)
  return Number.isFinite(t) ? t : null
}

export function DateFilter({ summary, onChange }: Props): React.JSX.Element {
  const [startStr, setStartStr] = useState('')
  const [endStr, setEndStr] = useState('')

  const apply = (s: string, e: string): void => {
    setStartStr(s)
    setEndStr(e)
    onChange(startOfDayUtc(s), endOfDayUtc(e))
  }

  const clear = (): void => apply('', '')

  const lastDays = (days: number): void => {
    const end = summary?.endTsMs ?? Date.now()
    apply(toDateInput(end - days * DAY_MS), toDateInput(end))
  }

  // Step the current window by one week; defaults to the dataset's last week.
  const stepWeek = (direction: -1 | 1): void => {
    let s = startOfDayUtc(startStr)
    let e = endOfDayUtc(endStr)
    if (s === null || e === null) {
      const end = summary?.endTsMs ?? Date.now()
      e = end
      s = end - WEEK_MS
    } else {
      s += direction * WEEK_MS
      e += direction * WEEK_MS
    }
    apply(toDateInput(s), toDateInput(e))
  }

  return (
    <section className="panel">
      <h2>Date range</h2>
      <div className="date-row">
        <input
          type="date"
          value={startStr}
          onChange={(e) => apply(e.target.value, endStr)}
          aria-label="start date"
        />
        <span>→</span>
        <input
          type="date"
          value={endStr}
          onChange={(e) => apply(startStr, e.target.value)}
          aria-label="end date"
        />
      </div>
      <div className="button-row">
        <button onClick={clear}>All time</button>
        <button onClick={() => lastDays(365)}>Last year</button>
        <button onClick={() => lastDays(90)}>90 days</button>
        <button onClick={() => stepWeek(-1)} title="previous week">
          ‹ wk
        </button>
        <button onClick={() => stepWeek(1)} title="next week">
          wk ›
        </button>
      </div>
      {summary?.startTsMs != null && summary.endTsMs != null && (
        <p className="hint">
          Data spans {toDateInput(summary.startTsMs)} → {toDateInput(summary.endTsMs)}
        </p>
      )}
    </section>
  )
}
