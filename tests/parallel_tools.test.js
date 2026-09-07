import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
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
