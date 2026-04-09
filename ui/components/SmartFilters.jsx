/**
 * ui/components/SmartFilters.jsx
 *
 * Renders the filter pill bar below the GridView header.
 *
 * Props:
 *   filters       — FilterPill[] from useGrid
 *   activeFilters — Set<string> of active filter ids
 *   onToggle      — (filterId: string) => void
 *   onAnalyze     — () => void  (called when "analyze ↗" pill is clicked)
 */

import React from 'react';

export default function SmartFilters({ filters, activeFilters, onToggle }) {
  if (!filters || filters.length === 0) return null;

  return (
    <div className="smart-filters" role="group" aria-label="Smart filters">
      {filters.map((pill) => {
        const isActive = activeFilters.has(pill.id);
        return (
          <button
            key={pill.id}
            className={[
              'filter-pill',
              'filter-pill--default',
              isActive ? 'filter-pill--active' : '',
            ].filter(Boolean).join(' ')}
            onClick={() => onToggle(pill.id)}
            aria-pressed={isActive}
          >
            {pill.label}
          </button>
        );
      })}
    </div>
  );
}
