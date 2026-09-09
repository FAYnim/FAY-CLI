# Fitur `/new` — Membuat Session Baru Tanpa Keluar CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Menambahkan slash command `/new` di dalam interactive REPL untuk membuat session percakapan baru (ID baru, pesan kosong, usage counter reset ke 0) sambil menyimpan session sebelumnya secara aman ke disk, tanpa harus keluar dan masuk kembali ke CLI.

**Architecture:** Logika transisi session ditangani murni di level `executeSlashCommand` (case `'new'`) dalam `src/cli/slash-commands.js` dengan memanfaatkan primitif yang sudah ada: `oldSession.save()`, `createSession()`, `resetUsage()`, dan `orchestrator.setSession()`. REPL loop di `src/cli/repl.js` menangkap hasil `slashResult.action === 'new_session'` untuk mereset counter prompt `turnCount = 0` dan `lastIterations = 0`. Shortcut overlay `?` dan dokumentasi diperbarui agar selaras.

**Tech Stack:** Node.js (>=20.0.0, ESM), `node:test`, `node:assert/strict`, `PassThrough` stream mocks, `AgentOrchestrator`, `SessionManager`, `Biome`.

---

## File Structure Map

| File | Status | Peran & Tanggung Jawab |
|---|---|---|
| `src/cli/slash-commands.js` | Modify | Import `createSession` & `resetUsage`; tambah entri `/new` di `SLASH_COMMANDS_HELP`; implementasi `case 'new':` |
| `src/cli/repl.js` | Modify | Tangani `slashResult?.action === 'new_session'` dengan mereset `turnCount = 0` dan `lastIterations = 0` |
| `src/ui/shortcut-overlay.js` | Modify | Tambah entri `{ key: '/new', desc: 'Start a fresh session (saves current one)' }` di `SHORTCUT_ENTRIES` |
| `README.md` | Modify | Tambahkan baris `/new` ke tabel "Slash Commands (inside REPL)" |
| `CHANGELOG.md` | Modify | Catat penambahan fitur `/new` di bawah section `## [Unreleased] -> ### Added` |
| `tests/slash-new.test.js` | Create | Unit test lengkap untuk `/new`: happy path, usage reset, metadata inheritance, save error handling, help & autocomplete |
| `tests/repl-new-session.test.js` | Create | REPL integration test: verifikasi reset prompt turn badge `[n]` dan status line setelah `/new` |
| `tests/e2e/e2e-new-session.test.js` | Create | E2E persistence test: verifikasi isolasi histori dua session pada disk dengan real `AgentOrchestrator` |

---

### Task 1: Unit Tests & Core Handler for `/new` in `src/cli/slash-commands.js`

**Files:**
- Create: `tests/slash-new.test.js`
- Modify: `src/cli/slash-commands.js:6-46, 500-530`

- [ ] **Step 1: Write the failing test for `/new` slash command**

Buat file baru `tests/slash-new.test.js`:

