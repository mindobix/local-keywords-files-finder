/**
 * ui/hooks/useGrid.js
 *
 * Fetches paginated row data for a selected file and derives the smart filter
 * pill list from the column types returned by the API.
 *
 * Returns:
 *   columns      — string[]
 *   rows         — object[]
 *   colTypes     — { [colName]: 'date' | 'number' | 'string' }
 *   total        — total row count (may be null for large JSON files)
 *   filters      — FilterPill[]
 *   activeFilters— Set of active filter ids
 *   toggleFilter — (filterId: string) => void
 *   isLoading    — boolean
 *   error        — string | null
 */

import { useState, useEffect, useCallback, useMemo } from 'react';

const API = '/api';

export function useGrid(file) {
  const [rows,          setRows]         = useState([]);
  const [columns,       setColumns]      = useState([]);
  const [colTypes,      setColTypes]     = useState({});
  const [total,         setTotal]        = useState(0);
  const [isLoading,     setIsLoading]    = useState(false);
  const [error,         setError]        = useState(null);
  const [activeFilters, setActiveFilters] = useState(new Set());

  useEffect(() => {
    if (!file) {
      setRows([]); setColumns([]); setColTypes({});
      setTotal(0); setError(null); setActiveFilters(new Set());
      return;
    }

    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    setActiveFilters(new Set());

    fetch(`${API}/files/${file.id}/rows?page=0&limit=100`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        setRows(data.rows);
        setColumns(data.columns);
        setColTypes(data.colTypes);
        setTotal(data.total);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err.message);
      })
      .finally(() => setIsLoading(false));

    return () => controller.abort();
  }, [file?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleFilter = useCallback((filterId) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      next.has(filterId) ? next.delete(filterId) : next.add(filterId);
      return next;
    });
  }, []);

  const filters     = useMemo(() => file ? inferFilters(columns, colTypes) : [],
    [columns.join(','), JSON.stringify(colTypes), file?.id]); // eslint-disable-line

  const filteredRows = useMemo(() => applyFilters(rows, filters, activeFilters),
    [rows, filters, activeFilters]); // eslint-disable-line

  return {
    rows:    filteredRows,
    columns,
    colTypes,
    total,
    filters,
    activeFilters,
    toggleFilter,
    isLoading,
    error,
  };
}

// ---------------------------------------------------------------------------
// Smart filter inference
// ---------------------------------------------------------------------------

function inferFilters(columns, colTypes) {
  const pills = [];

  const dateCol = columns.find((c) => colTypes[c] === 'date');
  if (dateCol) {
    pills.push({ id: 'date_range', label: 'date range', variant: 'default', colName: dateCol });
  }

  const numCol = columns.find((c) => colTypes[c] === 'number');
  if (numCol) {
    pills.push({ id: 'rows_gt_100', label: 'rows > 100', variant: 'default', colName: numCol });
  }

  const amountCols = columns.filter((c) =>
    /\b(amount|revenue|total|price|cost|value)\b/i.test(c)
  );
  for (const col of amountCols) {
    pills.push({ id: `has_${col}`, label: `has: ${col}`, variant: 'default', colName: col });
  }

  return pills;
}

// ---------------------------------------------------------------------------
// Filter application
// ---------------------------------------------------------------------------

/**
 * Apply active filters to the row set. Highlight filters are visual only
 * (they highlight cells, not hide rows), so they're skipped here.
 */
function applyFilters(rows, filters, activeFilters) {
  if (activeFilters.size === 0) return rows;

  let result = [...rows];

  for (const filter of filters) {
    if (!activeFilters.has(filter.id)) continue;
    if (filter.id === 'rows_gt_100') {
      result = result.filter((row) => {
        const v = Number(row[filter.colName]);
        return !Number.isNaN(v) && v > 100;
      });
    }
    // date_range and has_* are visual-only pills — no row filtering yet.
  }

  return result;
}
