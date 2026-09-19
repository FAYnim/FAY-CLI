import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { executeSlashCommand } from '../src/cli/slash-commands.js';

describe('slash-commands: /skill management', () => {
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-slash-skill-'));
  const s1 = path.join(tmpProject, '.agents', 'skills', 'mock-skill');
  fs.mkdirSync(s1, { recursive: true });
  fs.writeFileSync(
    path.join(s1, 'SKILL.md'),
    `---
name: mock-skill
description: "A mock skill description."
version: 1.0.0
---
# Mock Guide`,
  );

  after(() => {
    fs.rmSync(tmpProject, { recursive: true, force: true });
  });

  test('/skill list outputs installed skills', async () => {
    let captured = '';
    const mockStream = {
      write: (text) => {
        captured += text;
      },
    };

    const res = await executeSlashCommand('/skill list', {
      workingDir: tmpProject,
      projectRoot: tmpProject,
      homeDir: tmpProject,
      stream: mockStream,
    });

    assert.equal(res.handled, true);
    assert.ok(captured.includes('mock-skill'));
    assert.ok(captured.includes('A mock skill description.'));
  });

  test('/skill info <name> outputs skill details and instructions', async () => {
    let captured = '';
    const mockStream = {
      write: (text) => {
        captured += text;
      },
    };

    const res = await executeSlashCommand('/skill info mock-skill', {
      workingDir: tmpProject,
      projectRoot: tmpProject,
      homeDir: tmpProject,
      stream: mockStream,
    });

    assert.equal(res.handled, true);
    assert.ok(captured.includes('mock-skill'));
    assert.ok(captured.includes('Mock Guide'));
  });
});
