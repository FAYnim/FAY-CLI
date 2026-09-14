/**
 * CI guard (roadmap #4): every empty catch block in src/ must carry a
 * `silent-ok` marker on the same line. New silent catches fail the suite.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const EMPTY_CATCH = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/;

function* walkJs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJs(full);
    else if (entry.name.endsWith('.js')) yield full;
  }
}

test('no unexplained silent catch blocks in src/', () => {
  const violations = [];
  for (const file of walkJs(SRC)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (EMPTY_CATCH.test(line) && !line.includes('silent-ok')) {
        violations.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(violations, [], `Found unexplained silent catches:\n${violations.join('\n')}`);
});
