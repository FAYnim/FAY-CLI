# Dynamic System Prompt for Plan and Build Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject mode-aware system instructions (Plan Mode vs Build Mode) dynamically into the LLM system prompt so the agent behaves strictly according to the active mode.

**Architecture:** Extend `buildSystemPrompt({ workingDir, mode, activePlanPath })` in `src/agent/system-prompt.js` with mode-specific instruction blocks. Update `AgentOrchestrator.getEffectiveSystemInstruction()` in `src/agent/orchestrator.js` to dynamically generate the prompt per turn before calling `llmClient.generateStream()`.

**Tech Stack:** Node.js (ESM), `node:test`, `node:assert/strict`.

---

### File Structure Map
- Modify: `src/agent/system-prompt.js` (add mode instruction generator and integrate into `buildSystemPrompt`)
- Modify: `src/agent/orchestrator.js` (add `getEffectiveSystemInstruction()` and pass it to `llmClient.generateStream()`)
- Test: `tests/plan-mode-system-prompt.test.js` (unit tests for mode prompt generator and orchestrator dynamic prompt)

---

### Task 1: Mode-Aware Instructions in system-prompt.js

**Files:**
- Modify: `src/agent/system-prompt.js`
- Test: `tests/plan-mode-system-prompt.test.js`

- [ ] **Step 1: Write failing tests for mode-aware system prompt**

Create `tests/plan-mode-system-prompt.test.js`:
```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/plan-mode-system-prompt.test.js`
Expected: FAIL (missing 'ACTIVE MODE: BUILD MODE')

- [ ] **Step 3: Implement minimal mode instruction builder in `src/agent/system-prompt.js`**

Add mode generator function and append to `buildSystemPrompt`:
```javascript
export function buildModeInstructions(mode = 'build', activePlanPath = null) {
  if (mode === 'plan') {
    return `
### ACTIVE MODE: PLAN MODE (READ-ONLY ANALYSIS & PLANNING)
- You are currently in PLAN MODE. You are in read-only analysis and planning mode.
- DO NOT attempt to modify, patch, or delete project source code.
- DO NOT attempt to execute shell commands for system modification or building.
- Focus on inspecting files, analyzing architecture, and proposing concrete steps.
- You may only write or update the active plan file${activePlanPath ? ` at: \`${activePlanPath}\`` : ' inside `.fay/plans/`'}.
- When ready to execute changes, inform the user to switch to Build Mode using \`/build\`.
`.trim();
  }

  return `
### ACTIVE MODE: BUILD MODE (EXECUTION)
- You are in standard BUILD MODE with full permissions to read, write, patch files, and execute shell commands.
- Verify changes after editing and proceed autonomously.
`.trim();
}
```

Update `buildSystemPrompt(options = {})`:
```javascript
// Append mode block
parts.push(buildModeInstructions(options.mode || 'build', options.activePlanPath));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/plan-mode-system-prompt.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -f tests/plan-mode-system-prompt.test.js
git add src/agent/system-prompt.js
git commit -m "feat(agent): add mode-aware instructions to system prompt"
```

---

### Task 2: Orchestrator Dynamic System Instruction per Turn

**Files:**
- Modify: `src/agent/orchestrator.js`
- Test: `tests/plan-mode-system-prompt.test.js`

- [ ] **Step 1: Write failing test for dynamic orchestrator system instruction**

Append to `tests/plan-mode-system-prompt.test.js`:
```javascript
import { AgentOrchestrator } from '../src/agent/orchestrator.js';

test('AgentOrchestrator updates getEffectiveSystemInstruction() when mode changes', () => {
  const orchestrator = new AgentOrchestrator({ autoApprove: true });
  assert.ok(orchestrator.getEffectiveSystemInstruction().includes('ACTIVE MODE: BUILD MODE'));

  orchestrator.setMode('plan', '.fay/plans/test-plan.md');
  const planInstruction = orchestrator.getEffectiveSystemInstruction();
  assert.ok(planInstruction.includes('ACTIVE MODE: PLAN MODE'));
  assert.ok(planInstruction.includes('.fay/plans/test-plan.md'));

  orchestrator.setMode('build');
  assert.ok(orchestrator.getEffectiveSystemInstruction().includes('ACTIVE MODE: BUILD MODE'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/plan-mode-system-prompt.test.js`
Expected: FAIL (`orchestrator.getEffectiveSystemInstruction is not a function`)

- [ ] **Step 3: Implement `getEffectiveSystemInstruction()` in `src/agent/orchestrator.js`**

Add method:
```javascript
getEffectiveSystemInstruction() {
  return buildSystemPrompt({
    workingDir: this.workingDir,
    mode: this.mode,
    activePlanPath: this.activePlanPath,
    customInstructions: this.customInstructions,
  });
}
```

Update `runTurn()` inside `orchestrator.js` around line 297 to use `systemInstruction: this.getEffectiveSystemInstruction()`.

- [ ] **Step 4: Run all plan mode tests to verify they pass**

Run: `node --test tests/plan-mode-*.test.js tests/e2e/e2e-plan-mode.test.js`
Expected: PASS (9/9 tests pass)

- [ ] **Step 5: Commit and Push**

```bash
git add src/agent/orchestrator.js tests/plan-mode-system-prompt.test.js
git commit -m "feat(orchestrator): dynamically supply mode-aware system instruction to LLM"
git push origin feat/plan-mode
```
