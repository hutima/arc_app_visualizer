# Arc Visualizer

A **local-first** Electron app for importing, indexing, cleaning, and
visualizing [Arc Timeline](https://bigpaua.com/arcapp) weekly GPX exports on a
dark map. Built around three priorities, in order: **privacy**,
**performance**, **maintainability**.

## Privacy

**Your location history never leaves your machine.**

- All parsing, indexing, and rendering happens locally. There is no server,
  no telemetry, no analytics, and no upload path in the codebase.
- Imported GPX files stay wherever you keep them (outside this repository);
  the app only reads them and builds a local SQLite index in your OS app-data
  directory (shown in the app's Stats panel):
  - Linux: `~/.config/arc-visualizer/arc-visualizer.db`
  - macOS: `~/Library/Application Support/arc-visualizer/arc-visualizer.db`
  - Windows: `%APPDATA%/arc-visualizer/arc-visualizer.db`
- `.gitignore` blocks `*.gpx`, `*.tcx`, `*.fit`, databases, and import
  directories from ever being committed. Only hand-authored **synthetic**
  fixtures (fake coordinates near 0,0, fake year-2000 timestamps) are allowed
  under `fixtures/` — see `fixtures/README.md` for the rules. Tests use
  synthetic data only.
- **One deliberate network exception:** the basemap. The default style is
  CARTO's dark-matter tile service, so the map's tile requests (which reveal
  the areas you look at) go to CARTO while you pan. If the style cannot be
  fetched (e.g. offline) the app automatically falls back to a plain dark
  background and still renders your tracks. To avoid tile traffic entirely,
  point `basemapStyleUrl` in `settings.json` (path shown in the Stats panel)
  at a local/self-hosted style, or an empty/unreachable URL to force the
  offline fallback.

### Repository history note

A real weekly export was committed to this repository early in its life. It
has been **removed from the working tree and from the entire git history**
(`git filter-repo`), and the rewritten history was force-pushed to GitHub.
If you cloned this repository before the rewrite, delete that clone and
re-clone; old clones still contain the file and must not be pushed. GitHub
may retain unreachable objects in caches for a while — a GitHub Support
"sensitive data removal" request is the thorough way to purge those.

## Quick start

```bash
npm install
npm run dev        # launch the app (Vite dev server + Electron)
npm test           # unit + pipeline tests (synthetic fixture only)
npm run typecheck  # strict TypeScript over main/preload/renderer
npm run build      # production bundles in out/
```

Requires Node 22.13+ (for `node:sqlite`). No native modules, no rebuild
steps — the SQLite engine ships inside Node/Electron.

Then, in the app: **Import folder…** → select the directory holding your
weekly `*.gpx` exports → watch progress → **Fit map to data**. Use the type
checkboxes, the **Track detail** selector (auto by zoom, pinned levels, or
all raw points), and date-range presets (`All time`, `Last year`, `90 days`,
`‹ wk`/`wk ›`) to slice the map.

## What it does

- Imports one file or whole folders, recursively, in a **background worker
  thread** — the UI never freezes during parsing/indexing.
- **Skips already-imported files** by SHA-256 content hash; interrupted
  imports are rolled back per file and redone safely on the next run.
- Indexes tracks/segments/points into SQLite (WAL), with bounds, time ranges,
  ISO week labels, and per-point **cleaning flags**:
  - invalid coordinates (out-of-range, NaN, exact 0,0)
  - consecutive duplicates
  - impossible speed spikes (per-type ceilings, configurable in
    `settings.json`)
  - time anomalies (backwards/frozen clocks)

  Flagged points are **kept** (never deleted) and excluded only from display
  geometry — cleaning is transparent, reversible, and reprocessable.
- Precomputes **three simplification levels** (Douglas–Peucker) per segment;
  by default the map requests the level matching the current zoom, so
  world-level views draw ~1–2% of raw points. A **Track detail** control lets
  you pin a level or render **every raw clean point** (`All points`) instead.
- Limits gracefully: when a viewport would exceed the point budget
  (`queryLimits.points` in `settings.json`, default 300k), auto mode steps to
  a coarser level and lines are **evenly thinned (endpoints kept)** — routes
  are never silently dropped to satisfy the budget.
- Renders with MapLibre GL on a dark or light basemap (sidebar selector,
  persisted in `settings.json`); basemap streets are dimmed
  (`roadDimOpacity`, default 0.35, `1` disables) so they never compete with
  tracks. One color per activity type,
  grouped by mode family so similar transit looks similar: motorcycle/scooter
  in warm oranges, bus joins the violet→pink mass-transit family with
  metro/tram/train, boat and kayaking share the blues, and airplane has red
  to itself. Car and taxi are deliberately **light grey** — visually
  de-emphasized as the least environmentally friendly modes. Unknown types
  get stable generated colors.
  Arc's `bogus` category is imported but ignored/hidden by default.
- **Color tracks by year** instead of type (sidebar toggle): each calendar
  year gets a stable golden-angle hue with a legend; type checkboxes still
  filter what shows. Click any type's **color swatch** to pick a custom
  color (persisted across launches; ↺ reverts to the default).
- Waypoints (Arc "visits") render as dots, toggleable like any type. Repeat
  visits of the same named place merge into **one dot at their average
  location** (per locality — chain names in different cities stay separate).
  Over the waypoint budget (`queryLimits.waypoints`, default 5k) places are
  additionally **spatially thinned** — one dot per grid cell, most recent
  visit wins — so every visited area stays represented; the sidebar shows
  `N of M places` when thinning.
- Viewport-aware: only segments intersecting the (padded) visible bounds and
  active date range are queried and shipped to the GPU, as one compact
  binary buffer rather than a giant GeoJSON clone.
- Records performance stats (import duration, points indexed, query/encode/
  decode/render times) in a `perf_log` table and shows them live in the
  sidebar.

## Performance

Measured in this environment on the built bundles running under Electron's
Node runtime, with synthetic data:

| operation | result |
| --- | --- |
| import throughput | ~61,000 points/sec (3 files, 105k points in 1.7 s) |
| index size | ~0.5× the source GPX size (incl. raw points + 3 display levels) |
| viewport query, 210 segments | 2–3 ms at every detail level |
| world-zoom display load | 1,638 pts shipped for 105k raw (~64× reduction) |

A full 2016→present archive (~500 MB ≈ 3–4M points) projects to roughly a
one-minute first import and a ~250 MB index; queries stay millisecond-level
because they're bounded by viewport + zoom, not dataset size.

Key design rules (see `docs/architecture.md` for the full picture):

- Parsing/indexing in a `worker_threads` worker with its own SQLite
  connection; one transaction per file; prepared statements throughout.
- Raw points are stored once; the renderer only ever receives simplified
  display geometry for the current viewport/zoom/filters.
- Geometry never enters React state — a `MapController` owns the MapLibre
  instance and decodes binary payloads directly into GeoJSON sources.
- Type visibility toggles are layer-filter updates (instant, no re-query);
  viewport/date changes are debounced queries.

## Project layout

```
src/shared/     types, category palette, geo math, binary geometry codec
src/main/       Electron main: window, IPC, SQLite (node:sqlite), settings
src/main/importer/  parse → clean → simplify → index pipeline + worker entry
src/preload/    contextBridge API (typed, minimal surface)
src/renderer/   React UI; map/MapController.ts owns all heavy data
tests/          vitest suites — synthetic fixture only
fixtures/       synthetic GPX fixture + fixture policy
docs/           Arc GPX schema notes, architecture
```

## Roadmap

- Canonical tracks for repeated transit routes (train/metro) instead of
  re-drawing every noisy trace.
- Optional fully-offline basemap via local PMTiles.
- Trip/track browser, raw-vs-clean inspector overlay, segment details.
- DB maintenance panel: reindex, clear imports, rebuild display geometry
  with new tolerances/cleaning rules.
- Recurring-route clustering.
