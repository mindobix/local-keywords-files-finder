/**
 * crawler/db.js
 *
 * better-sqlite3 wrapper. Designed to be instantiated independently in both
 * the main thread (read-only API queries) and the worker thread (writes during
 * crawl). WAL mode lets both connections run concurrently without blocking.
 *
 * Usage:
 *   import { openDb } from './db.js';
 *   const db = openDb();          // opens/creates ./db/explorer.db
 */

import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "db", "explorer.db");
const SCHEMA = join(__dirname, "..", "db", "schema.sql");

// Built-in keywords shipped with the app. Users can add their own via the
// settings panel; those are stored with builtin=0.
const BUILTIN_KEYWORDS = [
  "financial",
  "tax",
  "loans",
  "payroll",
  "salary",
  "invoice",
  "budget",
  "insurance",
  "banking",
  "payment",
  "revenue",
  "expense",
  "audit",
  "contract",
  "benefits",
];

// Default settings applied on first run.
const DEFAULT_SETTINGS = {
  alert_on_new: "true",
  crawler_running: "true",
  anthropic_api_key: "",
  ai_categorization: "true",
};

// Default keywords seeded on first run.
const DEFAULT_TAXONOMY = [
  {
    name: "financial",
    pathHints: ["financial", "finance", "finances"],
    headerHints: ["financial", "finance", "amount", "balance", "total"],
  },
  {
    name: "tax",
    pathHints: ["tax", "taxes", "taxation"],
    headerHints: ["tax", "taxes", "tax_id", "tax_year", "taxable"],
  },
  {
    name: "loans",
    pathHints: ["loan", "loans", "lending"],
    headerHints: ["loan", "loan_id", "loan_amount", "lending", "borrower"],
  },
  {
    name: "payroll",
    pathHints: ["payroll", "pay_roll"],
    headerHints: ["payroll", "pay_period", "gross_pay", "net_pay", "deduction"],
  },
  {
    name: "salary",
    pathHints: ["salary", "salaries", "compensation"],
    headerHints: ["salary", "wage", "wages", "hourly_rate", "compensation"],
  },
  {
    name: "invoice",
    pathHints: ["invoice", "invoices", "billing"],
    headerHints: ["invoice", "invoice_id", "invoice_number", "billed", "due_date"],
  },
  {
    name: "budget",
    pathHints: ["budget", "budgets", "forecast"],
    headerHints: ["budget", "budgeted", "forecast", "planned", "actual"],
  },
  {
    name: "insurance",
    pathHints: ["insurance", "insured", "policy"],
    headerHints: ["insurance", "policy", "policy_number", "premium", "coverage"],
  },
  {
    name: "banking",
    pathHints: ["bank", "banking", "account"],
    headerHints: ["bank", "account_number", "routing", "iban", "swift"],
  },
  {
    name: "payment",
    pathHints: ["payment", "payments", "transaction"],
    headerHints: ["payment", "transaction", "transaction_id", "paid", "amount_paid"],
  },
  {
    name: "revenue",
    pathHints: ["revenue", "sales", "income"],
    headerHints: ["revenue", "sales", "income", "earnings", "gross"],
  },
  {
    name: "expense",
    pathHints: ["expense", "expenses", "expenditure"],
    headerHints: ["expense", "expenses", "expenditure", "cost", "spend"],
  },
  {
    name: "audit",
    pathHints: ["audit", "audits", "compliance"],
    headerHints: ["audit", "audit_id", "auditor", "compliance", "finding"],
  },
  {
    name: "contract",
    pathHints: ["contract", "contracts", "agreement"],
    headerHints: ["contract", "contract_id", "agreement", "vendor", "effective_date"],
  },
  {
    name: "benefits",
    pathHints: ["benefit", "benefits", "perks"],
    headerHints: ["benefit", "benefits", "pension", "pto", "vacation"],
  },
];

/**
 * Opens (or creates) the SQLite database, applies the schema, enables WAL
 * mode, and seeds default data on first run.
 *
 * @returns {import('better-sqlite3').Database}
 */
