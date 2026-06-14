/**
 * SQLite schema. Design notes:
 *
 * - `points` preserves every raw point with its cleaning flags (reprocessable
 *   forever); `display_geometries` holds the simplified per-zoom polylines
 *   the map actually renders.
 * - Spatial filtering uses plain min/max bounds columns. A decade of Arc
 *   data is only ~tens of thousands of segments, so a covering-index scan
 *   answers viewport queries in milliseconds without requiring the R*Tree
 *   extension (not guaranteed in node:sqlite builds).
 * - `points` and `display_geometries` are WITHOUT ROWID, clustered by
 *   (segment_id, ...) so a segment's data is contiguous on disk.
 */
// v2: idx_waypoints_bbox; v3: categories.custom; v4: categories.priority;
// v5: 'unknown' ignored by default; v6: OSM rail network tables;
// v7: rail regions accumulate (canonical a<b edges, unique (a,b));
// v8: rail_matched_geom (cached map-matched rail geometry, per detail level);
// v9: rail_edges.kind (OSM railway kind — type-constrained matching);
// v10: rail_coverage.category ('rail' | 'road' — fetched & gated separately);
// v11: segment_edits (user track edits as an overlay on raw points);
// v12: places + waypoints.place_id (user-merged stationary places);
// v13: idx_waypoints_name (full-cluster place pins resolve same-name visits)
export const SCHEMA_VERSION = 13

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS imported_files (
  id            INTEGER PRIMARY KEY,
  filename      TEXT NOT NULL,
  source_path   TEXT NOT NULL,
  file_hash     TEXT NOT NULL UNIQUE,
  file_size     INTEGER NOT NULL,
  file_mtime_ms INTEGER,
  imported_at_ms INTEGER NOT NULL,
  iso_year      INTEGER,
  iso_week      INTEGER,
  start_ts_ms   INTEGER,
  end_ts_ms     INTEGER,
  min_lat REAL, min_lon REAL, max_lat REAL, max_lon REAL,
  track_count    INTEGER NOT NULL DEFAULT 0,
  segment_count  INTEGER NOT NULL DEFAULT 0,
  point_count    INTEGER NOT NULL DEFAULT 0,
  waypoint_count INTEGER NOT NULL DEFAULT 0,
  import_ms     REAL,
  status        TEXT NOT NULL DEFAULT 'imported',
  error         TEXT
);

CREATE TABLE IF NOT EXISTS tracks (
  id          INTEGER PRIMARY KEY,
  file_id     INTEGER NOT NULL REFERENCES imported_files(id) ON DELETE CASCADE,
  name        TEXT,
  type        TEXT NOT NULL,
  start_ts_ms INTEGER,
  end_ts_ms   INTEGER,
  min_lat REAL, min_lon REAL, max_lat REAL, max_lon REAL
);
CREATE INDEX IF NOT EXISTS idx_tracks_file ON tracks(file_id);

