# File Mention (@) Autocomplete & Context Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement interactive `@` file mention autocomplete with hybrid fuzzy/hierarchical search in the REPL prompt editor, and automatically inject file contents into the LLM prompt context as structured XML blocks upon submission.

**Architecture:** A lightweight in-memory cached file index (`src/utils/file-index.js`) feeds candidates to the autocomplete engine (`src/cli/autocomplete.js`). When a prompt containing `@path/to/file` is submitted, `src/agent/mention-parser.js` extracts mentions, validates boundaries, enforces size/binary limits, and injects `<context_file>` blocks into the LLM turn payload while preserving the user's clean prompt in the terminal view.

**Tech Stack:** Node.js (>=20.0.0, Pure ESM), `node:fs`, `node:path`, `node:readline`, Node.js built-in test runner (`node:test`).

---

## File Structure

- **New:** `src/utils/file-index.js` — Workspace file indexing with in-memory TTL caching, ignore filtering, and fuzzy/substring ranking.
- **New:** `src/agent/mention-parser.js` — Parser for extracting `@file` mentions, reading contents safely (max 50KB, binary detection), and producing clean vs injected prompt payloads.
- **Modify:** `src/cli/autocomplete.js` — Enhance `getSuggestions` to route `@query` (no slash) to `searchWorkspaceFiles` and `@dir/` to hierarchical navigation.
- **Modify:** `src/cli/repl.js` — Wire mention expansion before submitting prompt to orchestrator, display subtle attachment hint in terminal.
- **Modify:** `src/agent/orchestrator.js` — Support optional `displayPrompt` in `runTurn` to record clean prompt in session history while executing the turn with injected file context.
- **New:** `tests/file-index.test.js` — Unit tests for workspace file indexing, cache TTL, ignore rules, and scoring.
- **New:** `tests/mention-parser.test.js` — Unit tests for mention parsing, bounds validation, size truncation, and XML wrapping.
- **Modify:** `tests/autocomplete.test.js` — Unit tests for hybrid global search vs directory drilldown.
- **New:** `tests/repl-mention.test.js` — Integration tests for REPL and Orchestrator mention handling.

---

### Task 1: Implement Workspace File Indexer (`src/utils/file-index.js`)

**Files:**
- Create: `src/utils/file-index.js`
- Test: `tests/file-index.test.js`

- [ ] **Step 1: Write failing unit test for `file-index.js`**

Create `tests/file-index.test.js`:
```javascript
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import {
  clearFileIndexCache,
  getWorkspaceFiles,
  searchWorkspaceFiles,
} from '../src/utils/file-index.js';

describe('file-index: workspace file indexing & search', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-fileindex-'));

  beforeEach(() => {
    clearFileIndexCache();
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('indexes workspace files while ignoring .git, node_modules, and binaries', () => {
    fs.mkdirSync(path.join(tmpDir, 'src', 'cli'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'foo'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.git', 'objects'), { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'src', 'index.js'), 'console.log(1);');
    fs.writeFileSync(path.join(tmpDir, 'src', 'cli', 'repl.js'), 'export function repl() {}');
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'foo', 'index.js'), 'module.exports = 1;');
    fs.writeFileSync(path.join(tmpDir, '.git', 'HEAD'), 'ref: refs/heads/main');
    fs.writeFileSync(path.join(tmpDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const files = getWorkspaceFiles(tmpDir);
    assert.ok(files.includes('src/index.js'));
    assert.ok(files.includes('src/cli/repl.js'));
    assert.ok(!files.some((f) => f.includes('node_modules')));
    assert.ok(!files.some((f) => f.includes('.git')));
    assert.ok(!files.some((f) => f.endsWith('.png')));
  });

  test('uses cache within TTL and clearFileIndexCache clears it', () => {
    fs.writeFileSync(path.join(tmpDir, 'test1.txt'), 'hello');
    const first = getWorkspaceFiles(tmpDir);
    assert.ok(first.includes('test1.txt'));

    // Create a new file without clearing cache
    fs.writeFileSync(path.join(tmpDir, 'test2.txt'), 'world');
    const cached = getWorkspaceFiles(tmpDir);
    assert.ok(!cached.includes('test2.txt'));

    // Clear cache
    clearFileIndexCache();
    const refreshed = getWorkspaceFiles(tmpDir);
    assert.ok(refreshed.includes('test2.txt'));
  });

  test('searchWorkspaceFiles returns scored matches with basename priority', () => {
    fs.mkdirSync(path.join(tmpDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'repl.js'), 'content');
    fs.writeFileSync(path.join(tmpDir, 'sub', 'fake-repl-utils.js'), 'content');
    clearFileIndexCache();

    const matches = searchWorkspaceFiles('repl', tmpDir);
    assert.ok(matches.length >= 2);
    // Exact basename match should rank first
    assert.equal(matches[0], 'repl.js');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/file-index.test.js`
