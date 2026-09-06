import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { AgentOrchestrator } from '../../src/agent/orchestrator.js';
import { executeSlashCommand } from '../../src/cli/slash-commands.js';

test('E2E: /plan to /build lifecycle with sandbox enforcement', async () => {
  const tmpDir = path.join(process.cwd(), 'tests/.tmp-plan-e2e');
  fs.mkdirSync(tmpDir, { recursive: true });

  const orchestrator = new AgentOrchestrator({
    workingDir: tmpDir,
    autoApprove: true,
  });

  // 1. Initial state is build
  assert.equal(orchestrator.getMode(), 'build');

  // 2. Trigger /plan
  let out = '';
  const stream = {
    write: (s) => {
      out += s;
    },
  };
  const planRes = await executeSlashCommand('/plan refactor auth', { orchestrator, stream });
  assert.equal(planRes.action, 'plan');
  assert.equal(orchestrator.getMode(), 'plan');
  assert.ok(fs.existsSync(orchestrator.getActivePlanPath()));

  // 3. Verify security restriction in plan mode
  const guard = orchestrator.securityGuard;
  const invalidWrite = await guard.authorize('write_file', {
    filePath: path.join(tmpDir, 'auth.js'),
    content: 'hack',
  });
  assert.equal(invalidWrite.allowed, false);

  const validPlanWrite = await guard.authorize('write_file', {
    filePath: orchestrator.getActivePlanPath(),
    content: '# Updated Plan',
  });
  assert.equal(validPlanWrite.allowed, true);

  // 4. Trigger /build
  const buildRes = await executeSlashCommand('/build', { orchestrator, stream });
  assert.equal(buildRes.action, 'build');
  assert.equal(orchestrator.getMode(), 'build');

  // 5. Verify normal permissions restored
  const normalWrite = await guard.authorize('write_file', {
    filePath: path.join(tmpDir, 'auth.js'),
    content: 'valid build output',
  });
  assert.equal(normalWrite.allowed, true);

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
