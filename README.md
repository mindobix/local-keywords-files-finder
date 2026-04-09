# Local Keywords Files Finder

> **Find any file on your machine — instantly — by what's inside it.**

Local Keywords Files Finder is a privacy-first, zero-cloud desktop tool that crawls your local filesystem, reads spreadsheet column headers and file paths, and surfaces the right files the moment you need them. No uploading. No indexing service. No subscription. Everything runs on your machine.

---

## Why This Exists

You have hundreds of spreadsheets, CSVs, and documents scattered across your Downloads, Desktop, and project folders. You remember a file had a "salary" column or was named something like "payroll" — but you can't find it. Spotlight doesn't look inside files. Finder search is slow. This tool does exactly that, continuously, in the background.

---

## What It Does

- **Crawls your filesystem** continuously, watching for new and changed files
- **Reads file contents** — column headers in spreadsheets, text in documents
- **Matches files against your keywords** using both path hints and column header hints
- **Organises matches into categories** you define — Financial, Tax, Payroll, anything
- **Shows you results in real time** via a live sidebar, updated as files are indexed
- **Previews file contents** — scroll through rows, search columns, paginate large files
- **Backs up and restores** your entire keyword configuration as a portable JSON file

---

## Supported File Types

| Type | Extensions |
|------|-----------|
| Spreadsheets | `.csv`, `.tsv`, `.xlsx`, `.xls` |
| Open formats | `.ods`, `.numbers` |
| Documents | `.pdf`, `.txt` |

The crawler automatically skips lock files, config files, dependency folders (`node_modules`, `__pycache__`, `venv`), build artefacts (`dist`, `out`), hex-named files (hashes, UUIDs), and any file whose name contains no recognisable English words.

---

## How Keyword Matching Works

Every keyword has two independent matching rules:

**Path hints** — matched against the full file path (case-insensitive regex)
```
keyword: "payroll"
path hint: "payroll"
→ matches /Documents/payroll_2024.csv
→ matches /HR/payroll/january.xlsx
```

**Header hints** — matched against column names inside the file
```
keyword: "salary"
header hint: "salary, gross_pay, net_pay"
→ matches any CSV/XLSX with a column named "salary"
→ matches any spreadsheet with a "gross_pay" or "net_pay" column
```

A file is indexed if it matches **any** keyword's path hint **or** header hint. Files with zero matches are silently skipped, keeping your index lean and relevant.

---

## Features

### Live Sidebar
Files are organised into keyword categories in a collapsible sidebar. A **NEW** section highlights recently discovered files. Click any file to open a full preview.

### File Preview & Grid View
Click a file to see a paginated data grid with sortable columns. Large files are loaded page by page. Search within columns. Reveal the file's location in Finder.

### Keyword Manager
Add, edit, and delete keywords directly from the Settings panel. Each keyword is a colour-coded pill. Click a keyword to expand it and edit its path and header hints. Changes trigger an immediate re-scan of all indexed files.

### Real-Time Updates
The UI connects via Server-Sent Events (SSE). New files appear in the sidebar within seconds of being created or changed on disk — no page refresh needed.

### Backup & Restore
Export your entire keyword taxonomy and settings as a single JSON file. Restore on any machine running the app. Useful for sharing keyword sets across a team or backing up before a clean install.

### Dark / Light Theme
Toggle between dark and light themes. Theme preference persists across sessions.

### Version Display
The current app version is shown in the top bar. The version auto-increments on every git commit via a pre-commit hook.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite, TanStack React Table |
| API Server | Express.js (port 3001) |
| Crawler / Indexer | Node.js Worker Thread + Chokidar (port 3002) |
| Database | SQLite 3 (better-sqlite3, WAL mode) |
| File Parsing | csv-parse, SheetJS (xlsx) |

The crawler runs as a separate process with a dedicated control API. SQLite WAL mode lets the crawler write while the API reads — no locking, no blocking.

---

## Getting Started

