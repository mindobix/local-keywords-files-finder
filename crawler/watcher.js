/**
 * crawler/watcher.js
 *
 * Runs inside the worker thread. Pipeline per file:
 *   noise-filter → fingerprint → dedupe → parse → categorize
 *   → AI fallback (if no category + key set) → scan → DB upsert → SSE emit
 *
 * Files with no category after all passes are silently skipped.
 */

import { workerData, parentPort } from 'worker_threads';
import { statSync, readdirSync }  from 'fs';
import { join, extname, basename } from 'path';
import chokidar from 'chokidar';

import {
  openDb, upsertFile, markDeleted, getFileByPath, getFileByHash,
  getFiles, getSettings, getKeywordsCompiled,
} from './db.js';
import { fingerprint, dedupAction } from './deduper.js';
import { categorize }               from './categorizer.js';
import { parseCSV } from './parsers/csv.js';
// parseXLSX and parseODS are lazy-loaded inside parseFile.
// Both re-export SheetJS; importing them at module level OOMs the worker before any file is processed.

// ---------------------------------------------------------------------------
// Supported extensions
// ---------------------------------------------------------------------------

const SUPPORTED_EXTS = new Set([
  '.csv', '.tsv', '.xlsx', '.xls', '.ods', '.numbers',
  '.pdf', '.txt',
]);

// ---------------------------------------------------------------------------
// Noise filters — directories and file patterns to always skip
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', '.out',
  '__pycache__', '.next', '.nuxt', '.expo', '.cache', 'coverage',
  'vendor', 'bower_components', 'target', '.gradle', 'Pods',
  'venv', '.venv', 'env', '.env', '__MACOSX',
  'Library', 'System', 'Applications', 'Frameworks',
]);

const NOISE_FILE_RE = [
  /^package(-lock)?\.json$/i,
  /^yarn\.lock$/i,
  /^pnpm-lock\.(yaml|yml)$/i,
  /^tsconfig(\..+)?\.json$/i,
  /^jsconfig\.json$/i,
  /\.(config|rc)\.(js|ts|mjs|cjs|json)$/i,
  /^\.(eslint|prettier|babel|jest|stylelint|postcss)(rc|\..*)?$/i,
  /^(vite|webpack|rollup|next|nuxt|svelte|astro)\.config\./i,
  /^\.env(\.|$)/,
  /^Makefile$/,
  /^Dockerfile/i,
  /^\.gitignore$/,
  /^composer\.(json|lock)$/i,
  /^Gemfile(\.lock)?$/,
  /^requirements.*\.txt$/i,
  /^setup\.(py|cfg)$/i,
  /^poetry\.lock$/i,
  /^Cargo\.(toml|lock)$/i,
  /^go\.(mod|sum)$/i,
  /^\.DS_Store$/,
];

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const { watchPath, scanHiddenFolders } = workerData;
const db = openDb();

let currentKeywords = getKeywordsCompiled(db);
let crawlerSettings    = getSettings(db);

let watcher = null;
let stopped = false;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function start() {
  emit({ type: 'crawler_status', running: true });

  const filesFound = walkDir(watchPath);
  let indexed = 0;
  let skipped = 0;

  for (const filePath of filesFound) {
    if (stopped) break;
    const result = await processFile(filePath, 'initial');
    if (result === 'indexed') indexed++;
    else if (result === 'skipped') skipped++;
  }

  if (!stopped) {
    emit({ type: 'scan_complete', total: indexed, skipped });
  }

  if (!stopped) startWatcher();
}

// ---------------------------------------------------------------------------
// Chokidar watcher
// ---------------------------------------------------------------------------

function startWatcher() {
  watcher = chokidar.watch(watchPath, {
    followSymlinks: false,
    ignored: scanHiddenFolders ? /(^|[/\\])\..+/ : /(^|[/\\])\../,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    persistent: true,
  });

  watcher
    .on('add',    (path) => processFile(path, 'add'))
    .on('change', (path) => processFile(path, 'change'))
    .on('unlink', (path) => handleUnlink(path))
    .on('error',  (err)  => emit({ type: 'crawler_error', message: String(err) }));
}

