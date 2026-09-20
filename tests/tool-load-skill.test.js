import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { dispatchToolCall, getToolDeclarations } from '../src/tools/registry.js';

describe('tool: load_skill actuator', () => {
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-tool-skill-'));
  const skillDir = path.join(tmpProject, '.agents', 'skills', 'code-review');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---
name: code-review
description: "Review pull requests and diffs thoroughly."
---

# Code Review Procedure
1. Check style.
2. Check security.`,
  );

  after(() => {
    fs.rmSync(tmpProject, { recursive: true, force: true });
  });

  test('load_skill is declared in getToolDeclarations', () => {
    const decls = getToolDeclarations();
    const decl = decls.find((d) => d.name === 'load_skill');
    assert.ok(decl);
    assert.equal(decl.parameters.required[0], 'skill_name');
  });

  test('load_skill successfully retrieves skill instructions', async () => {
    const res = await dispatchToolCall(
      'load_skill',
      { skill_name: 'code-review' },
      { workingDir: tmpProject, projectRoot: tmpProject, homeDir: tmpProject },
    );

    assert.equal(res.success, true);
    assert.equal(res.result.success, true);
    assert.equal(res.result.data.name, 'code-review');
    assert.ok(res.result.data.instructions.includes('# Code Review Procedure'));
  });

  test('load_skill returns failure with available skills list when skill is missing', async () => {
    const res = await dispatchToolCall(
      'load_skill',
      { skill_name: 'non-existent' },
      { workingDir: tmpProject, projectRoot: tmpProject, homeDir: tmpProject },
    );

    assert.equal(res.success, true);
    assert.equal(res.result.success, false);
    assert.ok(res.result.error.includes("Skill 'non-existent' not found"));
    assert.ok(res.result.error.includes('code-review'));
  });

  test('load_skill prevents duplicate loading when skill is already active in session', async () => {
    const session = { metadata: { loadedSkills: [] } };
    const loadedSkills = new Set();
    const context = {
      workingDir: tmpProject,
      projectRoot: tmpProject,
      homeDir: tmpProject,
      session,
      loadedSkills,
    };

    // First load succeeds with full instructions
    const firstRes = await dispatchToolCall('load_skill', { skill_name: 'code-review' }, context);
    assert.equal(firstRes.result.success, true);
    assert.ok(firstRes.result.data.instructions.includes('# Code Review Procedure'));
    assert.equal(loadedSkills.has('code-review'), true);

    // Second load returns already_loaded = true without re-dumping instructions
    const secondRes = await dispatchToolCall('load_skill', { skill_name: 'code-review' }, context);
    assert.equal(secondRes.result.success, true);
    assert.equal(secondRes.result.data.already_loaded, true);
    assert.equal(secondRes.result.data.instructions, undefined);
    assert.match(secondRes.result.data.message, /already loaded/i);
  });
});
