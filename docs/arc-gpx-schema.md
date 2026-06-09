# Arc Timeline GPX export schema

Derived from a privacy-safe structural inspection of one real weekly export
(element/attribute names, value *formats*, and aggregate counts only — no
coordinates, timestamps, or names were extracted, and the real file is not in
this repository or its git history).

## Structure

```
<gpx version="1.1"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     creator="Arc Timeline">

  <trk>                      one per Arc timeline activity item
    <name>…</name>           free text; often a place label → TREAT AS PRIVATE
    <type>…</type>           activity category (see below)
    <trkseg>                 exactly 1 per trk in the inspected file,
                             but parsers must accept 0..n and EMPTY segments
                             (empty trkseg occurs in real exports)
      <trkpt lat="…" lon="…">   decimal degrees as XML attributes
        <ele>…</ele>             decimal metres
        <time>…</time>           ISO 8601 UTC (e.g. 2000-01-03T08:00:00Z format)
      </trkpt>
      …
    </trkseg>
  </trk>
  …

  <wpt lat="…" lon="…">      Arc "visits"/places exported as waypoints
    <time>…</time>
    <name>…</name>           place name → TREAT AS PRIVATE
  </wpt>
  …
</gpx>
```

Notes:

- `<type>` sits directly under `<trk>` (standard GPX 1.1 position, after
  `<name>`).
- No `<extensions>`, no `hdop`/`speed`/`course` attributes, no `<metadata>`
  block, and no route (`<rte>`) elements were present in the inspected file.
- Every `trkpt` in the inspected file carried both `ele` and `time`, but the
  parser treats both as optional.

## Categories

Observed in the inspected week: `bus`, `metro`, `stationary`, `tram`,
`walking`.

Arc Timeline's full category set is larger; the app seeds colors for the
commonly seen ones and assigns deterministic fallback colors to anything new:
`walking`, `running`, `cycling`, `car`, `bus`, `train`, `tram`, `metro`,
`taxi`, `motorcycle`, `airplane`, `boat`, `scooter`, `skiing`, `stationary`,
`bogus`, plus unknown future values.

`bogus` is Arc's own junk/noise label — imported but marked
*ignored/hidden by default*.

## Scale (aggregate counts from one inspected week, 2021 era, ~650 KB)

| metric                | value                  |
| --------------------- | ---------------------- |
| tracks (`trk`)        | 66                     |
| segments (`trkseg`)   | 66 (always 1 per trk)  |
| points (`trkpt`)      | ~4,000                 |
| waypoints (`wpt`)     | ~40                    |
| points per segment    | min 0 · median 28 · max ~590 |

Newer weekly exports are ~5 MB → roughly 30k points/week at the same
points-per-byte density. A full 2016→present archive (~500 MB) lands around
**3–4 million points**, which comfortably fits a local SQLite index.

## Fixture

`fixtures/2000-W01-synthetic.gpx` reproduces this structure with entirely
fictional coordinates (a small grid near `0,0`) and fake timestamps
(ISO week 2000-W01). See `fixtures/README.md` for the rules.
