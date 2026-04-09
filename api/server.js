/**
 * api/server.js
 *
 * REST API + SSE push layer — port 3001.
 *
 * The crawler now runs as a separate process (indexer.js, port 3002).
 * This server:
 *   - Provides REST endpoints for the UI (DB reads, settings, taxonomy, etc.).
 *   - Fans out SSE events to all connected browser clients.
 *   - Receives raw crawler events from the indexer at POST /internal/event.
 *   - Proxies crawler control commands (start/stop/clear/rescan) to the indexer.
 *   - Notifies the indexer whenever settings, keywords, or taxonomy change.
 *
 * Run:  node api/server.js
 */

import express        from 'express';
import cors           from 'cors';
import { Worker }     from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn }      from 'child_process';
import { readFileSync } from 'fs';

const __dirname       = dirname(fileURLToPath(import.meta.url));
const PARSE_WORKER    = join(__dirname, '..', 'crawler', 'parse-worker.js');
const { version }     = JSON.parse(readFileSync(join(__dirname, '..', 'version.json'), 'utf8'));

import {
  openDb,
  getFiles, getFileById, getCategories,
  getSettings, upsertSetting,
  markSeen,
  getKeywordsRaw,
  addKeywordCategory, updateKeywordCategory, deleteKeywordCategory,
  addKeywordSubcategory, updateKeywordSubcategory, deleteKeywordSubcategory,
  getKeywords, addKeyword, updateKeyword, deleteKeyword,
} from '../crawler/db.js';

const INDEXER_URL = process.env.INDEXER_URL || 'http://localhost:3002';
const PORT        = Number(process.env.API_PORT) || 3001;

// ---------------------------------------------------------------------------
// DB — read-only queries for API responses.
// The indexer process owns writes; this connection is for reads + settings.
// WAL mode allows concurrent access from multiple processes.
//
// ---------------------------------------------------------------------------

const db = openDb();

// ---------------------------------------------------------------------------
// SSE state
// ---------------------------------------------------------------------------

/** All connected SSE response objects. */
const sseClients = new Set();

/** Mirror of the indexer's crawler state — updated via /internal/event. */
let crawlerRunning = getSettings(db).crawler_running !== 'false';

// ---------------------------------------------------------------------------
// Indexer proxy helpers
// ---------------------------------------------------------------------------

/**
 * Forward a control request to the indexer service.
 * Returns the parsed JSON response or null on network error.
 */
async function callIndexer(method, path, body) {
  try {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(`${INDEXER_URL}${path}`, opts);
    return res.json();
  } catch (err) {
    console.warn(`[API] Indexer unreachable (${path}):`, err.message);
    return null;
  }
}

