/**
 * REPL Autocomplete Suggestion Engine (pure)
 *
 * Computes inline suggestions for the prompt editor from (text, cursor):
 * - '/' at position 0 → slash-command names (from SLASH_COMMANDS_HELP)
 * - '@' word-initial  → filesystem entries under ctx.workingDir (Task 2)
 *
 * Never touches streams; never throws on I/O errors. UI lives in
 * src/ui/prompt-editor.js.
 */

import fs from 'node:fs';
import path from 'node:path';
import { searchWorkspaceFiles } from '../utils/file-index.js';
import { SLASH_COMMANDS_HELP } from './slash-commands.js';

/** Directory entries never offered as suggestions. Dotfiles are skipped separately. */
const SKIP_DIRS = new Set(['node_modules', '.git']);

/**
 * Unique sorted command names derived from the help table.
 * '/exit, /quit' contributes both; '/provider [id]' contributes 'provider'.
 *
 * @returns {string[]}
 */
export function listCommandNames() {
  const names = new Set();
  for (const { cmd } of SLASH_COMMANDS_HELP) {
    for (const part of cmd.split(',')) {
      const m = part.trim().match(/^\/([a-z][\w-]*)/i);
      if (m) names.add(m[1].toLowerCase());
    }
  }
  return [...names].sort();
}

/**
 * @typedef {Object} Suggestion
 * @property {string} value  Text inserted on select (includes trigger char)
 * @property {string} label  Display text in the popup
 * @property {boolean} [isDir]  File suggestions only: entry is a directory
 */

/**
 * @typedef {Object} SuggestionResult
 * @property {'command'|'file'} kind
 * @property {Suggestion[]} items        May be empty (trigger active, no matches)
 * @property {number} replaceStart       Index in text where replacement begins
 * @property {number} replaceEnd         Index in text where replacement ends
 * @property {string} [dir]              File suggestions only: folder portion being listed (rel, '/'-separated, may be '')
 */

/**
 * Compute inline suggestions for the current buffer + cursor position.
 *
 * @param {string} text   Full prompt text
 * @param {number} cursor Cursor index (0..text.length)
 * @param {{workingDir?: string}} ctx
 * @returns {SuggestionResult|null} null when no trigger is active
 */
export function getSuggestions(text, cursor, ctx = {}) {
  if (typeof text !== 'string' || cursor < 0 || cursor > text.length) return null;

  // ── Command mode: '/' at position 0, cursor before the first whitespace ──
  if (text.startsWith('/')) {
    const before = text.slice(0, cursor);
    if (!/\s/.test(before)) {
      const prefix = before.slice(1).toLowerCase();
      const items = listCommandNames()
        .filter((n) => n.startsWith(prefix))
        .map((n) => ({ value: `/${n}`, label: `/${n}` }));
      return { kind: 'command', items, replaceStart: 0, replaceEnd: cursor };
    }
    // whitespace after command → fall through: a later '@' token still suggests files
  }

  // ── File mode: '@' token that starts at string-start or after whitespace ──
  let start = cursor;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  let end = cursor;
  while (end < text.length && !/\s/.test(text[end])) end++;
  const token = text.slice(start, end);
  if (!token.startsWith('@')) return null;
  if (start > 0 && !/\s/.test(text[start - 1])) return null;

  const rel = token.slice(1);
  const base = ctx.workingDir || process.cwd();
  const slash = rel.lastIndexOf('/');
  const dirPart = slash >= 0 ? rel.slice(0, slash) : '';
  const filePrefix = (slash >= 0 ? rel.slice(slash + 1) : rel).toLowerCase();
  const dirPath = path.join(base, dirPart);

  let items = [];

  if (slash < 0) {
    // ── Hybrid mode: local directory matches + global workspace file search ──
    const immediateEntries = [];
    try {
      immediateEntries.push(...fs.readdirSync(base, { withFileTypes: true }));
    } catch {
      /* ignore */
    }

    const localDirs = immediateEntries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
      .filter((e) => !filePrefix || e.name.toLowerCase().startsWith(filePrefix))
      .map((e) => ({
        value: `@${e.name}/`,
        label: `${e.name}/`,
        isDir: true,
      }));

    // If query is empty, also include immediate root files so @ lists root entries
    const localFiles = !filePrefix
      ? immediateEntries
          .filter((e) => e.isFile() && !e.name.startsWith('.'))
          .map((e) => ({
            value: `@${e.name}`,
            label: e.name,
            isDir: false,
          }))
      : [];

    const globalFiles = searchWorkspaceFiles(filePrefix, base, { limit: 12 }).map((filePath) => ({
      value: `@${filePath}`,
      label: filePath,
      isDir: false,
    }));

    const seen = new Set();
    for (const item of [...localDirs, ...localFiles, ...globalFiles]) {
      if (!seen.has(item.value)) {
        seen.add(item.value);
        items.push(item);
      }
    }
  } else {
    // ── Hierarchical drilldown mode: reading specified dirPath ──
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      entries = []; // missing path / EPERM / ENOTDIR → no suggestions, never throw
    }

    items = entries
      .filter((e) => !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
      .filter((e) => e.name.toLowerCase().startsWith(filePrefix))
      .sort(
        (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
      )
      .map((e) => {
        const isDir = e.isDirectory();
        const relDir = dirPart ? `${dirPart}/` : '';
        return {
          value: `@${relDir}${e.name}${isDir ? '/' : ''}`,
          label: isDir ? `${e.name}/` : e.name,
          isDir,
        };
      });
  }

  return { kind: 'file', items, replaceStart: start, replaceEnd: end, dir: dirPart };
}
