/**
 * ui/components/CategoryGroup.jsx — collapsible keyword group in the sidebar
 */

import React, { useState, memo } from 'react';
import FileItem from './FileItem.jsx';

const CategoryGroup = memo(function CategoryGroup({ category, activeFileId, onFileSelect, searchQuery }) {
  const [open, setOpen] = useState(false);

  const files = searchQuery
    ? (category.files ?? []).filter((f) => f.name.toLowerCase().includes(searchQuery))
    : (category.files ?? []);

  if (files.length === 0) return null;

  return (
    <div className="category-group">
      <button
        className="category-group__header"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className={`chevron${open ? ' chevron--open' : ''}`}>›</span>
        <span className="category-group__dot" style={{ background: category.color }} />
        <span className="category-group__name">{category.name}</span>
        <span className="category-group__count badge">{files.length}</span>
      </button>

      {open && (
        <div className="category-group__body">
          {files.map((file) => (
            <FileItem
              key={file.id}
              file={file}
              isActive={file.id === activeFileId}
              onSelect={onFileSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
});

export default CategoryGroup;
