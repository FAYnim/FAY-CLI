import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { getAutocompleteSuggestions } from '../src/cli/autocomplete.js';

describe('autocomplete: @skill: and /skill suggestions', () => {
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-auto-skill-'));
  const s1 = path.join(tmpProject, '.agents', 'skills', 'frontend-design');
  const s2 = path.join(tmpProject, '.agents', 'skills', 'copywriting');
  fs.mkdirSync(s1, { recursive: true });
  fs.mkdirSync(s2, { recursive: true });
  fs.writeFileSync(path.join(s1, 'SKILL.md'), '---\nname: frontend-design\n---');
  fs.writeFileSync(path.join(s2, 'SKILL.md'), '---\nname: copywriting\n---');

  after(() => {
    fs.rmSync(tmpProject, { recursive: true, force: true });
  });

  test('suggests installed skills when typing @skill:', () => {
    const result = getAutocompleteSuggestions('@skill:', 7, {
      workingDir: tmpProject,
      projectRoot: tmpProject,
      homeDir: tmpProject,
    });

    assert.equal(result.type, 'skill');
    assert.ok(result.items.some((item) => item.text === '@skill:frontend-design'));
    assert.ok(result.items.some((item) => item.text === '@skill:copywriting'));
  });

  test('filters skill suggestions by prefix @skill:front', () => {
    const result = getAutocompleteSuggestions('@skill:front', 12, {
      workingDir: tmpProject,
      projectRoot: tmpProject,
      homeDir: tmpProject,
    });

    assert.equal(result.type, 'skill');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].text, '@skill:frontend-design');
  });

  test('suggests /skill subcommands when typing /skill ', () => {
    const result = getAutocompleteSuggestions('/skill ', 7, {
      workingDir: tmpProject,
      projectRoot: tmpProject,
      homeDir: tmpProject,
    });

    assert.equal(result.type, 'command');
    const texts = result.items.map((i) => i.text);
    assert.ok(texts.includes('/skill list'));
    assert.ok(texts.includes('/skill add'));
    assert.ok(texts.includes('/skill remove'));
    assert.ok(texts.includes('/skill info'));
  });
});