```javascript
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Session, SessionManager } from '../src/agent/session.js';
import { accumulateUsage, getUsage } from '../src/agent/usage.js';
import { listCommandNames } from '../src/cli/autocomplete.js';
import { executeSlashCommand, SLASH_COMMANDS_HELP } from '../src/cli/slash-commands.js';

test('/new: happy path saves old session, creates fresh session, resets usage and updates orchestrator', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faycli-slash-new-'));
  const sessionManager = new SessionManager({ sessionsDir: tmpDir });
  const oldSession = sessionManager.createSession({
    model: 'gemini-2.5-flash',
    provider: 'gemini',
    workingDir: tmpDir,
  });
  oldSession.addUserMessage('Old turn user message');
  oldSession.addModelMessage('Old turn assistant reply');
  accumulateUsage(oldSession, { promptTokenCount: 1500, candidatesTokenCount: 200, totalTokenCount: 1700 });

  let output = '';
  const mockStream = {
    write: (str) => {
      output += str;
    },
  };

  const mockOrchestrator = {
    session: oldSession,
    provider: 'gemini',
    workingDir: tmpDir,
    llmClient: {
      getModel: () => 'gemini-2.5-flash',
    },
    setSession(s) {
      this.session = s;
    },
    getSession() {
      return this.session;
    },
  };

  const res = await executeSlashCommand('/new', {
    orchestrator: mockOrchestrator,
    stream: mockStream,
    logger: { warn() {}, info() {}, error() {} },
  });

  assert.equal(res.handled, true);
  assert.equal(res.action, 'new_session');
  assert.notEqual(res.sessionId, oldSession.id);
  assert.equal(res.previousSessionId, oldSession.id);

  // New session state in orchestrator
  const currentSession = mockOrchestrator.getSession();
  assert.equal(currentSession.id, res.sessionId);
  assert.notEqual(currentSession.id, oldSession.id);
  assert.equal(currentSession.getMessages().length, 0);
  assert.equal(currentSession.workingDir, tmpDir);
  assert.equal(currentSession.provider, 'gemini');
  assert.equal(currentSession.sessionsDir, tmpDir);

  // Usage must be completely zeroed
  const currentUsage = getUsage(currentSession);
  assert.equal(currentUsage.llmRequests, 0);
  assert.equal(currentUsage.promptTokens, 0);
  assert.equal(currentUsage.completionTokens, 0);
  assert.equal(currentUsage.totalTokens, 0);

  // Old session was saved to disk
  const oldSessionFilePath = path.join(tmpDir, `${oldSession.id}.json`);
  assert.ok(fs.existsSync(oldSessionFilePath), 'Previous session must be written to disk');
  const savedData = JSON.parse(fs.readFileSync(oldSessionFilePath, 'utf-8'));
  assert.equal(savedData.id, oldSession.id);
  assert.equal(savedData.messages.length, 2);

  // Output contains confirmation
  assert.ok(output.includes('Started new session') || output.includes('Started'));
  assert.ok(output.includes(oldSession.id));
  assert.ok(output.includes(res.sessionId));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('/new: handles missing orchestrator or session context gracefully', async () => {
  let output = '';
  const mockStream = {
    write: (str) => {
      output += str;
    },
  };

  const res = await executeSlashCommand('/new', {
    stream: mockStream,
  });

  assert.equal(res.handled, true);
  assert.equal(res.action, 'new_session');
  assert.equal(res.error, true);
  assert.ok(output.includes('No active session context found'));
});

test('/new: registered in SLASH_COMMANDS_HELP and autocomplete listCommandNames', () => {
  const helpEntry = SLASH_COMMANDS_HELP.find((c) => c.cmd.startsWith('/new'));
  assert.ok(helpEntry, '/new entry must exist in SLASH_COMMANDS_HELP');
  assert.ok(helpEntry.desc.includes('new session'));

  const cmdNames = listCommandNames();
  assert.ok(cmdNames.includes('new'), 'autocomplete listCommandNames must include "new"');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/slash-new.test.js`
Expected: FAIL with `Unknown slash command: "/new"` or helpEntry not found.

- [ ] **Step 3: Implement `/new` in `src/cli/slash-commands.js`**

1. Tambahkan import `createSession` dan `resetUsage` di awal file `src/cli/slash-commands.js`:

```javascript
import { createSession } from '../agent/session.js';
import { getUsage, resetUsage } from '../agent/usage.js';
```

2. Tambahkan entri di `SLASH_COMMANDS_HELP` (setelah `/session`):

```javascript
  { cmd: '/session', desc: 'Display current session ID, token usage & stats' },
  {
    cmd: '/new',
    desc: 'Start a new session (current one is saved — use faycli resume <id> to return)',
  },
  {
    cmd: '/compact',
    desc: 'Summarize older context now to free space (agent loop does it automatically at 92%)',
  },
```

3. Tambahkan `case 'new':` dalam `switch (command)` di `executeSlashCommand`:

```javascript
    case 'new': {
      if (!orchestrator?.session && !orchestrator) {
        stream.write(`\n${ansi.yellow('⚠')} No active session context found.\n\n`);
        return { handled: true, action: 'new_session', error: true };
      }

      const oldSession = orchestrator?.session || null;
      if (oldSession && typeof oldSession.save === 'function') {
        try {
          oldSession.save();
        } catch (e) {
          logger.warn(`Failed to persist previous session before /new: ${e.message}`);
        }
      }

      const newSession = createSession({
        model: oldSession?.model || orchestrator?.llmClient?.getModel?.() || undefined,
        provider: oldSession?.provider || orchestrator?.provider || 'gemini',
        workingDir: oldSession?.workingDir || orchestrator?.workingDir || process.cwd(),
        sessionsDir: oldSession?.sessionsDir || undefined,
      });

      resetUsage(newSession);
      if (orchestrator && typeof orchestrator.setSession === 'function') {
        orchestrator.setSession(newSession);
      } else if (orchestrator) {
        orchestrator.session = newSession;
      }

      stream.write(
        `\n${ansi.green('✔')} Started ${ansi.bold('new session')}.\n` +
          `  Previous : ${ansi.dim(oldSession?.id || 'N/A')} ${ansi.dim('(saved — faycli resume <id> to return)')}\n` +
          `  New      : ${ansi.bold(ansi.yellow(newSession.id))}\n\n`,
      );

      return {
        handled: true,
        action: 'new_session',
        sessionId: newSession.id,
        previousSessionId: oldSession?.id || null,
      };
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/slash-new.test.js`
Expected: PASS (3 tests passing).

