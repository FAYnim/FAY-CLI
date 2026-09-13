/**
 * Project root auto-detection.
 * Walks up from a start directory looking for well-known markers.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from './logger.js';

/** Marker files/dirs that identify a project root. */
export const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Cargo.toml',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Makefile',
  'CMakeLists.txt',
];

/**
 * Find the nearest project root at or above startDir.
 * Returns startDir itself when no marker exists.
 *
 * @param {string} [startDir=process.cwd()]
 * @param {string[]} [markers=PROJECT_MARKERS]
 * @returns {string} absolute path
 */
export function findProjectRoot(startDir = process.cwd(), markers = PROJECT_MARKERS) {
  let start;
  try {
    start = fs.realpathSync(path.resolve(startDir));
  } catch {
    return path.resolve(startDir);
  }
  let dir = start;
  for (;;) {
    if (markers.some((m) => fs.existsSync(path.join(dir, m)))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return start; // filesystem root reached, no marker anywhere
    }
    dir = parent;
  }
}

/** Maximum byte size of merged instruction text before tail truncation. */
export const MAX_INSTRUCTION_BYTES = 8192;

/** Default instruction file name. */
export const DEFAULT_INSTRUCTIONS_FILE = 'AGENTS.md';

/**
 * Loads and merges project instruction files (AGENTS.md) from:
 *   1. Global: ~/.faycli/<fileName>
 *   2. Walk-up from workingDir to projectRoot in root-to-leaf order
 *
 * Files are merged with "## From <absPath>" headers. Total text is
 * truncated from the tail at MAX_INSTRUCTION_BYTES with a "…[truncated]" marker.
 *
 * Never throws — missing or unreadable files are silently skipped (logged at debug).
 *
 * @param {string} [workingDir=process.cwd()]
 * @param {object} [config={}]
 * @param {string|false} [config.instructionsFile] - File name or false to disable
 * @returns {{ text: string, files: string[] }}
 */
export function loadInstructions(workingDir = process.cwd(), config = {}) {
  if (config.instructionsFile === false) {
    return { text: '', files: [] };
  }

  const fileName =
    typeof config.instructionsFile === 'string' && config.instructionsFile.trim()
      ? config.instructionsFile.trim()
      : DEFAULT_INSTRUCTIONS_FILE;

  let resolvedCwd;
  try {
    resolvedCwd = fs.realpathSync(path.resolve(workingDir));
  } catch {
    resolvedCwd = path.resolve(workingDir);
  }

  const rootDir = findProjectRoot(resolvedCwd);
  let resolvedRoot;
  try {
    resolvedRoot = fs.realpathSync(rootDir);
  } catch {
    resolvedRoot = rootDir;
  }

  // 1. Collect candidate paths
  const candidates = [];

  // Global: ~/.faycli/<fileName>
  const globalPath = path.join(os.homedir(), '.faycli', fileName);
  if (fs.existsSync(globalPath)) {
    candidates.push(globalPath);
  }

  // Walk-up: collect dirs from resolvedCwd up to resolvedRoot (leaf → root), then reverse
  const walkDirs = [];
  let curr = resolvedCwd;
  for (;;) {
    walkDirs.push(curr);
    if (curr === resolvedRoot) break;
    const parent = path.dirname(curr);
    if (parent === curr) break; // filesystem root
    curr = parent;
  }
  walkDirs.reverse(); // now root → leaf

  for (const d of walkDirs) {
    const filePath = path.join(d, fileName);
    if (fs.existsSync(filePath)) {
      candidates.push(filePath);
    }
  }

  // 2. Read and merge into blocks
  const contributingFiles = [];
  const blocks = [];

  for (const file of candidates) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const trimmed = content.trim();
      if (!trimmed) continue;

      const absFile = path.resolve(file);
      contributingFiles.push(absFile);
      blocks.push(`## From ${absFile}\n\n${trimmed}`);
    } catch (err) {
      logger.debug(`Failed to read instructions file ${file}: ${err.message}`);
    }
  }

  if (blocks.length === 0) {
    return { text: '', files: [] };
  }

  let mergedText = blocks.join('\n\n');

  // 3. Tail-truncate if exceeding MAX_INSTRUCTION_BYTES
  if (Buffer.byteLength(mergedText, 'utf8') > MAX_INSTRUCTION_BYTES) {
    const marker = '\n…[truncated]';
    const markerBytes = Buffer.byteLength(marker, 'utf8');
    const targetBytes = MAX_INSTRUCTION_BYTES - markerBytes;

    let truncated = '';
    let currentBytes = 0;
    for (const char of mergedText) {
      const charBytes = Buffer.byteLength(char, 'utf8');
      if (currentBytes + charBytes > targetBytes) break;
      truncated += char;
      currentBytes += charBytes;
    }
    mergedText = truncated + marker;
  }

  return { text: mergedText, files: contributingFiles };
}
