import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { expandMentions, parseMentions } from '../src/agent/mention-parser.js';

describe('mention-parser: file extraction and prompt expansion', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-mention-'));
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'const app = 42;\nexport default app;');
  fs.writeFileSync(path.join(tmpDir, 'bin.dat'), Buffer.from([0x00, 0xff, 0x00, 0xff]));

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('parseMentions extracts @file tokens and ignores emails', () => {
    const text = 'Check @src/app.js and email support@example.com or @README.md';
    const mentions = parseMentions(text);
    assert.deepEqual(mentions, ['src/app.js', 'README.md']);
  });

  test('expandMentions injects existing file contents in XML block and preserves clean prompt', () => {
    const text = 'Please review @src/app.js for bugs';
    const result = expandMentions(text, { workingDir: tmpDir });
    assert.equal(result.cleanPrompt, text);
    assert.ok(result.injectedPrompt.includes('<context_file path="src/app.js">'));
    assert.ok(result.injectedPrompt.includes('const app = 42;'));
    assert.deepEqual(result.attachedFiles, ['src/app.js']);
  });

  test('expandMentions skips binary files safely with notification', () => {
    const text = 'Look at @bin.dat';
    const result = expandMentions(text, { workingDir: tmpDir });
    assert.ok(result.injectedPrompt.includes('[Binary file omitted]'));
  });

  test('expandMentions truncates files exceeding max size limit', () => {
    const largeFile = path.join(tmpDir, 'large.txt');
    const content = 'a'.repeat(60 * 1024); // 60 KB
    fs.writeFileSync(largeFile, content);

    const result = expandMentions('Read @large.txt', { workingDir: tmpDir, maxFileSizeBytes: 50 * 1024 });
    assert.ok(result.injectedPrompt.includes('[... content truncated: exceeds 50KB limit]'));
  });

  test('leaves non-existent mentions intact without injecting block', () => {
    const text = 'Missing @does-not-exist.js';
    const result = expandMentions(text, { workingDir: tmpDir });
    assert.equal(result.injectedPrompt, text);
    assert.equal(result.attachedFiles.length, 0);
  });
});
