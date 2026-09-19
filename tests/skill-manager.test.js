import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import {
  discoverSkills,
  getSkill,
  loadSkillContent,
  parseSkillFrontmatter,
} from '../src/skills/skill-manager.js';

describe('SkillManager: YAML frontmatter parser and multi-scope discovery', () => {
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-skill-proj-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-skill-home-'));

  // Global skills
  const globalSkillsDir = path.join(tmpHome, '.agents', 'skills');
  fs.mkdirSync(path.join(globalSkillsDir, 'brainstorming'), { recursive: true });
  fs.writeFileSync(
    path.join(globalSkillsDir, 'brainstorming', 'SKILL.md'),
    `---
name: brainstorming
description: "Explore user intent and design before implementation."
author: official
version: 1.0.0
---

# Brainstorming Guide
Follow collaborative dialogue steps.`,
  );

  // Global skill that will be overridden by project
  fs.mkdirSync(path.join(globalSkillsDir, 'frontend-design'), { recursive: true });
  fs.writeFileSync(
    path.join(globalSkillsDir, 'frontend-design', 'SKILL.md'),
    `---
name: frontend-design
description: "Global version of frontend design."
---
Global instructions`,
  );

  // Project skills
  const projectSkillsDir = path.join(tmpProject, '.agents', 'skills');
  fs.mkdirSync(path.join(projectSkillsDir, 'frontend-design'), { recursive: true });
  fs.writeFileSync(
    path.join(projectSkillsDir, 'frontend-design', 'SKILL.md'),
    `---
name: frontend-design
description: "Project version: Create distinctive, production-grade frontend interfaces."
version: 2.0.0
---

# Project Frontend Design
Use Tailwind and atomic tokens.`,
  );

  after(() => {
    fs.rmSync(tmpProject, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test('parseSkillFrontmatter parses yaml header and separates body correctly', () => {
    const raw = `---
name: test-skill
description: "A test description"
author: alice
version: 1.2.3
---
# Main Content
Hello world`;
    const parsed = parseSkillFrontmatter(raw);
    assert.equal(parsed.metadata.name, 'test-skill');
    assert.equal(parsed.metadata.description, 'A test description');
    assert.equal(parsed.metadata.author, 'alice');
    assert.equal(parsed.metadata.version, '1.2.3');
    assert.equal(parsed.content.trim(), '# Main Content\nHello world');
  });

  test('parseSkillFrontmatter gracefully handles markdown without frontmatter', () => {
    const raw = '# Just Markdown\nNo frontmatter here';
    const parsed = parseSkillFrontmatter(raw);
    assert.deepEqual(parsed.metadata, {});
    assert.equal(parsed.content.trim(), '# Just Markdown\nNo frontmatter here');
  });

  test('discoverSkills lists skills with project overriding global', () => {
    const skills = discoverSkills({ projectRoot: tmpProject, homeDir: tmpHome });
    assert.equal(skills.length, 2);

    const frontendSkill = skills.find((s) => s.name === 'frontend-design');
    assert.ok(frontendSkill);
    assert.equal(frontendSkill.scope, 'project');
    assert.equal(
      frontendSkill.description,
      'Project version: Create distinctive, production-grade frontend interfaces.',
    );

    const brainstormingSkill = skills.find((s) => s.name === 'brainstorming');
    assert.ok(brainstormingSkill);
    assert.equal(brainstormingSkill.scope, 'global');
  });

  test('getSkill returns single skill with correct priority', () => {
    const skill = getSkill('frontend-design', { projectRoot: tmpProject, homeDir: tmpHome });
    assert.ok(skill);
    assert.equal(skill.scope, 'project');
    assert.equal(skill.name, 'frontend-design');
  });

  test('loadSkillContent returns instructions and lists helper scripts', () => {
    // Add a script file to project frontend-design
    const scriptsDir = path.join(tmpProject, '.agents', 'skills', 'frontend-design', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'lint.sh'), '#!/bin/sh\necho ok');

    const result = loadSkillContent('frontend-design', {
      projectRoot: tmpProject,
      homeDir: tmpHome,
    });
    assert.ok(result);
    assert.ok(result.content.includes('# Project Frontend Design'));
    assert.deepEqual(result.scripts, ['scripts/lint.sh']);
  });

  test('loadSkillContent returns null for non-existent skill', () => {
    const result = loadSkillContent('non-existent', {
      projectRoot: tmpProject,
      homeDir: tmpHome,
    });
    assert.equal(result, null);
  });
});
