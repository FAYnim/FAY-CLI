import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSystemPrompt } from '../src/agent/system-prompt.js';

test('buildSystemPrompt includes Build Mode instructions by default', () => {
  const prompt = buildSystemPrompt({ mode: 'build' });
  assert.ok(prompt.includes('ACTIVE MODE: BUILD MODE'));
  assert.ok(prompt.includes('full permissions'));
});

test('buildSystemPrompt includes Plan Mode restrictions and plan path when in plan mode', () => {
  const prompt = buildSystemPrompt({
    mode: 'plan',
    activePlanPath: '.fay/plans/plan-123.md',
  });
  assert.ok(prompt.includes('ACTIVE MODE: PLAN MODE'));
  assert.ok(prompt.includes('READ-ONLY'));
  assert.ok(prompt.includes('.fay/plans/plan-123.md'));
  assert.ok(prompt.includes('/build'));
});
