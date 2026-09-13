/**
 * Unit & Integration Tests: Auto-load Project Instructions (AGENTS.md)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { DEFAULT_CONFIG } from '../src/config/constants.js';
import {
  DEFAULT_INSTRUCTIONS_FILE,
  loadInstructions,
  MAX_INSTRUCTION_BYTES,
} from '../src/utils/project.js';

describe('Project Instructions: Configuration', () => {
  test('DEFAULT_CONFIG contains instructionsFile set to AGENTS.md', () => {
    assert.equal(DEFAULT_CONFIG.instructionsFile, 'AGENTS.md');
  });
});

describe('Project Instructions: loadInstructions()', () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-instructions-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch (_) {}
  });

  test('constants have expected values', () => {
    assert.equal(MAX_INSTRUCTION_BYTES, 8192);
    assert.equal(DEFAULT_INSTRUCTIONS_FILE, 'AGENTS.md');
  });

  test('returns empty when instructionsFile is false', () => {
    const res = loadInstructions(tmpBase, { instructionsFile: false });
    assert.deepEqual(res, { text: '', files: [] });
  });

  test('merges root and subdirectory AGENTS.md in root-to-leaf order', () => {
    // tmpBase/ (project root marked by package.json) -> AGENTS.md
    // tmpBase/packages/app/ (cwd) -> AGENTS.md
    fs.writeFileSync(path.join(tmpBase, 'package.json'), '{}');
    fs.writeFileSync(path.join(tmpBase, 'AGENTS.md'), '# Root Rules\nRule 1');

    const subDir = path.join(tmpBase, 'packages', 'app');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'AGENTS.md'), '# App Rules\nRule 2');

    const res = loadInstructions(subDir);
    assert.equal(res.files.length, 2);

    const rootNorm = path.resolve(path.join(tmpBase, 'AGENTS.md'));
    const subNorm = path.resolve(path.join(subDir, 'AGENTS.md'));
    assert.equal(res.files[0], rootNorm);
    assert.equal(res.files[1], subNorm);

    // Root rules appear before app rules
    const idxRoot = res.text.indexOf('# Root Rules');
    const idxApp = res.text.indexOf('# App Rules');
    assert.ok(idxRoot !== -1);
    assert.ok(idxApp !== -1);
    assert.ok(idxRoot < idxApp);

    // Each block contains origin header
    assert.ok(res.text.includes(`## From ${rootNorm}`));
    assert.ok(res.text.includes(`## From ${subNorm}`));
  });

  test('walk-up stops at projectRoot and ignores AGENTS.md above projectRoot', () => {
    // tmpBase/AGENTS.md (above project root — should be ignored)
    // tmpBase/project/ (marked by package.json) -> AGENTS.md
    // tmpBase/project/src/ (cwd)
    fs.writeFileSync(path.join(tmpBase, 'AGENTS.md'), '# Outside Root (Should be ignored)');
    const projRoot = path.join(tmpBase, 'project');
    fs.mkdirSync(projRoot, { recursive: true });
    fs.writeFileSync(path.join(projRoot, 'package.json'), '{}');
    fs.writeFileSync(path.join(projRoot, 'AGENTS.md'), '# Project Root Rules');

    const cwd = path.join(projRoot, 'src');
    fs.mkdirSync(cwd, { recursive: true });

    const res = loadInstructions(cwd);
    assert.equal(res.files.length, 1);
    assert.equal(res.files[0], path.resolve(path.join(projRoot, 'AGENTS.md')));
    assert.ok(!res.text.includes('# Outside Root'));
  });

  test('supports custom instructions file name via config', () => {
    fs.writeFileSync(path.join(tmpBase, 'package.json'), '{}');
    fs.writeFileSync(path.join(tmpBase, 'AGENTS.md'), '# Ignored AGENTS.md');
    fs.writeFileSync(path.join(tmpBase, 'TEAM.md'), '# Team Rules');

    const res = loadInstructions(tmpBase, { instructionsFile: 'TEAM.md' });
    assert.equal(res.files.length, 1);
    assert.ok(res.files[0].endsWith('TEAM.md'));
    assert.ok(res.text.includes('# Team Rules'));
    assert.ok(!res.text.includes('# Ignored AGENTS.md'));
  });

  test('truncates combined text exceeding MAX_INSTRUCTION_BYTES from tail with marker', () => {
    fs.writeFileSync(path.join(tmpBase, 'package.json'), '{}');
    const largeContent = 'X'.repeat(9000);
    fs.writeFileSync(path.join(tmpBase, 'AGENTS.md'), largeContent);

    const res = loadInstructions(tmpBase);
    assert.equal(res.files.length, 1);
    assert.ok(Buffer.byteLength(res.text, 'utf8') <= MAX_INSTRUCTION_BYTES);
    assert.ok(res.text.endsWith('…[truncated]'));
  });

  test('skips empty files without throwing', () => {
    fs.writeFileSync(path.join(tmpBase, 'package.json'), '{}');
    fs.writeFileSync(path.join(tmpBase, 'AGENTS.md'), '   \n  '); // whitespace only

    const res = loadInstructions(tmpBase);
    assert.equal(res.files.length, 0);
    assert.equal(res.text, '');
  });
});

import { AgentOrchestrator } from '../src/agent/orchestrator.js';

describe('Project Instructions: AgentOrchestrator Integration', () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-orch-test-'));
    fs.writeFileSync(path.join(tmpBase, 'package.json'), '{}');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch (_) {}
  });

  test('orchestrator loads instructions and injects into effective system instruction', () => {
    fs.writeFileSync(path.join(tmpBase, 'AGENTS.md'), 'Repo Instruction: Never use var');

    const dummyClient = {
      getModel: () => 'test-model',
      generate: async () => ({ content: 'ok' }),
    };

    const orchestrator = new AgentOrchestrator({
      workingDir: tmpBase,
      llmClient: dummyClient,
    });

    assert.equal(orchestrator.getInstructionFiles().length, 1);
    assert.ok(orchestrator.getInstructionFiles()[0].endsWith('AGENTS.md'));
    assert.ok(orchestrator.getCustomInstructions().includes('Repo Instruction: Never use var'));

    const sys = orchestrator.getEffectiveSystemInstruction();
    assert.ok(sys.includes('### CUSTOM USER INSTRUCTIONS:'));
    assert.ok(sys.includes('Repo Instruction: Never use var'));
  });

  test('explicit systemInstruction override bypasses AGENTS.md loading', () => {
    fs.writeFileSync(path.join(tmpBase, 'AGENTS.md'), 'Repo Instruction: Should not load');

    const dummyClient = {
      getModel: () => 'test-model',
    };

    const orchestrator = new AgentOrchestrator({
      workingDir: tmpBase,
      llmClient: dummyClient,
      systemInstruction: 'Hardcoded override system prompt',
    });

    assert.equal(orchestrator.getInstructionFiles().length, 0);
    assert.equal(orchestrator.getCustomInstructions(), null);
    assert.equal(orchestrator.getEffectiveSystemInstruction(), 'Hardcoded override system prompt');
  });
});

import { PassThrough } from 'node:stream';
import { executeSlashCommand, SLASH_COMMANDS_HELP } from '../src/cli/slash-commands.js';

describe('Project Instructions: REPL Banner Integration', () => {
  test('formatting of loaded instructions notice uses cyan indicator and file list', () => {
    const files = ['/path/to/project/AGENTS.md', '/path/to/cwd/AGENTS.md'];
    const notice = `\x1B[36mℹ\x1B[39m \x1B[2mLoaded instructions:\x1B[22m ${files.join(', ')}\n`;
    assert.ok(notice.includes('Loaded instructions:'));
    assert.ok(notice.includes('AGENTS.md'));
  });
});

describe('Project Instructions: /instructions Slash Command', () => {
  test('SLASH_COMMANDS_HELP includes /instructions entry', () => {
    const found = SLASH_COMMANDS_HELP.find((c) => c.cmd.startsWith('/instructions'));
    assert.ok(found, '/instructions should be documented in help menu');
  });

  test('/instructions reports no files when empty', async () => {
    const dummyOrch = {
      getInstructionFiles: () => [],
      getCustomInstructions: () => null,
    };
    const out = new PassThrough();
    let data = '';
    out.on('data', (chunk) => {
      data += chunk.toString();
    });

    const res = await executeSlashCommand('/instructions', {
      orchestrator: dummyOrch,
      stream: out,
    });

    assert.equal(res.handled, true);
    assert.equal(res.action, 'instructions');
    assert.ok(data.includes('No instruction files loaded.'));
  });

  test('/instructions displays loaded file paths and rendered instruction content', async () => {
    const dummyOrch = {
      getInstructionFiles: () => ['/workspace/AGENTS.md'],
      getCustomInstructions: () =>
        '## From /workspace/AGENTS.md\n\n- Always run tests before commit',
    };
    const out = new PassThrough();
    let data = '';
    out.on('data', (chunk) => {
      data += chunk.toString();
    });

    const res = await executeSlashCommand('/instructions', {
      orchestrator: dummyOrch,
      stream: out,
    });

    assert.equal(res.handled, true);
    assert.equal(res.action, 'instructions');
    assert.ok(data.includes('/workspace/AGENTS.md'));
    assert.ok(data.includes('Always run tests before commit'));
  });
});