### Requirements

- Node.js 18 or later
- npm

### Install

```bash
git clone <repo-url>
cd local-keywords-files-finder
npm install
npm run setup-hooks   # installs the git pre-commit version-bump hook
```

### Run

```bash
npm run dev
```

This starts three processes concurrently:

| Process | Port | Role |
|---------|------|------|
| Indexer | 3002 | File crawler + control API |
| API Server | 3001 | REST + SSE for the UI |
| Vite Dev Server | 5173 | React frontend |

Open [http://localhost:5173](http://localhost:5173) in your browser.

### Fresh Start (clear all indexed data)

```bash
npm run dev:fresh
```

Wipes the database and starts a clean crawl from scratch.

---

## Configuration

### Watch Path

By default the crawler watches your **home directory**. Override with an environment variable:

```bash
WATCH_PATH=/Volumes/Data npm run dev
```

### Ports

```bash
API_PORT=3001 INDEXER_PORT=3002 npm run dev
```

### Keywords

Keywords are managed entirely through the Settings panel in the UI. No config files to edit.

---

## All API Endpoints

The API server runs on `http://localhost:3001`.

### Files
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/files` | List files (`?category=X&hits=1&new=1`) |
| `GET` | `/api/files/:id` | Get single file record |
| `POST` | `/api/files/:id/seen` | Mark file as seen |
| `GET` | `/api/files/:id/content` | Stream raw PDF/TXT content |
| `POST` | `/api/files/:id/reveal` | Open file location in Finder |
| `GET` | `/api/files/:id/rows` | Paginated rows (`?page=0&limit=100&col=name&dir=asc`) |

### Categories & Keywords
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/categories` | Category tree with file counts |
| `GET` | `/api/keywords` | Flat keyword list |
| `POST` | `/api/keywords` | Add keyword |
| `PUT` | `/api/keywords/:id` | Update keyword hints |
| `DELETE` | `/api/keywords/:id` | Delete keyword |

### Settings & Backup
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/settings` | All settings |
| `POST` | `/api/settings` | Upsert a setting |
| `GET` | `/api/export` | Download backup JSON |
| `POST` | `/api/import` | Restore from backup JSON |

### Crawler Control
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/crawler/status` | Running state + file count |
| `POST` | `/api/crawler/start` | Start crawling |
| `POST` | `/api/crawler/stop` | Stop crawling |
| `POST` | `/api/rescan` | Re-scan filesystem |
| `POST` | `/api/clear` | Wipe index and restart |

### Live Updates
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/events` | SSE stream (file_added, file_updated, scan_complete, …) |
| `GET` | `/api/version` | App version |

---

## Database Schema

```
files                  — indexed file records (path, columns, hits, categories)
taxonomy_categories    — user-defined keyword categories with path/header hints
taxonomy_subcategories — sub-categories (cascade-deleted with parent)
keywords_builtin       — built-in keyword seed list
settings               — key-value store for app configuration
```

The database lives at `db/explorer.db`. It is excluded from git and never leaves your machine.

---

## Version Bumping

The app version is stored in `version.json`. A git pre-commit hook automatically increments the patch number (`1.0.0 → 1.0.1`) on every commit and stages the updated file.

To manually bump:
```bash
node scripts/bump-version.mjs
```

To reinstall the hook after cloning:
```bash
npm run setup-hooks
```

---

## Privacy

- **Nothing leaves your machine.** No telemetry, no analytics, no cloud sync.
- **No API keys required.** The app works entirely offline.
- **Database is local-only.** `db/explorer.db` is gitignored and never committed.
- **Your files are never copied.** Only metadata (path, column names, row counts) is stored — not file contents.

---

## Roadmap Ideas

- Full-text search within file contents
- Export matched file lists to CSV
- Duplicate file detection and reporting
- Scheduled re-scan intervals
- Multi-folder watch paths
- Shareable keyword packs

---

## License

MIT — free to use, modify, and distribute.
