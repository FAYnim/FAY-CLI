# Checkpoint & `/undo` File Edit (Roadmap #3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement an automated file-edit snapshot and rollback system (`CheckpointManager`) with `/undo` and `/undo <n>` REPL commands, session retention pruning, and 1 MB safety bounds.

**Architecture:** A dedicated `CheckpointManager` records pre-edit snapshots to `~/.faycli/checkpoints/<sessionId>/` with an `index.jsonl` log right before `write_file` or `patch_file` runs via `dispatchToolCall`. A new `/undo` slash command in REPL provides instant rollback of single or multi-step edits (restoring modified files or unlinking newly created ones), while older session checkpoints are pruned on `/new` according to `checkpoint.keep`.

**Tech Stack:** Node.js ESM (>=20.0.0), `node:fs`, `node:path`, `node:crypto`, `node:test`, `node:assert/strict`, ANSI formatting (`src/utils/ansi.js`). Zero native dependencies.

---

### File Structure & Responsibilities

- **`src/config/constants.js`**:
  - Defines `DEFAULT_CHECKPOINTS_DIR_NAME = 'checkpoints'`.
  - Adds `checkpoint: { enabled: true, keep: 10, maxFileSize: 1048576 }` to `DEFAULT_CONFIG`.
- **`src/config/manager.js`**:
  - Exposes `getCheckpointsDir()` on `ConfigManager` and ensures directory creation in `ensureDirs()`.
- **`src/agent/checkpoint.js` (NEW)**:
  - `CheckpointManager` class: handles snapshot creation, commit/discard lifecycle, index logging (`index.jsonl`), undo execution, and session pruning.
- **`src/tools/registry.js`**:
  - Hooks into `dispatchToolCall` to create pending snapshot before `write_file` / `patch_file`, committing only on success and discarding on failure.
- **`src/agent/orchestrator.js`**:
  - Instantiates `CheckpointManager` and passes it along with `sessionId` to `dispatchToolCall`.
- **`src/cli/slash-commands.js`**:
  - Adds `/undo [n]` and `/undo list` commands to `SLASH_COMMANDS_HELP` and `executeSlashCommand`.
  - Prunes old session checkpoints when `/new` is invoked.
- **`tests/checkpoint.test.js` (NEW)**:
  - Unit and integration tests for snapshotting, undoing single/multiple files, new file rollback (unlink), large file skips (> 1 MB), REPL slash command `/undo`, and session pruning.

---

### Task 1: Checkpoint Config & Paths

**Files:**
- Modify: `src/config/constants.js`
- Modify: `src/config/manager.js`
- Test: `tests/checkpoint.test.js`

- [ ] **Step 1: Write failing test for checkpoint config and directory methods**

Create `tests/checkpoint.test.js`:

```javascript
/**
 * Tests for Checkpoint & /undo File Edit (Roadmap #3)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_CHECKPOINTS_DIR_NAME, DEFAULT_CONFIG } from '../src/config/constants.js';
import { ConfigManager } from '../src/config/manager.js';

describe('Checkpoint Config & Constants', () => {
  it('defines DEFAULT_CHECKPOINTS_DIR_NAME as "checkpoints"', () => {
    assert.equal(DEFAULT_CHECKPOINTS_DIR_NAME, 'checkpoints');
  });

  it('defines default checkpoint configuration in DEFAULT_CONFIG', () => {
    assert.ok(DEFAULT_CONFIG.checkpoint, 'DEFAULT_CONFIG.checkpoint should exist');
    assert.equal(DEFAULT_CONFIG.checkpoint.enabled, true);
    assert.equal(DEFAULT_CONFIG.checkpoint.keep, 10);
    assert.equal(DEFAULT_CONFIG.checkpoint.maxFileSize, 1048576);
  });

  it('ConfigManager exposes getCheckpointsDir() and creates the directory in ensureDirs()', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-ckpt-test-'));
    try {
      const mgr = new ConfigManager(tmpDir);
      const ckptDir = mgr.getCheckpointsDir();
      assert.equal(ckptDir, path.join(tmpDir, 'checkpoints'));

      mgr.ensureDirs();
      assert.ok(fs.existsSync(ckptDir), 'Checkpoints dir should be created by ensureDirs()');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/checkpoint.test.js`  
Expected: FAIL with `DEFAULT_CHECKPOINTS_DIR_NAME is not defined` or `AssertionError`.

- [ ] **Step 3: Update `src/config/constants.js` and `src/config/manager.js`**

In `src/config/constants.js`, add `DEFAULT_CHECKPOINTS_DIR_NAME`:

```javascript
export const DEFAULT_CONFIG_DIR_NAME = '.faycli';
export const DEFAULT_CONFIG_FILE_NAME = 'config.json';
export const DEFAULT_SESSIONS_DIR_NAME = 'sessions';
export const DEFAULT_CHECKPOINTS_DIR_NAME = 'checkpoints';
```

