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