Expected: FAIL with `Cannot find module '../src/utils/file-index.js'`

- [ ] **Step 3: Implement `src/utils/file-index.js`**

Create `src/utils/file-index.js`:
```javascript
/**
 * In-Memory Cached Workspace File Indexer & Fuzzy Scorer
 * Zero-dependency helper for fast file suggestions.
 */

import fs from 'node:fs';
import path from 'node:path';
import { walkDir } from './fs-walk.js';

const CACHE_TTL_MS = 30_000;
const MAX_INDEX_ENTRIES = 5_000;

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf',
  '.zip', '.tar', '.gz', '.tgz', '.rar', '.7z',
  '.exe', '.bin', '.dll', '.so', '.dylib', '.iso',
  '.mp3', '.mp4', '.wav', '.mov', '.avi', '.webm',
  '.woff', '.woff2', '.ttf', '.eot',
]);

const IGNORE_DIR_NAMES = new Set([
  '.git', 'node_modules', '.faycli', '.next', '.nuxt',
  'dist', 'build', 'coverage', '.cache',
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
 * Scan workspace files respecting ignore lists and caching results
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
  try {
    for (const entry of walkDir(normalizedBase, { ignores: IGNORE_DIR_NAMES, maxEntries: MAX_INDEX_ENTRIES })) {
      const ext = path.extname(entry.relativePath).toLowerCase();
      if (!BINARY_EXTENSIONS.has(ext)) {
        // Ensure POSIX style forward slashes
        files.push(entry.relativePath.split(path.sep).join('/'));
      }
    }
  } catch {
    // If walkDir encounters error, return existing cached or empty list
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/file-index.test.js`
Expected: All tests PASS.

- [ ] **Step 5: Commit changes**

```bash
git add src/utils/file-index.js tests/file-index.test.js
git commit -m "feat: implement workspace file indexer with in-memory caching and fuzzy ranking"
```

---

### Task 2: Enhance Autocomplete Engine for Hybrid `@` Mentions (`src/cli/autocomplete.js`)

**Files:**
- Modify: `src/cli/autocomplete.js`
- Modify: `tests/autocomplete.test.js`

- [ ] **Step 1: Write failing test in `tests/autocomplete.test.js`**

Add tests to `tests/autocomplete.test.js`:
```javascript
  test('@ with no slash triggers global workspace search', () => {
    const s = getSuggestions('@index', 6, fileCtx);
    assert.equal(s.kind, 'file');
    assert.ok(s.items.some((i) => i.value === '@src/index.js'));
    assert.equal(s.dir, '');
  });

  test('@ with empty query returns top workspace files', () => {
    const s = getSuggestions('@', 1, fileCtx);
    assert.equal(s.kind, 'file');
    assert.ok(s.items.some((i) => i.value === '@README.md'));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/autocomplete.test.js`
Expected: FAIL because `@index` currently does not find `src/index.js` (only top-level directory entries).

- [ ] **Step 3: Update `src/cli/autocomplete.js` to support hybrid search**

