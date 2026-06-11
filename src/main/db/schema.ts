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
// v2: idx_waypoints_bbox; v3: categories.custom; v4: categories.priority
export const SCHEMA_VERSION = 4

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
  lon     REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_waypoints_file ON waypoints(file_id);
-- Viewport waypoint queries fetch all rows in bounds (then thin in JS).
CREATE INDEX IF NOT EXISTS idx_waypoints_bbox ON waypoints(lat, lon);

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
`
