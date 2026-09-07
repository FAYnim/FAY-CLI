import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { SecurityGuard } from '../src/security/guard.js';

test('SecurityGuard rejects write_file outside .fay/plans in plan mode', async () => {
  const baseDir = process.cwd();
  const guard = new SecurityGuard({ baseDir, autoApprove: true });
  guard.setMode('plan');

  const outsideResult = await guard.authorize('write_file', {
    filePath: path.join(baseDir, 'src/index.js'),
    content: 'console.log(1)',
  });
  assert.equal(outsideResult.allowed, false);
  assert.match(outsideResult.reason, /restricted to \.fay[\\\/]plans/i);

  const planResult = await guard.authorize('write_file', {
    filePath: path.join(baseDir, '.fay/plans/plan-test.md'),
    content: '# Plan',
  });
  assert.equal(planResult.allowed, true);
});

test('SecurityGuard rejects patch_file and execute_command in plan mode', async () => {
  const guard = new SecurityGuard({ autoApprove: true });
  guard.setMode('plan');

  const execRes = await guard.authorize('execute_command', { command: 'ls' });
  assert.equal(execRes.allowed, false);
  assert.match(execRes.reason, /not permitted in Plan Mode/i);

  const patchRes = await guard.authorize('patch_file', { filePath: 'foo.txt' });
  assert.equal(patchRes.allowed, false);
  assert.match(patchRes.reason, /not permitted in Plan Mode/i);
});