Update `getSuggestions` in `src/cli/autocomplete.js`:
Import `searchWorkspaceFiles` from `../utils/file-index.js`.
When `token.startsWith('@')`:
- If `rel` does NOT contain `/`:
  - Call `searchWorkspaceFiles(rel, base, { limit: 12 })`.
  - If results found, map them to `{ value: `@${filePath}`, label: filePath, isDir: false }`.
  - Return `{ kind: 'file', items, replaceStart: start, replaceEnd: end, dir: '' }`.
- If `rel` contains `/`:
  - Keep hierarchical directory drilldown logic using `fs.readdirSync`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/autocomplete.test.js`
Expected: All tests in `tests/autocomplete.test.js` PASS.

- [ ] **Step 5: Commit changes**

```bash
git add src/cli/autocomplete.js tests/autocomplete.test.js
git commit -m "feat(cli): add hybrid fuzzy workspace search to file mention autocomplete"
```

---

### Task 3: Implement Mention Parser & Guardrails (`src/agent/mention-parser.js`)

**Files:**
- Create: `src/agent/mention-parser.js`
- Test: `tests/mention-parser.test.js`

- [ ] **Step 1: Write failing unit test for `mention-parser.js`**

Create `tests/mention-parser.test.js`:
```javascript
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { expandMentions, parseMentions } from '../src/agent/mention-parser.js';

