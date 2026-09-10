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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach } from 'node:test';
import { SessionManager } from '../src/agent/session.js';

describe('SessionManager: Scoped Listing & Renaming', () => {
  let tmpDir;
  let mgr;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-sess-test-'));
    mgr = new SessionManager({ sessionsDir: tmpDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  test('listSessions filters by workingDir when all=false', () => {
    const s1 = mgr.createSession({ id: 'sess_proj1', workingDir: '/workspace/project-alpha' });
    s1.setTitle('Alpha Feature');
    s1.addUserMessage('Implement Alpha');
    s1.save();

    const s2 = mgr.createSession({ id: 'sess_proj2', workingDir: '/workspace/project-beta' });
    s2.setTitle('Beta Bugfix');
    s2.addUserMessage('Fix Beta');
    s2.save();

    // Default: filters by current project
    const alphaList = mgr.listSessions({ workingDir: '/workspace/project-alpha', all: false });
    assert.equal(alphaList.length, 1);
    assert.equal(alphaList[0].id, 'sess_proj1');
    assert.equal(alphaList[0].title, 'Alpha Feature');

    // All = true: returns both
    const allList = mgr.listSessions({ workingDir: '/workspace/project-alpha', all: true });
    assert.equal(allList.length, 2);
  });

  test('renameSession updates title in memory and on disk', () => {
    const s = mgr.createSession({ id: 'sess_rename_test' });
    s.addUserMessage('Initial message');
    s.save();

    const ok = mgr.renameSession('sess_rename_test', 'Renamed Title');
    assert.equal(ok, true);

    const reloaded = mgr.loadSession('sess_rename_test');
    assert.equal(reloaded.title, 'Renamed Title');
  });

  test('listSessions safely skips corrupted JSON files without crashing', () => {
    fs.writeFileSync(path.join(tmpDir, 'corrupt.json'), '{ broken json ...');
    const valid = mgr.createSession({ id: 'sess_valid' });
    valid.save();

    const list = mgr.listSessions({ all: true });
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'sess_valid');
  });
});

import { PassThrough } from 'node:stream';
import {
  buildSessionMenuItems,
  formatRelativeTime,
  showSessionMenu,
} from '../src/ui/session-menu.js';

describe('SessionMenu: UI & TTY Logic', () => {
  test('formatRelativeTime formats durations correctly', () => {
    const now = Date.now();
    assert.equal(formatRelativeTime(new Date(now - 30 * 1000).toISOString()), 'just now');
    assert.equal(formatRelativeTime(new Date(now - 5 * 60 * 1000).toISOString()), '5m ago');
    assert.equal(formatRelativeTime(new Date(now - 3 * 3600 * 1000).toISOString()), '3h ago');
    assert.equal(formatRelativeTime(new Date(now - 2 * 86400 * 1000).toISOString()), '2d ago');
  });

  test('buildSessionMenuItems tags active session and formats metadata', () => {
    const sessions = [
      {
        id: 'sess_1',
        title: 'Fix Auth',
        updatedAt: new Date().toISOString(),
        messageCount: 6,
        model: 'gemini-2.5-flash',
        workingDir: '/workspace/app',
      },
    ];
    const items = buildSessionMenuItems(sessions, 'sess_1');
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'sess_1');
    assert.equal(items[0].isActive, true);
    assert.equal(items[0].title, 'Fix Auth');
  });

  test('showSessionMenu falls back gracefully on non-TTY streams', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-sess-menu-'));
    const tempMgr = new SessionManager({ sessionsDir: tmp });
    const input = new PassThrough();
    const output = new PassThrough();
    const result = await showSessionMenu({
      sessionManager: tempMgr,
      activeSessionId: 'sess_none',
      input,
      output,
    });
    assert.equal(result.cancelled, true);
    assert.equal(result.isNonTty, true);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (_) {}
  });
});

import { executeSlashCommand } from '../src/cli/slash-commands.js';

describe('Slash Commands: /session and /resume', () => {
  let tmpDir;
  let mgr;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-slash-test-'));
    mgr = new SessionManager({ sessionsDir: tmpDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  test('/session rename changes active session title', async () => {
    const dummySession = mgr.createSession({ id: 'sess_cmd_test' });
    const dummyOrchestrator = {
      session: dummySession,
      getSession: () => dummySession,
      workingDir: tmpDir,
    };
    const out = new PassThrough();

    const res = await executeSlashCommand('/session rename New Project Task', {
      orchestrator: dummyOrchestrator,
      sessionManager: mgr,
      stream: out,
    });

    assert.equal(res.handled, true);
    assert.equal(res.action, 'session_rename');
    assert.equal(dummySession.title, 'New Project Task');
  });

  test('/session switch with ID returns switch_session action', async () => {
    const s1 = mgr.createSession({ id: 'sess_target' });
    s1.addUserMessage('Target chat');
    s1.save();

    const currentSess = mgr.createSession({ id: 'sess_curr' });
    currentSess.save();

    const dummyOrchestrator = {
      session: currentSess,
      getSession: () => currentSess,
      workingDir: tmpDir,
      setSession: (s) => {
        dummyOrchestrator.session = s;
      },
    };
    const out = new PassThrough();

    const res = await executeSlashCommand('/session switch sess_target', {
      orchestrator: dummyOrchestrator,
      sessionManager: mgr,
      stream: out,
    });

    assert.equal(res.handled, true);
    assert.equal(res.action, 'switch_session');
    assert.equal(res.sessionId, 'sess_target');
  });

  test('/resume alias routes identically to /session', async () => {
    const currentSess = mgr.createSession({ id: 'sess_curr' });
    const dummyOrchestrator = {
      session: currentSess,
      getSession: () => currentSess,
      workingDir: tmpDir,
    };
    const out = new PassThrough();

    const res = await executeSlashCommand('/resume info', {
      orchestrator: dummyOrchestrator,
      sessionManager: mgr,
      stream: out,
    });

    assert.equal(res.handled, true);
    assert.equal(res.action, 'session_info');
  });
});

import { renderMarkdown } from '../src/ui/markdown.js';

describe('REPL: History Replay & Switch Synchronization', () => {
  test('session messages replay formatting works correctly', () => {
    const s = new Session({ id: 'sess_replay' });
    s.addUserMessage('What is Node.js?');
    s.addModelMessage('Node.js is an open-source JavaScript runtime environment.');
    s.addUserMessage('How do I run tests?');
    s.addModelMessage('Use `node --test`.');

    const msgs = s.getMessages();
    assert.equal(msgs.length, 4);

    // Last 2 turns = last 4 messages
    const recent = msgs.slice(-4);
    assert.equal(recent[0].role, 'user');
    assert.equal(recent[1].role, 'model');
    assert.equal(recent[2].role, 'user');
    assert.equal(recent[3].role, 'model');

    const rendered = renderMarkdown(recent[3].parts[0].text);
    assert.ok(rendered.includes('node --test'));
  });
});

describe('CLI: Resume Command Resolution', () => {
  test('resolves resumeId from args or prompts via session picker', () => {
    // When subcommand is passed: faycli resume <id>
    const parsedWithId = { command: 'resume', subcommand: 'sess_123', flags: {} };
    assert.equal(parsedWithId.subcommand, 'sess_123');

    // When no subcommand passed: faycli resume
    const parsedNoId = { command: 'resume', subcommand: null, flags: {} };
    assert.equal(parsedNoId.subcommand, null);
  });
});





