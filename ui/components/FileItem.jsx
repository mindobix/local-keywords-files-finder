/**
 * ui/components/FileItem.jsx — L3 sidebar row (individual file)
 *
 * Props:
 *   file         — file record
 *   isActive     — boolean (currently open in main panel)
 *   onSelect     — (file) => void
 */

import React, { memo } from 'react';

// Map extension strings to CSS custom property names.
const EXT_STYLE = {
  csv:     { bg: 'var(--csv-bg)',  fg: 'var(--csv-fg)',  label: 'CS' },
  tsv:     { bg: 'var(--csv-bg)',  fg: 'var(--csv-fg)',  label: 'TS' },
  xlsx:    { bg: 'var(--xlsx-bg)', fg: 'var(--xlsx-fg)', label: 'XL' },
  xls:     { bg: 'var(--xlsx-bg)', fg: 'var(--xlsx-fg)', label: 'XL' },
  ods:     { bg: 'var(--ods-bg)',  fg: 'var(--ods-fg)',  label: 'OD' },
  numbers: { bg: 'var(--ods-bg)',  fg: 'var(--ods-fg)',  label: 'NB' },
  json:    { bg: 'var(--json-bg)', fg: 'var(--json-fg)', label: 'JS' },
};

const FileItem = memo(function FileItem({ file, isActive, onSelect }) {
  const ext   = (file.ext ?? '').toLowerCase();
  const style = EXT_STYLE[ext] ?? { bg: 'var(--bg-tertiary)', fg: 'var(--text-secondary)', label: ext.toUpperCase().slice(0, 2) };

  return (
    <button
      className={`file-item${isActive ? ' file-item--active' : ''}`}
      onClick={() => onSelect(file)}
      title={file.path}
    >
      {/* File type badge box */}
      <span
        className="file-item__type-badge"
        style={{ background: style.bg, color: style.fg }}
      >
        {style.label}
      </span>

      {/* Name + timestamp */}
      <span className="file-item__body">
        <span className="file-item__name">{file.name}</span>
        <span className="file-item__time">{relativeTime(file.modified)}</span>
      </span>
    </button>
  );
});

export default FileItem;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(unixSeconds) {
  if (!unixSeconds) return '';
  const diff = Date.now() / 1000 - unixSeconds;

  if (diff < 60)          return 'just now';
  if (diff < 3600)        return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)       return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7)   return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}
