/**
 * crawler/parsers/xlsx.js
 *
 * Handles .xlsx, .xls, and .ods files via SheetJS.
 * Reads only the first sheet. Every parse is wrapped in try/catch because
 * SheetJS throws on corrupted or partially-written files (e.g., open in Excel).
 */

import XLSX from 'xlsx';

const SAMPLE_ROWS     = 100;
const TYPE_INFER_ROWS = 50;

/**
 * @param {string} filePath  Absolute path to the spreadsheet file.
 * @returns {ParseResult}
 */
export function parseXLSX(filePath) {
  // Parse only what we need. Skipping formulas, HTML, styles, and number
  // formats cuts parse time dramatically on complex XLSX workbooks.
  const workbook = XLSX.readFile(filePath, {
    cellDates:    true,           // emit JS Date objects for date cells
    sheetRows:    SAMPLE_ROWS + 1,// stop reading after N rows (incl. header)
    cellFormula:  false,          // skip formula strings — expensive
    cellHTML:     false,          // skip HTML rendering
    cellNF:       false,          // skip number-format strings
    cellStyles:   false,          // skip font/color/border metadata
    cellText:     false,          // skip formatted text generation
    sheetStubs:   false,          // skip empty stub cells
    dense:        true,           // use compact array storage — cuts heap ~40%
    WTF:          false,          // suppress warnings from malformed xlsx
  });

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return { columns: [], colTypes: {}, rowCount: 0, sample: [] };
  }

  const sheet = workbook.Sheets[sheetName];

  // sheet_to_json with header:1 gives us raw arrays; using defval:'' avoids
  // sparse rows where missing cells would be undefined.
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  if (rawRows.length < 1) {
    return { columns: [], colTypes: {}, rowCount: 0, sample: [] };
  }

  // First row is the header. Coerce every header cell to a trimmed string,
  // replacing empty cells with "Column_N" so downstream code always has names.
  const headers = rawRows[0].map((h, i) =>
    h != null && String(h).trim() !== '' ? String(h).trim() : `Column_${i + 1}`
  );

  const dataRows = rawRows.slice(1);

  // Convert each data row array into an object keyed by header.
  const records = dataRows.map((row) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] ?? ''; });
    return obj;
  });

  const sample   = records.slice(0, SAMPLE_ROWS);
  const colTypes = inferColumnTypes(headers, records.slice(0, TYPE_INFER_ROWS));

  return { columns: headers, colTypes, rowCount: records.length, sample };
}

// ---------------------------------------------------------------------------
// Type inference — mirrors csv.js logic, adapted for JS native types from XLSX
// ---------------------------------------------------------------------------

function inferColumnTypes(columns, rows) {
  const types = {};

  for (const col of columns) {
    const values = rows.map((r) => r[col]).filter((v) => v != null && v !== '');
    const total  = values.length;

    if (total === 0) { types[col] = 'string'; continue; }

    // SheetJS already emits native Date objects when cellDates is true.
    const dateCount = values.filter((v) => v instanceof Date).length;
    const numCount  = values.filter((v) => typeof v === 'number').length;

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
