import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import {
  clearFileIndexCache,
  getWorkspaceFiles,
  searchWorkspaceFiles,
} from '../src/utils/file-index.js';

describe('file-index: workspace file indexing & search', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-fileindex-'));

  beforeEach(() => {
    clearFileIndexCache();
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('indexes workspace files while ignoring .git, node_modules, and binaries', () => {
    fs.mkdirSync(path.join(tmpDir, 'src', 'cli'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'foo'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.git', 'objects'), { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'src', 'index.js'), 'console.log(1);');
    fs.writeFileSync(path.join(tmpDir, 'src', 'cli', 'repl.js'), 'export function repl() {}');
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'foo', 'index.js'), 'module.exports = 1;');
    fs.writeFileSync(path.join(tmpDir, '.git', 'HEAD'), 'ref: refs/heads/main');
    fs.writeFileSync(path.join(tmpDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const files = getWorkspaceFiles(tmpDir);
    assert.ok(files.includes('src/index.js'));
    assert.ok(files.includes('src/cli/repl.js'));
    assert.ok(!files.some((f) => f.includes('node_modules')));
    assert.ok(!files.some((f) => f.includes('.git')));
    assert.ok(!files.some((f) => f.endsWith('.png')));
  });

  test('uses cache within TTL and clearFileIndexCache clears it', () => {
    fs.writeFileSync(path.join(tmpDir, 'test1.txt'), 'hello');
    const first = getWorkspaceFiles(tmpDir);
    assert.ok(first.includes('test1.txt'));

    // Create a new file without clearing cache
    fs.writeFileSync(path.join(tmpDir, 'test2.txt'), 'world');
    const cached = getWorkspaceFiles(tmpDir);
    assert.ok(!cached.includes('test2.txt'));

    // Clear cache
    clearFileIndexCache();
    const refreshed = getWorkspaceFiles(tmpDir);
    assert.ok(refreshed.includes('test2.txt'));
  });

  test('searchWorkspaceFiles returns scored matches with basename priority', () => {
    fs.mkdirSync(path.join(tmpDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'repl.js'), 'content');
    fs.writeFileSync(path.join(tmpDir, 'sub', 'fake-repl-utils.js'), 'content');
    clearFileIndexCache();

    const matches = searchWorkspaceFiles('repl', tmpDir);
    assert.ok(matches.length >= 2);
    // Exact basename match should rank first
    assert.equal(matches[0], 'repl.js');
  });
});
