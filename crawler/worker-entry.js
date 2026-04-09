/**
 * crawler/worker-entry.js
 *
 * Thin entry point executed by Node's worker_threads inside a fresh thread.
 * Its only job is to import watcher.js and call start(). Keeping this
 * separate makes watcher.js independently testable without spinning up a thread.
 *
 * workerData shape (set by main thread when spawning):
 *   { watchPath: string, scanHiddenFolders: boolean }
 */

import { parentPort } from 'worker_threads';
import { start }      from './watcher.js';

start().catch((err) => {
  // Surface unhandled startup errors to the main thread before dying.
  parentPort.postMessage({ type: 'crawler_error', message: err.message });
  process.exit(1);
});