And update `DEFAULT_CONFIG` in `src/config/constants.js`:

```javascript
// Default Config Object
export const DEFAULT_CONFIG = {
  activeProvider: DEFAULT_ACTIVE_PROVIDER,
  providers: {},
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
  autoConfirm: false,
  verbose: false,
  locale: 'en',
  instructionsFile: 'AGENTS.md',
  checkpoint: {
    enabled: true,
    keep: 10,
    maxFileSize: 1048576, // 1 MB cap
  },
};
```

In `src/config/manager.js`, import `DEFAULT_CHECKPOINTS_DIR_NAME`:

```javascript
import {
  BUILTIN_PROVIDERS,
  DEFAULT_ACTIVE_PROVIDER,
  DEFAULT_CHECKPOINTS_DIR_NAME,
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_DIR_NAME,
  DEFAULT_CONFIG_FILE_NAME,
  DEFAULT_SESSIONS_DIR_NAME,
  TERMUX_HOME_FALLBACK,
} from './constants.js';
```

Add `getCheckpointsDir()` method and update `ensureDirs()` in `src/config/manager.js`:

```javascript
  /**
   * Get path to checkpoints directory
   * @returns {string}
   */
  getCheckpointsDir() {
    return path.join(this.getConfigDir(), DEFAULT_CHECKPOINTS_DIR_NAME);
  }

  /**
   * Ensure directory structure exists
   */
  ensureDirs() {
    const configDir = this.getConfigDir();
    const sessionsDir = this.getSessionsDir();
    const checkpointsDir = this.getCheckpointsDir();

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(checkpointsDir)) {
      fs.mkdirSync(checkpointsDir, { recursive: true, mode: 0o700 });
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/checkpoint.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/constants.js src/config/manager.js tests/checkpoint.test.js
git commit -m "feat(checkpoint): add checkpoint configuration and directory management"
```

---

### Task 2: Core Checkpoint Manager (`src/agent/checkpoint.js`)

**Files:**
- Create: `src/agent/checkpoint.js`
- Modify: `tests/checkpoint.test.js`

- [ ] **Step 1: Write failing tests for `CheckpointManager` lifecycle**

Append to `tests/checkpoint.test.js`:

