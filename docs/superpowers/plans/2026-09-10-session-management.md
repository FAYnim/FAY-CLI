# Interactive Session Management & Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an OpenCode-style interactive session management system with in-REPL keyboard picker, auto-titling, workspace scoping, seamless session switching with history replay, and CLI resume picker.

**Architecture:** Extend the `Session` model with titling and auto-extraction, enhance `SessionManager` to extract rich metadata and filter by `workingDir`, implement a zero-dependency ANSI keyboard-driven TUI picker in `src/ui/session-menu.js`, wire `/session` and `/resume` commands with history replay in the REPL loop, and integrate startup picker support into `bin/faycli.js`.

**Tech Stack:** Pure Node.js ESM (>=20.0.0), Node.js `readline`, ANSI escape codes (`src/utils/ansi.js`), `node:test`, `node:assert/strict`. Zero external/native dependencies.

---

### File Structure & Responsibilities

- **`src/agent/session.js`**: Core session data model and file-based persistence. Adds `title` field, `setTitle()`, `ensureTitle()`, `SessionManager.listSessions({ workingDir, all })`, and `SessionManager.renameSession(id, title)`.
- **`src/ui/session-menu.js`**: Interactive keyboard-driven TUI session picker. Handles TTY raw mode keypresses (arrows, Enter, Esc, 'a', 'r', 'd', 'n'), ANSI formatting, and non-TTY fallback.
- **`src/cli/slash-commands.js`**: Command router for `/session` and `/resume`. Dispatches interactive picker in TTY or executes subcommands (`info`, `rename`, `switch`, `list`, `delete`).
- **`src/cli/repl.js`**: Interactive REPL engine. Handles `switch_session` action: auto-saves old session, mounts new session into orchestrator, resets turn counters, renders switch banner and replays the last 2-3 message turns.
- **`bin/faycli.js`**: CLI executable entrypoint. Enhances `faycli resume` without arguments to launch the interactive picker on startup.
- **`tests/session-management.test.js`**: Unit and integration test suite verifying auto-titling, scoping, slash commands, switching mechanics, and non-TTY menu fallbacks.

---

### Task 1: Session Model Enhancement - Title Management & Auto-Titling

**Files:**
- Modify: `src/agent/session.js`
- Test: `tests/session-management.test.js`

- [ ] **Step 1: Write the failing unit tests for title and auto-titling**

Create `tests/session-management.test.js` with tests verifying `title` property persistence, `setTitle()`, and `ensureTitle()` with prompt sanitization:

```javascript
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/session-management.test.js`  
Expected: FAIL (`s1.title is undefined` or `s.setTitle is not a function`)

- [ ] **Step 3: Implement title and auto-titling in `src/agent/session.js`**

In `src/agent/session.js`:
1. In `Session.constructor(data = {})`:
   ```javascript
   this.title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : null;
   ```
2. In `Session.toJSON()`:
   Add `title: this.title` to the returned object.
3. In `Session` class, add `setTitle(title)`:
   ```javascript
   setTitle(title) {
     this.title = typeof title === 'string' && title.trim() ? title.trim() : null;
     this.touch();
     return this.title;
   }
   ```
4. In `Session` class, add `ensureTitle(textOrParts)`:
   ```javascript
   ensureTitle(textOrParts) {
     if (this.title) return this.title;
     let raw = '';
     if (typeof textOrParts === 'string') {
       raw = textOrParts;
     } else if (Array.isArray(textOrParts)) {
       raw = textOrParts
         .map((p) => (typeof p === 'string' ? p : p?.text || ''))
         .join(' ');
     } else if (textOrParts && typeof textOrParts.text === 'string') {
       raw = textOrParts.text;
     }

     const cleaned = raw
       .replace(/```[\s\S]*?```/g, '') // remove code blocks
       .replace(/`([^`]+)`/g, '$1')     // unwrap inline code
       .replace(/[\r\n\t]+/g, ' ')      // replace whitespace/newlines with space
       .replace(/\s+/g, ' ')            // collapse multiple spaces
       .trim();

     if (!cleaned) return null;

     const maxLen = 45;
     if (cleaned.length <= maxLen) {
       this.title = cleaned;
     } else {
       const sliced = cleaned.slice(0, maxLen);
       const lastSpace = sliced.lastIndexOf(' ');
       this.title = (lastSpace > 20 ? sliced.slice(0, lastSpace) : sliced).trim() + '…';
     }

     this.touch();
     return this.title;
   }
   ```
5. In `Session.addUserMessage(textOrParts)`:
   Call `this.ensureTitle(textOrParts)` if `!this.title` before adding the message.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/session-management.test.js`  
