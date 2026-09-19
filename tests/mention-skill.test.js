import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { expandMentions, parseMentions } from '../src/agent/mention-parser.js';

describe('mention-parser: @skill:<name> context expansion', () => {
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-mention-skill-'));
  const skillDir = path.join(tmpProject, '.agents', 'skills', 'canvas-design');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---
name: canvas-design
description: "Create visual posters in PNG."
---

# Canvas Rules
Always use high contrast.`,
  );

  after(() => {
    fs.rmSync(tmpProject, { recursive: true, force: true });
  });

  test('parseMentions identifies @skill:<name> tokens separately from normal file mentions', () => {
    const text = 'Help me build a poster @skill:canvas-design and inspect @README.md';
    const mentions = parseMentions(text);
    assert.ok(mentions.includes('README.md'));
    assert.ok(mentions.includes('skill:canvas-design'));
  });

  test('expandMentions injects skill instructions into <context_skill> block', () => {
    const text = 'Create poster @skill:canvas-design';
    const result = expandMentions(text, { workingDir: tmpProject, projectRoot: tmpProject, homeDir: tmpProject });

    assert.equal(result.cleanPrompt, text);
    assert.ok(result.injectedPrompt.includes('<context_skill name="canvas-design">'));
    assert.ok(result.injectedPrompt.includes('Always use high contrast.'));
    assert.deepEqual(result.attachedSkills, ['canvas-design']);
  });

  test('expandMentions gracefully handles non-existent @skill:<name>', () => {
    const text = 'Create poster @skill:unknown-skill';
    const result = expandMentions(text, { workingDir: tmpProject, projectRoot: tmpProject, homeDir: tmpProject });

    assert.equal(result.cleanPrompt, text);
    assert.ok(!result.injectedPrompt.includes('<context_skill'));
    assert.deepEqual(result.attachedSkills, []);
  });
});