- [ ] **Step 5: Commit**

```bash
git add src/cli/slash-commands.js tests/slash-new.test.js
git commit -m "feat(cli): add /new slash command to start fresh session without exiting"
```

---

### Task 2: REPL Wiring and Prompt Badge Reset

**Files:**
- Create: `tests/repl-new-session.test.js`
- Modify: `src/cli/repl.js:208-213`

- [ ] **Step 1: Write the failing test for REPL reset behavior on `/new`**

Buat file baru `tests/repl-new-session.test.js`:

```javascript
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';
import { Session } from '../src/agent/session.js';
import { startRepl } from '../src/cli/repl.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };
const stubConfigMgr = { get: () => undefined };

function createIO() {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => {
    text += chunk.toString();
  });
  return { input, output, getText: () => text };
}

function createFakeOrchestrator(initialSession) {
  let session = initialSession;
  return {
    provider: 'gemini',
    workingDir: '/tmp/fake-repl',
    maxIterations: 30,
    maxContextTokens: undefined,
    llmClient: { getModel: () => 'gemini-2.5-flash' },
    getSession: () => session,
    setSession: (s) => {
      session = s;
    },
    get session() {
      return session;
    },
    set session(s) {
      session = s;
    },
    async runTurn(_prompt, opts = {}) {
      opts.onIterationStart?.(1);
      session.addUserMessage('user prompt');
      session.addModelMessage('assistant reply');
      return {
        success: true,
        text: 'fake turn reply',
        iterations: 1,
        toolCalls: [],
        loopLimitReached: false,
        session,
      };
    },
  };
}

describe('REPL /new Session Handling', () => {
  test('resets turn count and displays new session confirmation', async () => {
    const session = new Session({ id: 'sess_initial_123' });
    const io = createIO();
    const orchestrator = createFakeOrchestrator(session);

    const replDone = startRepl({
      orchestrator,
      configMgr: stubConfigMgr,
      input: io.input,
      output: io.output,
      logger: silentLogger,
    });

    // 1. Run a turn to increment turnCount to 1
    io.input.write('hello world\n');

    // 2. Wait for turn resolution, then invoke /new
    setTimeout(() => {
      io.input.write('/new\n');
      setTimeout(() => {
        io.input.write('/exit\n');
        setTimeout(() => io.input.end(), 30);
      }, 50);
    }, 50);

    await replDone;

    const text = io.getText();
    assert.ok(text.includes('Started new session'), 'Should output confirmation of new session');
    assert.ok(text.includes('sess_initial_123'), 'Should reference previous session ID');
    assert.notEqual(orchestrator.getSession().id, 'sess_initial_123');

    // Verify turn count was reset: prompt rendered after /new should NOT show badge [1]
    // The prompt format in buildReplPrompt is: "fay [1] > " when turnCount === 1, and "fay > " when turnCount === 0.
    const promptsAfterNew = text.split('Started new session')[1] || '';
    assert.ok(!promptsAfterNew.includes('[1] >'), 'Badge [1] must not appear after /new');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/repl-new-session.test.js`
Expected: FAIL (prompt still displays badge `[1] >` after `/new` or turnCount is not reset).

- [ ] **Step 3: Modify `src/cli/repl.js` to handle `new_session` action**

Di file `src/cli/repl.js`, cari penanganan `slashResult` (sekitar baris 208):

```javascript
      if (slashResult?.action === 'exit') {
        isClosing = true;
        break;
      }
      if (slashResult?.action === 'new_session') {
        turnCount = 0;
        lastIterations = 0;
      }
      continue;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/repl-new-session.test.js`
Expected: PASS (1 test passing).

