import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { installSkillFromGitHub, parseInstallSource, removeSkill } from '../src/skills/installer.js';

describe('SkillInstaller: Source parsing and skill management', () => {
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-install-proj-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-install-home-'));

  after(() => {
    fs.rmSync(tmpProject, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test('parseInstallSource parses owner/repo shorthand and options', () => {
    const s1 = parseInstallSource('anthropics/skills');
    assert.deepEqual(s1, { owner: 'anthropics', repo: 'skills', skillName: null });

    const s2 = parseInstallSource('vercel-labs/skills --skill frontend-design');
    assert.deepEqual(s2, { owner: 'vercel-labs', repo: 'skills', skillName: 'frontend-design' });

    const s3 = parseInstallSource('https://github.com/my-org/my-skills/tree/main/skills/custom');
    assert.equal(s3.owner, 'my-org');
    assert.equal(s3.repo, 'my-skills');
    assert.equal(s3.skillName, 'custom');
  });

  test('installSkillFromGitHub writes skill folder and SKILL.md using mock client', async () => {
    const mockFetcher = async (url) => {
      if (url.includes('SKILL.md')) {
        return {
          ok: true,
          status: 200,
          text: async () => '---\nname: mock-skill\ndescription: Mock test\n---\n# Content',
        };
      }
      return { ok: false, status: 404 };
    };

    const targetDir = path.join(tmpProject, '.agents', 'skills');
    const result = await installSkillFromGitHub('test-owner/test-repo', {
      skillName: 'mock-skill',
      targetDir,
      fetcher: mockFetcher,
    });

    assert.equal(result.success, true);
    const installedFile = path.join(targetDir, 'mock-skill', 'SKILL.md');
    assert.ok(fs.existsSync(installedFile));
    assert.ok(fs.readFileSync(installedFile, 'utf8').includes('Mock test'));
  });

  test('removeSkill deletes installed skill folder', () => {
    const targetDir = path.join(tmpProject, '.agents', 'skills');
    const result = removeSkill('mock-skill', { targetDir });
    assert.equal(result.success, true);
    assert.ok(!fs.existsSync(path.join(targetDir, 'mock-skill')));
  });
});
