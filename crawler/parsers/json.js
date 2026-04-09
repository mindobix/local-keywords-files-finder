/**
 * crawler/parsers/json.js
 *
 * Handles two common JSON shapes:
 *   1. Array of objects  — [ { ... }, { ... } ]
 *   2. Newline-delimited JSON (NDJSON) — one JSON object per line
 *
 * Large files (> 50 MB) are not fully parsed — we read only the first
 * MAX_READ_BYTES bytes to keep memory usage bounded, so rowCount may be null.
 */

import { openSync, readSync, closeSync } from 'fs';

const SAMPLE_ROWS      = 100;
const MAX_READ_BYTES   = 1024 * 1024;          // 1 MB covers 100+ NDJSON lines
const MAX_FULL_PARSE   = 50 * 1024 * 1024;     // 50 MB — read fully below this

/**
 * @param {string} filePath  Absolute path to the JSON file.
 * @param {number} fileSize  File size in bytes (from fs.stat, passed by watcher).
 * @returns {ParseResult}
 */
export function parseJSON(filePath, fileSize = 0) {
  const raw = fileSize > MAX_FULL_PARSE
    ? readChunk(filePath, MAX_READ_BYTES)
    : readChunk(filePath, fileSize + 1); // +1 to read complete file

  const { records, isComplete } = extractRecords(raw);

  if (records.length === 0) {
    return { columns: [], colTypes: {}, rowCount: 0, sample: [] };
  }

  // Union of all keys across sampled records — handles heterogeneous objects.
  const columnSet = new Set();
  for (const rec of records) {
    Object.keys(rec).forEach((k) => columnSet.add(k));
  }
  const columns = [...columnSet];

  const sample   = records.slice(0, SAMPLE_ROWS);
  const colTypes = inferColumnTypes(columns, sample);

  // When file was too large to fully read, report rowCount as null so the UI
  // can display "unknown" instead of an inaccurate number.
  const rowCount = isComplete ? records.length : null;

  return { columns, colTypes, rowCount, sample };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Synchronously read up to `maxBytes` from a file.
 * Running inside a worker thread so synchronous I/O is fine.
 */
function readChunk(filePath, maxBytes) {
  const actualBytes = Math.max(0, maxBytes);
  const buf = Buffer.alloc(actualBytes);
  const fd  = openSync(filePath, 'r');
  const bytesRead = readSync(fd, buf, 0, actualBytes, 0);
  closeSync(fd);
  return buf.slice(0, bytesRead).toString('utf8');
}

/**
 * Attempt to extract an array of plain objects from raw JSON text.
 * Returns { records: object[], isComplete: boolean }
 *   isComplete = false when we hit EOF before the closing bracket (truncated read).
 */
function extractRecords(raw) {
  const trimmed = raw.trim();

  // --- Try standard JSON array ---
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return {
          records:    parsed.filter(isPlainObject).slice(0, SAMPLE_ROWS),
          isComplete: true,
        };
      }
    } catch {
      // JSON.parse failed — possibly truncated. Fall through to NDJSON.
    }
  }

  // --- Try NDJSON (one object per line) ---
  const lines   = trimmed.split('\n');
  const records = [];

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (isPlainObject(obj)) records.push(obj);
    } catch {
      // Skip malformed lines — common in append-only log files.
    }
    if (records.length >= SAMPLE_ROWS) break;
  }

  if (records.length > 0) {
    // isComplete is approximate for NDJSON — we assume truncation only matters
    // for full-file arrays; NDJSON sample is always valid.
    return { records, isComplete: records.length < SAMPLE_ROWS };
  }

  // --- Single top-level object — wrap so downstream always gets an array ---
  try {
    const obj = JSON.parse(trimmed);
    if (isPlainObject(obj)) {
      return { records: [obj], isComplete: true };
    }
  } catch { /* not valid JSON at all */ }

  return { records: [], isComplete: false };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function inferColumnTypes(columns, rows) {
  const types = {};

  for (const col of columns) {
    const values = rows.map((r) => r?.[col]).filter((v) => v != null && v !== '');
    const total  = values.length;

    if (total === 0) { types[col] = 'string'; continue; }

    const numCount    = values.filter((v) => typeof v === 'number').length;
    const boolCount   = values.filter((v) => typeof v === 'boolean').length;
    // Date objects from JSON.parse are impossible — check for ISO string pattern.
    const dateCount   = values.filter((v) => typeof v === 'string' && isDateString(v)).length;

    if (dateCount / total >= 0.7) {
      types[col] = 'date';
    } else if ((numCount + boolCount) / total >= 0.7) {
      types[col] = 'number';
    } else {
      types[col] = 'string';
    }
  }

  return types;
}

function isDateString(str) {
  if (str.length < 8) return false;
  // Only match unambiguous date patterns to avoid false positives on IDs.
  const iso  = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/.test(str);
  const long = /^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}/.test(str);
  if (!iso && !long) return false;

  const ts = Date.parse(str);
  return !Number.isNaN(ts) && ts > -2208988800000 && ts < 4102444800000;
}
