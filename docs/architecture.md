# Architecture

Priorities, in order: **privacy** (everything local), **performance**
(hundreds of files / millions of points without freezing), **maintainability**
(small typed modules, pure-Node core, tests against synthetic data).

## Process model

```
┌────────────────────────── Electron main ──────────────────────────┐
│ window/IPC wiring (ipc.ts)        SQLite read connection (WAL)    │
│ settings.json loader              viewport/category/summary SQL   │
│                                                                   │
│   spawns per import job:                                          │
│   ┌────────────── worker_threads: importWorker ────────────────┐  │
│   │ own SQLite connection (WAL writer)                         │  │
│   │ walk dirs → SHA-256 → dedupe → parseGpx → cleanSegment     │  │
│   │ → simplifyIndices ×3 levels → one transaction per file     │  │
│   │ → progress postMessage                                     │  │
│   └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────▲────────────────────────────────────┘
                       typed IPC│(contextBridge, invoke/send)
┌──────────────────────────────▼─────────────── renderer ───────────┐
│ React: small state only (filters, stats, progress)                │
│ MapController (plain TS class): owns MapLibre + ALL geometry      │
│   moveend/date-change → debounced IPC query → binary payload      │
│   → decode → setData on GeoJSON sources                           │
│   type toggles → layer filter update only (no re-query)           │
└────────────────────────────────────────────────────────────────────┘
```

Why this split:

- The renderer never parses files or touches the filesystem.
- The main process never does CPU-heavy work; imports run in a worker with
  its own connection. WAL mode lets the UI keep querying mid-import.
- `node:sqlite` (Node ≥22.13, Electron ≥35) avoids native-module rebuilds
  entirely (better-sqlite3 would need an Electron-ABI build that conflicts
  with running the same module under plain Node for tests).
- Everything in `src/main/importer` and `src/main/db` is pure Node, so
  vitest exercises the exact production code paths (`tests/importAndQuery.test.ts`).

## Data model (SQLite, WAL)

```
imported_files  hash-deduped file registry: sha256, size, mtime, iso week,
                time range, bounds, counts, import duration, status
tracks          one per <trk>: name, type, time range, bounds
segments        one per <trkseg>: type (denormalized), time range, bounds,
                point_count, clean_point_count, flags
points          raw archive: (segment_id, seq) PK, ts, lat/lon/ele, flags —
                flagged points are kept, never deleted
display_geometries  (segment_id, detail 0|1|2) → Float32 lon/lat blob,
                    Douglas–Peucker at 1e-3 / 1e-4 / 1e-5 deg from CLEAN points
waypoints       Arc visits: lat/lon, time, name
categories      name → color, visible (UI state), ignored (query-level)
perf_log        import/query timings
```

Spatial filtering uses plain min/max bounds columns with a covering index
instead of an R*Tree: a decade of Arc data is only ~35k segments, measured at
2–3 ms per viewport query, and it avoids depending on SQLite compile flags.
If segment counts ever grow 100×, swap `idx_segments_bbox` for an R*Tree
virtual table behind `queryViewportSegments` — callers won't change.

`points` keeps NULL lat/lon for unparsable coordinates (with the invalid
flag) so the raw archive is faithful enough to reprocess with future rules.

## Cleaning (flag, don't delete)

Per-point flag bits (`src/main/importer/clean.ts`):

| bit | meaning |
| --- | --- |
| 1 | invalid coordinate (NaN, out of range, exact 0,0) |
| 2 | exact consecutive duplicate (same lat/lon/ts) |
| 4 | speed spike vs last clean point (per-type ceilings, settings-overridable) |
| 8 | time anomaly (backwards clock, or frozen clock with >50 m movement) |

Segment `flags` is the OR of its point flags (plus 256 = empty segment).
Display geometry and bounds are built from clean points only; raw counts and
raw points remain untouched. `bogus` (Arc's junk label) is a category-level
ignore at query time, not a data deletion.

## Viewport pipeline

1. Renderer debounces `moveend` (200 ms), pads bounds 15%, picks nothing —
   the **main process** picks the detail level from zoom (`displayDetail.ts`:
   z<8→0, z<13→1, else 2).
2. SQL: bounds intersection + time-range overlap (NULL-tolerant) + ignored
   categories excluded + `LIMIT n+1` to detect truncation.
3. Rows are packed into one `ArrayBuffer` (`shared/geomCodec.ts`: type table
   + per-segment id/type/Float32 coords). Cloning one buffer over IPC is far
   cheaper than cloning nested GeoJSON, and decode is allocation-light.
4. `MapController` decodes into a single GeoJSON source; per-type color via
   a `match` expression; visibility via layer filter (no re-query); waypoint
   circles on a second source.
5. Stats (query/encode/decode/render ms, counts, truncation) surface in the
   sidebar and `perf_log`.

## Failure behavior

- Each file imports in one `BEGIN IMMEDIATE` transaction; failures roll back
  that file only, are recorded per file, and don't stop the batch.
- A file whose previous import was interrupted (status ≠ imported) is wiped
  and re-imported on the next run; hash dedupe keeps re-runs idempotent.
- If the basemap style fetch fails (offline), the map falls back to a plain
  dark background; tracks still render.
- Unreadable `settings.json` falls back to defaults rather than crashing.

## Deliberate v1 simplifications

- Track-level `<name>` values (often place names) are stored in the local DB
  for future UI but never rendered yet and never leave the machine.
- Degree-space simplification tolerances (slight over-simplification of
  longitude at high latitudes; raw data unaffected).
- Antimeridian-crossing viewports are not special-cased.
- Category visibility filtering happens client-side (instant toggles); the
  query still returns hidden-but-not-ignored types within the viewport.
