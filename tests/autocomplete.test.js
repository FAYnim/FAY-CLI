/**
 * Unit Tests: Autocomplete suggestion logic (pure)
 * Feature: slash-command + @file autocomplete
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { getSuggestions, listCommandNames } from '../src/cli/autocomplete.js';

describe('autocomplete: command suggestions', () => {
  test('slash at position 0 returns command list', () => {
    const s = getSuggestions('/', 1, {});
    assert.equal(s.kind, 'command');
    assert.ok(s.items.some((i) => i.value === '/help'));
    assert.ok(s.items.some((i) => i.value === '/provider'));
    assert.equal(s.replaceStart, 0);
    assert.equal(s.replaceEnd, 1);
  });

  test('prefix filter is case-insensitive', () => {
    const s = getSuggestions('/PRO', 4, {});
    assert.equal(s.kind, 'command');
    assert.deepEqual(
      s.items.map((i) => i.value),
      ['/provider'],
    );
  });

  test('no match returns empty items (still a trigger)', () => {
    const s = getSuggestions('/zzz', 4, {});
    assert.equal(s.kind, 'command');
    assert.deepEqual(s.items, []);
  });

  test('slash mid-word is not a trigger', () => {
    assert.equal(getSuggestions('a/b', 3, {}), null);
  });

  test('space after command ends command mode', () => {
    assert.equal(getSuggestions('/help ', 6, {}), null);
  });

  test('listCommandNames derives unique sorted names from help table', () => {
    const names = listCommandNames();
    assert.ok(names.includes('help'));
    assert.ok(names.includes('exit'));
    assert.ok(names.includes('quit'));
    assert.ok(names.includes('provider'));
    assert.ok(!names.some((n) => n.includes(' ')));
    assert.deepEqual(names, [...names].sort());
  });
});

// ── File-suggestion fixtures ─────────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-ac-'));
fs.mkdirSync(path.join(tmpRoot, 'src', 'cli'), { recursive: true });
fs.mkdirSync(path.join(tmpRoot, 'node_modules'), { recursive: true });
fs.mkdirSync(path.join(tmpRoot, '.git'), { recursive: true });
fs.writeFileSync(path.join(tmpRoot, 'README.md'), 'x');
fs.writeFileSync(path.join(tmpRoot, '.hidden'), 'x');
fs.writeFileSync(path.join(tmpRoot, 'src', 'index.js'), 'x');
fs.writeFileSync(path.join(tmpRoot, 'src', 'cli', 'repl.js'), 'x');
fs.writeFileSync(path.join(tmpRoot, 'node_modules', 'dep.js'), 'x');

after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const fileCtx = { workingDir: tmpRoot };

describe('autocomplete: file suggestions', () => {
  test('@ at start of empty token lists working dir', () => {
    const s = getSuggestions('@', 1, fileCtx);
    assert.equal(s.kind, 'file');
    const labels = s.items.map((i) => i.label);
    assert.ok(labels.includes('README.md'));
    assert.ok(labels.includes('src/'));
    assert.ok(!labels.includes('node_modules'));
    assert.ok(!labels.includes('.hidden'));
    assert.ok(!labels.includes('.git'));
    assert.equal(s.replaceStart, 0);
    assert.equal(s.replaceEnd, 1);
    assert.equal(s.dir, '');
  });

  test('@ after space triggers; email@host does not', () => {
    const s = getSuggestions('lihat @RE', 7, fileCtx);
    assert.equal(s.kind, 'file');
    assert.ok(s.items.some((i) => i.value === '@README.md'));
    assert.ok(s.items.some((i) => i.value === '@src/cli/repl.js'));
    assert.equal(s.replaceStart, 6);
    assert.equal(s.replaceEnd, 9);
    assert.equal(getSuggestions('email@host', 10, fileCtx), null);
  });


  test('trailing slash drills into directory', () => {
    const s = getSuggestions('@src/', 5, fileCtx);
    assert.equal(s.kind, 'file');
    assert.deepEqual(
      s.items.map((i) => i.label),
      ['cli/', 'index.js'],
    );
    assert.equal(s.dir, 'src');
  });

  test('partial segment filters by prefix, dirs first', () => {
    const s = getSuggestions('@src/c', 6, fileCtx);
    assert.deepEqual(
      s.items.map((i) => i.value),
      ['@src/cli/'],
    );
  });

  test('nonexistent path yields empty items, no throw', () => {
    const s = getSuggestions('@no/such/xyz', 12, fileCtx);
    assert.equal(s.kind, 'file');
    assert.deepEqual(s.items, []);
  });

  test('cursor past token end (whitespace follows) is not a trigger', () => {
    assert.equal(getSuggestions('@README.md ', 11, fileCtx), null);
  });

  test('@ with no slash triggers global workspace search', () => {
    const s = getSuggestions('@index', 6, fileCtx);
    assert.equal(s.kind, 'file');
    assert.ok(s.items.some((i) => i.value === '@src/index.js'));
    assert.equal(s.dir, '');
  });

  test('@ with empty query returns top workspace files', () => {
    const s = getSuggestions('@', 1, fileCtx);
    assert.equal(s.kind, 'file');
    assert.ok(s.items.some((i) => i.value === '@README.md'));
  });
});

