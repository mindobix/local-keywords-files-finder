/**
 * indexer.js
 *
 * Standalone indexer service — port 3002.
 *
 * Responsibilities:
 *   - Manage the crawler Worker thread lifecycle.
 *   - Expose a lightweight HTTP control API for the API server to call.
 *   - Forward every worker message to the API server's /internal/event endpoint
 *     so the UI gets live SSE updates regardless of whether the UI is open.
 *
 * The indexer can run 24/7 independently of the API server. The SQLite DB is
 * updated continuously, so users benefit from accumulated index data even when
 * the API server / UI is closed.
 *
 * Control endpoints (all local, not exposed to the internet):
 *   GET  /control/status
 *   POST /control/start
 *   POST /control/stop
 *   POST /control/clear     — terminate worker, wipe DB, restart worker
 *   POST /control/rescan    — restart worker (picks up new/changed files)
 *   POST /notify/:cmd       — relay a command into the live worker thread
 *                             (settings_changed | taxonomy_changed | keywords_changed)
 *
 * Run:  node indexer.js [--fresh]
 */

import express   from 'express';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';
import { unlinkSync, existsSync } from 'fs';
import os from 'os';

import {
  openDb, getSettings, upsertSetting, clearAllFiles,
} from './crawler/db.js';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, 'crawler', 'worker-entry.js');
const DB_FILES    = ['explorer.db', 'explorer.db-wal', 'explorer.db-shm']
  .map((f) => join(__dirname, 'db', f));

const INDEXER_PORT    = Number(process.env.INDEXER_PORT)    || 3002;
const API_SERVER_URL  = process.env.API_SERVER_URL          || 'http://localhost:3001';

// ---------------------------------------------------------------------------
// --fresh: wipe DB files before opening
// ---------------------------------------------------------------------------

if (process.argv.includes('--fresh')) {
  console.log('[Indexer] --fresh: clearing database...');
  for (const f of DB_FILES) {
    if (existsSync(f)) { unlinkSync(f); console.log(`  deleted ${f}`); }
  }
}

// ---------------------------------------------------------------------------
// DB — single connection owned by this process (worker gets its own)
// ---------------------------------------------------------------------------

const db = openDb();

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

let worker               = null;
let crawlerRunning       = false;
let intentionalTerminate = false;
let restartTimer         = null;
let lastProcessedFile    = null; // track for crash diagnosis

function startWorker() {
  if (worker) return;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }

  const watchPath         = process.env.WATCH_PATH || os.homedir();
  const scanHiddenFolders = false;

  worker = new Worker(WORKER_PATH, {
    workerData: { watchPath, scanHiddenFolders },
  });

  crawlerRunning = true;
  upsertSetting(db, 'crawler_running', 'true');

  worker.on('message', (msg) => {
    forwardEvent(msg);

    if (msg.type === 'crawler_stopped') {
      crawlerRunning = false;
      worker         = null;
      upsertSetting(db, 'crawler_running', 'false');
    }
  });

  worker.on('error', (err) => {
    console.error('[Worker error]', err.message);
    if (lastProcessedFile) {
      console.error('[Worker error] last file being processed:', lastProcessedFile);
    }
    forwardEvent({ type: 'crawler_error', message: err.message });
    crawlerRunning = false;
    worker         = null;
  });

  worker.on('exit', (code) => {
    const wasIntentional = intentionalTerminate;
    intentionalTerminate = false;
    crawlerRunning       = false;
    worker               = null;

    if (code !== 0 && !wasIntentional) {
      console.error(`[Worker] crashed (code ${code}) — last file: ${lastProcessedFile ?? 'unknown'}`);
      forwardEvent({ type: 'crawler_error', message: `Worker crashed (code ${code}), restarting…` });
      // Brief cooldown so a single bad file doesn't spin-loop.
      restartTimer = setTimeout(() => {
        restartTimer = null;
        console.log('[Indexer] Restarting worker after crash…');
        startWorker();
      }, 3000);
    }
  });

  console.log(`[Indexer] Worker started — watching ${watchPath}`);
}

function stopWorker() {
  if (!worker) return;
  worker.postMessage({ cmd: 'stop' });
}

// ---------------------------------------------------------------------------
// Event forwarding to API server
// ---------------------------------------------------------------------------

/**
 * POST the event payload to the API server's /internal/event endpoint.
 * Errors are swallowed — the API server may not be up yet on startup,
 * and the DB is the source of truth anyway.
 */
async function forwardEvent(payload) {
  try {
    await fetch(`${API_SERVER_URL}/internal/event`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
  } catch {
    // API server temporarily unreachable — not fatal
  }
}

// ---------------------------------------------------------------------------
// Control HTTP API
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '10mb' }));

// GET /control/status
app.get('/control/status', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS n FROM files WHERE is_deleted = 0').get().n;
  const last  = db.prepare('SELECT MAX(last_scanned) AS ts FROM files').get().ts;
  res.json({ running: crawlerRunning, filesIndexed: total, lastScan: last || null });
});

// POST /control/start
app.post('/control/start', (req, res) => {
  if (crawlerRunning) return res.json({ ok: true, message: 'Already running' });
  startWorker();
  res.json({ ok: true, running: true });
});

// POST /control/stop
app.post('/control/stop', (req, res) => {
  if (!crawlerRunning) return res.json({ ok: true, message: 'Already stopped' });
  stopWorker();
  res.json({ ok: true, running: false });
});

// POST /control/clear — hard-terminate and wipe DB.
// Does NOT restart the worker — the API server will call /control/start
// after broadcasting data_cleared, so no file_added events race the signal.
app.post('/control/clear', (req, res) => {
  if (worker) {
    intentionalTerminate = true;
    worker.terminate();
    worker         = null;
    crawlerRunning = false;
    upsertSetting(db, 'crawler_running', 'false');
    console.log('[Indexer] Worker terminated for data clear.');
  }

  clearAllFiles(db);
  res.json({ ok: true });
});

// POST /control/rescan — graceful restart
app.post('/control/rescan', (req, res) => {
  if (worker) {
    worker.once('exit', () => startWorker());
    stopWorker();
  } else {
    startWorker();
  }
  res.json({ ok: true });
});

// POST /notify/:cmd — relay a command into the live worker
//   settings_changed | taxonomy_changed
app.post('/notify/:cmd', (req, res) => {
  if (worker) worker.postMessage({ cmd: req.params.cmd });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(INDEXER_PORT, () => {
  console.log(`[Indexer] Control API on http://localhost:${INDEXER_PORT}`);
});

// Auto-start the worker unless the user explicitly stopped it last session.
const settings = getSettings(db);
if (settings.crawler_running !== 'false') {
  startWorker();
} else {
  console.log('[Indexer] Crawler paused (stopped last session). POST /control/start to resume.');
}

// Graceful shutdown
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function shutdown(signal) {
  console.log(`\n[Indexer] ${signal} — shutting down...`);
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  intentionalTerminate = true;
  stopWorker();
  setTimeout(() => process.exit(0), 1500);
}