describe('mention-parser: file extraction and prompt expansion', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-mention-'));
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'const app = 42;\nexport default app;');
  fs.writeFileSync(path.join(tmpDir, 'bin.dat'), Buffer.from([0x00, 0xff, 0x00, 0xff]));

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('parseMentions extracts @file tokens and ignores emails', () => {
    const text = 'Check @src/app.js and email support@example.com or @README.md';
    const mentions = parseMentions(text);
    assert.deepEqual(mentions, ['src/app.js', 'README.md']);
  });

  test('expandMentions injects existing file contents in XML block and preserves clean prompt', () => {
    const text = 'Please review @src/app.js for bugs';
    const result = expandMentions(text, { workingDir: tmpDir });
    assert.equal(result.cleanPrompt, text);
    assert.ok(result.injectedPrompt.includes('<context_file path="src/app.js">'));
    assert.ok(result.injectedPrompt.includes('const app = 42;'));
    assert.deepEqual(result.attachedFiles, ['src/app.js']);
  });

  test('expandMentions skips binary files safely with notification', () => {
    const text = 'Look at @bin.dat';
    const result = expandMentions(text, { workingDir: tmpDir });
    assert.ok(result.injectedPrompt.includes('[Binary file omitted]'));
  });

  test('expandMentions truncates files exceeding max size limit', () => {
    const largeFile = path.join(tmpDir, 'large.txt');
    const content = 'a'.repeat(60 * 1024); // 60 KB
    fs.writeFileSync(largeFile, content);

    const result = expandMentions('Read @large.txt', { workingDir: tmpDir, maxFileSizeBytes: 50 * 1024 });
    assert.ok(result.injectedPrompt.includes('[... content truncated: exceeds 50KB limit]'));
  });

  test('leaves non-existent mentions intact without injecting block', () => {
    const text = 'Missing @does-not-exist.js';
    const result = expandMentions(text, { workingDir: tmpDir });
    assert.equal(result.injectedPrompt, text);
    assert.equal(result.attachedFiles.length, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/mention-parser.test.js`
Expected: FAIL with `Cannot find module '../src/agent/mention-parser.js'`

- [ ] **Step 3: Implement `src/agent/mention-parser.js`**

Create `src/agent/mention-parser.js`:
```javascript
/**
 * Prompt File Mention Parser & Context Injector
 * Extracts @file references and safely embeds file content in LLM messages.
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MAX_FILE_SIZE = 50 * 1024; // 50 KB
export const DEFAULT_MAX_FILES = 5;

// Regex matching @path/file preceded by start of string or whitespace
const MENTION_REGEX = /(?:^|\s)@([a-zA-Z0-9_\-\.\/]+)/g;

/**
 * Check if a buffer contains binary data (contains null bytes)
 *
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function isBinaryBuffer(buffer) {
  const checkLen = Math.min(buffer.length, 1024);
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Extract all unique valid mention tokens from user text
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseMentions(text) {
  if (typeof text !== 'string') return [];
  const matches = new Set();
  let m;
  MENTION_REGEX.lastIndex = 0;
  while ((m = MENTION_REGEX.exec(text)) !== null) {
    const fileToken = m[1].replace(/^\/+|\/+$/g, '');
    if (fileToken && !fileToken.endsWith('@')) {
      matches.add(fileToken);
    }
  }
  return [...matches];
}

/**
 * Expand @file mentions by reading target files and appending <context_file> blocks
 *
 * @param {string} text - Original user prompt
 * @param {object} [options={}]
 * @param {string} [options.workingDir=process.cwd()]
 * @param {number} [options.maxFileSizeBytes=DEFAULT_MAX_FILE_SIZE]
 * @param {number} [options.maxFiles=DEFAULT_MAX_FILES]
 * @returns {{ cleanPrompt: string, injectedPrompt: string, attachedFiles: string[] }}
 */
export function expandMentions(text, options = {}) {
  const cleanPrompt = text || '';
  if (!cleanPrompt.trim()) {
    return { cleanPrompt, injectedPrompt: cleanPrompt, attachedFiles: [] };
  }

  const workingDir = options.workingDir || process.cwd();
  const maxSizeBytes = options.maxFileSizeBytes || DEFAULT_MAX_FILE_SIZE;
  const maxFiles = options.maxFiles || DEFAULT_MAX_FILES;

  const rawMentions = parseMentions(cleanPrompt);
  if (rawMentions.length === 0) {
    return { cleanPrompt, injectedPrompt: cleanPrompt, attachedFiles: [] };
  }

  const attachedFiles = [];
  const contextBlocks = [];

  for (const relPath of rawMentions) {
    if (attachedFiles.length >= maxFiles) break;

    const fullPath = path.resolve(workingDir, relPath);

    // Ensure within workingDir jail
    if (!fullPath.startsWith(path.resolve(workingDir))) {
      continue;
    }

    let stats;
    try {
      stats = fs.statSync(fullPath);
    } catch {
      continue; // File does not exist
    }

    if (!stats.isFile()) continue;

    try {
      const buffer = fs.readFileSync(fullPath);
      const posixPath = relPath.split(path.sep).join('/');

      if (isBinaryBuffer(buffer)) {
        contextBlocks.push(`<context_file path="${posixPath}">\n[Binary file omitted]\n</context_file>`);
        attachedFiles.push(posixPath);
        continue;
      }

      if (buffer.length > maxSizeBytes) {
        const truncated = buffer.subarray(0, maxSizeBytes).toString('utf-8');
        contextBlocks.push(
          `<context_file path="${posixPath}">\n${truncated}\n\n[... content truncated: exceeds 50KB limit]\n</context_file>`,
        );
      } else {
        contextBlocks.push(`<context_file path="${posixPath}">\n${buffer.toString('utf-8')}\n</context_file>`);
      }
      attachedFiles.push(posixPath);
    } catch {
      // Ignore read errors
    }
  }

  if (contextBlocks.length === 0) {
    return { cleanPrompt, injectedPrompt: cleanPrompt, attachedFiles: [] };
  }

  const injectedPrompt = `${cleanPrompt}\n\n${contextBlocks.join('\n\n')}`;
  return { cleanPrompt, injectedPrompt, attachedFiles };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/mention-parser.test.js`
Expected: All tests in `tests/mention-parser.test.js` PASS.

- [ ] **Step 5: Commit changes**

```bash
git add src/agent/mention-parser.js tests/mention-parser.test.js
git commit -m "feat(agent): implement mention parser and secure context injection"
```

---

### Task 4: Integrate Mention Expansion with Orchestrator and REPL (`src/cli/repl.js`, `src/agent/orchestrator.js`)

**Files:**
- Modify: `src/agent/orchestrator.js`
- Modify: `src/cli/repl.js`
- Test: `tests/repl-mention.test.js`

- [ ] **Step 1: Write integration test `tests/repl-mention.test.js`**

Create `tests/repl-mention.test.js`:
```javascript
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { AgentOrchestrator } from '../src/agent/orchestrator.js';

describe('orchestrator & repl: mention expansion in ReAct loop', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-repl-mention-'));
  fs.writeFileSync(path.join(tmpDir, 'data.txt'), 'secret_key_123');

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('runTurn records displayPrompt in session while LLM gets full prompt', async () => {
    let capturedContents = null;

    const mockLlmClient = {
      getModel: () => 'mock-model',
      generateStream: async ({ contents }) => {
        capturedContents = contents;
        return { text: 'I received the file.', functionCalls: [], usage: { promptTokens: 10, totalTokens: 10 } };
      },
    };

    const orchestrator = new AgentOrchestrator({
      workingDir: tmpDir,
      llmClient: mockLlmClient,
      maxIterations: 1,
    });

    const fullPrompt = 'Check this:\n\n<context_file path="data.txt">\nsecret_key_123\n</context_file>';
    const displayPrompt = 'Check this: @data.txt';

    await orchestrator.runTurn(fullPrompt, { displayPrompt });

    // Session user message should show the clean displayPrompt
    const messages = orchestrator.getSession().getMessages();
    const userMsg = messages.find((m) => m.role === 'user');
    assert.ok(userMsg);
    assert.equal(userMsg.parts[0].text, displayPrompt);

    // LLM must have received the fullPrompt with context_file
    const llmUserTurn = capturedContents.find((m) => m.role === 'user');
    assert.ok(llmUserTurn.parts[0].text.includes('<context_file path="data.txt">'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/repl-mention.test.js`
Expected: FAIL because `displayPrompt` option is not yet supported in `orchestrator.runTurn`.

- [ ] **Step 3: Update `src/agent/orchestrator.js`**

In `src/agent/orchestrator.js`:
Modify `runTurn(prompt, options = {})`:
When adding user prompt to session history (around line 307):
```javascript
const userDisplayText = (options.displayPrompt && typeof options.displayPrompt === 'string')
  ? options.displayPrompt.trim()
  : (prompt && typeof prompt === 'string' ? prompt.trim() : '');

if (userDisplayText !== '') {
  this.session.addUserMessage(userDisplayText);
}
```
And in Step 1/Step 2 when sending contents to LLM:
Ensure the prompt sent to the LLM for the current turn includes the injected file context (replace the last message's text in `prunedContents` for this turn with `prompt`, or pass `prompt` dynamically).

- [ ] **Step 4: Update `src/cli/repl.js`**

Import `expandMentions` from `../agent/mention-parser.js`.
In `src/cli/repl.js`:
Before `orchestrator.runTurn(line, ...)`:
```javascript
const { cleanPrompt, injectedPrompt, attachedFiles } = expandMentions(line, {
  workingDir: orchestrator.workingDir,
});

if (attachedFiles.length > 0) {
  output.write(`${ansi.dim(`📎 Attached ${attachedFiles.length} file(s): ${attachedFiles.join(', ')}`)}\n`);
}

const result = await orchestrator.runTurn(injectedPrompt, {
  displayPrompt: cleanPrompt,
  signal: activeAbortController.signal,
  ...
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/repl-mention.test.js`
Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 6: Commit changes**

```bash
git add src/agent/orchestrator.js src/cli/repl.js tests/repl-mention.test.js
git commit -m "feat(repl): wire mention context expansion into agent turn with clean session display"
```

---

### Task 5: Formatting, Biome Linting, and Verification

**Files:**
- Touched files in `src/` and `tests/`

- [ ] **Step 1: Run code linter and formatter**

Run: `npm run lint`
If any issues: `npm run lint:fix` and `npm run format`

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: All unit tests PASS without warnings.

- [ ] **Step 3: Commit formatting changes if any**

```bash
git commit -am "style: format touched files with biome"
```
