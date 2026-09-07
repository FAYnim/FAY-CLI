import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
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