/** Tell the indexer's live worker to reload a setting. */
function notifyIndexer(cmd) {
  callIndexer('POST', `/notify/${cmd}`).catch(() => {});
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(cors({ origin: 'http://localhost:5173' })); // Vite dev server
app.use(express.json({ limit: '10mb' }));

// ---------------------------------------------------------------------------
// Internal event receiver — called by the indexer for every worker message
// ---------------------------------------------------------------------------

app.post('/internal/event', (req, res) => {
  const msg = req.body;

  // Keep local crawler state in sync.
  if (msg.type === 'crawler_status')  crawlerRunning = msg.running;
  if (msg.type === 'crawler_stopped') crawlerRunning = false;

  broadcast(msg);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

app.get('/api/version', (_req, res) => res.json({ version }));

// ---------------------------------------------------------------------------
// SSE endpoint — GET /api/events
// ---------------------------------------------------------------------------

app.get('/api/events', async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  sseClients.add(res);

  // Send current status immediately so the UI doesn't wait for the first event.
  const total = db.prepare('SELECT COUNT(*) AS n FROM files WHERE is_deleted = 0').get().n;
  sendSSE(res, { type: 'crawler_status', running: crawlerRunning, filesIndexed: total });

  req.on('close', () => sseClients.delete(res));
});

/** Broadcast a message to all connected SSE clients. */
function broadcast(payload) {
  for (const res of sseClients) sendSSE(res, payload);
}

/** Write a single SSE event frame to one response. */
function sendSSE(res, payload) {
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    sseClients.delete(res);
  }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

app.get('/api/files', (req, res) => {
  const filters = {
    category: req.query.category || null,
    hits:     req.query.hits === '1',
    isNew:    req.query.new === '1',
  };
  res.json(getFiles(db, filters));
});

app.get('/api/files/:id', (req, res) => {
  const file = getFileById(db, Number(req.params.id));
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.json(file);
});

app.post('/api/files/:id/seen', (req, res) => {
  markSeen(db, Number(req.params.id));
  res.json({ ok: true });
});

// GET /api/files/:id/content — stream raw file for PDF/HTML/TXT preview
app.get('/api/files/:id/content', (req, res) => {
  const file = getFileById(db, Number(req.params.id));
  if (!file) return res.status(404).json({ error: 'Not found' });

  const mimeMap = {
    pdf: 'application/pdf',
    txt: 'text/plain; charset=utf-8',
  };
  const mime = mimeMap[file.ext];
  if (!mime) return res.status(400).json({ error: 'Not a previewable type' });

  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', 'inline');
  res.sendFile(file.path);
});

// POST /api/files/:id/reveal — open the file's folder in Finder / Explorer
app.post('/api/files/:id/reveal', (req, res) => {
  const file = getFileById(db, Number(req.params.id));
  if (!file) return res.status(404).json({ error: 'Not found' });

  const platform = process.platform;
  let cmd, args;

  if (platform === 'darwin') {
    // -R selects the file in Finder rather than opening it
    cmd  = 'open';
    args = ['-R', file.path];
  } else if (platform === 'win32') {
    // /select highlights the file in Explorer
    cmd  = 'explorer';
    args = ['/select,', file.path.replace(/\//g, '\\')];
  } else {
    // Linux fallback — open the containing directory
    cmd  = 'xdg-open';
    args = [dirname(file.path)];
  }

  // Use spawn (not exec) to avoid shell injection — args are passed as an array.
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Paginated row data — GET /api/files/:id/rows
//
// Parsing runs in a dedicated worker thread so the Express event loop (and
// SSE connections) are never blocked by synchronous file I/O.
//
// Results are cached in memory keyed by (path + mtime). The same file can
// appear in multiple sidebar sections (e.g. Investments + SENSITIVE); without
// a cache every click re-parses — with it the second click is instant.
// ---------------------------------------------------------------------------

const parseCache    = new Map(); // key → { mtime, result }
const CACHE_MAX     = 30;

function cacheGet(path, mtime) {
  const entry = parseCache.get(path);
  return entry?.mtime === mtime ? entry.result : null;
}

function cacheSet(path, mtime, result) {
  if (parseCache.size >= CACHE_MAX) {
    parseCache.delete(parseCache.keys().next().value); // evict oldest
  }
  parseCache.set(path, { mtime, result });
}

// Only one parse worker at a time. Tapping a new file terminates the previous
// parse immediately instead of letting multiple xlsx-loading workers pile up
// and saturate CPU (which starves Chrome's renderer thread).
let activeParseWorker = null;

function parseInWorker(filePath, ext, sizeBytes) {
  // Terminate any in-flight parse — single-user app, one preview at a time.
  if (activeParseWorker) {
    activeParseWorker.terminate();
    activeParseWorker = null;
  }

  return new Promise((resolve, reject) => {
    const w = new Worker(PARSE_WORKER, { workerData: { filePath, ext, sizeBytes } });
    activeParseWorker = w;

    const timer = setTimeout(() => {
      w.terminate();
      if (activeParseWorker === w) activeParseWorker = null;
      reject(new Error('Parse timed out — file may be too large or complex'));
    }, 15_000);

    const cleanup = () => {
      clearTimeout(timer);
      if (activeParseWorker === w) activeParseWorker = null;
    };

    w.once('message', (msg) => { cleanup(); msg.ok ? resolve(msg.result) : reject(new Error(msg.error)); });
    w.once('error',   (err) => { cleanup(); reject(err); });
    w.once('exit',    (code) => { cleanup(); if (code !== 0) reject(new Error(`Parse worker exited ${code}`)); });
  });
}

app.get('/api/files/:id/rows', async (req, res) => {
  const file = getFileById(db, Number(req.params.id));
  if (!file) return res.status(404).json({ error: 'Not found' });

  try {
    let rows     = file.sample_data ?? [];
    let columns  = file.columns     ?? [];
    let colTypes = file.col_types   ?? {};

    const ext = '.' + file.ext;
    const needsParse = rows.length === 0 &&
      ['.csv', '.tsv', '.xlsx', '.xls', '.ods', '.numbers'].includes(ext);

    if (needsParse) {
      // xlsx/ods: watcher intentionally stores no sample (SheetJS excluded from
      // crawler to prevent OOM). CSV: legacy file pre-dating sample_data column.
      // Parse on demand in an isolated worker, cache result in memory.
      let parsed = cacheGet(file.path, file.modified);
      if (!parsed) {
        req.on('close', () => {
          if (activeParseWorker) { activeParseWorker.terminate(); activeParseWorker = null; }
        });
        parsed = await parseInWorker(file.path, ext, file.size_bytes);
        cacheSet(file.path, file.modified, parsed);
      }
      rows     = parsed.sample ?? [];
      columns  = parsed.columns;
      colTypes = parsed.colTypes;
    }

    // Sort
    const { col, dir } = req.query;
    if (col && rows.length > 0 && col in rows[0]) {
      rows = [...rows].sort((a, b) => {
        const cmp = String(a[col] ?? '').localeCompare(String(b[col] ?? ''), undefined, { numeric: true });
        return dir === 'desc' ? -cmp : cmp;
      });
    }

    // Paginate
    const page  = Math.max(0, Number(req.query.page)  || 0);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));

    res.json({
      rows:     rows.slice(page * limit, (page + 1) * limit),
      total:    file.row_count ?? rows.length,
      page,
      limit,
      columns,
      colTypes,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

app.get('/api/categories', (req, res) => {
  res.json(getCategories(db));
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

app.get('/api/settings', (req, res) => {
  res.json({ settings: getSettings(db) });
});

app.post('/api/settings', (req, res) => {
  const { key, value } = req.body;
  if (!key || value === undefined) {
    return res.status(400).json({ error: 'key and value required' });
  }
  upsertSetting(db, key, value);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Crawler control — proxied to the indexer
// ---------------------------------------------------------------------------

app.get('/api/crawler/status', async (req, res) => {
  const data = await callIndexer('GET', '/control/status');
  if (!data) {
    // Indexer unreachable — return what we know from DB
    const total = db.prepare('SELECT COUNT(*) AS n FROM files WHERE is_deleted = 0').get().n;
    const last  = db.prepare('SELECT MAX(last_scanned) AS ts FROM files').get().ts;
    return res.json({ running: false, filesIndexed: total, lastScan: last || null });
  }
  res.json(data);
});

app.post('/api/crawler/start', async (req, res) => {
  const data = await callIndexer('POST', '/control/start');
  if (data) crawlerRunning = true;
  res.json(data ?? { ok: false, error: 'Indexer unreachable' });
});

app.post('/api/crawler/stop', async (req, res) => {
  const data = await callIndexer('POST', '/control/stop');
  if (data) crawlerRunning = false;
  res.json(data ?? { ok: false, error: 'Indexer unreachable' });
});

// POST /api/clear — wipe DB, broadcast data_cleared, then restart the worker.
// The restart is intentionally deferred: broadcasting first guarantees the UI
// clears before any new file_added events arrive from the fresh scan.
app.post('/api/clear', async (req, res) => {
  const data = await callIndexer('POST', '/control/clear');
  if (!data) return res.status(503).json({ error: 'Indexer unreachable' });

  crawlerRunning = false;
  broadcast({ type: 'data_cleared' });
  broadcast({ type: 'keywords_updated' });
  res.json({ ok: true });

  // Small pause so SSE clients can process data_cleared before new events arrive.
  setTimeout(() => callIndexer('POST', '/control/start'), 800);
});

// POST /api/rescan
app.post('/api/rescan', async (req, res) => {
  const data = await callIndexer('POST', '/control/rescan');
  res.json(data ?? { ok: false, error: 'Indexer unreachable' });
});

// ---------------------------------------------------------------------------
// Keywords (flat taxonomy)
// ---------------------------------------------------------------------------

app.get('/api/keywords', (req, res) => res.json(getKeywords(db)));

app.post('/api/keywords', (req, res) => {
  const { name, pathHints, headerHints } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  try {
    const kw = addKeyword(db, { name: name.trim(), pathHints: pathHints ?? [name.trim()], headerHints: headerHints ?? [] });
    notifyIndexer('keywords_changed');
    broadcast({ type: 'keywords_updated' });
    res.json(kw);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/keywords/:id', (req, res) => {
  const { name, pathHints, headerHints } = req.body;
  updateKeyword(db, Number(req.params.id), { name, pathHints, headerHints });
  notifyIndexer('keywords_changed');
  broadcast({ type: 'keywords_updated' });
  res.json(getKeywords(db));
});

app.delete('/api/keywords/:id', (req, res) => {
  deleteKeyword(db, Number(req.params.id));
  notifyIndexer('keywords_changed');
  broadcast({ type: 'keywords_updated' });
  res.json(getKeywords(db));
});

// ---------------------------------------------------------------------------
// Backup / Restore
// ---------------------------------------------------------------------------

app.get('/api/export', (req, res) => {
  const settings  = getSettings(db);
  const keywords = getKeywordsRaw(db);
  res.json({ version: 1, exportedAt: new Date().toISOString(), settings, keywords });
});

app.post('/api/import', (req, res) => {
  const { settings: s, keywords: t } = req.body ?? {};
  if (!s || !t) return res.status(400).json({ error: 'Invalid backup file' });

  db.transaction(() => {
    // Restore settings (skip runtime-only and removed keys)
    const SKIP_KEYS = new Set([
      'crawler_running',
      'watch_for_changes',
      'scan_hidden_folders',
      'include_ods_and_numbers',
      'filename_keywords',
    ]);
    for (const [key, value] of Object.entries(s)) {
      if (!SKIP_KEYS.has(key)) upsertSetting(db, key, value);
    }

    // Replace keywords — subcategories cascade via FK
    db.prepare('DELETE FROM taxonomy_categories').run();

    const insCategory = db.prepare(
      'INSERT INTO taxonomy_categories (name, color, path_hints, header_hints, sort_order) VALUES (?, ?, ?, ?, ?)'
    );
    const insSubcategory = db.prepare(
      'INSERT INTO taxonomy_subcategories (category_id, name, path_hints, header_hints, sort_order) VALUES (?, ?, ?, ?, ?)'
    );

    for (const cat of (t.categories ?? [])) {
      const r = insCategory.run(
        cat.name, cat.color ?? '#888780',
        JSON.stringify(cat.path_hints ?? []),
        JSON.stringify(cat.header_hints ?? []),
        cat.sort_order ?? 0,
      );
      const subs = (t.subcategories ?? []).filter((s) => s.category_id === cat.id);
      subs.forEach((sub, i) => {
        insSubcategory.run(
          r.lastInsertRowid, sub.name,
          JSON.stringify(sub.path_hints ?? []),
          JSON.stringify(sub.header_hints ?? []),
          sub.sort_order ?? i,
        );
      });
    }
  })();

  // Notify crawler to reload taxonomy + settings
  notifyIndexer('keywords_changed');
  notifyIndexer('settings_changed');
  broadcast({ type: 'keywords_updated' });

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Taxonomy CRUD
// ---------------------------------------------------------------------------

function notifyKeywordsChanged() {
  notifyIndexer('keywords_changed');
  broadcast({ type: 'keywords_updated' });
}

app.get('/api/taxonomy', (req, res) => res.json(getKeywordsRaw(db)));

app.post('/api/taxonomy/categories', (req, res) => {
  const { name, color, pathHints, headerHints } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  try {
    addKeywordCategory(db, { name: name.trim(), color, pathHints, headerHints });
    notifyKeywordsChanged();
    res.json(getKeywordsRaw(db));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/taxonomy/categories/:id', (req, res) => {
  const { name, color, pathHints, headerHints } = req.body;
  updateKeywordCategory(db, Number(req.params.id), { name, color, pathHints, headerHints });
  notifyKeywordsChanged();
  res.json(getKeywordsRaw(db));
});

app.delete('/api/taxonomy/categories/:id', (req, res) => {
  deleteKeywordCategory(db, Number(req.params.id));
  notifyKeywordsChanged();
  res.json(getKeywordsRaw(db));
});

app.post('/api/taxonomy/categories/:id/subcategories', (req, res) => {
  const { name, pathHints, headerHints } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  try {
    addKeywordSubcategory(db, Number(req.params.id), { name: name.trim(), pathHints, headerHints });
    notifyKeywordsChanged();
    res.json(getKeywordsRaw(db));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/taxonomy/subcategories/:id', (req, res) => {
  const { name, pathHints, headerHints } = req.body;
  updateKeywordSubcategory(db, Number(req.params.id), { name, pathHints, headerHints });
  notifyKeywordsChanged();
  res.json(getKeywordsRaw(db));
});

app.delete('/api/taxonomy/subcategories/:id', (req, res) => {
  deleteKeywordSubcategory(db, Number(req.params.id));
  notifyKeywordsChanged();
  res.json(getKeywordsRaw(db));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[API] Server listening on http://localhost:${PORT}`);
});
