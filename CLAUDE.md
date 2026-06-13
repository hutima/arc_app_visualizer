# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

**Arc Visualizer** — a local-first Electron desktop app for importing, indexing,
and visualizing [Arc Timeline](https://arctimeline.com) weekly **GPX** exports
(years of personal location history) on an interactive map.

Priorities, in order: **privacy → performance → maintainability.** Every design
choice should preserve all three; when they conflict, the earlier one wins.

## Commands

```bash
npm run dev        # electron-vite dev (launch the app with HMR)
npm run build      # production build to out/
npm test           # vitest run (the gate — keep it green)
npm run test:watch # vitest watch
npm run typecheck  # tsc --noEmit (also a gate)
```

Before committing, **`npm run typecheck && npm test` must both pass.** The GUI
can't be launched in CI/headless sandboxes — logic lives behind testable
functions exactly so it can be verified without the GUI.

## Privacy rules (non-negotiable)

- **Never commit real location data.** `.gitignore` blocks `*.gpx/*.tcx/*.fit`,
  local SQLite DBs, and import/cache dirs. Only **synthetic, hand-authored**
  fixtures under `fixtures/` are allowed (fake coords near 0,0, fake timestamps).
- Imported data and the SQLite index live **outside the repo**, in Electron's
  `userData` dir. Tests use synthetic data only.
- The app makes **exactly one** kind of network call: the OSM/Overpass rail
  fetch the user explicitly triggers (see Rail subsystem). Everything else is
  offline. Don't add network calls without a very good, user-visible reason.

## Architecture

Electron + electron-vite + React 19 + TypeScript (strict) + MapLibre GL.
SQLite via Node's built-in **`node:sqlite`** (no native module — tests exercise
the exact production code paths; note it's still flagged experimental).

```
src/
  main/        Electron main process (Node): DB, IPC, import worker, rail
    db/        schema.ts, db.ts (open+migrate), queries.ts, railStore.ts, railAverage.ts
    importer/  parseGpx, clean, simplify, importFiles (+ importWorker thread)
    rail/      overpass.ts (fetch+parse), snapRail.ts (matcher), buildMatches.ts (cache pass)
    ipc.ts     all ipcMain.handle handlers; the main↔renderer contract
    index.ts   app entry, window creation
  preload/     contextBridge → window.api (must mirror ArcApi in shared/types.ts)
  renderer/    React UI
    src/map/MapController.ts   owns MapLibre; geometry lives here, NOT in React state
    src/components/*.tsx       sidebar panels
    src/App.tsx                wiring + state
  shared/      types.ts (IPC contract), categories, displayDetail, geomCodec, geo, yearColors
tests/         vitest; *.test.ts mirror the module they cover
```

### Data flow

1. **Import** (worker thread, `importWorker.ts`): parse GPX → clean (flag, never
   delete) → write to SQLite. SHA-256 dedupe; per-file transactions; progress
   events; UI never blocks. Re-running a partial import self-heals.
2. **Index** (`schema.ts`): `points` keeps every raw point with cleaning flags
   (reprocessable forever); `display_geometries` holds per-zoom Douglas–Peucker
   simplifications (`DETAIL_LEVELS` in `shared/displayDetail.ts`) — what the map
   actually draws.
3. **Query** (`queries.ts`): viewport bbox + time + category filter → rows.
   Encoded to a compact **binary buffer** (`shared/geomCodec.ts`) for IPC, decoded
   outside React state and handed to MapController.
4. **Render** (`MapController.ts`): MapLibre source/layers; instant type toggles
   via layer filters; coloring by type or year.

### Key invariants & gotchas

- **`ORDER BY` before any `LIMIT`** on segment/waypoint queries. A bare `LIMIT`
  with no order served rows in import order and silently dropped whole eras /
  regions — this bug class has bitten **three times** (segments, waypoints,
  rail edges). When capping, shed *least* important rows deterministically
  (e.g. `point_count DESC`), never an arbitrary prefix.
- **A route/place must never vanish because the viewport got busy.** Over budget
  → downsample/thin uniformly (keep endpoints), don't drop features.
- **SQLite BLOB → Float32Array byte alignment:** blobs come back byte-aligned
  copies; build the `Float32Array` view defensively
  (`coords.byteOffset % 4 === 0 ? view : copy`). See `decimateRow`, the ipc
  encode loop, `floatView`.
- **Geometry never lives in React state** — it's in MapController. React holds
  small objects (stats, category lists, progress) only.
- Cleaning is **display-only**: flag/transform what's shown; raw points are
  never mutated.

### Schema migrations

`schema.ts` holds `SCHEMA_VERSION` and `SCHEMA_SQL` (all `CREATE … IF NOT
EXISTS`). `db.ts::migrate()` runs `SCHEMA_SQL` then version-specific fixups
inside one transaction, bumping `PRAGMA user_version`. To change schema:

1. Add/modify DDL in `SCHEMA_SQL` (idempotent).
2. Bump `SCHEMA_VERSION` and append a one-line history comment.
3. If pre-existing rows need fixing (new column, dedupe), add a guarded step in
   `migrate()` keyed on the *old* `user_version` (see the v6→v7 edge
   canonicalization). `CREATE IF NOT EXISTS` can't add columns — use
   `ensureColumn`.

Current version: **8**. History is in the comment above `SCHEMA_VERSION`.

## Rail / OSM snapping subsystem

The most-iterated feature. Cleans noisy metro/tram/train GPS (worst in tunnels,
where OSM is best) by map-matching rides onto real OSM rail geometry.

- **`rail/overpass.ts`** — builds the Overpass query, parses JSON → nodes/edges
  (pure, unit-tested), and `fetchRailNetwork` (the only network call). It
  **falls back across mirrors** on 429/5xx/network errors, fails fast on 4xx,
  sends an identifying `User-Agent` (Overpass 406s anonymous requests), and
  surfaces the server's error text.
- **`db/railStore.ts`** — fetched regions **accumulate** one viewport at a time
  (load each city separately). Two **layers** fetched & gated independently
  (`rail_coverage.category` = `'rail'` | `'road'`): transit track vs highway
  tunnels. Nodes dedupe by OSM id; edges stored canonically (`a < b`, unique)
  with their OSM `railway`/road **kind** (`rail_edges.kind`, `RAIL_KIND`;
  re-fetch upserts the kind onto legacy `0`/unknown rows). Per-layer coverage
  bboxes gate matching. `rail_matched_geom` caches the matched output;
  `clearRailNetwork` wipes everything.
- **`rail/snapRail.ts` (`matchRideToRail`)** — the matcher. **Segment-local, not
  all-or-nothing:** anchor each vertex to the nearest point on the *track* (edge
  distance — OSM nodes are sparse on straight runs), join consecutive anchors by
  Dijkstra along the graph (fills tunnels, crosses lines via transfer edges),
  and **keep raw GPS** for any stretch that's off-network/off-coverage or a gap
  too long to route. **Contiguity:** anchoring is sticky to the previous
  vertex's *track component* (`graph.comp`, union-find over real edges only) so
  a noisy point near a parallel line doesn't flip the ride onto it, and transfer
  edges carry a flat penalty (`TRANSFER_PENALTY_DEG`) so fills prefer one track
  and transfer only at genuine interchanges. **Time plausibility:** fills are
  gated by elapsed time (raw `points.ts_ms` flows through `buildMatches`) — a
  fill far too short for its dt is an unseen out-and-back, and instead of a
  track jump the matcher emits a **NaN break sentinel** (a deliberate gap;
  parts survive simplification/decimation and render as MultiLineString).
  Covered-but-unanchored *tunnel scatter* inside a run is judged by the next
  anchor: `rescueRoute` re-anchors it at `RESCUE_ANCHOR_SCALE`× the radius and
  routes through it (recovering e.g. a downtown out-and-back, length checked
  against dt both ways), and scatter explained by an accepted fill is dropped
  (display-only point rejection). The user-facing ranges (`RailTuning`: snap
  radius, transfer radius — meters) live in `settings.json` under `rail` and in
  the Cleaning panel ("Apply & re-match" persists + rebuilds); gap factor/
  slack, soft bridge, transfer penalty, time gates stay constants.
- **`rail/buildMatches.ts`** — runs the matcher over every rail ride's **raw
  points** once (not zoom-simplified geometry), simplifies into the per-zoom
  detail levels, and caches in `rail_matched_geom`. **Type-constrained:** builds
  one graph per Arc mode filtered to its allowed kinds
  (`ALLOWED_KINDS_BY_TYPE` — metro→subway/light-rail, train→rail, tram→
  tram/light-rail), so a metro ride can't snap to a parallel commuter line.
  Each graph keeps **only nodes its kept edges reference** — otherwise transfer
  edges chain across a foreign line's orphaned nodes and route across modes.
  **Road tunnels** (`RAIL_KIND.road_tunnel`, fetched as `highway` + `tunnel`
  ways only) are a separate path with **its own UI toggle** (`snapRoad`; the
  viewport query swaps cached geometry per type group per toggle): car/taxi/
  bus trips are never map-matched, but a GPS **dropout window** that's
  anomalous for that trip (an absolute floor *and* ≥ a multiple of the trip's
  median point spacing) whose flanks anchor near tunnel geometry is bridged by
  routing through it (`bridgeRoadGaps`, time-gated like rail) — and the
  scatter *inside* a bridged window is dropped rather than drawn as a fan.
  Un-bridgeable windows keep every raw point.
  Heavy → runs after a fetch (auto) with chunked progress, **not** per viewport.
  The viewport query `COALESCE`s the cached line in under snap mode.

Snapping **supersedes averaging** (`railAverage.ts`, the no-network fallback) —
they're mutually exclusive in the query and the UI.

If snapping looks wrong: check the **Stats panel** ("X of Y rail rides snapped")
and `perf_log` (`railSnap=X/Y`, `rail.match`). Most "nothing snapped" causes are
type-name mismatch (`RAIL_SNAP_TYPES`), missing coverage, or tunables too tight.

## Conventions

- TS is **strict** with `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`.
  Indexed access yields `T | undefined` — assert (`arr[i]!`) only when you've
  reasoned it's safe.
- **The IPC contract is `ArcApi` in `shared/types.ts`.** Any new IPC needs:
  handler in `ipc.ts`, method in `preload/index.ts`, and the signature in
  `ArcApi` — all three, or typecheck/runtime breaks.
- Match the surrounding **comment style**: short "why", not "what". Explain
  non-obvious decisions and bug-class guards.
- Every new module gets a `tests/*.test.ts`; prefer testing pure functions over
  end-to-end. In-memory DB tests use `openDb(':memory:')`.
- Commit messages: a "why" subject line + body explaining the reasoning. Do not
  put model identifiers in commits/PRs/code.
