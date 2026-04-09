/**
 * ui/components/GridView.jsx
 *
 * Main panel. Renders:
 *   - Data grid   for CSV / TSV / XLSX / XLS / ODS / Numbers
 *   - iframe      for PDF and HTML
 *   - Text viewer for TXT
 */

import { useMemo, useState, useEffect } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
} from '@tanstack/react-table';
import { useGrid }  from '../hooks/useGrid.js';
import SmartFilters from './SmartFilters.jsx';

const MAX_VISIBLE_COLS = 6;

// ---------------------------------------------------------------------------
// File type helpers
// ---------------------------------------------------------------------------

const TYPE_BADGE_CLASS = {
  csv:  'type-badge--csv',  tsv:  'type-badge--csv',
  xlsx: 'type-badge--xlsx', xls:  'type-badge--xlsx',
  ods:  'type-badge--ods',  numbers: 'type-badge--ods',
  pdf:  'type-badge--pdf',
  txt:  'type-badge--txt',
};

const DOC_EXTS   = new Set(['pdf']);
const TEXT_EXTS  = new Set(['txt']);
const TABLE_EXTS = new Set(['csv', 'tsv', 'xlsx', 'xls', 'ods', 'numbers']);

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024)    return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Sub-views
// ---------------------------------------------------------------------------

function DocViewer({ file }) {
  return (
    <iframe
      key={file.id}
      src={`/api/files/${file.id}/content`}
      className="doc-viewer"
      title={file.name}
      sandbox={file.ext === 'pdf' ? undefined : 'allow-same-origin'}
    />
  );
}

function TextViewer({ file }) {
  const [text, setText]     = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/files/${file.id}/content`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((t) => { if (!cancelled) { setText(t); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [file.id]);

  if (loading) return <div className="grid-loading">Loading…</div>;
  if (error)   return <div className="grid-error">Failed to load: {error}</div>;

  return <pre className="text-viewer">{text}</pre>;
}

function DataGrid({ file }) {
  const {
    rows, columns, total,
    filters, activeFilters, toggleFilter,
    isLoading, error,
  } = useGrid(file);

  const visibleColumns = columns.slice(0, MAX_VISIBLE_COLS);
  const hiddenCount    = Math.max(0, columns.length - MAX_VISIBLE_COLS);

  const columnDefs = useMemo(() => visibleColumns.map((col) => ({
    id:          col,
    accessorKey: col,
    header:      col,
    cell:        (info) => (info.getValue() == null ? '' : String(info.getValue())),
  })), [visibleColumns.join(',')]); // eslint-disable-line

  const table = useReactTable({
    data:              rows,
    columns:           columnDefs,
    getCoreRowModel:   getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <>
      <SmartFilters filters={filters} activeFilters={activeFilters} onToggle={toggleFilter} />

      {isLoading && <div className="grid-loading">Loading…</div>}
      {error     && <div className="grid-error">Failed to load: {error}</div>}

      {!isLoading && !error && (
        <div className="grid-table-wrap">
          <div className="grid-row-count">
            {total != null && `${total.toLocaleString()} rows · `}{columns.length} cols
          </div>
          <table className="grid-table">
            <thead>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((header) => (
                    <th
                      key={header.id}
                      className="grid-th"
                      onClick={header.column.getToggleSortingHandler()}
                      style={{ cursor: 'pointer', userSelect: 'none' }}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getIsSorted() === 'asc'  && ' ↑'}
                      {header.column.getIsSorted() === 'desc' && ' ↓'}
                    </th>
                  ))}
                  {hiddenCount > 0 && (
                    <th className="grid-th grid-th--overflow">+{hiddenCount} more</th>
                  )}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr key={row.id} className="grid-row">
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="grid-td">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                  {hiddenCount > 0 && <td className="grid-td grid-td--overflow" />}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && !isLoading && (
            <div className="grid-no-rows">No rows match the current filters.</div>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export default function GridView({ file }) {
  if (!file) {
    return (
      <div className="grid-empty">
        <div className="grid-empty__icon">🗂</div>
        <div className="grid-empty__text">Select a file from the sidebar to preview it</div>
      </div>
    );
  }

  const ext = (file.ext ?? '').toLowerCase();

  return (
    <div className="grid-view">

      {/* ── Header ──────────────────────────────────────────── */}
      <div className="grid-header">
        <div className="grid-header__left">
          <span className="grid-header__filename">{file.name}</span>
          <span className={`type-badge ${TYPE_BADGE_CLASS[ext] ?? ''}`}>
            {file.ext?.toUpperCase()}
          </span>
          {file.is_new === 1 && <span className="badge badge--new">New</span>}
        </div>
        <div className="grid-header__meta">
          {formatBytes(file.size_bytes)}
          <button
            className="reveal-btn"
            onClick={() => fetch(`/api/files/${file.id}/reveal`, { method: 'POST' })}
            title="Reveal in Finder / Explorer"
          >
            ↗ Show in {window.navigator.platform.startsWith('Win') ? 'Explorer' : 'Finder'}
          </button>
        </div>
      </div>

      {/* ── Content area ────────────────────────────────────── */}
      {DOC_EXTS.has(ext)   && <DocViewer  file={file} />}
      {TEXT_EXTS.has(ext)  && <TextViewer file={file} />}
      {TABLE_EXTS.has(ext) && <DataGrid   file={file} />}
      {!DOC_EXTS.has(ext) && !TEXT_EXTS.has(ext) && !TABLE_EXTS.has(ext) && (
        <div className="grid-no-rows">No preview available for .{ext} files.</div>
      )}

    </div>
  );
}
