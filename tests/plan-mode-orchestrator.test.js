import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentOrchestrator } from '../src/agent/orchestrator.js';

test('AgentOrchestrator defaults to build mode', () => {
  const orchestrator = new AgentOrchestrator({ autoApprove: true });
  assert.equal(orchestrator.getMode(), 'build');
  assert.equal(orchestrator.getActivePlanPath(), null);
  const tools = orchestrator.getEffectiveTools();
  const toolNames = tools.map((t) => t.name);
  assert.ok(toolNames.includes('write_file'));
  assert.ok(toolNames.includes('patch_file'));
  assert.ok(toolNames.includes('execute_command'));
});

test('AgentOrchestrator switches to plan mode and restricts tool declarations', () => {
  const orchestrator = new AgentOrchestrator({ autoApprove: true });
  orchestrator.setMode('plan', '/path/to/.fay/plans/plan-1.md');
  assert.equal(orchestrator.getMode(), 'plan');
  assert.equal(orchestrator.getActivePlanPath(), '/path/to/.fay/plans/plan-1.md');

  const tools = orchestrator.getEffectiveTools();
  const toolNames = tools.map((t) => t.name);
  assert.ok(toolNames.includes('read_file'));
  assert.ok(toolNames.includes('list_dir'));
  assert.ok(toolNames.includes('write_file'));
  assert.ok(!toolNames.includes('patch_file'), 'patch_file must be excluded in plan mode');
  assert.ok(!toolNames.includes('execute_command'), 'execute_command must be excluded in plan mode');
  assert.ok(!toolNames.includes('git_add_commit'), 'git_add_commit must be excluded in plan mode');
});