export function openDb() {
  // On --fresh startups the indexer and API server both race to open the same
  // newly-created file. Retry with a short delay so the loser waits for the
  // winner to finish WAL initialisation rather than crashing immediately.
  const MAX_ATTEMPTS = 12;
  const DELAY_MS = 500;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let db;
    try {
      // timeout passed to the constructor calls sqlite3_busy_timeout() before
      // any SQL runs, but the WAL exclusive-lock window is too short for it to
      // help reliably — hence the outer retry loop.
      db = new Database(DB_PATH, { timeout: 5000 });

      // WAL (Write-Ahead Logging) allows concurrent readers while a writer is
      // active — essential because the crawler worker writes while the API
      // thread reads. Standard journal mode would serialize all access.
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");

      // Apply schema DDL (idempotent due to IF NOT EXISTS clauses).
      const schema = readFileSync(SCHEMA, "utf8");
      db.exec(schema);

      // Column migrations for existing DBs (SQLite has no ADD COLUMN IF NOT EXISTS).
      const migrations = [
        "ALTER TABLE files ADD COLUMN is_duplicate    INTEGER DEFAULT 0",
        "ALTER TABLE files ADD COLUMN is_uncategorized INTEGER DEFAULT 0",
        "ALTER TABLE files ADD COLUMN sample_data     TEXT    DEFAULT NULL",
        // Rename pii_hits → hits
        "ALTER TABLE files RENAME COLUMN pii_hits TO hits",
        // Rename pii_keywords table → keywords_builtin
        "ALTER TABLE pii_keywords RENAME TO keywords_builtin",
      ];
      for (const sql of migrations) {
        try {
          db.exec(sql);
        } catch {
          /* column/table already migrated or doesn't exist */
        }
      }
      // Migrate setting key: alert_on_new_pii → alert_on_new
      try {
        const old = db.prepare("SELECT value FROM settings WHERE key = 'alert_on_new_pii'").get();
        if (old) {
          db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('alert_on_new', ?)").run(old.value);
          db.prepare("DELETE FROM settings WHERE key = 'alert_on_new_pii'").run();
        }
      } catch { /* table may not exist yet */ }

      seedDefaults(db);
      promoteSubcategoriesToKeywords(db);
      return db;
    } catch (err) {
      try {
        db?.close();
      } catch {}
      if (err.code !== "SQLITE_BUSY" || attempt === MAX_ATTEMPTS - 1) throw err;
      console.warn(
        `[DB] Busy — retrying in ${DELAY_MS}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, DELAY_MS);
    }
  }
}

/**
 * Deterministically generate a vivid color from a keyword name.
 * Uses golden-angle hue distribution for even spread across the spectrum.
 */
export function autoColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++)
    h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  const hue = Math.abs(h * 137 + 60) % 360; // golden-angle spread
  const sat = 58 + (Math.abs(h >> 8) % 14); // 58-72 %
  const lit = 46 + (Math.abs(h >> 4) % 12); // 46-58 %
  return `hsl(${hue}, ${sat}%, ${lit}%)`;
}

/**
 * One-time migration: promote all subcategories to top-level keywords so the
 * taxonomy is flat. Runs every startup but is a no-op when the table is empty.
 */
function promoteSubcategoriesToKeywords(db) {
  const subs = db.prepare("SELECT * FROM taxonomy_subcategories").all();
  if (subs.length === 0) return;

  const maxOrder = db
    .prepare(
      "SELECT COALESCE(MAX(sort_order), -1) AS n FROM taxonomy_categories",
    )
    .get().n;
  const exists = db.prepare(
    "SELECT id FROM taxonomy_categories WHERE name = ?",
  );
  const insert = db.prepare(
    "INSERT INTO taxonomy_categories (name, color, path_hints, header_hints, sort_order) VALUES (?, ?, ?, ?, ?)",
  );

  db.transaction(() => {
    subs.forEach((sub, i) => {
      if (!exists.get(sub.name)) {
        insert.run(
          sub.name,
          autoColor(sub.name),
          sub.path_hints,
          sub.header_hints,
          maxOrder + i + 1,
        );
      }
    });
    db.prepare("DELETE FROM taxonomy_subcategories").run();
  })();

  console.log(
    `[DB] Promoted ${subs.length} subcategories to top-level keywords.`,
  );
}

/** Seed built-in keywords, default settings, and default taxonomy on first run. */
function seedDefaults(db) {
  const existingKw = db.prepare("SELECT COUNT(*) AS n FROM keywords_builtin").get();
  if (existingKw.n === 0) {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO keywords_builtin (keyword, builtin) VALUES (?, 1)",
    );
    const seedAll = db.transaction((kws) =>
      kws.forEach((kw) => insert.run(kw)),
    );
    seedAll(BUILTIN_KEYWORDS);
  }

  const setSetting = db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
  );
  const seedSettings = db.transaction((entries) =>
    entries.forEach(([k, v]) => setSetting.run(k, v)),
  );
  seedSettings(Object.entries(DEFAULT_SETTINGS));

  // Seed keywords only when the table is empty (first run or after clear).
  const existingTax = db
    .prepare("SELECT COUNT(*) AS n FROM taxonomy_categories")
    .get();
  if (existingTax.n === 0) {
    const insCategory = db.prepare(
      "INSERT INTO taxonomy_categories (name, color, path_hints, header_hints, sort_order) VALUES (?, ?, ?, ?, ?)",
    );
    db.transaction(() => {
      DEFAULT_TAXONOMY.forEach((kw, i) => {
        insCategory.run(
          kw.name,
          autoColor(kw.name),
          JSON.stringify(kw.pathHints),
          JSON.stringify(kw.headerHints),
          i,
        );
      });
    })();
  }
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

/**
 * Insert or update a file record. All JSON fields are serialized here so
 * callers work with plain JS objects/arrays.
 */
export function upsertFile(db, record) {
  const stmt = db.prepare(`
    INSERT INTO files
      (path, hash, name, ext, size_bytes, row_count, col_count,
       columns, col_types, sample_data, categories, sub_category, hits,
       parse_error, is_new, is_deleted, is_duplicate, discovered, modified, last_scanned)
    VALUES
      (@path, @hash, @name, @ext, @size_bytes, @row_count, @col_count,
       @columns, @col_types, @sample_data, @categories, @sub_category, @hits,
       @parse_error, @is_new, 0, @is_duplicate, @discovered, @modified, @last_scanned)
    ON CONFLICT(path) DO UPDATE SET
      hash         = excluded.hash,
      name         = excluded.name,
      ext          = excluded.ext,
      size_bytes   = excluded.size_bytes,
      row_count    = excluded.row_count,
      col_count    = excluded.col_count,
      columns      = excluded.columns,
      col_types    = excluded.col_types,
      sample_data  = excluded.sample_data,
      categories   = excluded.categories,
      sub_category = excluded.sub_category,
      hits     = excluded.hits,
      parse_error  = excluded.parse_error,
      is_deleted   = 0,
      is_duplicate = excluded.is_duplicate,
      modified     = excluded.modified,
      last_scanned = excluded.last_scanned
  `);

  stmt.run({
    ...record,
    columns: JSON.stringify(record.columns ?? []),
    col_types: JSON.stringify(record.col_types ?? {}),
    sample_data: JSON.stringify(record.sample ?? []),
    categories: JSON.stringify(record.categories ?? []),
    sub_category: JSON.stringify(record.sub_categories ?? {}),
    hits: JSON.stringify(record.hits ?? []),
    is_new: record.is_new ?? 1,
    is_duplicate: record.is_duplicate ?? 0,
  });

  // Return the full row so the caller can broadcast it via SSE.
  return getFileByPath(db, record.path);
}

/**
 * Delete every row from the files table.
 * Settings and keywords are left untouched.
 */
export function clearAllFiles(db) {
  db.transaction(() => {
    db.prepare("DELETE FROM files").run();
    db.prepare("DELETE FROM taxonomy_categories").run();

    const ins = db.prepare(
      "INSERT INTO taxonomy_categories (name, color, path_hints, header_hints, sort_order) VALUES (?, ?, ?, ?, ?)",
    );
    DEFAULT_TAXONOMY.forEach((kw, i) => {
      ins.run(
        kw.name,
        autoColor(kw.name),
        JSON.stringify(kw.pathHints),
        JSON.stringify(kw.headerHints),
        i,
      );
    });
  })();
}

/** Mark a file as deleted without removing the row (preserves history). */
export function markDeleted(db, filePath) {
  db.prepare("UPDATE files SET is_deleted = 1 WHERE path = ?").run(filePath);
}

/** Mark a file as "seen" (user opened it), clearing the is_new flag. */
export function markSeen(db, fileId) {
  db.prepare("UPDATE files SET is_new = 0 WHERE id = ?").run(fileId);
}

export function getFileByPath(db, filePath) {
  const row = db.prepare("SELECT * FROM files WHERE path = ?").get(filePath);
  return row ? deserializeFile(row) : null;
}

/**
 * Find any non-deleted file with the given hash at a DIFFERENT path.
 * Used to detect cross-path duplicates.
 */
export function getFileByHash(db, hash, excludePath) {
  const row = db
    .prepare(
      "SELECT * FROM files WHERE hash = ? AND path != ? AND is_deleted = 0 LIMIT 1",
    )
    .get(hash, excludePath);
  return row ? deserializeFile(row) : null;
}

export function getFileById(db, id) {
  const row = db.prepare("SELECT * FROM files WHERE id = ?").get(id);
  return row ? deserializeFile(row) : null;
}

/**
 * Return all non-deleted files, optionally filtered.
 *
 * @param {object} filters  - { category, hits, isNew }
 */
export function getFiles(db, filters = {}) {
  let sql = "SELECT * FROM files WHERE is_deleted = 0 AND is_duplicate = 0";
  const params = [];

  if (filters.hits) {
    // hits is a JSON array; a non-empty array is never '[]'.
    sql += " AND hits != '[]' AND hits IS NOT NULL";
  }
  if (filters.isNew) {
    sql += " AND is_new = 1";
  }

  const rows = db.prepare(sql).all(...params);

  // Category filtering done in JS because SQLite JSON functions are optional.
  let results = rows.map(deserializeFile);
  if (filters.category) {
    results = results.filter((f) => f.categories.includes(filters.category));
  }

  return results;
}

/**
 * Build the flat keyword tree used by GET /api/categories.
 * Returns: [{ name, color, count, files }]
 */
export function getCategories(db) {
  const files = getFiles(db);

  const colorMap = {};
  const taxCats = db
    .prepare("SELECT name, color FROM taxonomy_categories")
    .all();
  for (const tc of taxCats) colorMap[tc.name] = tc.color;

  const tree = {};
  for (const file of files) {
    // eslint-disable-next-line no-unused-vars
    const { sample_data, ...slim } = file;
    for (const kw of slim.categories) {
      if (!tree[kw])
        tree[kw] = {
          name: kw,
          color: colorMap[kw] ?? autoColor(kw),
          files: [],
        };
      tree[kw].files.push(slim);
    }
  }

  return Object.values(tree).map((kw) => ({
    name: kw.name,
    color: kw.color,
    count: kw.files.length,
    files: kw.files,
  }));
}

// ---------------------------------------------------------------------------
// Keywords helpers
// ---------------------------------------------------------------------------

/**
 * Returns the full taxonomy tree with compiled RegExp objects.
 * Shape: [{ id, name, color, pathHints: RegExp[], headerHints: RegExp[], subcategories: [...] }]
 */
export function getKeywordsCompiled(db) {
  const cats = db
    .prepare("SELECT * FROM taxonomy_categories ORDER BY sort_order, name")
    .all();
  const subs = db
    .prepare(
      "SELECT * FROM taxonomy_subcategories ORDER BY category_id, sort_order, name",
    )
    .all();

  const subsByCat = {};
  for (const sub of subs) {
    if (!subsByCat[sub.category_id]) subsByCat[sub.category_id] = [];
    subsByCat[sub.category_id].push(sub);
  }

  return cats.map((cat) => ({
    id: cat.id,
    name: cat.name,
    color: cat.color,
    pathHints: compileHints(cat.path_hints),
    headerHints: compileHints(cat.header_hints),
    rawPathHints: safeParseJSON(cat.path_hints, []),
    rawHeaderHints: safeParseJSON(cat.header_hints, []),
    subcategories: (subsByCat[cat.id] ?? []).map((sub) => ({
      id: sub.id,
      name: sub.name,
      pathHints: compileHints(sub.path_hints),
      headerHints: compileHints(sub.header_hints),
      rawPathHints: safeParseJSON(sub.path_hints, []),
      rawHeaderHints: safeParseJSON(sub.header_hints, []),
    })),
  }));
}

/** Compile a JSON string[] of keyword strings into RegExp objects. */
function compileHints(jsonStr) {
  const hints = safeParseJSON(jsonStr, []);
  return hints
    .map((h) => {
      try {
        return new RegExp(h, "i");
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function getKeywordsRaw(db) {
  const cats = db
    .prepare("SELECT * FROM taxonomy_categories ORDER BY sort_order, name")
    .all();
  const subs = db
    .prepare(
      "SELECT * FROM taxonomy_subcategories ORDER BY category_id, sort_order, name",
    )
    .all();
  return {
    categories: cats.map((c) => ({
      ...c,
      path_hints: safeParseJSON(c.path_hints, []),
      header_hints: safeParseJSON(c.header_hints, []),
    })),
    subcategories: subs.map((s) => ({
      ...s,
      path_hints: safeParseJSON(s.path_hints, []),
      header_hints: safeParseJSON(s.header_hints, []),
    })),
  };
}

// ---------------------------------------------------------------------------
// Flat keyword CRUD (keywords are just taxonomy_categories with auto-color)
// ---------------------------------------------------------------------------

export function getKeywords(db) {
  return db
    .prepare("SELECT * FROM taxonomy_categories ORDER BY sort_order, name")
    .all()
    .map((r) => ({
      ...r,
      path_hints: safeParseJSON(r.path_hints, []),
      header_hints: safeParseJSON(r.header_hints, []),
    }));
}

export function addKeyword(db, { name, pathHints = [], headerHints = [] }) {
  const color = autoColor(name);
  const sort = db
    .prepare("SELECT COUNT(*) AS n FROM taxonomy_categories")
    .get().n;
  db.prepare(
    "INSERT INTO taxonomy_categories (name, color, path_hints, header_hints, sort_order) VALUES (?, ?, ?, ?, ?)",
  ).run(
    name,
    color,
    JSON.stringify(pathHints),
    JSON.stringify(headerHints),
    sort,
  );
  return db
    .prepare("SELECT * FROM taxonomy_categories WHERE name = ?")
    .get(name);
}

export function updateKeyword(db, id, { name, pathHints, headerHints }) {
  const fields = [];
  const params = [];
  if (name !== undefined) {
    fields.push("name = ?");
    params.push(name);
  }
  if (pathHints !== undefined) {
    fields.push("path_hints = ?");
    params.push(JSON.stringify(pathHints));
  }
  if (headerHints !== undefined) {
    fields.push("header_hints = ?");
    params.push(JSON.stringify(headerHints));
  }
  if (fields.length === 0) return;
  params.push(id);
  db.prepare(
    `UPDATE taxonomy_categories SET ${fields.join(", ")} WHERE id = ?`,
  ).run(...params);
}

export function deleteKeyword(db, id) {
  db.prepare("DELETE FROM taxonomy_categories WHERE id = ?").run(id);
}

export function addKeywordCategory(
  db,
  { name, color = "#888780", pathHints = [], headerHints = [] },
) {
  const sort = db
    .prepare("SELECT COUNT(*) AS n FROM taxonomy_categories")
    .get().n;
  db.prepare(
    "INSERT INTO taxonomy_categories (name, color, path_hints, header_hints, sort_order) VALUES (?, ?, ?, ?, ?)",
  ).run(
    name,
    color,
    JSON.stringify(pathHints),
    JSON.stringify(headerHints),
    sort,
  );
  return db
    .prepare("SELECT * FROM taxonomy_categories WHERE name = ?")
    .get(name);
}

export function updateKeywordCategory(
  db,
  id,
  { name, color, pathHints, headerHints },
) {
  const fields = [];
  const params = [];
  if (name !== undefined) {
    fields.push("name = ?");
    params.push(name);
  }
  if (color !== undefined) {
    fields.push("color = ?");
    params.push(color);
  }
  if (pathHints !== undefined) {
    fields.push("path_hints = ?");
    params.push(JSON.stringify(pathHints));
  }
  if (headerHints !== undefined) {
    fields.push("header_hints = ?");
    params.push(JSON.stringify(headerHints));
  }
  if (fields.length === 0) return;
  params.push(id);
  db.prepare(
    `UPDATE taxonomy_categories SET ${fields.join(", ")} WHERE id = ?`,
  ).run(...params);
}

export function deleteKeywordCategory(db, id) {
  // Subcategories cascade via FK ON DELETE CASCADE.
  db.prepare("DELETE FROM taxonomy_categories WHERE id = ?").run(id);
}

export function addKeywordSubcategory(
  db,
  categoryId,
  { name, pathHints = [], headerHints = [] },
) {
  const sort = db
    .prepare(
      "SELECT COUNT(*) AS n FROM taxonomy_subcategories WHERE category_id = ?",
    )
    .get(categoryId).n;
  db.prepare(
    "INSERT INTO taxonomy_subcategories (category_id, name, path_hints, header_hints, sort_order) VALUES (?, ?, ?, ?, ?)",
  ).run(
    categoryId,
    name,
    JSON.stringify(pathHints),
    JSON.stringify(headerHints),
    sort,
  );
}

export function updateKeywordSubcategory(
  db,
  id,
  { name, pathHints, headerHints },
) {
  const fields = [];
  const params = [];
  if (name !== undefined) {
    fields.push("name = ?");
    params.push(name);
  }
  if (pathHints !== undefined) {
    fields.push("path_hints = ?");
    params.push(JSON.stringify(pathHints));
  }
  if (headerHints !== undefined) {
    fields.push("header_hints = ?");
    params.push(JSON.stringify(headerHints));
  }
  if (fields.length === 0) return;
  params.push(id);
  db.prepare(
    `UPDATE taxonomy_subcategories SET ${fields.join(", ")} WHERE id = ?`,
  ).run(...params);
}

export function deleteKeywordSubcategory(db, id) {
  db.prepare("DELETE FROM taxonomy_subcategories WHERE id = ?").run(id);
}

/**
 * Ensure a category (and optional subcategory) exists, creating them if needed.
 * Used by AI categorizer when it suggests a novel category.
 */
export function ensureKeywordEntry(db, categoryName, subCategoryName) {
  let cat = db
    .prepare("SELECT id FROM taxonomy_categories WHERE name = ?")
    .get(categoryName);
  if (!cat) {
    addKeywordCategory(db, { name: categoryName });
    cat = db
      .prepare("SELECT id FROM taxonomy_categories WHERE name = ?")
      .get(categoryName);
  }
  if (subCategoryName) {
    const existsSub = db
      .prepare(
        "SELECT id FROM taxonomy_subcategories WHERE category_id = ? AND name = ?",
      )
      .get(cat.id, subCategoryName);
    if (!existsSub) {
      addKeywordSubcategory(db, cat.id, { name: subCategoryName });
    }
  }
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

export function getSettings(db) {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function upsertSetting(db, key, value) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, String(value));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Parse JSON columns back into JS values on the way out of the DB. */
function deserializeFile(row) {
  return {
    ...row,
    columns: safeParseJSON(row.columns, []),
    col_types: safeParseJSON(row.col_types, {}),
    sample_data: safeParseJSON(row.sample_data, []),
    categories: safeParseJSON(row.categories, []),
    sub_categories: safeParseJSON(row.sub_category, {}),
    hits: safeParseJSON(row.hits, []),
  };
}

function safeParseJSON(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
