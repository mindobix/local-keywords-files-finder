/**
 * ui/components/KeywordsManager.jsx
 *
 * Free-flowing pill editor for flat keywords.
 * Each keyword pill shows its auto-generated color.
 * Click a pill to expand path/header hints inline.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';

export default function KeywordsManager() {
  const [keywords,  setKeywords]  = useState([]);
  const [expanded,  setExpanded]  = useState(null);   // id of expanded keyword
  const [newName,   setNewName]   = useState('');
  const [busy,      setBusy]      = useState(false);
  const inputRef = useRef(null);

  const load = useCallback(async () => {
    const res  = await fetch('/api/keywords');
    const data = await res.json();
    setKeywords(data);
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Add ────────────────────────────────────────────────────────────────────

  const handleAdd = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await fetch('/api/keywords', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, pathHints: [name.toLowerCase()], headerHints: [] }),
      });
      setNewName('');
      await load();
    } finally { setBusy(false); }
  }, [newName, load]);

  // ── Delete ─────────────────────────────────────────────────────────────────

  const handleDelete = useCallback(async (id) => {
    await fetch(`/api/keywords/${id}`, { method: 'DELETE' });
    setExpanded((e) => e === id ? null : e);
    await load();
  }, [load]);

  // ── Update hints ───────────────────────────────────────────────────────────

  const handleSaveHints = useCallback(async (id, pathHints, headerHints) => {
    await fetch(`/api/keywords/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pathHints, headerHints }),
    });
    await load();
  }, [load]);

  return (
    <div className="kw-manager">
      {/* ── Pill flow ─────────────────────────────────────────── */}
      <div className="kw-pills">
        {keywords.map((kw) => (
          <KeywordPill
            key={kw.id}
            keyword={kw}
            expanded={expanded === kw.id}
            onToggle={() => setExpanded((e) => e === kw.id ? null : kw.id)}
            onDelete={() => handleDelete(kw.id)}
            onSave={(p, h) => handleSaveHints(kw.id, p, h)}
          />
        ))}

        {/* ── Inline add pill ─────────────────────────────────── */}
        <div className="kw-add-pill">
          <input
            ref={inputRef}
            className="kw-add-pill__input"
            placeholder="Add keyword…"
            value={newName}
            disabled={busy}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
          />
          {newName.trim() && (
            <button className="kw-add-pill__btn" onClick={handleAdd} disabled={busy}>
              +
            </button>
          )}
        </div>
      </div>

      <p className="settings-section__hint" style={{ marginTop: 12 }}>
        A file is tagged when its path or column headers match a keyword. Click a keyword to add extra terms — for example, add a person's name to find files containing their data.
      </p>
    </div>
  );
}

// ── KeywordPill ──────────────────────────────────────────────────────────────

function KeywordPill({ keyword, expanded, onToggle, onDelete, onSave }) {
  const [paths,   setPaths]   = useState((keyword.path_hints   ?? []).join(', '));
  const [headers, setHeaders] = useState((keyword.header_hints ?? []).join(', '));
  const [saving,  setSaving]  = useState(false);

  // Sync when parent reloads keyword data
  useEffect(() => {
    setPaths((keyword.path_hints   ?? []).join(', '));
    setHeaders((keyword.header_hints ?? []).join(', '));
  }, [keyword.path_hints, keyword.header_hints]);

  const save = async () => {
    setSaving(true);
    try {
      const split = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
      await onSave(split(paths), split(headers));
    } finally { setSaving(false); }
  };

  return (
    <div className={`kw-pill-wrap${expanded ? ' kw-pill-wrap--open' : ''}`}>
      <div className="kw-pill" style={{ '--kw-color': keyword.color }}>
        <button className="kw-pill__label" onClick={onToggle}>
          <span className="kw-pill__dot" />
          {keyword.name}
        </button>
        <button className="kw-pill__del" onClick={onDelete} title="Delete keyword">×</button>
      </div>

      {expanded && (
        <div className="kw-pill__editor">
          <label className="kw-hint-label">Path hints</label>
          <input
            className="kw-hint-input"
            value={paths}
            onChange={(e) => setPaths(e.target.value)}
            placeholder="e.g. amandeep, tax, finance"
          />
          <label className="kw-hint-label">Header hints</label>
          <input
            className="kw-hint-input"
            value={headers}
            onChange={(e) => setHeaders(e.target.value)}
            placeholder="e.g. salary, invoice, amount"
          />
          <button className="btn btn--primary btn--sm" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save hints'}
          </button>
        </div>
      )}
    </div>
  );
}
