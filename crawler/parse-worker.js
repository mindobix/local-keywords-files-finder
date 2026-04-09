/**
 * crawler/parse-worker.js
 *
 * Thin worker-thread wrapper around the file parsers.
 * Spawned on-demand by the API server's /api/files/:id/rows endpoint so that
 * synchronous file I/O never blocks the Express event loop.
 */

import { workerData, parentPort } from 'worker_threads';
import { parseCSV }  from './parsers/csv.js';
import { parseJSON } from './parsers/json.js';
// parseXLSX and parseODS are lazy-loaded — both pull in SheetJS which OOMs the worker at import time.

const { filePath, ext, sizeBytes } = workerData;

async function run() {
  let result;
  switch (ext) {
    case '.csv':
    case '.tsv':     result = parseCSV(filePath);              break;
    case '.xlsx':
    case '.xls': {
      const { parseXLSX } = await import('./parsers/xlsx.js');
      result = parseXLSX(filePath);
      break;
    }
    case '.ods':
    case '.numbers': {
      const { parseODS } = await import('./parsers/ods.js');
      result = parseODS(filePath);
      break;
    }
    case '.json':    result = parseJSON(filePath, sizeBytes);  break;
    default:
      result = { columns: [], colTypes: {}, rowCount: 0, sample: [], error: `Unsupported: ${ext}` };
  }
  parentPort.postMessage({ ok: true, result });
}

run().catch((err) => parentPort.postMessage({ ok: false, error: err.message }));
