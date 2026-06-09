import { describe, it, expect } from 'vitest'
import { isoWeekFromFilename, isoWeekFromTimestamp } from '../src/main/importer/isoWeek'

describe('isoWeekFromFilename', () => {
  it('parses Arc weekly export names, including duplicate suffixes', () => {
    expect(isoWeekFromFilename('2024-W07.gpx')).toEqual({ year: 2024, week: 7 })
    expect(isoWeekFromFilename('2024-W07 2.gpx')).toEqual({ year: 2024, week: 7 })
    expect(isoWeekFromFilename('2016-W53.gpx')).toEqual({ year: 2016, week: 53 })
  })

  it('rejects names without a week pattern or with impossible weeks', () => {
    expect(isoWeekFromFilename('export.gpx')).toBeNull()
    expect(isoWeekFromFilename('2024-W54.gpx')).toBeNull()
    expect(isoWeekFromFilename('2024-W00.gpx')).toBeNull()
  })
})

describe('isoWeekFromTimestamp', () => {
  it('computes ISO weeks including year boundaries', () => {
    expect(isoWeekFromTimestamp(Date.parse('2000-01-03T12:00:00Z'))).toEqual({ year: 2000, week: 1 })
    // Jan 1 2021 is a Friday: it belongs to ISO week 53 of 2020.
    expect(isoWeekFromTimestamp(Date.parse('2021-01-01T00:00:00Z'))).toEqual({ year: 2020, week: 53 })
    expect(isoWeekFromTimestamp(Date.parse('2016-01-04T00:00:00Z'))).toEqual({ year: 2016, week: 1 })
    expect(isoWeekFromTimestamp(Date.parse('2024-07-15T09:30:00Z'))).toEqual({ year: 2024, week: 29 })
  })
})
