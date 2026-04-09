#!/usr/bin/env node
/**
 * scripts/bump-version.mjs
 *
 * Increments the patch segment of version.json (e.g. 1.0.0 → 1.0.1).
 * Called automatically by the pre-commit git hook.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'version.json');

const { version } = JSON.parse(readFileSync(file, 'utf8'));
const [major, minor, patch] = version.split('.').map(Number);
const next = `${major}.${minor}.${patch + 1}`;

writeFileSync(file, JSON.stringify({ version: next }, null, 2) + '\n');
console.log(`version: ${version} → ${next}`);
