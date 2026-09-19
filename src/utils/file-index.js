/**
 * In-Memory Cached Workspace File Indexer & Fuzzy Scorer
 * Zero-dependency helper for fast file suggestions.
 */

import fs from 'node:fs';
import path from 'node:path';

const CACHE_TTL_MS = 30_000;
const MAX_INDEX_ENTRIES = 5_000;

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.rar',
  '.7z',
  '.exe',
  '.bin',
  '.dll',
  '.so',
  '.dylib',
  '.iso',
  '.mp3',
  '.mp4',
  '.wav',
  '.mov',
  '.avi',
  '.webm',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
]);

const IGNORE_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  '.faycli',
  '.next',
  '.nuxt',
  'dist',
  'build',
  'coverage',
  '.cache',
]);

/** @type {Map<string, { files: string[], timestamp: number }>} */
const cache = new Map();

/**
 * Invalidate in-memory file cache
 */
export function clearFileIndexCache() {
  cache.clear();
}

/**
 * Scan workspace files synchronously with an iterative stack, respecting ignore lists and caching results
 *
 * @param {string} [workingDir=process.cwd()]
 * @param {object} [options={}]
 * @param {boolean} [options.forceRefresh=false]
 * @returns {string[]} Relative POSIX paths
 */
export function getWorkspaceFiles(workingDir = process.cwd(), options = {}) {
  const normalizedBase = path.resolve(workingDir);
  const now = Date.now();
  const cached = cache.get(normalizedBase);

  if (!options.forceRefresh && cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.files;
  }

  const files = [];
  const stack = [normalizedBase];
  let count = 0;

  try {
    while (stack.length > 0) {
      const currentDir = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (IGNORE_DIR_NAMES.has(entry.name) || entry.name.startsWith('.')) continue;

        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile()) {
          if (++count > MAX_INDEX_ENTRIES) break;
          const ext = path.extname(entry.name).toLowerCase();
          if (!BINARY_EXTENSIONS.has(ext)) {
            const rel = path.relative(normalizedBase, fullPath);
            files.push(rel.split(path.sep).join('/'));
          }
        }
      }
      if (count > MAX_INDEX_ENTRIES) break;
    }
  } catch {
    return cached ? cached.files : [];
  }

  cache.set(normalizedBase, { files, timestamp: now });
  return files;
}

/**
 * Score and filter files matching a query string
 *
 * @param {string} query
 * @param {string} [workingDir=process.cwd()]
 * @param {object} [options={}]
 * @param {number} [options.limit=10]
 * @returns {string[]}
 */
export function searchWorkspaceFiles(query, workingDir = process.cwd(), options = {}) {
  const limit = options.limit || 10;
  const files = getWorkspaceFiles(workingDir);
  const q = (query || '').toLowerCase().trim();

  if (!q) {
    return files.slice(0, limit);
  }

  const scored = [];

  for (const file of files) {
    const lowerFile = file.toLowerCase();
    const basename = path.posix.basename(lowerFile);

    // Exact basename match gets highest score
    if (basename === q) {
      scored.push({ file, score: 100 });
      continue;
    }
    // Basename starts with query
    if (basename.startsWith(q)) {
      scored.push({ file, score: 80 });
      continue;
    }
    // Basename contains query
    if (basename.includes(q)) {
      scored.push({ file, score: 60 });
      continue;
    }
    // Full relative path starts with query
    if (lowerFile.startsWith(q)) {
      scored.push({ file, score: 40 });
      continue;
    }
    // Full relative path contains query
    if (lowerFile.includes(q)) {
      scored.push({ file, score: 20 });
      continue;
    }
  }

  scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return scored.slice(0, limit).map((s) => s.file);
}
