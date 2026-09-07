import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { AgentOrchestrator } from '../src/agent/orchestrator.js';
import { SessionManager } from '../src/agent/session.js';
import { partitionToolCalls } from '../src/agent/tool-partitioner.js';
import { READ_ONLY_TOOLS } from '../src/tools/registry.js';

describe('Parallel Tools: Registry Definition', () => {
  test('should export READ_ONLY_TOOLS set containing safe idempotent tools', () => {
    assert.ok(READ_ONLY_TOOLS instanceof Set);
    assert.ok(READ_ONLY_TOOLS.has('read_file'));
    assert.ok(READ_ONLY_TOOLS.has('grep_file'));
    assert.ok(READ_ONLY_TOOLS.has('search_files'));
    assert.ok(READ_ONLY_TOOLS.has('list_dir'));
    assert.ok(READ_ONLY_TOOLS.has('git_status'));
    assert.ok(READ_ONLY_TOOLS.has('git_diff'));
    assert.ok(READ_ONLY_TOOLS.has('web_fetch'));

    // Mutating/interactive tools must NOT be in read-only set
    assert.equal(READ_ONLY_TOOLS.has('write_file'), false);
    assert.equal(READ_ONLY_TOOLS.has('patch_file'), false);
    assert.equal(READ_ONLY_TOOLS.has('execute_command'), false);
    assert.equal(READ_ONLY_TOOLS.has('git_add_commit'), false);
    assert.equal(READ_ONLY_TOOLS.has('web_search'), false);
  });
});

describe('Parallel Tools: Partitioner', () => {
  test('should return empty array for empty function calls', () => {
    const chunks = partitionToolCalls([], READ_ONLY_TOOLS);
    assert.deepEqual(chunks, []);
  });

  test('should partition consecutive read tools into a single parallel chunk', () => {
    const calls = [
      { name: 'read_file', args: { filePath: 'a.js' } },
      { name: 'grep_file', args: { query: 'test' } },
      { name: 'list_dir', args: { dirPath: '.' } },
    ];
    const chunks = partitionToolCalls(calls, READ_ONLY_TOOLS);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].type, 'parallel');
    assert.equal(chunks[0].calls.length, 3);
    assert.equal(chunks[0].calls[0].originalIndex, 0);
    assert.equal(chunks[0].calls[1].originalIndex, 1);
    assert.equal(chunks[0].calls[2].originalIndex, 2);
  });

  test('should partition mutating tools as separate sequential chunks', () => {
    const calls = [
      { name: 'write_file', args: { filePath: 'a.js', content: 'x' } },
      { name: 'execute_command', args: { command: 'ls' } },
    ];
    const chunks = partitionToolCalls(calls, READ_ONLY_TOOLS);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].type, 'sequential');
    assert.equal(chunks[0].call.name, 'write_file');
    assert.equal(chunks[0].call.originalIndex, 0);
    assert.equal(chunks[1].type, 'sequential');
    assert.equal(chunks[1].call.name, 'execute_command');
    assert.equal(chunks[1].call.originalIndex, 1);
  });

  test('should correctly interleave parallel and sequential chunks', () => {
    const calls = [
      { name: 'read_file', args: { filePath: 'a.js' } },
      { name: 'grep_file', args: { query: 'foo' } },
      { name: 'patch_file', args: { filePath: 'a.js' } },
      { name: 'search_files', args: { pattern: '*.js' } },
    ];
    const chunks = partitionToolCalls(calls, READ_ONLY_TOOLS);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].type, 'parallel');
    assert.equal(chunks[0].calls.length, 2);
    assert.equal(chunks[1].type, 'sequential');
    assert.equal(chunks[1].call.name, 'patch_file');
    assert.equal(chunks[2].type, 'parallel');
    assert.equal(chunks[2].calls.length, 1);
  });
});

describe('Parallel Tools: Orchestrator Integration', () => {
  let tempDir;
  let sessionManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faycli-parallel-test-'));
    sessionManager = new SessionManager({ sessionsDir: tempDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  test('should execute multiple read_file calls concurrently and preserve message order', async () => {
    const fileA = path.join(tempDir, 'a.txt');
    const fileB = path.join(tempDir, 'b.txt');
    fs.writeFileSync(fileA, 'Content A', 'utf8');
    fs.writeFileSync(fileB, 'Content B', 'utf8');

    let turn = 0;
    const mockLlm = {
      getModel: () => 'gemini-2.5-flash',
      generateStream: async () => {
        turn++;
        if (turn === 1) {
          return {
            text: '',
            functionCalls: [
              { name: 'read_file', args: { filePath: 'a.txt' } },
              { name: 'read_file', args: { filePath: 'b.txt' } },
            ],
            finishReason: 'TOOL_CALL',
          };
        }
        return {
          text: 'Both files read successfully.',
          functionCalls: [],
          finishReason: 'STOP',
        };
      },
    };

    const session = sessionManager.createSession({ workingDir: tempDir });
    const orchestrator = new AgentOrchestrator({
      llmClient: mockLlm,
      session,
      workingDir: tempDir,
    });

    const batchEvents = [];
    const result = await orchestrator.runTurn('Baca kedua file', {
      onBatchStart: (info) => batchEvents.push(info),
    });

    assert.equal(result.success, true);
    assert.equal(batchEvents.length, 1);
    assert.equal(batchEvents[0].parallel, true);
    assert.equal(batchEvents[0].total, 2);

    // Verify session function response order matches original calls
    const messages = session.getMessages();
    const funcResponses = messages.filter((m) => m.role === 'function');
    assert.equal(funcResponses.length, 2);
    assert.equal(funcResponses[0].parts[0].functionResponse.name, 'read_file');
    assert.equal(funcResponses[0].parts[0].functionResponse.response.content, 'Content A');
    assert.equal(funcResponses[1].parts[0].functionResponse.name, 'read_file');
    assert.equal(funcResponses[1].parts[0].functionResponse.response.content, 'Content B');
  });

  test('should handle independent error in parallel batch without aborting sibling tools', async () => {
    const fileA = path.join(tempDir, 'exists.txt');
    fs.writeFileSync(fileA, 'Existing content', 'utf8');

    let turn = 0;
    const mockLlm = {
      getModel: () => 'gemini-2.5-flash',
      generateStream: async () => {
        turn++;
        if (turn === 1) {
          return {
            text: '',
            functionCalls: [
              { name: 'read_file', args: { filePath: 'non_existent.txt' } },
              { name: 'read_file', args: { filePath: 'exists.txt' } },
            ],
            finishReason: 'TOOL_CALL',
          };
        }
        return {
          text: 'Handled error gracefully.',
          functionCalls: [],
          finishReason: 'STOP',
        };
      },
    };

    const session = sessionManager.createSession({ workingDir: tempDir });
    const orchestrator = new AgentOrchestrator({
      llmClient: mockLlm,
      session,
      workingDir: tempDir,
    });

    const result = await orchestrator.runTurn('Coba baca file', {});
    assert.equal(result.success, true);

    const messages = session.getMessages();
    const funcResponses = messages.filter((m) => m.role === 'function');
    assert.equal(funcResponses.length, 2);

    // First tool failed
    assert.equal(funcResponses[0].parts[0].functionResponse.response.error, true);
    // Second tool succeeded
    assert.equal(funcResponses[1].parts[0].functionResponse.response.content, 'Existing content');
  });
});

