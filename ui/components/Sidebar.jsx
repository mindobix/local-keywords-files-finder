/**
 * ui/components/Sidebar.jsx
 *
 * Three-section sidebar layout:
 *   A. Top bar   — search input + gear icon
 *   B. NEW       — newly crawled files
 *   C. CATEGORIES— category tree
 *   D. SENSITIVE — files with sensitive hits
 *   E. Footer    — crawler status indicator
 *
 * All collapse states live here. Receives data from App via props (which gets
 * it from useIndex). Search query is local state — it filters all sections.
 */

import React, { useState } from 'react';
import CategoryGroup from './CategoryGroup.jsx';
import FileItem      from './FileItem.jsx';

export default function Sidebar({
  categoryTree,
  newFiles,
  crawlerRunning,
  filesIndexed,
  activeFile,
  onFileSelect,
  onSettingsOpen,
  style,
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [newOpen,     setNewOpen]     = useState(false);

  const q = searchQuery.toLowerCase().trim();

  const filteredNew = q
    ? newFiles.filter((f) => f.name.toLowerCase().includes(q))
    : newFiles;

  // Sensitive files stay in their categories — no filtering needed.
  const cleanCategoryTree = categoryTree;

  return (
    <aside className="sidebar" style={style}>

      {/* ── A. Top bar ────────────────────────────────────── */}
      <div className="sidebar__topbar">
        <input
          className="sidebar__search"
          type="search"
          placeholder="Search files…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="Search files"
        />
        <button
          className="sidebar__gear"
          onClick={onSettingsOpen}
          title="Settings"
          aria-label="Open settings"
        >
          ⚙
        </button>
      </div>

      {/* ── Scrollable body ───────────────────────────────── */}
      <div className="sidebar__body">

        {/* ── B. NEW section — files that appeared while the watcher was running ── */}
        {filteredNew.length > 0 && (
          <section className="sidebar__section">
            <div className="sidebar__section-label">NEW</div>

            <button
              className="sidebar__l1-row"
              onClick={() => setNewOpen((o) => !o)}
              aria-expanded={newOpen}
            >
              <span className={`chevron${newOpen ? ' chevron--open' : ''}`}>›</span>
              <span className="sidebar__l1-name">Added this session</span>
              <span className="badge badge--new">{filteredNew.length} new</span>
            </button>

            {newOpen && filteredNew.map((file) => (
              <div key={file.id} style={{ paddingLeft: '16px' }}>
                <FileItem
                  file={file}
                  isActive={activeFile?.id === file.id}
                  onSelect={onFileSelect}
                />
              </div>
            ))}
          </section>
        )}

        {/* ── C. CATEGORIES section ───────────────────────── */}
        <section className="sidebar__section">
          <div className="sidebar__section-label">CATEGORIES</div>

          {cleanCategoryTree.map((cat) => (
            <CategoryGroup
              key={cat.name}
              category={cat}
              activeFileId={activeFile?.id}
              onFileSelect={onFileSelect}
              searchQuery={q}
            />
          ))}

          {cleanCategoryTree.length === 0 && !q && (
            <p className="sidebar__empty">No files indexed yet.</p>
          )}
        </section>

      </div>{/* end sidebar__body */}

      {/* ── E. Footer — crawler status ────────────────────── */}
      <footer className="sidebar__footer">
        {crawlerRunning ? (
          <>
            <span className="status-dot status-dot--green pulse" />
            <span>
              Crawling — {filesIndexed.toLocaleString()} files indexed
            </span>
          </>
        ) : (
          <>
            <span className="status-dot status-dot--grey" />
            <span>
              Crawler stopped — {filesIndexed.toLocaleString()} files indexed
            </span>
          </>
        )}
      </footer>

    </aside>
  );
}