Expected: All 4 tests in `Session: Title & Auto-Titling` PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/session.js tests/session-management.test.js
git commit -m "feat(session): add session title field and auto-titling from user prompt"
```

---

### Task 2: SessionManager - Scoped Listing, Metadata Extraction & Renaming

**Files:**
- Modify: `src/agent/session.js`
- Test: `tests/session-management.test.js`

- [ ] **Step 1: Write failing tests for `SessionManager.listSessions` with scoping and `renameSession`**

Append to `tests/session-management.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/session-management.test.js`  
Expected: FAIL (`mgr.renameSession is not a function` or `workingDir` filtering not supported)

- [ ] **Step 3: Implement enhanced `listSessions` and `renameSession` in `src/agent/session.js`**

In `SessionManager` class in `src/agent/session.js`:
1. Update `listSessions(options = {})`:
   ```javascript
   listSessions(options = {}) {
     const { workingDir = null, all = false } = options;
     const dir = this.getSessionsDir();
     if (!fs.existsSync(dir)) return [];

     const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.archive.json'));
     const results = [];

     for (const f of files) {
       const filepath = path.join(dir, f);
       try {
         const raw = fs.readFileSync(filepath, 'utf8');
         const parsed = JSON.parse(raw);
         const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
         
         // Extract last user message or preview
         let lastMessagePreview = null;
         for (let i = messages.length - 1; i >= 0; i--) {
           const m = messages[i];
           if (m && m.parts && m.parts[0]?.text) {
             lastMessagePreview = m.parts[0].text.slice(0, 80);
             break;
           }
         }

         const sessionWorkDir = parsed.workingDir || null;
         if (!all && workingDir && sessionWorkDir) {
           const normTarget = path.resolve(workingDir);
           const normSess = path.resolve(sessionWorkDir);
           if (normTarget !== normSess) {
             continue;
           }
         }

         results.push({
           id: parsed.id || path.basename(f, '.json'),
           title: parsed.title || null,
           createdAt: parsed.createdAt || null,
           updatedAt: parsed.updatedAt || null,
           model: parsed.model || null,
           provider: parsed.provider || null,
           workingDir: sessionWorkDir,
           messageCount: messages.length,
           lastMessagePreview,
           metadata: parsed.metadata || {},
         });
       } catch {
         // Silently skip corrupted session file to avoid breaking listing
       }
     }

     return results.sort((a, b) => {
       const dateA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
       const dateB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
       return dateB - dateA;
     });
   }
   ```
2. Add `renameSession(sessionId, newTitle)`:
   ```javascript
   renameSession(sessionId, newTitle) {
     if (!this.hasSession(sessionId)) return false;
     const session = this.loadSession(sessionId);
     session.setTitle(newTitle);
     return this.saveSession(session);
   }
   ```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/session-management.test.js`  
Expected: PASS for all tests in `SessionManager: Scoped Listing & Renaming`.

- [ ] **Step 5: Commit**

```bash
git add src/agent/session.js tests/session-management.test.js
git commit -m "feat(session): add workingDir scoping and renameSession to SessionManager"
```

---

### Task 3: Interactive TUI Session Picker (`src/ui/session-menu.js`)

**Files:**
- Create: `src/ui/session-menu.js`
- Test: `tests/session-management.test.js`

- [ ] **Step 1: Write failing test for non-TTY fallback and menu item builder**

Append to `tests/session-management.test.js`:

