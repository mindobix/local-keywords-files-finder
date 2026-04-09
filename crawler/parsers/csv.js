/**
 * crawler/parsers/csv.js
 *
 * Parses CSV and TSV files using csv-parse.
 * Returns a normalized ParseResult so all parsers have the same shape.
 */

import { readFileSync, openSync, readSync, closeSync } from 'fs';
import { parse } from 'csv-parse/sync';

// Never read more than 2 MB — enough for hundreds of rows, avoids OOM on
// multi-GB log dumps that happen to have a .csv extension.
const MAX_READ_BYTES = 2 * 1024 * 1024;

const SAMPLE_ROWS     = 100;  // rows returned for keyword scanning + grid preview
const TYPE_INFER_ROWS = 50;   // rows used for column-type inference

/**
 * @param {string} filePath  Absolute path to the CSV/TSV file.
 * @returns {ParseResult}
 */
export function parseCSV(filePath) {
  // Read at most MAX_READ_BYTES so a 2 GB CSV log file doesn't OOM the process.
  let raw;
  try {
    const fd  = openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(MAX_READ_BYTES);
    const n   = readSync(fd, buf, 0, MAX_READ_BYTES, 0);
    closeSync(fd);
    raw = buf.slice(0, n).toString('utf8');
    // Trim to the last newline so we don't pass csv-parse a truncated record.
    const lastNl = raw.lastIndexOf('\n');
    if (lastNl > 0) raw = raw.slice(0, lastNl);
  } catch {
    raw = readFileSync(filePath, 'utf8');
  }

  // Auto-detect delimiter: prefer comma, fall back to tab for .tsv files or
  // files that clearly have more tabs than commas in the first line.
  const firstLine = raw.split('\n')[0] ?? '';
  const delimiter = firstLine.split('\t').length > firstLine.split(',').length
    ? '\t'
    : ',';

  const records = parse(raw, {
    delimiter,
    columns:          true,   // first row as header
    skip_empty_lines: true,
    trim:             true,
    // Relax quoting to handle common real-world CSV quirks.
    relax_quotes:           true,
    relax_column_count:     true,
  });

  if (records.length === 0) {
    return { columns: [], colTypes: {}, rowCount: 0, sample: [] };
  }

  const columns  = Object.keys(records[0]);
  const sample   = records.slice(0, SAMPLE_ROWS);
  const colTypes = inferColumnTypes(columns, records.slice(0, TYPE_INFER_ROWS));

  return { columns, colTypes, rowCount: records.length, sample };
}

// ---------------------------------------------------------------------------
// Type inference
// ---------------------------------------------------------------------------

/**
 * Heuristic column-type inference.
 * Examines up to TYPE_INFER_ROWS values per column. A column is classified as:
 *   - 'date'   — if ≥ 70 % of non-empty values parse as a date
 *   - 'number' — if ≥ 70 % of non-empty values parse as a number
 *   - 'string' — otherwise
 */
function inferColumnTypes(columns, rows) {
  const types = {};

  for (const col of columns) {
    const values    = rows.map((r) => r[col]).filter((v) => v != null && v !== '');
    const total     = values.length;

    if (total === 0) { types[col] = 'string'; continue; }

    const numCount  = values.filter(isNumeric).length;
    const dateCount = values.filter(isDateLike).length;

    if (dateCount / total >= 0.7) {
      types[col] = 'date';
    } else if (numCount / total >= 0.7) {
      types[col] = 'number';
    } else {
      types[col] = 'string';
    }
  }

  return types;
}

function isNumeric(value) {
  // Strip currency symbols, commas, percent signs before testing.
  const cleaned = String(value).replace(/[$,€£%]/g, '').trim();
  return cleaned !== '' && !Number.isNaN(Number(cleaned));
}

function isDateLike(value) {
  const str = String(value).trim();
  if (str.length < 6) return false;

  // Quick pattern pre-check before expensive Date.parse.
  const datePatterns = [
    /^\d{4}-\d{2}-\d{2}/,                         // ISO 8601
    /^\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/,    // M/D/Y or D/M/Y
    /^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}/,         // "January 1, 2024"
  ];
  if (!datePatterns.some((p) => p.test(str))) return false;

  const ts = Date.parse(str);
  // Exclude obviously wrong timestamps (year < 1900 or > 2100).
  return !Number.isNaN(ts) && ts > -2208988800000 && ts < 4102444800000;
}
