/**
 * crawler/categorizer.js
 *
 * Flat keyword categorizer. Each keyword has path hints and header hints;
 * a file is tagged with every keyword whose hints match.
 *
 * keywords shape (from db.getKeywordsCompiled):
 *   [{ name, pathHints: RegExp[], headerHints: RegExp[] }]
 *
 * Returns: string[]  — names of all matching keywords
 */

/**
 * @param {string}   filePath  Absolute file path.
 * @param {string[]} columns   Column header names from the parser.
 * @param {object[]} keywords  Compiled keyword list from getKeywordsCompiled(db).
 * @returns {string[]}
 */
export function categorize(filePath, columns = [], keywords = []) {
  // Normalise once — lowercase the full path for case-insensitive substring matching.
  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
  const headerStr      = columns.join(' ').toLowerCase();

  const matched = [];

  for (const kw of keywords) {
    const pathHit   = kw.pathHints.some((re)  => re.test(normalizedPath));
    const headerHit = kw.headerHints.some((re) => re.test(headerStr));
    if (pathHit || headerHit) matched.push(kw.name);
  }

  return matched;
}
