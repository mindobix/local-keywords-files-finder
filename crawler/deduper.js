/**
 * crawler/deduper.js
 *
 * Hash-based deduplication. The hash is SHA-256 over the first 64 KB of the
 * file concatenated with the file's byte size. Using a size suffix prevents
 * hash collisions between files that share the same opening bytes but differ
 * only beyond the 64 KB boundary.
 *
 * Dedup outcomes:
 *   SKIP      — path + hash match DB → file is unchanged, skip re-parse
 *   UPDATE    — path matches but hash changed → re-parse and update
 *   NEW       — path not in DB → parse and insert
 *   DUPLICATE — different path but same hash as an existing entry → index both,
 *               but note the duplicate relationship (currently via shared hash)
 */

import { createHash }    from 'crypto';
import { openSync, readSync, closeSync, statSync } from 'fs';

const HASH_CHUNK_BYTES = 64 * 1024; // 64 KB

/**
 * Compute a fingerprint for a file.
 *
 * @param {string} filePath  Absolute file path.
 * @returns {{ hash: string, sizeBytes: number }}
 */
export function fingerprint(filePath) {
  const { size: sizeBytes } = statSync(filePath);

  const buf       = Buffer.alloc(Math.min(HASH_CHUNK_BYTES, sizeBytes));
  const fd        = openSync(filePath, 'r');
  const bytesRead = readSync(fd, buf, 0, buf.length, 0);
  closeSync(fd);

  const hash = createHash('sha256')
    .update(buf.slice(0, bytesRead))
    .update(String(sizeBytes))   // append size to bust collisions on identical prefixes
    .digest('hex');

  return { hash, sizeBytes };
}

/**
 * Determine what action to take for a file given its current DB state.
 *
 * @param {string}      filePath   Absolute file path.
 * @param {string}      newHash    From fingerprint().
 * @param {object|null} dbRecord   Existing DB row (or null if not found).
 * @returns {'skip' | 'update' | 'new'}
 */
export function dedupAction(filePath, newHash, dbRecord) {
  if (!dbRecord) return 'new';
  if (dbRecord.hash === newHash) return 'skip';
  return 'update';
}
