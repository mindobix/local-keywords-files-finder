/**
 * ui/components/App.jsx
 *
 * Root component. Owns the three-panel shell layout:
 *   Left  — <Sidebar>  (always visible, 258 px fixed)
 *   Right — <GridView> | <SettingsPanel> | empty state (flex:1)
 *
 * useIndex() is the single source of truth for file data + crawler state.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useIndex }      from '../hooks/useIndex.js';
import Sidebar           from './Sidebar.jsx';
import GridView          from './GridView.jsx';
import SettingsPanel     from './SettingsPanel.jsx';

const API = '/api';

export default function App() {
  const {
    categoryTree,
    newFiles,
    isScanning,
    crawlerRunning,
    filesIndexed,
    dataCleared,
    markFileSeen,
  } = useIndex();

  // App version — fetched once from API.
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => {
    fetch(`${API}/version`).then((r) => r.json()).then(({ version }) => setAppVersion(version)).catch(() => {});
  }, []);

  // Theme — read from localStorage so it matches the pre-paint inline script.
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem('theme', next);
      document.documentElement.dataset.theme = next;
      return next;
    });
  }, []);

  // Which file is currently open in the main panel (null = empty state).
  const [activeFile,   setActiveFile]   = useState(null);
  // Whether the settings panel is shown instead of the grid.
  const [showSettings, setShowSettings] = useState(false);

  // When the SSE data_cleared event fires, close whatever is open.
  useEffect(() => {
    if (dataCleared > 0) {
      setActiveFile(null);
      setShowSettings(false);
    }
  }, [dataCleared]);

  // Called when the user clicks a file in any sidebar section.
  const handleFileSelect = useCallback(async (file) => {
    setActiveFile(file);
    setShowSettings(false);
    // Clear the "New" badge for this file.
    if (file.is_new) {
      await markFileSeen(file.id);
    }
  }, [markFileSeen]);

  // Gear button toggles the settings panel; clicking again closes it.
  const handleSettingsOpen = useCallback(() => {
    setShowSettings((prev) => !prev);
    if (showSettings) return; // closing — leave active file as-is
    setActiveFile(null);      // opening — clear any selected file
  }, [showSettings]);

  // Called from SettingsPanel after a start/stop request — nothing to do here
  // because the SSE stream will push the updated crawlerRunning state.
  const handleCrawlerToggle = useCallback(() => {}, []);

  // ── Backup / Restore ─────────────────────────────────────────────────────
  const [backupStatus, setBackupStatus] = useState(''); // ''|'saving'|'saved'|'restoring'|'restored'|'error'
  const restoreInputRef = useRef(null);

  const handleBackup = useCallback(async () => {
    setBackupStatus('saving');
    try {
      const res  = await fetch(`${API}/export`);
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `local-explorer-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setBackupStatus('saved');
    } catch {
      setBackupStatus('error');
    } finally {
      setTimeout(() => setBackupStatus(''), 2500);
    }
  }, []);

  const handleRestoreFile = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setBackupStatus('restoring');
    try {
      const data = JSON.parse(await file.text());
      const res  = await fetch(`${API}/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error();
      setBackupStatus('restored');
    } catch {
      setBackupStatus('error');
    } finally {
      setTimeout(() => setBackupStatus(''), 2500);
    }
  }, []);

  // ── Resizable sidebar ────────────────────────────────────────────────────
  const MIN_WIDTH = 180;
  const MAX_WIDTH = 600;
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = parseInt(localStorage.getItem('sidebarWidth'), 10);
    return saved && saved >= MIN_WIDTH && saved <= MAX_WIDTH ? saved : 258;
  });
  const dragging = useRef(false);

  const onDividerMouseDown = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor    = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (ev) => {
      if (!dragging.current) return;
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, ev.clientX));
      setSidebarWidth(next);
    };

    const onMouseUp = (ev) => {
      dragging.current = false;
      document.body.style.cursor    = '';
      document.body.style.userSelect = '';
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, ev.clientX));
      localStorage.setItem('sidebarWidth', String(next));
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup',   onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup',   onMouseUp);
  }, []);

  // ── Alternating title ────────────────────────────────────────────────────
  const TITLES = ['Keywords Files Finder', 'Local Keywords Files Finder'];
  const [titleIdx,   setTitleIdx]   = useState(0);
  const [titleFaded, setTitleFaded] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setTitleFaded(true);
      setTimeout(() => {
        setTitleIdx((i) => (i + 1) % TITLES.length);
        setTitleFaded(false);
      }, 400); // fade out, swap, fade in
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

  const backupLabel = { saving: 'Saving…', saved: 'Saved ✓', restoring: 'Restoring…', restored: 'Restored ✓', error: 'Error ✗' }[backupStatus];

  return (
    <div className="app-shell">

      {/* ── Top bar ───────────────────────────────────────────── */}
      <header className="topbar">
        <div className="topbar__left">
          <span className="topbar__word">Local</span>
          <span className="topbar__sep">›</span>
          <span className={`topbar__brand${titleFaded ? ' topbar__brand--faded' : ''}`}>
            {TITLES[titleIdx]}
          </span>
          {appVersion && <span className="topbar__version">v{appVersion}</span>}
        </div>
        <div className="topbar__right">
          {backupStatus && (
            <span className={`topbar__backup-status${backupStatus === 'error' ? ' topbar__backup-status--error' : ''}`}>
              {backupLabel}
            </span>
          )}
          <button
            className="topbar__btn"
            onClick={handleBackup}
            disabled={!!backupStatus}
            title="Download all settings and taxonomy as a JSON backup"
          >
            ⬇ Backup
          </button>
          <button
            className="topbar__btn"
            onClick={() => restoreInputRef.current?.click()}
            disabled={!!backupStatus}
            title="Restore settings and taxonomy from a backup file"
          >
            ⬆ Restore
          </button>
          <input ref={restoreInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleRestoreFile} />
        </div>
      </header>

      {/* ── Body (sidebar + main) ─────────────────────────────── */}
      <div className="app-body">

      {/* Left: resizable sidebar */}
      <Sidebar
        style={{ width: sidebarWidth, minWidth: sidebarWidth }}
        categoryTree={categoryTree}
        newFiles={newFiles}
        crawlerRunning={crawlerRunning}
        filesIndexed={filesIndexed}
        activeFile={activeFile}
        onFileSelect={handleFileSelect}
        onSettingsOpen={handleSettingsOpen}
      />

      {/* Drag divider */}
      <div className="sidebar-divider" onMouseDown={onDividerMouseDown} />

      {/* Right: main panel */}
      <main className="main-panel">
        {showSettings ? (
          <SettingsPanel
            crawlerRunning={crawlerRunning}
            filesIndexed={filesIndexed}
            onCrawlerToggle={handleCrawlerToggle}
            theme={theme}
            onThemeToggle={toggleTheme}
          />
        ) : (
          <GridView file={activeFile} />
        )}
      </main>

      </div>{/* end app-body */}
    </div>
  );
}
