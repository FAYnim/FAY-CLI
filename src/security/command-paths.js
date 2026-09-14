/**
 * H-1: Command-text path auditing.
 *
 * `SecurityGuard.inspectCommand` only pattern-matches the raw command string.
 * This module tokenizes a command shell-lite (quote-aware) and resolves every
 * *unquoted* path-looking token against the workspace jail, so the guard can
 * prompt before `mv notes.txt ../outside` runs silently.
 *
 * ponytail: heuristic, not a full shell parser. Ceiling — quoted tokens are
 * skipped (`bash -c 'cat ../outside'` is not caught here, only by the
 * pattern layer), `$(...)`/backtick substitutions are opaque, cmd.exe and
 * POSIX quoting differ slightly on backslash handling. Upgrade path: swap
 * `tokenizeCommand` for a real shlex port if false positives ever demand it.
 */

import os from 'node:os';
import path from 'node:path';
import { validateSafePath } from './path-validator.js';

const SPLIT_CHARS = /[\s;&|<>()]/;
const TRAILING_PUNCT = /[*?:,"']+$/;
const DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const IS_WINDOWS = path.sep === '\\';

/**
 * Quote-aware tokenizer. Mirrors POSIX-ish splitting; returns
 * `{ value, quoted }` so callers can skip quoted payloads (data, not target).
 *
 * @param {string} command
 * @returns {Array<{ value: string, quoted: boolean }>}
 */
export function tokenizeCommand(command) {
  const out = [];
  let current = '';
  let hasToken = false;
  let sawQuote = false;
  let quote = null; // "'" | '"' | null

  const flush = () => {
    if (hasToken) out.push({ value: current, quoted: sawQuote });
    current = '';
    hasToken = false;
    sawQuote = false;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && !IS_WINDOWS && '"$`\\'.includes(command[i + 1]))
        current += command[++i];
      else current += ch;
      continue;
    }
    if (ch === "'") {
      quote = "'";
      hasToken = true;
      sawQuote = true;
      continue;
    }
    if (ch === '"') {
      quote = '"';
      hasToken = true;
      sawQuote = true;
      continue;
    }
    if (ch === '\\' && !IS_WINDOWS && i + 1 < command.length) {
      current += command[++i];
      hasToken = true;
      continue;
    }
    if (SPLIT_CHARS.test(ch)) {
      flush();
      continue;
    }
    current += ch;
    hasToken = true;
  }
  flush();
  return out;
}

/**
 * Heuristic: does this unquoted token *look* like a path reference?
 * Flags (`-i`), URLs (`https://`), and plain words never do.
 *
 * @param {string} bare
 * @returns {boolean}
 */
function looksLikePath(bare) {
  if (!bare || bare.startsWith('-')) return false;
  if (bare.includes('://')) return false;
  if (DRIVE_RE.test(bare)) return true;
  if (bare === '~' || /^~[\\/]/.test(bare)) return true;
  if (/^\.\.?[\\/]/.test(bare)) return true;
  if (bare.startsWith('/')) return true;
  // $VAR/path, ${VAR}/path, %VAR%\path, $env:VAR\path
  if (/[/\\]/.test(bare) && /[$%]\{?[\w:]+\}?(?:%|:)?[/\\]/.test(bare)) return true;
  return false;
}

/**
 * Expands `~`, `$VAR`/`${VAR}` (HOME falls back to os.homedir()), and
 * `%VAR%` / `$env:VAR`, then resolves against the jail. Returns `null`
 * when the token still contains an unresolvable variable reference —
 * callers must treat unknown as outside (fail-closed).
 *
 * @param {string} raw
 * @param {string} baseDir
 * @returns {string | null}
 */
function expandAndResolve(raw, baseDir) {
  let s = raw;
  if (IS_WINDOWS) {
    s = s.replace(/"/g, '');
  }
  s = s.replace(/^~/, () => os.homedir());
  s = s.replace(/\$\{?(\w+)\}?/g, (m, name) => {
    const val = name === 'HOME' ? os.homedir() : process.env[name];
    return val !== undefined ? val : m;
  });
  s = s.replace(/%(\w+)%/g, (m, name) => {
    const val = name === 'USERPROFILE' ? os.homedir() : process.env[name];
    return val !== undefined ? val : m;
  });
  s = s.replace(/\$env:(\w+)/gi, (m, name) => {
    const val = name.toLowerCase() === 'userprofile' ? os.homedir() : process.env[name];
    return val !== undefined ? val : m;
  });
  // Unresolvable variable left ⇒ fail-closed.
  if (/\$\{?\w/.test(s) || /%\w+%/.test(s) || /\$env:\w/i.test(s)) return null;
  // Drive-letter reference on POSIX is suspicious regardless of resolution.
  if (!IS_WINDOWS && DRIVE_RE.test(s)) return null;
  // Backslash-separated path on POSIX cannot be resolved meaningfully.
  if (!IS_WINDOWS && s.includes('\\')) return null;
  return path.resolve(baseDir, s);
}

/**
 * Find unquoted path-like tokens that resolve OUTSIDE the workspace jail.
 *
 * @param {string} command - raw command text
 * @param {string} baseDir - workspace jail root
 * @param {object} [options={}] - passed through to validateSafePath
 * @param {string[]} [options.allowedDirs]
 * @param {boolean} [options.allowTermuxStorage]
 * @returns {Array<{ raw: string, resolved: string | null }>} deduped by `raw`;
 *   `resolved === null` means unresolvable variable ⇒ treat as outside.
 */
export function findPathsOutsideJail(command, baseDir, options = {}) {
  const out = [];
  const seen = new Set();
  if (!command || typeof command !== 'string' || !baseDir) return out;

  for (const token of tokenizeCommand(command)) {
    if (token.quoted) continue;
    const bare = token.value.replace(TRAILING_PUNCT, '');
    if (!looksLikePath(bare)) continue;
    if (seen.has(bare)) continue;
    const resolved = expandAndResolve(bare, baseDir);
    if (resolved === null) {
      seen.add(bare);
      out.push({ raw: token.value, resolved: null });
      continue;
    }
    const validation = validateSafePath(resolved, baseDir, options);
    if (!validation.isAllowed) {
      seen.add(bare);
      out.push({ raw: token.value, resolved: validation.resolvedPath });
    }
  }
  return out;
}