- [ ] **Step 5: Commit**

```bash
git add src/cli/repl.js tests/repl-new-session.test.js
git commit -m "feat(repl): reset turn count and last iterations on /new slash command"
```

---

### Task 3: Keyboard Shortcut Reference Overlay (`?`) Update

**Files:**
- Modify: `src/ui/shortcut-overlay.js:8-25`
- Test: `tests/slash-new.test.js`

- [ ] **Step 1: Add unit test asserting `/new` in shortcut overlay**

Tambahkan assertion ke `tests/slash-new.test.js`:

```javascript
import { buildShortcutOverlay, SHORTCUT_ENTRIES } from '../src/ui/shortcut-overlay.js';

test('shortcut overlay includes /new entry', () => {
  const newEntry = SHORTCUT_ENTRIES.find((e) => e.key === '/new');
  assert.ok(newEntry, 'SHORTCUT_ENTRIES must contain /new');
  assert.ok(newEntry.desc.includes('fresh session') || newEntry.desc.includes('new session'));

  const overlayText = buildShortcutOverlay();
  assert.ok(overlayText.includes('/new'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/slash-new.test.js`
Expected: FAIL with `SHORTCUT_ENTRIES must contain /new`.

- [ ] **Step 3: Update `src/ui/shortcut-overlay.js`**

Tambahkan entri `{ key: '/new', desc: 'Start a fresh session (saves current one)' }` di `SHORTCUT_ENTRIES`:

```javascript
  { key: '/model',     desc: 'Interactive model picker' },
  { key: '/session',   desc: 'Show session token usage stats' },
  { key: '/new',       desc: 'Start a fresh session (saves current one)' },
  { key: '/compact',   desc: 'Manually compact context window' },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/slash-new.test.js`
Expected: PASS (4 tests passing).

- [ ] **Step 5: Commit**

```bash
git add src/ui/shortcut-overlay.js tests/slash-new.test.js
git commit -m "feat(ui): add /new command to keyboard shortcut overlay"
```

---

### Task 4: E2E Persistence & Context Isolation Test

**Files:**
- Create: `tests/e2e/e2e-new-session.test.js`

- [ ] **Step 1: Write E2E test exercising real session persistence and context isolation across `/new`**

Buat file baru `tests/e2e/e2e-new-session.test.js`:

```javascript
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { AgentOrchestrator } from '../../src/agent/orchestrator.js';
import { SessionManager } from '../../src/agent/session.js';
import { executeSlashCommand } from '../../src/cli/slash-commands.js';

describe('E2E: Session Transition via /new', () => {
  let tempDir;
  let sessionManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faycli-e2e-new-'));
    sessionManager = new SessionManager({ sessionsDir: tempDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  test('executing /new archives initial session and starts fresh isolated session', async () => {
    const session1 = sessionManager.createSession({
      model: 'gemini-2.5-flash',
      workingDir: tempDir,
      sessionsDir: tempDir,
    });

    let currentTurn = 1;
    const mockGemini = {
      getModel: () => 'gemini-2.5-flash',
      generateStream: async () => {
        if (currentTurn === 1) {
          return {
            text: 'I noted your project CalculatorApp.',
            functionCalls: [],
            finishReason: 'STOP',
          };
        }
        return {
          text: 'Starting fresh for WeatherApp.',
          functionCalls: [],
          finishReason: 'STOP',
        };
      },
    };

    const orchestrator = new AgentOrchestrator({
      llmClient: mockGemini,
      session: session1,
      workingDir: tempDir,
      maxIterations: 10,
    });

    // ── Turn 1 in Session 1 ──
    const turn1Res = await orchestrator.runTurn('My project is CalculatorApp.');
    assert.equal(turn1Res.success, true);
    assert.ok(turn1Res.text.includes('CalculatorApp'));

    const session1Path = path.join(tempDir, `${session1.id}.json`);
    assert.ok(fs.existsSync(session1Path), 'Session 1 must be saved on disk');

    // ── Execute /new ──
    let output = '';
    const slashRes = await executeSlashCommand('/new', {
      orchestrator,
      stream: { write: (s) => { output += s; } },
      logger: { warn() {}, info() {}, error() {} },
    });

    assert.equal(slashRes.handled, true);
    assert.equal(slashRes.action, 'new_session');
    assert.notEqual(slashRes.sessionId, session1.id);

    const session2 = orchestrator.getSession();
    assert.equal(session2.id, slashRes.sessionId);
    assert.equal(session2.getMessages().length, 0);

    // ── Turn 2 in Session 2 ──
    currentTurn = 2;
    const turn2Res = await orchestrator.runTurn('Now tell me about WeatherApp.');
    assert.equal(turn2Res.success, true);
    assert.ok(turn2Res.text.includes('WeatherApp'));

    const session2Path = path.join(tempDir, `${session2.id}.json`);
    assert.ok(fs.existsSync(session2Path), 'Session 2 must be saved on disk');

    // Verify Session 1 disk file contains CalculatorApp
    const s1Saved = JSON.parse(fs.readFileSync(session1Path, 'utf8'));
    assert.equal(s1Saved.id, session1.id);
    const s1Text = JSON.stringify(s1Saved.messages);
    assert.ok(s1Text.includes('CalculatorApp'));
    assert.ok(!s1Text.includes('WeatherApp'));

    // Verify Session 2 disk file contains WeatherApp and has NO CalculatorApp
    const s2Saved = JSON.parse(fs.readFileSync(session2Path, 'utf8'));
    assert.equal(s2Saved.id, session2.id);
    const s2Text = JSON.stringify(s2Saved.messages);
    assert.ok(s2Text.includes('WeatherApp'));
    assert.ok(!s2Text.includes('CalculatorApp'));
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test tests/e2e/e2e-new-session.test.js`
Expected: PASS (1 test passing).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/e2e-new-session.test.js
git commit -m "test(e2e): add persistence and context isolation verification for /new"
```

---

### Task 5: Documentation & Changelog Updates

**Files:**
- Modify: `README.md:264-275`
- Modify: `CHANGELOG.md:10-25`

- [ ] **Step 1: Update README.md Slash Commands table**

Di tabel `#### Slash Commands (inside REPL)` dalam `README.md`, tambahkan baris `/new`:

