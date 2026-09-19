import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { buildSystemPrompt } from '../src/agent/system-prompt.js';

describe('system-prompt: skills catalog injection', () => {
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-sys-prompt-'));
  const skillsDir = path.join(tmpProject, '.agents', 'skills', 'test-automation');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillsDir, 'SKILL.md'),
    `---
name: test-automation
description: "Automate test generation using unit testing conventions."
---
# Testing guidelines`,
  );

  after(() => {
    fs.rmSync(tmpProject, { recursive: true, force: true });
  });

  test('buildSystemPrompt injects AVAILABLE SKILLS block when skills are present', () => {
    const prompt = buildSystemPrompt({
      workingDir: tmpProject,
      projectRoot: tmpProject,
      homeDir: tmpProject, // redirect home to avoid picking up machine-level skills in tests
    });

    assert.ok(prompt.includes('### AVAILABLE SKILLS:'));
    assert.ok(
      prompt.includes(
        '- **test-automation** (project): Automate test generation using unit testing conventions.',
      ),
    );
    assert.ok(prompt.includes('invoke the `load_skill` tool'));
  });

  test('buildSystemPrompt omits AVAILABLE SKILLS block if skills option is explicitly disabled', () => {
    const prompt = buildSystemPrompt({
      workingDir: tmpProject,
      projectRoot: tmpProject,
      homeDir: tmpProject,
      enableSkills: false,
    });

    assert.ok(!prompt.includes('### AVAILABLE SKILLS:'));
  });
});
