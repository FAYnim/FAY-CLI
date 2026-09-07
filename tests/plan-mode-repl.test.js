import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReplPrompt } from '../src/cli/repl.js';

test('buildReplPrompt renders correctly for build and plan mode', () => {
  const buildPrompt = buildReplPrompt('build');
  assert.ok(buildPrompt.includes('❯'));
  assert.ok(!buildPrompt.includes('[PLAN]'));

  const planPrompt = buildReplPrompt('plan');
  assert.ok(planPrompt.includes('[PLAN]'));
  assert.ok(planPrompt.includes('❯'));
});
