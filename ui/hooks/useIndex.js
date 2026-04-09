/**
 * ui/hooks/useIndex.js
 *
 * Central data hook. Populates from the REST API on mount, then keeps state
 * live via the SSE stream. All downstream components receive derived state
 * from this single source of truth.
 *
 * Returns:
 *   categoryTree    — [{ name, count, subCategories, files }]
 *   newFiles        — files with is_new === 1
 *   files with hits.length > 0
 *   isScanning      — true while the crawler is running
 *   filesIndexed    — total file count
 *   crawlerRunning  — boolean (distinct from isScanning — stays true between scans)
 */

import { useState, useEffect, useRef, useCallback } from 'react';

const API = '/api';
const SSE_URL = `${API}/events`;

export function useIndex() {
  const [categoryTree,   setCategoryTree]   = useState([]);
  const [allFiles,       setAllFiles]       = useState({}); // keyed by id for O(1) updates
  const [isScanning,     setIsScanning]     = useState(false);
  const [crawlerRunning, setCrawlerRunning] = useState(false);
  const [filesIndexed,   setFilesIndexed]   = useState(0);
  const [dataCleared,    setDataCleared]    = useState(0); // increments on each clear

  // Keep a ref to the EventSource so we can close it on unmount.
  const esRef = useRef(null);

  // ---------------------------------------------------------------------------
  // Initial load
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        // Fetch category tree (includes file metadata) and crawler status in parallel.
        const [catRes, statusRes] = await Promise.all([
          fetch(`${API}/categories`),
          fetch(`${API}/crawler/status`),
        ]);

        if (cancelled) return;

        const categories = await catRes.json();
        const status     = await statusRes.json();

        setCategoryTree(categories);
        setCrawlerRunning(status.running);
        setFilesIndexed(status.filesIndexed);

        // Flatten all files from the category tree into the keyed map.
        // Files that belong to multiple categories appear in multiple places
        // in the tree but must be deduplicated in the map.
        const fileMap = {};
        for (const cat of categories) {
          for (const file of cat.files ?? []) {
            fileMap[file.id] = file;
          }
        }
        setAllFiles(fileMap);

      } catch (err) {
        console.error('[useIndex] Bootstrap fetch failed:', err);
      }
    }

    bootstrap();
    return () => { cancelled = true; };
  }, []);

  // ---------------------------------------------------------------------------
  // SSE stream
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const es = new EventSource(SSE_URL);
    esRef.current = es;

    es.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleSSEMessage(msg);
      } catch (err) {
        console.warn('[useIndex] Failed to parse SSE message:', event.data, err);
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects — we don't need to do anything here.
      // The browser will retry after a short delay.
    };

    return () => es.close();
  }, []); // deliberately empty — we use functional state updates below

  // ---------------------------------------------------------------------------
  // SSE message handler — uses functional state updaters to avoid stale closures
  // ---------------------------------------------------------------------------

  // Pending file_added/file_updated events are batched here so rapid SSE
  // floods (initial scan) don't cause one React re-render per file.
  const pendingFilesRef = useRef({});
  const batchTimerRef   = useRef(null);

  function flushPendingFiles() {
    batchTimerRef.current = null;
    const batch = pendingFilesRef.current;
    pendingFilesRef.current = {};
    if (Object.keys(batch).length === 0) return;
    setAllFiles((prev) => ({ ...prev, ...batch }));
    refreshCategories();
  }

  function scheduleFlush() {
    if (batchTimerRef.current) return; // already scheduled
    batchTimerRef.current = setTimeout(flushPendingFiles, 300);
  }

  const handleSSEMessage = useCallback((msg) => {
    switch (msg.type) {

      case 'file_added':
      case 'file_updated': {
        // Accumulate into batch — applied at most once every 300 ms.
        pendingFilesRef.current[msg.file.id] = msg.file;
        scheduleFlush();
        break;
      }

      case 'file_removed':
        setAllFiles((prev) => {
          const next = { ...prev };
          delete next[msg.id];
          return next;
        });
        refreshCategories();
        break;

      case 'scan_complete':
        setIsScanning(false);
        setFilesIndexed(msg.total);
        break;

      case 'crawler_status':
        setCrawlerRunning(msg.running);
        setIsScanning(msg.running);
        setFilesIndexed(msg.filesIndexed ?? 0);
        break;

      case 'crawler_stopped':
        setCrawlerRunning(false);
        setIsScanning(false);
        break;

      case 'crawler_error':
        console.error('[Crawler]', msg.message);
        break;

      case 'data_cleared':
        // Cancel any pending timers so stale data isn't applied after the wipe.
        if (refreshTimerRef.current) { clearTimeout(refreshTimerRef.current); refreshTimerRef.current = null; }
        if (batchTimerRef.current)   { clearTimeout(batchTimerRef.current);   batchTimerRef.current   = null; }
        pendingFilesRef.current = {};
        setAllFiles({});
        setCategoryTree([]);
        setFilesIndexed(0);
        setIsScanning(false);
        setCrawlerRunning(false);
        setDataCleared((n) => n + 1); // lets App.jsx react via useEffect
        break;

      case 'keywords_updated':
        refreshCategories();
        break;

      default:
        // Unknown event type — ignore gracefully.
        break;
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Category tree refresh (debounced via idle callback)
  // ---------------------------------------------------------------------------

  const refreshTimerRef = useRef(null);

  function refreshCategories() {
    // Debounce: if many file_added events arrive in quick succession (initial
    // walk), only refresh the tree once things quiet down.
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(async () => {
      try {
        const res  = await fetch(`${API}/categories`);
        const cats = await res.json();
        setCategoryTree(cats);
      } catch { /* network error during refresh — silently skip */ }
    }, 300); // 300 ms debounce
  }

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const files    = Object.values(allFiles);
  const newFiles = files.filter((f) => f.is_new === 1);

  return {
    categoryTree,
    newFiles,
    isScanning,
    crawlerRunning,
    filesIndexed,
    dataCleared,
    // Expose so App can mark a file seen after the user clicks it.
    markFileSeen: useCallback(async (fileId) => {
      await fetch(`${API}/files/${fileId}/seen`, { method: 'POST' });
      setAllFiles((prev) => ({
        ...prev,
        [fileId]: { ...prev[fileId], is_new: 0 },
      }));
    }, []),
  };
}
