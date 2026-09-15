/**
 * Tests for Checkpoint & /undo File Edit (Roadmap #3)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
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

import { CheckpointManager } from '../src/agent/checkpoint.js';

describe('CheckpointManager Core', () => {
  let tmpRoot;
  let checkpointsDir;
  let workspaceDir;

  it('creates snapshot for existing file and commits to index.jsonl on success', async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-ckpt-mgr-1-'));
    checkpointsDir = path.join(tmpRoot, 'checkpoints');
    workspaceDir = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(checkpointsDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    try {
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
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('discards pending snapshot if tool execution fails', async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-ckpt-mgr-2-'));
    checkpointsDir = path.join(tmpRoot, 'checkpoints');
    workspaceDir = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(checkpointsDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    try {
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
        assert.equal(files.filter((f) => f.endsWith('.bak')).length, 0);
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('handles brand new file (existedBefore: false) and removes it on undo', async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-ckpt-mgr-3-'));
    checkpointsDir = path.join(tmpRoot, 'checkpoints');
    workspaceDir = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(checkpointsDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    try {
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
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('skips snapshot content when file exceeds maxFileSize (> 1 MB)', async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-ckpt-mgr-4-'));
    checkpointsDir = path.join(tmpRoot, 'checkpoints');
    workspaceDir = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(checkpointsDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    try {
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
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('supports multi-step undo (steps = 2)', async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-ckpt-mgr-5-'));
    checkpointsDir = path.join(tmpRoot, 'checkpoints');
    workspaceDir = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(checkpointsDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    try {
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
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('pruneSessions retains only keep most recent sessions', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-ckpt-mgr-6-'));
    checkpointsDir = path.join(tmpRoot, 'checkpoints');
    workspaceDir = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(checkpointsDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    try {
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
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

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