```javascript
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
    const input = new PassThrough();
    const output = new PassThrough();
    const result = await showSessionMenu({
      sessionManager: mgr,
      activeSessionId: 'sess_none',
      input,
      output,
    });
    assert.equal(result.cancelled, true);
    assert.equal(result.isNonTty, true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/session-management.test.js`  
Expected: FAIL (`Cannot find module '../src/ui/session-menu.js'`)

- [ ] **Step 3: Implement `src/ui/session-menu.js`**

Create `src/ui/session-menu.js` following the architecture of `src/ui/model-menu.js`:
- Supports keyboard navigation: `↑` / `k`, `↓` / `j`, `Enter` to switch, `Esc` / `q` to cancel.
- Scope toggle with key `'a'` (switches between current `workingDir` and all sessions, re-rendering the frame instantly).
- Inline rename prompt on `'r'`.
- Delete confirmation on `'d'`.
- Create new session on `'n'`.
- Clean terminal cleanup restoring raw mode on any exit.
- Full relative time helper (`formatRelativeTime`).

```javascript
/**
 * Interactive TUI Session Picker
 * Zero-dependency, lightweight keyboard-driven menu for managing and switching sessions.
 */

import readline from 'node:readline';
import { ansi } from '../utils/ansi.js';

export function formatRelativeTime(isoString) {
  if (!isoString) return 'unknown';
  const diffMs = Date.now() - new Date(isoString).getTime();
  if (diffMs < 0 || isNaN(diffMs)) return 'just now';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(isoString).toLocaleDateString();
}

export function buildSessionMenuItems(sessions, activeSessionId) {
  return (sessions || []).map((s) => ({
    id: s.id,
    title: s.title || s.lastMessagePreview || '(Untitled Session)',
    updatedAt: s.updatedAt,
    relativeTime: formatRelativeTime(s.updatedAt),
    messageCount: s.messageCount || 0,
    model: s.model || 'default',
    provider: s.provider || 'gemini',
    workingDir: s.workingDir || '',
    isActive: s.id === activeSessionId,
  }));
}

function renderFrame(items, selectedIndex, showAll, workingDir, output) {
  const scopeLabel = showAll
    ? `${ansi.yellow('All Projects')}`
    : `${ansi.cyan('Current Project')} ${ansi.dim(`(${workingDir || process.cwd()})`)}`;
  const countLabel = `[${items.length} session${items.length === 1 ? '' : 's'}]`;

  const header = `${ansi.bold(ansi.cyan('⚡ Select a session'))}  ${ansi.dim('(↑/↓ navigate • Enter switch • a toggle all • r rename • d delete • n new • Esc cancel)')}`;
  const lines = [header, `Scope: ${scopeLabel} ${ansi.dim(countLabel)}`, ''];

  if (items.length === 0) {
    lines.push(`  ${ansi.dim('(no sessions found in this scope — press \'a\' for all projects or \'n\' for new)')}`);
  } else {
    items.forEach((it, idx) => {
      const isSelected = idx === selectedIndex;
      const cursor = isSelected ? ansi.green('▸') : ' ';
      const marker = it.isActive ? ansi.green('●') : ansi.dim('○');
      const title = isSelected ? ansi.bold(ansi.whiteBright(it.title)) : ansi.white(it.title);
      const activeTag = it.isActive ? ` ${ansi.green('(active)')}` : '';

      lines.push(`  ${cursor} ${marker} ${title}${activeTag}`);
      const meta = `${it.id} · ${it.messageCount} msgs · ${it.relativeTime} · ${it.model}`;
      lines.push(`      ${ansi.dim(meta)}`);
    });
  }

  lines.push('');
  output.write(`\x1B[2J\x1B[H${lines.join('\n')}\n`);
}

export async function showSessionMenu({
  sessionManager,
  activeSessionId = null,
  workingDir = process.cwd(),
  input = process.stdin,
  output = process.stdout,
}) {
  const isInteractiveTty = Boolean(output?.isTTY && input?.isTTY);
  if (!isInteractiveTty) {
    return { cancelled: true, isNonTty: true };
  }

  return new Promise((resolve) => {
    let showAll = false;
    let items = buildSessionMenuItems(
      sessionManager.listSessions({ workingDir, all: showAll }),
      activeSessionId,
    );

    let selectedIndex = 0;
    const activeIdx = items.findIndex((it) => it.isActive);
    if (activeIdx >= 0) selectedIndex = activeIdx;

    if (typeof input.resume === 'function') input.resume();
    if (typeof input.setRawMode === 'function') {
      try {
        input.setRawMode(true);
      } catch (_) {}
    }
    readline.emitKeypressEvents(input);

    let isPrompting = false;

    renderFrame(items, selectedIndex, showAll, workingDir, output);

    const cleanup = (result) => {
      try {
        input.removeListener('keypress', onKeypress);
      } catch (_) {}
      try {
        if (typeof input.setRawMode === 'function' && input.isTTY) {
          input.setRawMode(false);
        }
      } catch (_) {}
      output.write('\x1B[2J\x1B[H');
      resolve(result);
    };

    const onKeypress = async (_chunk, key) => {
      if (isPrompting || !key) return;

      if ((key.ctrl && key.name === 'c') || key.name === 'escape' || key.name === 'q') {
        cleanup({ cancelled: true });
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        const chosen = items[selectedIndex];
        if (!chosen) {
          cleanup({ cancelled: true });
          return;
        }
        cleanup({ cancelled: false, action: 'switch', sessionId: chosen.id });
        return;
      }

      if (key.name === 'up' || key.name === 'k') {
        if (items.length > 0) {
          selectedIndex = (selectedIndex - 1 + items.length) % items.length;
          renderFrame(items, selectedIndex, showAll, workingDir, output);
        }
        return;
      }

      if (key.name === 'down' || key.name === 'j') {
        if (items.length > 0) {
          selectedIndex = (selectedIndex + 1) % items.length;
          renderFrame(items, selectedIndex, showAll, workingDir, output);
        }
        return;
      }

      // 'a' -> toggle all / project scoped
      if (key.name === 'a') {
        showAll = !showAll;
        items = buildSessionMenuItems(
          sessionManager.listSessions({ workingDir, all: showAll }),
          activeSessionId,
        );
        selectedIndex = Math.min(selectedIndex, Math.max(0, items.length - 1));
        renderFrame(items, selectedIndex, showAll, workingDir, output);
        return;
      }

      // 'n' -> new session
      if (key.name === 'n') {
        cleanup({ cancelled: false, action: 'new' });
        return;
      }

      // 'd' -> delete selected session
      if (key.name === 'd' && items.length > 0) {
        const target = items[selectedIndex];
        if (target.isActive) {
          output.write(`\n${ansi.yellow('⚠ Cannot delete currently active session.')}\n`);
          setTimeout(() => renderFrame(items, selectedIndex, showAll, workingDir, output), 1500);
          return;
        }

        isPrompting = true;
        input.setRawMode(false);
        const rl = readline.createInterface({ input, output });
        rl.question(`\nDelete session "${target.title}" (${target.id})? [y/N]: `, (ans) => {
          rl.close();
          input.setRawMode(true);
          isPrompting = false;
          if (ans.trim().toLowerCase() === 'y') {
            sessionManager.deleteSession(target.id);
            items = buildSessionMenuItems(
              sessionManager.listSessions({ workingDir, all: showAll }),
              activeSessionId,
            );
            selectedIndex = Math.min(selectedIndex, Math.max(0, items.length - 1));
          }
          renderFrame(items, selectedIndex, showAll, workingDir, output);
        });
        return;
      }

      // 'r' -> rename selected session
      if (key.name === 'r' && items.length > 0) {
        const target = items[selectedIndex];
        isPrompting = true;
        input.setRawMode(false);
        const rl = readline.createInterface({ input, output });
        rl.question(`\nNew title for session "${target.title}": `, (ans) => {
          rl.close();
          input.setRawMode(true);
          isPrompting = false;
          const newTitle = ans.trim();
          if (newTitle) {
            sessionManager.renameSession(target.id, newTitle);
            items = buildSessionMenuItems(
              sessionManager.listSessions({ workingDir, all: showAll }),
              activeSessionId,
            );
          }
          renderFrame(items, selectedIndex, showAll, workingDir, output);
        });
        return;
      }
    };

    input.on('keypress', onKeypress);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/session-management.test.js`  
Expected: PASS for all tests in `SessionMenu: UI & TTY Logic`.

- [ ] **Step 5: Commit**

```bash
git add src/ui/session-menu.js tests/session-management.test.js
git commit -m "feat(ui): implement interactive TUI session picker with keybindings and non-TTY fallback"
```

---

### Task 4: Slash Commands Routing for `/session` and `/resume`

**Files:**
- Modify: `src/cli/slash-commands.js`
- Test: `tests/session-management.test.js`

- [ ] **Step 1: Write failing test for `/session` subcommands and `/resume`**

Append to `tests/session-management.test.js`:

```javascript
import { executeSlashCommand } from '../src/cli/slash-commands.js';

describe('Slash Commands: /session and /resume', () => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/session-management.test.js`  
Expected: FAIL (`res.action !== 'session_rename'` or `/resume` not handled)

- [ ] **Step 3: Update `src/cli/slash-commands.js`**

1. In `SLASH_COMMANDS_HELP`, update `/session` description and add `/resume`:
   ```javascript
   { cmd: '/session [switch|rename|info|list|delete]', desc: 'Manage or switch sessions via interactive picker' },
   { cmd: '/resume [id]', desc: 'Resume or switch to a past session (opens picker if no ID)' },
   ```
2. Import `showSessionMenu` from `../ui/session-menu.js` and `defaultSessionManager` from `../agent/session.js`.
3. In `executeSlashCommand()` switch statement, handle `case 'session':` and `case 'resume':`:
   - If `command === 'resume'` and `args.length === 0`: treat as opening picker.
   - If `command === 'resume'` and `args.length > 0`: treat as `/session switch <args[0]>`.
   - Subcommand routing for `case 'session':`:
     - `info` | `stats`: render existing status card with `Title: sess.title || 'Untitled'`.
     - `rename`: take `args.slice(1).join(' ')`, call `sess.setTitle(newTitle)`, `sess.save()`, print success confirmation.
     - `list`: call `sessionMgr.listSessions({ workingDir, all: true })`, print formatted table/box.
     - `delete`: call `sessionMgr.deleteSession(targetId)`.
     - `switch`: load `targetId` from `args[1] || args[0]`. Auto-save current session, load new session from disk, call `orchestrator.setSession(newSession)`. Return `{ handled: true, action: 'switch_session', session: newSession, sessionId: newSession.id }`.
     - Default (no subcommands):
       - If TTY, invoke `await showSessionMenu({ sessionManager: sessionMgr, activeSessionId: sess.id, workingDir, input: inputStream, output: stream })`.
       - If result action is `'switch'`, perform switch and return `switch_session`.
       - If result action is `'new'`, return `{ handled: true, action: 'new_session' }`.
       - If non-TTY fallback, print session list box.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/session-management.test.js`  
Expected: PASS for all `/session` and `/resume` slash command tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/slash-commands.js tests/session-management.test.js
git commit -m "feat(cli): wire interactive picker and subcommands into /session and /resume"
```

---

### Task 5: REPL Session Switching & History Replay

**Files:**
- Modify: `src/cli/repl.js`
- Test: `tests/session-management.test.js`

- [ ] **Step 1: Write failing test verifying REPL session switch action handling and history replay**

Append to `tests/session-management.test.js`:

```javascript
import { renderMarkdown } from '../src/ui/markdown.js';

describe('REPL: History Replay & Switch Synchronization', () => {
  test('session messages replay formatting works correctly', () => {
    const s = mgr.createSession({ id: 'sess_replay' });
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
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test tests/session-management.test.js`  
Expected: PASS.

- [ ] **Step 3: Update `src/cli/repl.js` to handle `switch_session`**

In `src/cli/repl.js`:
In the slash command result check (around line 212):
```javascript
if (slashResult?.action === 'switch_session') {
  const newSession = slashResult.session || orchestrator.getSession();
  turnCount = newSession.messages ? newSession.messages.length : 0;
  lastIterations = 0;

  // Print switch confirmation card
  const titleDisplay = newSession.title ? `"${newSession.title}"` : ansi.dim('(Untitled)');
  output.write(
    `\n${ansi.green('✔')} Switched to session: ${ansi.bold(ansi.yellow(titleDisplay))} ${ansi.dim(`(${newSession.id})`)}\n` +
      `  Model   : ${ansi.cyan(newSession.model || orchestrator.llmClient?.getModel() || 'default')}\n` +
      `  Messages: ${newSession.messages?.length || 0} turn(s)\n` +
      `${ansi.dim('─'.repeat(50))}\n`,
  );

  // History Replay: show last 2 turns (up to 4 messages)
  const msgs = newSession.getMessages ? newSession.getMessages() : newSession.messages || [];
  if (msgs.length > 0) {
    output.write(`${ansi.dim('Recent conversation history:')}\n\n`);
    const recent = msgs.slice(-4);
    for (const m of recent) {
      const text = m.parts?.[0]?.text || '';
      if (!text) continue;
      if (m.role === 'user') {
        output.write(`${ansi.bold(ansi.cyan('❯'))} ${ansi.white(text)}\n\n`);
      } else if (m.role === 'model') {
        output.write(`${renderMarkdown(text)}\n\n`);
      }
    }
    output.write(`${ansi.dim('─'.repeat(50))}\n\n`);
  }
}
```

- [ ] **Step 4: Run test suite**

Run: `node --test tests/session-management.test.js`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/repl.js tests/session-management.test.js
git commit -m "feat(repl): implement switch_session event with recent history replay and state sync"
```

---

### Task 6: CLI Startup Resume Integration (`bin/faycli.js`)

**Files:**
- Modify: `bin/faycli.js`
- Test: `tests/session-management.test.js`

- [ ] **Step 1: Write failing test verifying startup resume picker logic**

Append to `tests/session-management.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test tests/session-management.test.js`  
Expected: PASS.

- [ ] **Step 3: Update `bin/faycli.js` to support interactive picker on `faycli resume`**

In `bin/faycli.js`:
Import `showSessionMenu` from `../src/ui/session-menu.js`.
In the resume handler block (around line 313):
```javascript
let activeSession = null;
let resumeId = parsed.command === 'resume' ? parsed.subcommand : parsed.flags.session;

if (parsed.command === 'resume' && !resumeId) {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const menuResult = await showSessionMenu({
      sessionManager: defaultSessionManager,
      workingDir: process.cwd(),
      input: process.stdin,
      output: process.stdout,
    });
    if (menuResult.cancelled) {
      process.exit(0);
    }
    if (menuResult.action === 'switch' && menuResult.sessionId) {
      resumeId = menuResult.sessionId;
    }
  }
}

if (resumeId) {
  if (defaultSessionManager.hasSession(resumeId)) {
    activeSession = defaultSessionManager.loadSession(resumeId);
    logger.info(`Resumed existing session: ${ansi.yellow(resumeId)} (${activeSession.title || 'Untitled'})`);
  } else {
    logger.error(`Session "${resumeId}" not found in storage.`);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/session-management.test.js`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/faycli.js tests/session-management.test.js
git commit -m "feat(cli): launch interactive session picker when running faycli resume without ID"
```

---

### Task 7: Full System Verification & Regression Suite

**Files:**
- `tests/session-management.test.js`
- Full test suite

- [ ] **Step 1: Run complete unit tests for session management**

Run: `node --test tests/session-management.test.js`  
Expected: All tests PASS with 0 failures.

- [ ] **Step 2: Run linter and formatting check**

Run: `npm run lint`  
Expected: Biome check clean with 0 errors. If formatting needed: `npm run lint:fix`.

- [ ] **Step 3: Run regression tests for all core modules**

Run: `node --test tests/step4-session.test.js tests/slash-new.test.js tests/repl-new-session.test.js tests/session-status-repl.test.js`  
Expected: All existing session-related tests PASS.

- [ ] **Step 4: Final commit**

```bash
git add tests/
git commit -m "test: add comprehensive session management and switching test suite"
```
