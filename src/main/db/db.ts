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
    db.exec(SCHEMA_SQL)
    // v3/v4: CREATE IF NOT EXISTS cannot add columns to pre-existing tables.
    ensureColumn(db, 'categories', 'custom', 'custom INTEGER NOT NULL DEFAULT 0')
    ensureColumn(db, 'categories', 'priority', 'priority INTEGER')
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
