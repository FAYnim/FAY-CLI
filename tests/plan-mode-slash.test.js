import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { executeSlashCommand } from '../src/cli/slash-commands.js';

test('executeSlashCommand handles /plan and creates draft file', async () => {
  const tmpDir = path.join(process.cwd(), 'tests/.tmp-plan-test');
  fs.mkdirSync(tmpDir, { recursive: true });

  const mockOrchestrator = {
    workingDir: tmpDir,
    mode: 'build',
    activePlanPath: null,
    getMode() {
      return this.mode;
    },
    getActivePlanPath() {
      return this.activePlanPath;
    },
    setMode(mode, p) {
      this.mode = mode;
      this.activePlanPath = p;
    },
  };

  let output = '';
  const mockStream = {
    write: (str) => {
      output += str;
    },
  };

  const res = await executeSlashCommand('/plan my feature', {
    orchestrator: mockOrchestrator,
    stream: mockStream,
  });

  assert.equal(res.handled, true);
  assert.equal(res.action, 'plan');
  assert.equal(mockOrchestrator.getMode(), 'plan');
  assert.ok(mockOrchestrator.getActivePlanPath());
  assert.ok(fs.existsSync(mockOrchestrator.getActivePlanPath()));

  // Clean up
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('executeSlashCommand handles /build and returns to build mode', async () => {
  const mockOrchestrator = {
    mode: 'plan',
    activePlanPath: '/some/plan.md',
    getMode() {
      return this.mode;
    },
    getActivePlanPath() {
      return this.activePlanPath;
    },
    setMode(mode, p) {
      this.mode = mode;
      this.activePlanPath = p;
    },
  };

  let output = '';
  const mockStream = {
    write: (str) => {
      output += str;
    },
  };

  const res = await executeSlashCommand('/build', {
    orchestrator: mockOrchestrator,
    stream: mockStream,
  });

  assert.equal(res.handled, true);
  assert.equal(res.action, 'build');
  assert.equal(mockOrchestrator.getMode(), 'build');
});
