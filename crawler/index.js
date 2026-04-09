/**
 * crawler/index.js
 *
 * Legacy combined launcher — kept for backward compatibility.
 * Prefer using the npm scripts directly:
 *
 *   npm run indexer   — start the crawler/indexer service (port 3002)
 *   npm run server    — start the API server (port 3001)
 *   npm run ui        — start the Vite dev server (port 5173)
 *   npm run dev       — start all three together
 *   npm start         — start indexer + server (no Vite)
 *   npm run start:fresh  — same but with --fresh (clears DB first)
 *
 * This file spawns both the indexer and API server as child processes so
 * that `node crawler/index.js` (or older tooling) still works.
 */

import { spawn }     from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = join(__dirname, '..');

const fresh = process.argv.includes('--fresh');

function run(script, args = []) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd:   root,
    stdio: 'inherit',
    env:   process.env,
  });
  child.on('exit', (code) => {
    if (code !== 0) console.error(`[Launcher] ${script} exited with code ${code}`);
  });
  return child;
}

console.log('[LocalDataExplorer] Starting indexer + API server...');

const indexerArgs = fresh ? ['--fresh'] : [];
const indexer = run('indexer.js', indexerArgs);
const server  = run('api/server.js');

process.on('SIGINT',  () => { indexer.kill(); server.kill(); });
process.on('SIGTERM', () => { indexer.kill(); server.kill(); });