// ---------------------------------------------------------------------------
// File processing pipeline
// ---------------------------------------------------------------------------

async function processFile(filePath, reason) {
  if (stopped) return 'stopped';
  if (!isSupportedFile(filePath)) return 'filtered';

  process.stderr.write(`[Crawler] parsing: ${filePath}\n`);

  try {
    const { hash, sizeBytes } = fingerprint(filePath);
    const existing            = getFileByPath(db, filePath);
    const action              = dedupAction(filePath, hash, existing);
    if (action === 'skip') return 'skipped';

    const parsed = parseFile(filePath);

    // --- Match against flat keyword list ---
    let keywords = categorize(filePath, parsed.columns, currentKeywords);

    // Skip files with no matching keyword — keeps the index clean.
    if (keywords.length === 0) {
      process.stderr.write(`[Crawler] skipped (no keyword match): ${filePath}\n`);
      return 'skipped';
    }

    const now  = Math.floor(Date.now() / 1000);
    let mtime  = now;
    try { mtime = Math.floor(statSync(filePath).mtimeMs / 1000); } catch {}

    const isDuplicate = !existing && !!getFileByHash(db, hash, filePath) ? 1 : 0;

    // Only flag as new when a file appears via live watch ('add' event).
    // The initial directory walk indexes what was already there — those files
    // are not "new news" for the user and should not flood the NEW section.
    const isNew = existing
      ? existing.is_new          // preserve seen/unseen state for known files
      : (isDuplicate ? 0 : (reason === 'add' ? 1 : 0));

    const record = {
      path:         filePath,
      hash,
      name:         basename(filePath),
      ext:          extname(filePath).toLowerCase().replace('.', ''),
      size_bytes:   sizeBytes,
      row_count:    parsed.rowCount,
      col_count:    parsed.columns.length,
      columns:      parsed.columns,
      col_types:    parsed.colTypes,
      sample:       parsed.sample ?? [],
      categories:     keywords,
      sub_categories: {},
      hits:     [],
      parse_error:  parsed.error ?? null,
      is_new:       isNew,
      is_duplicate: isDuplicate,
      discovered:   existing ? existing.discovered : now,
      modified:     mtime,
      last_scanned: now,
    };

    const saved = upsertFile(db, record);
    const isFirstIndex = !existing || existing.is_deleted;
    // Strip sample_data before broadcasting — the UI doesn't need row data in
    // SSE events (it fetches that separately on click), and including it would
    // send megabytes over the wire during a full directory scan.
    // eslint-disable-next-line no-unused-vars
    const { sample_data, ...slimSaved } = saved;
    emit({ type: isFirstIndex ? 'file_added' : 'file_updated', file: slimSaved });
    return 'indexed';

  } catch (err) {
    emit({ type: 'crawler_error', message: `Failed to process ${filePath}: ${err.message}` });
    return 'error';
  }
}

function handleUnlink(filePath) {
  if (stopped) return;
  const existing = getFileByPath(db, filePath);
  if (!existing) return;
  markDeleted(db, filePath);
  emit({ type: 'file_removed', id: existing.id });
}

// ---------------------------------------------------------------------------
// Control messages from main thread
// ---------------------------------------------------------------------------

if (parentPort) parentPort.on('message', async (msg) => {
  if (msg.cmd === 'stop') {
    stopped = true;
    if (watcher) { await watcher.close(); watcher = null; }
    db.close();
    emit({ type: 'crawler_stopped' });
    setTimeout(() => process.exit(0), 100);

  } else if (msg.cmd === 'settings_changed') {
    crawlerSettings  = getSettings(db);

  } else if (msg.cmd === 'keywords_changed') {
    currentKeywords = getKeywordsCompiled(db);
    console.log('[Crawler] Keywords reloaded — re-categorizing indexed files…');
    await recategorizeAll();

  }
});

// ---------------------------------------------------------------------------
// Re-categorize all indexed files after a taxonomy change
// ---------------------------------------------------------------------------

