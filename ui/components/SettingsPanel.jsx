/**
 * ui/components/SettingsPanel.jsx
 */

import React, { useState, useEffect, useCallback } from 'react';
import KeywordsManager from './KeywordsManager.jsx';

const API = '/api';

export default function SettingsPanel({ crawlerRunning, filesIndexed, onCrawlerToggle, theme, onThemeToggle }) {
  const [settings,       setSettings]     = useState({});
  const [lastScan,       setLastScan]      = useState(null);
  const [crawlerBusy,    setCrawlerBusy]  = useState(false);
  const [rescanBusy,     setRescanBusy]   = useState(false);
  const [clearConfirm,   setClearConfirm] = useState(false);
  const [clearBusy,      setClearBusy]    = useState(false);

  // ---------------------------------------------------------------------------
  // Load settings on mount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [settingsRes, statusRes] = await Promise.all([
          fetch(`${API}/settings`),
          fetch(`${API}/crawler/status`),
        ]);
        const { settings: s } = await settingsRes.json();
        const status = await statusRes.json();
        if (cancelled) return;
        setSettings(s);
        setLastScan(status.lastScan);
      } catch (err) {
        console.error('[Settings] Failed to load:', err);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);


  // ---------------------------------------------------------------------------
  // Toggle settings
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Crawler control
  // ---------------------------------------------------------------------------

  const handleCrawlerToggle = useCallback(async () => {
    setCrawlerBusy(true);
    try {
      const endpoint = crawlerRunning ? '/api/crawler/stop' : '/api/crawler/start';
      await fetch(endpoint, { method: 'POST' });
      onCrawlerToggle?.();
    } finally {
      setCrawlerBusy(false);
    }
  }, [crawlerRunning, onCrawlerToggle]);

  // ---------------------------------------------------------------------------
  // Re-scan
  // ---------------------------------------------------------------------------

  const handleRescan = useCallback(async () => {
    setRescanBusy(true);
    try {
      await fetch(`${API}/rescan`, { method: 'POST' });
    } finally {
      setTimeout(() => setRescanBusy(false), 1500);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Clear all data
  // ---------------------------------------------------------------------------

  const handleClear = useCallback(async () => {
    if (!clearConfirm) { setClearConfirm(true); return; }
    setClearBusy(true);
    try {
      await fetch(`${API}/clear`, { method: 'POST' });
    } finally {
      setClearBusy(false);
      setClearConfirm(false);
    }
  }, [clearConfirm]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="settings-panel">
      <h2 className="settings-panel__title">Settings</h2>

      {/* ── Appearance ───────────────────────────────────────── */}
      <section className="settings-section">
        <h3 className="settings-section__heading">Appearance</h3>
        <div className="settings-toggle-row">
          <div className="settings-toggle-row__text">
            <span className="settings-toggle-row__label">{theme === 'dark' ? 'Dark mode' : 'Light mode'}</span>
            <span className="settings-toggle-row__hint">{theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}</span>
          </div>
          <button
            className={`toggle-switch${theme === 'dark' ? ' toggle-switch--on' : ''}`}
            onClick={onThemeToggle}
            role="switch" aria-checked={theme === 'dark'} aria-label="Toggle dark mode"
          >
            <span className="toggle-switch__knob" />
          </button>
        </div>
      </section>



      {/* ── Keywords ──────────────────────────────────────────── */}
      <section className="settings-section">
        <h3 className="settings-section__heading">Keywords</h3>
        <KeywordsManager />
      </section>

      {/* ── Crawler control ───────────────────────────────────── */}
      <section className="settings-section">
        <h3 className="settings-section__heading">Crawler control</h3>
        <div className="crawler-control">
          <div className="crawler-control__status">
            <span className={`status-dot ${crawlerRunning ? 'status-dot--green pulse' : 'status-dot--grey'}`} />
            <span className="crawler-control__label">{crawlerRunning ? 'Running' : 'Stopped'}</span>
          </div>
          <button
            className={`btn ${crawlerRunning ? 'btn--danger' : 'btn--primary'}`}
            onClick={handleCrawlerToggle}
            disabled={crawlerBusy}
          >
            {crawlerBusy ? (crawlerRunning ? 'Stopping…' : 'Starting…') : (crawlerRunning ? 'Stop crawler' : 'Start crawler')}
          </button>
        </div>
        <p className="settings-section__hint">Stopping pauses file watching. The existing index is preserved.</p>
      </section>

      {/* ── Index ─────────────────────────────────────────────── */}
      <section className="settings-section">
        <h3 className="settings-section__heading">Index</h3>
        <div className="index-info">
          <span className="index-info__text">
            {filesIndexed.toLocaleString()} files indexed
            {lastScan ? ` · last full scan ${formatScanTime(lastScan)}` : ' · never scanned'}
          </span>
          <button className="btn btn--secondary" onClick={handleRescan} disabled={rescanBusy || !crawlerRunning}
            title={!crawlerRunning ? 'Start the crawler first' : ''}>
            {rescanBusy ? 'Scanning…' : 'Re-scan ↗'}
          </button>
        </div>
        <div className="index-info" style={{ marginTop: '12px' }}>
          <span className="index-info__text" style={{ color: 'var(--color)' }}>
            {clearConfirm
              ? 'This will delete all indexed files. Are you sure?'
              : 'Remove all crawled data from the index. Settings and taxonomy are kept.'}
          </span>
          <div style={{ display: 'flex', gap: '8px' }}>
            {clearConfirm && (
              <button className="btn btn--secondary" onClick={() => setClearConfirm(false)} disabled={clearBusy}>Cancel</button>
            )}
            <button className="btn btn--danger" onClick={handleClear} disabled={clearBusy}>
              {clearBusy ? 'Clearing…' : clearConfirm ? 'Yes, clear all' : 'Clear all data'}
            </button>
          </div>
        </div>
      </section>

    </div>
  );
}

function formatScanTime(unixSeconds) {
  const d   = new Date(unixSeconds * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  return d.toLocaleDateString();
}