```javascript
import { CheckpointManager } from '../src/agent/checkpoint.js';

describe('CheckpointManager Core', () => {
  let tmpRoot;
  let checkpointsDir;
  let workspaceDir;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-ckpt-mgr-'));
    checkpointsDir = path.join(tmpRoot, 'checkpoints');
    workspaceDir = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(checkpointsDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('creates snapshot for existing file and commits to index.jsonl on success', async () => {
    const mgr = new CheckpointManager({ checkpointsDir, baseDir: workspaceDir });
    const targetFile = path.join(workspaceDir, 'hello.txt');
    fs.writeFileSync(targetFile, 'original content', 'utf8');

    const sessionId = 'test-session-1';
    const token = await mgr.createSnapshot({
      sessionId,
      toolName: 'write_file',
      filePath: 'hello.txt',
      baseDir: workspaceDir,
    });

    assert.equal(token.existedBefore, true);
    assert.equal(token.tooLarge, false);
    assert.ok(token.backupFile);

    // Overwrite file
    fs.writeFileSync(targetFile, 'modified content', 'utf8');

    // Commit snapshot
    await mgr.commitSnapshot(sessionId, token);

    const checkpoints = mgr.getCheckpoints(sessionId);
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].relPath, 'hello.txt');
    assert.equal(checkpoints[0].tool, 'write_file');
    assert.equal(checkpoints[0].existedBefore, true);
  });

  it('discards pending snapshot if tool execution fails', async () => {
    const mgr = new CheckpointManager({ checkpointsDir, baseDir: workspaceDir });
    const targetFile = path.join(workspaceDir, 'fail.txt');
    fs.writeFileSync(targetFile, 'initial content', 'utf8');

    const sessionId = 'test-session-2';
    const token = await mgr.createSnapshot({
      sessionId,
      toolName: 'patch_file',
      filePath: 'fail.txt',
      baseDir: workspaceDir,
    });

    // Discard snapshot
    await mgr.discardSnapshot(sessionId, token);

    const checkpoints = mgr.getCheckpoints(sessionId);
    assert.equal(checkpoints.length, 0);

    // Backup file should be cleaned up
    const sessionDir = mgr.getSessionDir(sessionId);
    if (fs.existsSync(sessionDir)) {
      const files = fs.readdirSync(sessionDir);
      assert.equal(files.filter(f => f.endsWith('.bak')).length, 0);
    }
  });

  it('handles brand new file (existedBefore: false) and removes it on undo', async () => {
    const mgr = new CheckpointManager({ checkpointsDir, baseDir: workspaceDir });
    const sessionId = 'test-session-3';
    const relPath = 'new-file.js';
    const targetFile = path.join(workspaceDir, relPath);

    const token = await mgr.createSnapshot({
      sessionId,
      toolName: 'write_file',
      filePath: relPath,
      baseDir: workspaceDir,
    });

    assert.equal(token.existedBefore, false);
    assert.equal(token.backupFile, null);

    // Create the file as write_file would
    fs.writeFileSync(targetFile, 'console.log("hello");', 'utf8');
    await mgr.commitSnapshot(sessionId, token);

    // Undo should delete the newly created file
    const undoResult = await mgr.undo({ sessionId, baseDir: workspaceDir });
    assert.equal(undoResult.success, true);
    assert.equal(undoResult.restored.length, 1);
    assert.equal(undoResult.restored[0].action, 'unlinked');
    assert.equal(fs.existsSync(targetFile), false);
    assert.equal(mgr.getCheckpoints(sessionId).length, 0);
  });

  it('skips snapshot content when file exceeds maxFileSize (> 1 MB)', async () => {
    const mgr = new CheckpointManager({
      checkpointsDir,
      baseDir: workspaceDir,
      maxFileSize: 100, // 100 bytes for test
    });
    const sessionId = 'test-session-4';
    const targetFile = path.join(workspaceDir, 'large.txt');
    fs.writeFileSync(targetFile, 'A'.repeat(200), 'utf8');

    const token = await mgr.createSnapshot({
      sessionId,
      toolName: 'write_file',
      filePath: 'large.txt',
      baseDir: workspaceDir,
    });

    assert.equal(token.tooLarge, true);
    assert.equal(token.backupFile, null);

    await mgr.commitSnapshot(sessionId, token);

    // Undo should fail with warning because file was too large
    const undoResult = await mgr.undo({ sessionId, baseDir: workspaceDir });
    assert.equal(undoResult.success, false);
    assert.ok(undoResult.reason.includes('exceeded maximum checkpoint size'));
  });

  it('supports multi-step undo (steps = 2)', async () => {
    const mgr = new CheckpointManager({ checkpointsDir, baseDir: workspaceDir });
    const sessionId = 'test-session-5';

    const fileA = path.join(workspaceDir, 'a.txt');
    const fileB = path.join(workspaceDir, 'b.txt');
    fs.writeFileSync(fileA, 'v1-a', 'utf8');
    fs.writeFileSync(fileB, 'v1-b', 'utf8');

    // Step 1: modify a.txt
    const token1 = await mgr.createSnapshot({
      sessionId,
      toolName: 'write_file',
      filePath: 'a.txt',
      baseDir: workspaceDir,
    });
    fs.writeFileSync(fileA, 'v2-a', 'utf8');
    await mgr.commitSnapshot(sessionId, token1);

    // Step 2: modify b.txt
    const token2 = await mgr.createSnapshot({
      sessionId,
      toolName: 'write_file',
      filePath: 'b.txt',
      baseDir: workspaceDir,
    });
    fs.writeFileSync(fileB, 'v2-b', 'utf8');
    await mgr.commitSnapshot(sessionId, token2);

    assert.equal(mgr.getCheckpoints(sessionId).length, 2);

    // Undo 2 steps
    const undoResult = await mgr.undo({ sessionId, steps: 2, baseDir: workspaceDir });
    assert.equal(undoResult.success, true);
    assert.equal(undoResult.restored.length, 2);

    assert.equal(fs.readFileSync(fileA, 'utf8'), 'v1-a');
    assert.equal(fs.readFileSync(fileB, 'utf8'), 'v1-b');
    assert.equal(mgr.getCheckpoints(sessionId).length, 0);
  });

  it('pruneSessions retains only keep most recent sessions', () => {
    const mgr = new CheckpointManager({ checkpointsDir, baseDir: workspaceDir, keep: 2 });

    for (let i = 1; i <= 4; i++) {
      const dir = path.join(checkpointsDir, `sess-${i}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.jsonl'), `{"id":${i}}\n`, 'utf8');
      // Set distinct mtime
      const time = new Date(2026, 0, i).getTime() / 1000;
      fs.utimesSync(dir, time, time);
    }

    mgr.pruneSessions(2);

    const remaining = fs.readdirSync(checkpointsDir);
    assert.equal(remaining.length, 2);
    assert.ok(remaining.includes('sess-4'));
    assert.ok(remaining.includes('sess-3'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/checkpoint.test.js`  
Expected: FAIL with `Cannot find module '../src/agent/checkpoint.js'`

- [ ] **Step 3: Implement `src/agent/checkpoint.js`**

Create `src/agent/checkpoint.js`:

```javascript
/**
 * Checkpoint & Rollback Management
 * Provides automated file modification snapshots and /undo capability.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logger as defaultLogger } from '../utils/logger.js';

export class CheckpointManager {
  /**
   * @param {object} options
   * @param {string} options.checkpointsDir - Root directory for checkpoints (~/.faycli/checkpoints)
   * @param {string} [options.baseDir] - Default workspace baseDir
   * @param {boolean} [options.enabled=true] - Whether checkpointing is active
   * @param {number} [options.keep=10] - Number of session checkpoint folders to retain
   * @param {number} [options.maxFileSize=1048576] - Maximum file size to backup (default 1 MB)
   * @param {object} [options.logger] - Logger instance
   */
  constructor(options = {}) {
    this.checkpointsDir = options.checkpointsDir;
    this.baseDir = options.baseDir || process.cwd();
    this.enabled = options.enabled !== false;
    this.keep = typeof options.keep === 'number' ? options.keep : 10;
    this.maxFileSize = typeof options.maxFileSize === 'number' ? options.maxFileSize : 1048576;
    this.logger = options.logger || defaultLogger;
  }

  /**
   * Get storage directory for a specific session
   * @param {string} sessionId
   * @returns {string}
   */
  getSessionDir(sessionId) {
    const safeId = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.checkpointsDir, safeId);
  }

  /**
   * Ensure session directory exists
   * @param {string} sessionId
   * @returns {string}
   */
  ensureSessionDir(sessionId) {
    const dir = this.getSessionDir(sessionId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    return dir;
  }

  /**
   * Prepare snapshot before file mutation.
   *
   * @param {object} params
   * @param {string} params.sessionId
   * @param {string} params.toolName
   * @param {string} params.filePath
   * @param {string} [params.baseDir]
   * @returns {Promise<object>} Token to commit or discard
   */
  async createSnapshot({ sessionId, toolName, filePath, baseDir }) {
    if (!this.enabled || !sessionId || !filePath) {
      return { skipped: true, reason: 'disabled_or_missing_params' };
    }

    const effectiveBase = baseDir || this.baseDir;
    const resolvedPath = path.resolve(effectiveBase, filePath);
    const relPath = path.relative(effectiveBase, resolvedPath).replace(/\\/g, '/');

    const sessionDir = this.ensureSessionDir(sessionId);
    const id = Date.now() + Math.floor(Math.random() * 1000);

    if (!fs.existsSync(resolvedPath)) {
      return {
        id,
        sessionId,
        tool: toolName,
        relPath,
        resolvedPath,
        existedBefore: false,
        backupFile: null,
        tooLarge: false,
        size: 0,
      };
    }

    let stats;
    try {
      stats = fs.statSync(resolvedPath);
    } catch (err) {
      this.logger.debug('checkpoint.createSnapshot stat error', err);
      return { skipped: true, reason: 'stat_failed' };
    }

    if (stats.size > this.maxFileSize) {
      return {
        id,
        sessionId,
        tool: toolName,
        relPath,
        resolvedPath,
        existedBefore: true,
        backupFile: null,
        tooLarge: true,
        size: stats.size,
      };
    }

    const hashSlug = crypto.createHash('sha256').update(relPath).digest('hex').slice(0, 8);
    const backupFileName = `${id}-${hashSlug}.bak`;
    const backupFullPath = path.join(sessionDir, backupFileName);

    try {
      fs.copyFileSync(resolvedPath, backupFullPath);
    } catch (copyErr) {
      this.logger.warn(`Failed to create checkpoint snapshot for "${relPath}": ${copyErr.message}`);
      return { skipped: true, reason: 'copy_failed' };
    }

    return {
      id,
      sessionId,
      tool: toolName,
      relPath,
      resolvedPath,
      existedBefore: true,
      backupFile: backupFileName,
      backupFullPath,
      tooLarge: false,
      size: stats.size,
    };
  }

  /**
   * Commits snapshot into session index.jsonl
   *
   * @param {string} sessionId
   * @param {object} token
   */
  async commitSnapshot(sessionId, token) {
    if (!token || token.skipped) return;

    const sessionDir = this.ensureSessionDir(sessionId);
    const indexPath = path.join(sessionDir, 'index.jsonl');

    const record = {
      id: token.id,
      timestamp: new Date().toISOString(),
      tool: token.tool,
      relPath: token.relPath,
      existedBefore: token.existedBefore,
      backupFile: token.backupFile,
      tooLarge: token.tooLarge,
      size: token.size,
    };

    fs.appendFileSync(indexPath, `${JSON.stringify(record)}\n`, 'utf8');
  }

  /**
   * Discards snapshot if tool execution fails
   *
   * @param {string} sessionId
   * @param {object} token
   */
  async discardSnapshot(sessionId, token) {
    if (!token || token.skipped) return;

    if (token.backupFullPath && fs.existsSync(token.backupFullPath)) {
      try {
        fs.unlinkSync(token.backupFullPath);
      } catch (_e) {
        /* silent-ok: discard cleanup is best-effort */
      }
    }
  }

  /**
   * Get all checkpoints for a session
   *
   * @param {string} sessionId
   * @returns {Array<object>}
   */
  getCheckpoints(sessionId) {
    const sessionDir = this.getSessionDir(sessionId);
    const indexPath = path.join(sessionDir, 'index.jsonl');

    if (!fs.existsSync(indexPath)) return [];

    try {
      const content = fs.readFileSync(indexPath, 'utf8');
      return content
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch (err) {
      this.logger.debug('checkpoint.getCheckpoints read error', err);
      return [];
    }
  }

  /**
   * Revert file edits by n steps
   *
   * @param {object} params
   * @param {string} params.sessionId
   * @param {number} [params.steps=1]
   * @param {string} [params.baseDir]
   * @returns {Promise<{ success: boolean, restored?: Array<object>, reason?: string }>}
   */
  async undo({ sessionId, steps = 1, baseDir }) {
    if (!sessionId) {
      return { success: false, reason: 'No active session' };
    }

    const checkpoints = this.getCheckpoints(sessionId);
    if (!checkpoints.length) {
      return { success: false, reason: 'No file checkpoints found for this session.' };
    }

    const effectiveBase = baseDir || this.baseDir;
    const sessionDir = this.getSessionDir(sessionId);
    const countToUndo = Math.min(Math.max(1, steps), checkpoints.length);

    const entriesToUndo = checkpoints.slice(-countToUndo).reverse();
    const restored = [];

    for (const entry of entriesToUndo) {
      if (entry.tooLarge) {
        return {
          success: false,
          reason: `Cannot undo edit on "${entry.relPath}": file exceeded maximum checkpoint size (1 MB).`,
        };
      }

      const targetPath = path.resolve(effectiveBase, entry.relPath);

      if (entry.existedBefore && entry.backupFile) {
        const backupPath = path.join(sessionDir, entry.backupFile);
        if (!fs.existsSync(backupPath)) {
          return {
            success: false,
            reason: `Backup file "${entry.backupFile}" missing for "${entry.relPath}".`,
          };
        }

        const parentDir = path.dirname(targetPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        fs.copyFileSync(backupPath, targetPath);
        try {
          fs.unlinkSync(backupPath);
        } catch (_e) {
          /* silent-ok: cleanup is best-effort */
        }

        restored.push({ relPath: entry.relPath, action: 'restored', tool: entry.tool });
      } else if (!entry.existedBefore) {
        if (fs.existsSync(targetPath)) {
          fs.unlinkSync(targetPath);
        }
        restored.push({ relPath: entry.relPath, action: 'unlinked', tool: entry.tool });
      }
    }

    // Rewrite remaining index.jsonl entries
    const remaining = checkpoints.slice(0, checkpoints.length - countToUndo);
    const indexPath = path.join(sessionDir, 'index.jsonl');
    if (remaining.length === 0) {
      try {
        fs.unlinkSync(indexPath);
      } catch (_e) {
        /* silent-ok */
      }
    } else {
      const newContent = remaining.map((r) => JSON.stringify(r)).join('\n') + '\n';
      fs.writeFileSync(indexPath, newContent, 'utf8');
    }

    return { success: true, restored };
  }

  /**
   * Prune old session checkpoints keeping only the most recent N sessions.
   *
   * @param {number} [keepLimit]
   */
  pruneSessions(keepLimit) {
    const keep = typeof keepLimit === 'number' ? keepLimit : this.keep;
    if (!this.checkpointsDir || !fs.existsSync(this.checkpointsDir)) return;

    try {
      const entries = fs
        .readdirSync(this.checkpointsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const fullPath = path.join(this.checkpointsDir, d.name);
          try {
            const stat = fs.statSync(fullPath);
            return { name: d.name, fullPath, mtimeMs: stat.mtimeMs };
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      if (entries.length <= keep) return;

      entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const toDelete = entries.slice(keep);

      for (const item of toDelete) {
        try {
          fs.rmSync(item.fullPath, { recursive: true, force: true });
        } catch (err) {
          this.logger.debug(`checkpoint.pruneSessions: failed to remove ${item.fullPath}`, err);
        }
      }
    } catch (err) {
      this.logger.debug('checkpoint.pruneSessions error', err);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/checkpoint.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/checkpoint.js tests/checkpoint.test.js
git commit -m "feat(checkpoint): implement CheckpointManager with snapshot, undo, and pruning"
```

---

### Task 3: Tool Dispatcher Integration (`src/tools/registry.js`)

**Files:**
- Modify: `src/tools/registry.js`
- Test: `tests/checkpoint.test.js`

- [ ] **Step 1: Write failing test for `dispatchToolCall` checkpoint snapshotting**

Append to `tests/checkpoint.test.js`:

```javascript
import { dispatchToolCall } from '../src/tools/registry.js';

describe('Tool Dispatcher Checkpoint Integration', () => {
  let tmpRoot;
  let checkpointsDir;
  let workspaceDir;
  let mgr;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-ckpt-dispatch-'));
    checkpointsDir = path.join(tmpRoot, 'checkpoints');
    workspaceDir = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(checkpointsDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    mgr = new CheckpointManager({ checkpointsDir, baseDir: workspaceDir });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('captures checkpoint when write_file succeeds via dispatchToolCall', async () => {
    const filePath = 'test-write.txt';
    const absPath = path.join(workspaceDir, filePath);
    fs.writeFileSync(absPath, 'initial text', 'utf8');

    const result = await dispatchToolCall(
      'write_file',
      { filePath, content: 'updated text' },
      {
        baseDir: workspaceDir,
        checkpointManager: mgr,
        sessionId: 'sess-dispatch-1',
      },
    );

    assert.equal(result.success, true);
    assert.equal(fs.readFileSync(absPath, 'utf8'), 'updated text');

    const checkpoints = mgr.getCheckpoints('sess-dispatch-1');
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].relPath, filePath);

    // Rollback via manager
    const undoRes = await mgr.undo({ sessionId: 'sess-dispatch-1', baseDir: workspaceDir });
    assert.equal(undoRes.success, true);
    assert.equal(fs.readFileSync(absPath, 'utf8'), 'initial text');
  });

  it('does not commit checkpoint if tool throws or fails', async () => {
    const filePath = 'test-patch-fail.txt';
    const absPath = path.join(workspaceDir, filePath);
    fs.writeFileSync(absPath, 'hello world', 'utf8');

    const result = await dispatchToolCall(
      'patch_file',
      { filePath, searchString: 'nonexistent phrase', replaceString: 'replacement' },
      {
        baseDir: workspaceDir,
        checkpointManager: mgr,
        sessionId: 'sess-dispatch-fail',
      },
    );

    assert.equal(result.error, true);
    const checkpoints = mgr.getCheckpoints('sess-dispatch-fail');
    assert.equal(checkpoints.length, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/checkpoint.test.js`  
Expected: FAIL because `dispatchToolCall` does not yet invoke `checkpointManager`.

- [ ] **Step 3: Modify `src/tools/registry.js`**

In `src/tools/registry.js`, update `dispatchToolCall` to manage checkpoint snapshots around modifying tools:

```javascript
  const isModifyingTool = name === 'write_file' || name === 'patch_file';
  let snapshotToken = null;

  if (
    isModifyingTool &&
    context.checkpointManager &&
    context.sessionId &&
    typeof context.checkpointManager.createSnapshot === 'function'
  ) {
    try {
      snapshotToken = await context.checkpointManager.createSnapshot({
        sessionId: context.sessionId,
        toolName: name,
        filePath: args.filePath,
        baseDir: context.baseDir,
      });
    } catch (snapErr) {
      /* silent-ok: snapshot failure should not prevent tool execution */
    }
  }

  try {
    const result = await tool(args, context);

    if (
      snapshotToken &&
      context.checkpointManager &&
      typeof context.checkpointManager.commitSnapshot === 'function'
    ) {
      try {
        await context.checkpointManager.commitSnapshot(context.sessionId, snapshotToken);
      } catch (_e) {
        /* silent-ok: commit logging failure is non-fatal */
      }
    }

    return {
      success: true,
      result,
    };
  } catch (err) {
    if (
      snapshotToken &&
      context.checkpointManager &&
      typeof context.checkpointManager.discardSnapshot === 'function'
    ) {
      try {
        await context.checkpointManager.discardSnapshot(context.sessionId, snapshotToken);
      } catch (_e) {
        /* silent-ok: discard cleanup is best-effort */
      }
    }

    return {
      error: true,
      message: err.message || String(err),
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/checkpoint.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/registry.js tests/checkpoint.test.js
git commit -m "feat(checkpoint): wire snapshot lifecycle into dispatchToolCall"
```

---

### Task 4: Orchestrator Integration (`src/agent/orchestrator.js`)

**Files:**
- Modify: `src/agent/orchestrator.js`
- Test: `tests/checkpoint.test.js`

- [ ] **Step 1: Write test verifying `AgentOrchestrator` initializes `CheckpointManager` and passes it in context**

Append to `tests/checkpoint.test.js`:

```javascript
import { AgentOrchestrator } from '../src/agent/orchestrator.js';

describe('AgentOrchestrator Checkpoint Integration', () => {
  it('initializes checkpointManager on orchestrator instance', () => {
    const orchestrator = new AgentOrchestrator({
      autoApprove: true,
      checkpointEnabled: true,
    });
    assert.ok(orchestrator.checkpointManager instanceof CheckpointManager);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/checkpoint.test.js`  
Expected: FAIL with `AssertionError: false == true` or `orchestrator.checkpointManager is undefined`.

- [ ] **Step 3: Modify `src/agent/orchestrator.js`**

In `src/agent/orchestrator.js`, import `CheckpointManager` and `configManager`:

```javascript
import { CheckpointManager } from './checkpoint.js';
import { configManager } from '../config/manager.js';
```

In `constructor(options = {})`, initialize `this.checkpointManager`:

```javascript
    // Checkpoint Manager for file rollback
    const ckptConfig = configManager.get('checkpoint') || {};
    this.checkpointManager =
      options.checkpointManager ||
      new CheckpointManager({
        checkpointsDir: options.checkpointsDir || configManager.getCheckpointsDir(),
        baseDir: this.workingDir,
        enabled: options.checkpointEnabled ?? ckptConfig.enabled ?? true,
        keep: options.checkpointKeep ?? ckptConfig.keep ?? 10,
        maxFileSize: options.checkpointMaxFileSize ?? ckptConfig.maxFileSize ?? 1048576,
        logger: this.logger,
      });
```

In `executeSingleCall`, pass `checkpointManager` and `sessionId`:

```javascript
        // Dispatch actuator tool with security authorization
        const toolExecution = await dispatchToolCall(name, args, {
          securityGuard: this.securityGuard,
          checkpointManager: this.checkpointManager,
          sessionId: this.session?.id,
          baseDir: this.workingDir,
          logger: this.logger,
          signal,
          isFallback: Boolean(fc.isFallback),
        });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/checkpoint.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/orchestrator.js tests/checkpoint.test.js
git commit -m "feat(orchestrator): instantiate CheckpointManager and pass session context to dispatch"
```

---

### Task 5: Slash Command `/undo` & REPL Integration

**Files:**
- Modify: `src/cli/slash-commands.js`
- Modify: `tests/checkpoint.test.js`

- [ ] **Step 1: Write failing tests for `/undo` slash command**

Append to `tests/checkpoint.test.js`:

```javascript
import { executeSlashCommand, SLASH_COMMANDS_HELP } from '../src/cli/slash-commands.js';
import { listCommandNames } from '../src/cli/autocomplete.js';

describe('/undo Slash Command', () => {
  it('SLASH_COMMANDS_HELP includes /undo', () => {
    const entry = SLASH_COMMANDS_HELP.find((c) => c.cmd.includes('/undo'));
    assert.ok(entry, 'SLASH_COMMANDS_HELP should contain /undo');
  });

  it('autocomplete discovers "undo" command name', () => {
    const commands = listCommandNames();
    assert.ok(commands.includes('undo'), 'listCommandNames should include undo');
  });

  it('reverts file edit when /undo is executed', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-undo-repl-'));
    try {
      const workspaceDir = path.join(tmpRoot, 'workspace');
      const checkpointsDir = path.join(tmpRoot, 'checkpoints');
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.mkdirSync(checkpointsDir, { recursive: true });

      const testFile = path.join(workspaceDir, 'script.js');
      fs.writeFileSync(testFile, 'console.log("before");', 'utf8');

      const mgr = new CheckpointManager({ checkpointsDir, baseDir: workspaceDir });
      const sessionId = 'repl-session-1';

      // Perform edit
      const token = await mgr.createSnapshot({
        sessionId,
        toolName: 'write_file',
        filePath: 'script.js',
        baseDir: workspaceDir,
      });
      fs.writeFileSync(testFile, 'console.log("after");', 'utf8');
      await mgr.commitSnapshot(sessionId, token);

      let output = '';
      const stream = {
        write: (str) => {
          output += str;
        },
      };

      const orchestrator = {
        session: { id: sessionId },
        workingDir: workspaceDir,
        checkpointManager: mgr,
      };

      const result = await executeSlashCommand('/undo', { orchestrator, stream });
      assert.equal(result.handled, true);
      assert.equal(result.action, 'undo');
      assert.equal(fs.readFileSync(testFile, 'utf8'), 'console.log("before");');
      assert.ok(output.includes('Restored script.js') || output.includes('script.js'));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('lists checkpoints when /undo list is called', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-undo-list-'));
    try {
      const workspaceDir = path.join(tmpRoot, 'workspace');
      const checkpointsDir = path.join(tmpRoot, 'checkpoints');
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.mkdirSync(checkpointsDir, { recursive: true });

      const mgr = new CheckpointManager({ checkpointsDir, baseDir: workspaceDir });
      const sessionId = 'repl-session-list';

      let output = '';
      const stream = {
        write: (str) => {
          output += str;
        },
      };

      const orchestrator = {
        session: { id: sessionId },
        workingDir: workspaceDir,
        checkpointManager: mgr,
      };

      const result = await executeSlashCommand('/undo list', { orchestrator, stream });
      assert.equal(result.handled, true);
      assert.equal(result.action, 'undo_list');
      assert.ok(output.includes('No file changes recorded'));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/checkpoint.test.js`  
Expected: FAIL with `/undo not in SLASH_COMMANDS_HELP` or `Unknown slash command: "/undo"`.

- [ ] **Step 3: Modify `src/cli/slash-commands.js`**

1. In `SLASH_COMMANDS_HELP`, add `/undo [n]`:

```javascript
  {
    cmd: '/undo [n]',
    desc: 'Undo the last file edit (or n steps back) performed by the agent',
  },
```

2. In `executeSlashCommand(input, context)`, add `case 'undo':`:

```javascript
    case 'undo': {
      if (!orchestrator?.checkpointManager || !orchestrator?.session) {
        stream.write(`\n${ansi.yellow('⚠')} Checkpoint manager or active session not available.\n\n`);
        return { handled: true, action: 'undo_error', error: true };
      }

      const sessId = orchestrator.session.id;
      const ckptMgr = orchestrator.checkpointManager;

      if (args[0]?.toLowerCase() === 'list') {
        const checkpoints = ckptMgr.getCheckpoints(sessId);
        if (!checkpoints.length) {
          stream.write(`\n${ansi.dim('No file changes recorded in this session.')}\n\n`);
          return { handled: true, action: 'undo_list', count: 0 };
        }

        const lines = checkpoints.map((cp, idx) => {
          const actionType = cp.existedBefore ? ansi.cyan('edit') : ansi.green('created');
          const sizeStr = cp.tooLarge ? ansi.red('(> 1MB - skipped)') : ansi.dim(`(${cp.size} bytes)`);
          return `  ${idx + 1}. [${actionType}] ${ansi.white(cp.relPath)} via ${ansi.yellow(cp.tool)} ${sizeStr}`;
        });

        const box = renderBox(lines.join('\n'), {
          title: `File Checkpoints (${checkpoints.length} in session)`,
          borderColor: 'cyan',
          borderStyle: 'round',
          minWidth: 50,
        });
        stream.write(`\n${box}\n\n`);
        return { handled: true, action: 'undo_list', count: checkpoints.length };
      }

      const steps = args[0] && /^\d+$/.test(args[0]) ? Number.parseInt(args[0], 10) : 1;
      const undoResult = await ckptMgr.undo({
        sessionId: sessId,
        steps,
        baseDir: orchestrator.workingDir,
      });

      if (!undoResult.success) {
        stream.write(`\n${ansi.yellow('⚠')} ${undoResult.reason || 'Could not undo changes.'}\n\n`);
        return { handled: true, action: 'undo_failed', error: true, message: undoResult.reason };
      }

      stream.write(`\n${ansi.green('✔')} ${ansi.bold('Undo successful:')}\n`);
      for (const item of undoResult.restored) {
        const label =
          item.action === 'unlinked'
            ? `${ansi.red('Deleted created file')} ${ansi.white(item.relPath)}`
            : `${ansi.green('Restored')} ${ansi.white(item.relPath)} ${ansi.dim(`(reverted ${item.tool})`)}`;
        stream.write(`  • ${label}\n`);
      }
      stream.write('\n');

      return { handled: true, action: 'undo', restored: undoResult.restored };
    }
```

3. In `case 'new':`, prune old checkpoint sessions:

```javascript
      if (orchestrator.checkpointManager && typeof orchestrator.checkpointManager.pruneSessions === 'function') {
        try {
          orchestrator.checkpointManager.pruneSessions();
        } catch (_e) {
          /* silent-ok: checkpoint pruning is best-effort */
        }
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/checkpoint.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/slash-commands.js tests/checkpoint.test.js
git commit -m "feat(repl): add /undo and /undo list slash commands with checkpoint pruning"
```

---

### Task 6: Comprehensive Verification & Lint

**Files:**
- Run all test suites
- Run linter

- [ ] **Step 1: Run checkpoint test suite**

Run: `node --test tests/checkpoint.test.js`  
Expected: PASS (all tests green)

- [ ] **Step 2: Run all existing tests**

Run: `npm test`  
Expected: PASS (805+ tests pass)

- [ ] **Step 3: Run linter**

Run: `npm run lint`  
Expected: No lint errors in modified files. If format issues arise, run `npm run format`.

- [ ] **Step 4: Update `docs/ROADMAP.md` status**

Update `docs/ROADMAP.md` line 13 and 75: mark feature 3 as done.

```bash
git add docs/ROADMAP.md
git commit -m "docs(roadmap): mark Checkpoint & /undo File Edit as done"
```