```markdown
| Command | Description |
|---|---|
| `/help` | Display all available slash commands |
| `/model [name]` | View or switch active model (interactive TUI menu on TTY) |
| `/session` | Show current session info and ID |
| `/new` | Start a new session in the same REPL (previous session is saved; `faycli resume <id>` to return) |
| `/clear` | Clear conversation history |
| `/config` | View current configuration |
| `/exit` or `/quit` | Exit the REPL |
```

- [ ] **Step 2: Update CHANGELOG.md**

Di `CHANGELOG.md` pada section `## [Unreleased] -> ### Added`, tambahkan entri fitur baru:

```markdown
- `/new` slash command inside REPL to start a fresh conversation session (new ID, reset turn badge, zeroed usage counters) without restarting the CLI process, automatically preserving the previous session to disk for later `faycli resume <id>` (FEATURE-03).
```

- [ ] **Step 3: Run Biome lint & format check**

Run: `npm run lint`
Expected: Biome exits with code 0 (no errors, no unformatted code).

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document /new slash command in README and CHANGELOG"
```

---

## Verification & Self-Review Checklist

- [ ] **Spec coverage**:
  - [x] Slash command `/new` in `src/cli/slash-commands.js`
  - [x] Inherit model, provider, workingDir, sessionsDir from previous session
  - [x] Safeguard old session save to disk with try/catch + logger.warn
  - [x] Reset usage counters via `resetUsage(newSession)`
  - [x] Attach new session via `orchestrator.setSession(newSession)`
  - [x] Return `{ handled: true, action: 'new_session', sessionId, previousSessionId }`
  - [x] REPL catches `new_session` and resets `turnCount = 0`, `lastIterations = 0`
  - [x] Autocomplete `listCommandNames()` and `SLASH_COMMANDS_HELP` include `/new`
  - [x] Shortcut overlay `?` includes `/new`
  - [x] Unit test (`tests/slash-new.test.js`)
  - [x] REPL test (`tests/repl-new-session.test.js`)
  - [x] E2E test (`tests/e2e/e2e-new-session.test.js`)
  - [x] README.md and CHANGELOG.md documentation
- [ ] **No placeholders scan**: All tasks specify exact file paths, complete code blocks, exact commands, and commit messages.
- [ ] **Type consistency**: Method names and signatures (`createSession`, `resetUsage`, `setSession`, `getSession`, `executeSlashCommand`, `SLASH_COMMANDS_HELP`, `SHORTCUT_ENTRIES`) match existing codebase exactly.
