/**
 * Unit & Integration Tests: Session Management & Interactive Switching
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Session } from '../src/agent/session.js';

describe('Session: Title & Auto-Titling', () => {
  test('initializes with null title or provided title', () => {
    const s1 = new Session();
    assert.equal(s1.title, null);

    const s2 = new Session({ title: 'Refactor Auth' });
    assert.equal(s2.title, 'Refactor Auth');
    assert.equal(s2.toJSON().title, 'Refactor Auth');
  });

  test('setTitle updates title and timestamps', () => {
    const s = new Session();
    const oldUpdated = s.updatedAt;
    s.setTitle('New Title');
    assert.equal(s.title, 'New Title');
    assert.equal(s.toJSON().title, 'New Title');
    assert.ok(s.updatedAt >= oldUpdated);
  });

  test('ensureTitle creates clean truncated title from first prompt', () => {
    const s = new Session();
    s.ensureTitle('Fix login authentication issue when redirecting from Google OAuth');
    assert.ok(s.title);
    assert.ok(s.title.length <= 50);
    assert.match(s.title, /^Fix login authentication/);

    // Does not overwrite existing title
    s.ensureTitle('Different prompt text');
    assert.match(s.title, /^Fix login authentication/);
  });

  test('ensureTitle sanitizes newlines and markdown characters', () => {
    const s = new Session();
    s.ensureTitle('```javascript\nconst x = 1;\n```\nHow do I test this function?');
    assert.ok(!s.title.includes('\n'));
    assert.ok(!s.title.includes('```'));
  });

  test('addUserMessage automatically calls ensureTitle when title is null', () => {
    const s = new Session();
    assert.equal(s.title, null);
    s.addUserMessage('Optimize database query performance for large datasets');
    assert.ok(s.title);
    assert.match(s.title, /^Optimize database query/);
  });
});