async function recategorizeAll() {
  const now = Math.floor(Date.now() / 1000);

  // Phase 1 — re-categorize ALL files already in the DB, regardless of their
  // current category. A file previously in "Taxes" can also gain "names >
  // Amandeep" if the updated taxonomy now matches it on both axes.
  const allFiles = getFiles(db);
  let updated = 0;
  for (const file of allFiles) {
    if (stopped) break;
    const keywords = categorize(file.path, file.columns ?? [], currentKeywords);
    if (keywords.length === 0) continue;

    const saved = upsertFile(db, {
      ...file,
      sample:         file.sample_data,
      categories:     keywords,
      sub_categories: {},
      last_scanned:   now,
    });
    // eslint-disable-next-line no-unused-vars
    const { sample_data, ...slim } = saved;
    emit({ type: 'file_updated', file: slim });
    updated++;
  }
  console.log(`[Crawler] Phase 1: updated ${updated}/${allFiles.length} DB files with new taxonomy.`);

  // Phase 2 — walk the filesystem for files that were previously skipped
  // (never in the DB) but now match the updated taxonomy.
  const filesFound = walkDir(watchPath);
  let newlyIndexed = 0;
  for (const filePath of filesFound) {
    if (stopped) break;
    const result = await processFile(filePath, 'initial');
    if (result === 'indexed') {
      newlyIndexed++;
      process.stderr.write(`[Crawler] newly matched: ${filePath}\n`);
    }
  }
  console.log(`[Crawler] Phase 2: ${newlyIndexed} previously-skipped files now matched.`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSupportedFile(filePath) {
  const ext  = extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) return false;
  const name = basename(filePath);
  if (NOISE_FILE_RE.some((re) => re.test(name))) return false;
  if (!isEnglishNamed(filePath)) return false;
  return true;
}

/**
 * Returns true only when the filename looks like a human-readable name.
 *
 * Rejects:
 *  - Pure hex strings ≥ 8 chars  (SHA-256 / MD5 / webpack chunk hashes)
 *  - UUIDs
 *  - Stems where no token looks like an English word (3+ letters with a vowel)
 *
 * Accepts:  budget_2024, bank-statement, Q1_Report, transactions_jan
 * Rejects:  32f6bbafd838…, 0f1ed15f62ca…, dfg_ccd_xls, aabbccdd
 */
function isEnglishNamed(filePath) {
  const stem = basename(filePath, extname(filePath));

  // Pure hex strings (MD5, SHA-1, SHA-256, webpack hashes, etc.)
  if (/^[0-9a-f]{8,}$/i.test(stem)) return false;

  // UUIDs — e.g. 550e8400-e29b-41d4-a716-446655440000
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stem)) return false;

  // Require at least one token that looks like a real word:
  //   3+ letters with at least one vowel.
  // This rejects gibberish like "dfg_ccd" or "aabbcc" while accepting
  // "budget", "report", "jan", "transactions", "payroll", etc.
  const tokens = stem.split(/[^a-zA-Z]+/).filter(Boolean);
  return tokens.some((t) => t.length >= 3 && /[aeiou]/i.test(t));
}


function walkDir(dirPath) {
  const results = [];

  function walk(current) {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (!scanHiddenFolders && entry.name.startsWith('.')) continue;
      // Skip known noise directories at any depth.
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;

      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && isSupportedFile(fullPath)) {
        results.push(fullPath);
      }
    }
  }

  walk(dirPath);
  return results;
}

function parseFile(filePath) {
  const ext = extname(filePath).toLowerCase();

  // CSV/TSV — parse inline, lightweight.
  if (ext === '.csv' || ext === '.tsv') {
    try { return parseCSV(filePath); }
    catch (err) { return { columns: [], colTypes: {}, rowCount: 0, sample: [], error: err.message }; }
  }

  // All other supported types (xlsx, ods, pdf, txt, html) — no watcher-side parse.
  // xlsx/ods: SheetJS excluded to avoid OOM.
  // pdf/txt/html: previewed via /api/files/:id/content, not a data grid.
  // Full content served on demand by the API.
  return { columns: [], colTypes: {}, rowCount: 0, sample: [] };
}

function emit(payload) {
  parentPort.postMessage(payload);
}
