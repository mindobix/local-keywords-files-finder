-- Enable WAL mode for concurrent reads during crawl + API serving.
-- Applied once at DB open time via PRAGMA, not stored here.

CREATE TABLE IF NOT EXISTS files (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  path         TEXT    NOT NULL UNIQUE,
  hash         TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  ext          TEXT    NOT NULL,
  size_bytes   INTEGER,
  row_count    INTEGER,
  col_count    INTEGER,
  columns      TEXT,          -- JSON array of column name strings
  col_types    TEXT,          -- JSON object mapping colName → 'date'|'number'|'string'
  categories   TEXT,          -- JSON array e.g. ["Finance","Payroll"]
  sub_category TEXT,          -- single sub-category string or null
  hits           TEXT,         -- JSON array of matched keyword strings
  parse_error  TEXT,          -- error message if file could not be parsed, else null
  is_new       INTEGER DEFAULT 1,   -- 1 until user opens the file via the UI
  is_deleted   INTEGER DEFAULT 0,   -- 1 when chokidar fires 'unlink'
  is_duplicate INTEGER DEFAULT 0,   -- 1 when another file with the same hash was indexed first
  discovered   INTEGER,       -- unix timestamp (seconds)
  modified     INTEGER,       -- unix timestamp (seconds) from fs.stat
  last_scanned INTEGER        -- unix timestamp (seconds)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- User-editable taxonomy stored in DB so it can be CRUD'd from the UI.
-- taxonomy_categories holds top-level categories; taxonomy_subcategories holds children.
CREATE TABLE IF NOT EXISTS taxonomy_categories (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL UNIQUE,
  color        TEXT    NOT NULL DEFAULT '#888780',
  path_hints   TEXT    NOT NULL DEFAULT '[]',   -- JSON string[] matched against path segments
  header_hints TEXT    NOT NULL DEFAULT '[]',   -- JSON string[] matched against column headers
  sort_order   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS taxonomy_subcategories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES taxonomy_categories(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  path_hints  TEXT    NOT NULL DEFAULT '[]',
  header_hints TEXT   NOT NULL DEFAULT '[]',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(category_id, name)
);

CREATE TABLE IF NOT EXISTS keywords_builtin (
  keyword TEXT PRIMARY KEY,
  builtin INTEGER DEFAULT 0  -- 1 = shipped built-in, 0 = user-added
);
