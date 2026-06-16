import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema'
import { KNOWN_CATEGORY_COLORS, IGNORED_BY_DEFAULT } from '../../shared/categories'

/**
 * Opens (and migrates) the local index database. Used by both the main
 * process (reads) and the import worker (writes): WAL mode lets the UI keep
 * querying while an import transaction is in flight.
 */
export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  syncKnownCategoryColors(db)
  return db
}

/**
 * The curated palette is code-owned: refresh previously seeded rows whenever
 * it changes, so existing databases pick up new colors on the next launch.
 * Categories the palette does not know keep their import-time generated
 * color, and user-customized colors (custom = 1) are never touched.
 */
function syncKnownCategoryColors(db: DatabaseSync): void {
  const update = db.prepare(
    'UPDATE categories SET color = ? WHERE name = ? AND color <> ? AND custom = 0'
  )
  for (const [name, color] of Object.entries(KNOWN_CATEGORY_COLORS)) {
    update.run(color, name, color)
  }
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (row.user_version >= SCHEMA_VERSION) return
  db.exec('BEGIN')
  try {
    // v7: rail edges become canonical (a < b) and unique so overlapping
    // region fetches dedupe; v6 rows must comply before SCHEMA_SQL can
    // create the unique index. (SET a = b, b = a reads the old row, so it
    // swaps.)
    if (row.user_version === 6) {
      db.exec('UPDATE rail_edges SET a = b, b = a WHERE a > b')
      db.exec('DELETE FROM rail_edges WHERE id NOT IN (SELECT MIN(id) FROM rail_edges GROUP BY a, b)')
    }
    db.exec(SCHEMA_SQL)
    // v3/v4/v9: CREATE IF NOT EXISTS cannot add columns to pre-existing tables.
    ensureColumn(db, 'categories', 'custom', 'custom INTEGER NOT NULL DEFAULT 0')
    ensureColumn(db, 'categories', 'priority', 'priority INTEGER')
    // v9: pre-existing edges have no stored kind (0 = unknown, matches any
    // mode); re-fetching an area populates real kinds and constrains matching.
    ensureColumn(db, 'rail_edges', 'kind', 'kind INTEGER NOT NULL DEFAULT 0')
    // v10: existing coverage rows predate the split; default them to 'rail'
    // (re-fetch road tunnels to gate car-gap bridging).
    ensureColumn(db, 'rail_coverage', 'category', "category TEXT NOT NULL DEFAULT 'rail'")
    // v12: place_id links a visit to a user-merged place. Add the column before
    // its index (CREATE INDEX in SCHEMA_SQL can't reference a not-yet-added
    // column on pre-existing waypoints tables), then index it here.
    ensureColumn(db, 'waypoints', 'place_id', 'place_id INTEGER')
    db.exec('CREATE INDEX IF NOT EXISTS idx_waypoints_place ON waypoints(place_id)')
    // v13: place pins resolve their full same-name cluster every viewport query
    // (so they don't drift with zoom); index name to keep that lookup cheap.
    db.exec('CREATE INDEX IF NOT EXISTS idx_waypoints_name ON waypoints(name)')
    // v15: inserted vertices can carry an explicit timestamp (the bulk archetype
    // apply stores each track's layered timing). NULL on older rows keeps the
    // by-seq interpolation behavior unchanged.
    ensureColumn(db, 'segment_edits', 'ts_ms', 'ts_ms INTEGER')
    seedCategories(db)
    // v5: 'unknown' joins 'bogus' as excluded-by-default (existing databases
    // seeded it visible before this rule existed).
    db.prepare("UPDATE categories SET ignored = 1, visible = 0 WHERE name = 'unknown'").run()
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  }
}

function seedCategories(db: DatabaseSync): void {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO categories (name, color, visible, ignored) VALUES (?, ?, ?, ?)'
  )
  for (const [name, color] of Object.entries(KNOWN_CATEGORY_COLORS)) {
    const ignored = IGNORED_BY_DEFAULT.has(name) ? 1 : 0
    insert.run(name, color, ignored ? 0 : 1, ignored)
  }
}
