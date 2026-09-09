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
  assert.ok(prompt.includes('Writing-Plans Standard'));
  assert.ok(prompt.includes('Zero-Placeholder Policy'));
  assert.ok(prompt.includes('Bite-Sized Task Granularity'));
  assert.ok(prompt.includes('Mandatory Document Format'));
  assert.ok(prompt.includes('Agent Execution Workflow in Plan Mode'));
});

test('buildSystemPrompt in plan mode uses fallback target file path when activePlanPath is not provided', () => {
  const prompt = buildSystemPrompt({ mode: 'plan' });
  assert.ok(prompt.includes('.fay/plans/<YYYY-MM-DD-feature-name>.md'));
});

test('AgentOrchestrator updates getEffectiveSystemInstruction() when mode changes', async () => {
  const { AgentOrchestrator } = await import('../src/agent/orchestrator.js');
  const orchestrator = new AgentOrchestrator({ autoApprove: true });
  assert.ok(orchestrator.getEffectiveSystemInstruction().includes('ACTIVE MODE: BUILD MODE'));

  orchestrator.setMode('plan', '.fay/plans/test-plan.md');
  const planInstruction = orchestrator.getEffectiveSystemInstruction();
  assert.ok(planInstruction.includes('ACTIVE MODE: PLAN MODE'));
  assert.ok(planInstruction.includes('.fay/plans/test-plan.md'));

  orchestrator.setMode('build');
  assert.ok(orchestrator.getEffectiveSystemInstruction().includes('ACTIVE MODE: BUILD MODE'));
});