CREATE TABLE IF NOT EXISTS segments (
  id          INTEGER PRIMARY KEY,
  track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  file_id     INTEGER NOT NULL,
  type        TEXT NOT NULL,
  start_ts_ms INTEGER,
  end_ts_ms   INTEGER,
  point_count       INTEGER NOT NULL,
  clean_point_count INTEGER NOT NULL,
  min_lat REAL, min_lon REAL, max_lat REAL, max_lon REAL,
  flags       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_segments_track ON segments(track_id);
CREATE INDEX IF NOT EXISTS idx_segments_file ON segments(file_id);
-- Covering index for viewport queries: bounds + filters resolved index-only.
CREATE INDEX IF NOT EXISTS idx_segments_bbox
  ON segments(min_lat, max_lat, min_lon, max_lon, type, start_ts_ms, end_ts_ms);

CREATE TABLE IF NOT EXISTS points (
  segment_id INTEGER NOT NULL,
  seq        INTEGER NOT NULL,
  ts_ms      INTEGER,
  lat        REAL,
  lon        REAL,
  ele        REAL,
  flags      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (segment_id, seq)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS display_geometries (
  segment_id  INTEGER NOT NULL,
  detail      INTEGER NOT NULL,
  point_count INTEGER NOT NULL,
  coords      BLOB NOT NULL,
  PRIMARY KEY (segment_id, detail)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS waypoints (
  id      INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES imported_files(id) ON DELETE CASCADE,
  name    TEXT,
  ts_ms   INTEGER,
  lat     REAL NOT NULL,
  lon     REAL NOT NULL,
  place_id INTEGER -- user-merged place (places.id); NULL = clustered by name only
);
CREATE INDEX IF NOT EXISTS idx_waypoints_file ON waypoints(file_id);
-- Viewport waypoint queries fetch all rows in bounds (then thin in JS).
CREATE INDEX IF NOT EXISTS idx_waypoints_bbox ON waypoints(lat, lon);

-- User-merged places: a stable identity + chosen name for a set of visits
-- (waypoints.place_id), overriding the display-time name+proximity clustering
-- so far-apart or differently-named visits can be combined into one pin. Plain
-- INTEGER link (no FK), like points.segment_id; integrity is managed in code
-- (orphaned places are pruned after a merge). The idx_waypoints_place index is
-- created in migrate(), after place_id is ensured on pre-existing databases.
CREATE TABLE IF NOT EXISTS places (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  name    TEXT PRIMARY KEY,
  color   TEXT NOT NULL,
  visible INTEGER NOT NULL DEFAULT 1,
  ignored INTEGER NOT NULL DEFAULT 0,
  custom  INTEGER NOT NULL DEFAULT 0, -- 1 = user-picked color, never auto-refreshed
  priority INTEGER                    -- draw/list order, 0 = top; NULL = unordered
);

CREATE TABLE IF NOT EXISTS perf_log (
  id          INTEGER PRIMARY KEY,
  at_ms       INTEGER NOT NULL,
  op          TEXT NOT NULL,
  duration_ms REAL NOT NULL,
  detail      TEXT
);

-- OSM rail network for offline snapping. Regions are fetched one viewport at
-- a time and accumulate; edges store a < b so overlapping fetches dedupe.
-- ids are OSM node ids; geometry is plain lat/lon (no R*Tree dependency).
CREATE TABLE IF NOT EXISTS rail_nodes (
  id  INTEGER PRIMARY KEY,
  lat REAL NOT NULL,
  lon REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS rail_edges (
  id INTEGER PRIMARY KEY,
  a  INTEGER NOT NULL,
  b  INTEGER NOT NULL,
  kind INTEGER NOT NULL DEFAULT 0, -- OSM way kind (RAIL_KIND; incl. road tunnels); 0 = unknown/any rail
  min_lat REAL, min_lon REAL, max_lat REAL, max_lon REAL
);
CREATE INDEX IF NOT EXISTS idx_rail_edges_bbox
  ON rail_edges(min_lat, max_lat, min_lon, max_lon);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rail_edges_ab ON rail_edges(a, b);

-- Bounding boxes already fetched, per layer ('rail' or 'road'): shows
-- coverage, and gates matching so rides keep raw GPS wherever they leave
-- their layer's fetched areas.
CREATE TABLE IF NOT EXISTS rail_coverage (
  id          INTEGER PRIMARY KEY,
  category    TEXT NOT NULL DEFAULT 'rail',
  min_lat REAL, min_lon REAL, max_lat REAL, max_lon REAL,
  fetched_at_ms INTEGER NOT NULL,
  node_count  INTEGER NOT NULL,
  edge_count  INTEGER NOT NULL
);

-- Cached map-matched rail geometry. Matching raw points against the network
-- is too heavy to run per viewport, so it runs once after a fetch and is
-- stored here, simplified into the same per-zoom detail levels as
-- display_geometries; the viewport query swaps it in for rail segments that
-- have it. Rebuilt wholesale when coverage changes; absent ⇒ ride shows raw.
CREATE TABLE IF NOT EXISTS rail_matched_geom (
  segment_id  INTEGER NOT NULL,
  detail      INTEGER NOT NULL,
  point_count INTEGER NOT NULL,
  coords      BLOB NOT NULL,
  PRIMARY KEY (segment_id, detail)
) WITHOUT ROWID;

-- User track edits: an overlay on raw points. A row at an existing integer
-- seq moves that point; a row at a fractional seq inserts a vertex between
-- its neighbors. Drafts live here indefinitely (raw points untouched,
-- revertible) until the user saves permanently, which bakes the overlay
-- into points and clears it. Applied wherever raw points are read for
-- display or map-matching, so edits always precede rail/road snapping.
CREATE TABLE IF NOT EXISTS segment_edits (
  segment_id   INTEGER NOT NULL,
  seq          REAL NOT NULL,
  kind         INTEGER NOT NULL DEFAULT 0, -- 0 = move, 1 = insert, 2 = delete
  lat          REAL NOT NULL,
  lon          REAL NOT NULL,
  edited_at_ms INTEGER NOT NULL,
  PRIMARY KEY (segment_id, seq)
) WITHOUT ROWID;
`
