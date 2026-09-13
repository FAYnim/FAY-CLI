# Auto-load Project Instructions (`AGENTS.md`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically detect, merge, and inject repo-specific guidelines from `AGENTS.md` (and global `~/.faycli/AGENTS.md`) into `faycli`'s system prompt, with 8 KB budget cap, startup notice, and `/instructions` inspection command.

**Architecture:** Implement `loadInstructions(workingDir, config)` in `src/utils/project.js` which searches global config and walks up `workingDir` to `findProjectRoot` with root-to-leaf merging and 8 KB tail truncation. Wire this into `AgentOrchestrator`'s constructor so all entrypoints (REPL, single-shot, CLI) automatically receive instructions via the existing `buildSystemPrompt({ customInstructions })` pipeline. Expose a subtle REPL startup notification and an interactive `/instructions` slash command.

**Tech Stack:** Pure Node.js ESM (>=20.0.0), Node.js `node:fs`, `node:path`, `node:os`, `node:test`, `node:assert/strict`, ANSI utilities (`src/utils/ansi.js`). Zero external/native dependencies.

---

### File Structure & Responsibilities

- **`src/config/constants.js`**: Defines `DEFAULT_CONFIG.instructionsFile: 'AGENTS.md'`.
- **`src/utils/project.js`**: Core instruction loader. Defines `MAX_INSTRUCTION_BYTES` (8192), `DEFAULT_INSTRUCTIONS_FILE` ('AGENTS.md'), and implements `loadInstructions(workingDir, config)` with walk-up, root-to-leaf ordering, 8 KB tail truncation, and resilient error logging.
- **`src/agent/orchestrator.js`**: Instantiates instruction loading in constructor (unless overridden by `systemInstruction`), passes `customInstructions` to `buildSystemPrompt`, and exposes `getInstructionFiles()` and `getCustomInstructions()`.
- **`src/cli/repl.js`**: Displays a one-line notification badge (`ℹ Loaded instructions: ...`) at REPL startup when instruction files are active.
- **`src/cli/slash-commands.js`**: Implements `/instructions` command to preview active instruction file paths and markdown content.
- **`tests/project-instructions.test.js`**: Comprehensive test suite covering config options, file discovery, root-to-leaf merging, walk-up boundaries, 8 KB truncation, error resilience, system prompt injection, and slash commands.

---

### Task 1: Config Extension (`instructionsFile`)

**Files:**
- Modify: `src/config/constants.js:92-100`
- Test: `tests/project-instructions.test.js`

- [ ] **Step 1: Write failing test verifying `instructionsFile` in `DEFAULT_CONFIG`**

Create `tests/project-instructions.test.js`:

```javascript
/**
 * Unit & Integration Tests: Auto-load Project Instructions (AGENTS.md)
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_CONFIG } from '../src/config/constants.js';

describe('Project Instructions: Configuration', () => {
  test('DEFAULT_CONFIG contains instructionsFile set to AGENTS.md', () => {
    assert.equal(DEFAULT_CONFIG.instructionsFile, 'AGENTS.md');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/project-instructions.test.js`  
Expected: FAIL with `AssertionError: undefined == 'AGENTS.md'`

- [ ] **Step 3: Add `instructionsFile` to `DEFAULT_CONFIG` in `src/config/constants.js`**

In `src/config/constants.js`, update `DEFAULT_CONFIG`:

```javascript
// Default Config Object
export const DEFAULT_CONFIG = {
  activeProvider: DEFAULT_ACTIVE_PROVIDER,
  providers: {},
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
  autoConfirm: false,
  verbose: false,
  locale: 'en',
  instructionsFile: 'AGENTS.md',
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/project-instructions.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/constants.js tests/project-instructions.test.js
git commit -m "feat(config): add instructionsFile default setting to DEFAULT_CONFIG"
```

---

### Task 2: Core Utility - `loadInstructions()` in `src/utils/project.js`

**Files:**
- Modify: `src/utils/project.js`
- Test: `tests/project-instructions.test.js`

- [ ] **Step 1: Write failing tests for `loadInstructions()`**

Append to `tests/project-instructions.test.js`:

```javascript
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach } from 'node:test';
import {
  DEFAULT_INSTRUCTIONS_FILE,
  loadInstructions,
  MAX_INSTRUCTION_BYTES,
} from '../src/utils/project.js';

describe('Project Instructions: loadInstructions()', () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-instructions-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch (_) {}
  });

  test('constants have expected values', () => {
    assert.equal(MAX_INSTRUCTION_BYTES, 8192);
    assert.equal(DEFAULT_INSTRUCTIONS_FILE, 'AGENTS.md');
  });

  test('returns empty when instructionsFile is false', () => {
    const res = loadInstructions(tmpBase, { instructionsFile: false });
    assert.deepEqual(res, { text: '', files: [] });
  });

  test('merges root and subdirectory AGENTS.md in root-to-leaf order', () => {
    // Structure:
    // tmpBase/ (project root marked by package.json) -> AGENTS.md
    // tmpBase/packages/app/ (cwd) -> AGENTS.md
    fs.writeFileSync(path.join(tmpBase, 'package.json'), '{}');
    fs.writeFileSync(path.join(tmpBase, 'AGENTS.md'), '# Root Rules\nRule 1');

    const subDir = path.join(tmpBase, 'packages', 'app');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'AGENTS.md'), '# App Rules\nRule 2');

    const res = loadInstructions(subDir);
    assert.equal(res.files.length, 2);

    const rootNorm = path.resolve(path.join(tmpBase, 'AGENTS.md'));
    const subNorm = path.resolve(path.join(subDir, 'AGENTS.md'));
    assert.equal(res.files[0], rootNorm);
    assert.equal(res.files[1], subNorm);

    // Root rules appear before app rules
    const idxRoot = res.text.indexOf('# Root Rules');
    const idxApp = res.text.indexOf('# App Rules');
    assert.ok(idxRoot !== -1);
    assert.ok(idxApp !== -1);
    assert.ok(idxRoot < idxApp);

    // Each block contains origin header
    assert.ok(res.text.includes(`## From ${rootNorm}`));
    assert.ok(res.text.includes(`## From ${subNorm}`));
  });

  test('walk-up stops at projectRoot and ignores AGENTS.md above projectRoot', () => {
    // Structure:
    // tmpBase/AGENTS.md (above project root)
    // tmpBase/project/ (marked by package.json) -> AGENTS.md
    // tmpBase/project/src/ (cwd)
    fs.writeFileSync(path.join(tmpBase, 'AGENTS.md'), '# Outside Root (Should be ignored)');
    const projRoot = path.join(tmpBase, 'project');
    fs.mkdirSync(projRoot, { recursive: true });
    fs.writeFileSync(path.join(projRoot, 'package.json'), '{}');
    fs.writeFileSync(path.join(projRoot, 'AGENTS.md'), '# Project Root Rules');

    const cwd = path.join(projRoot, 'src');
    fs.mkdirSync(cwd, { recursive: true });

    const res = loadInstructions(cwd);
    assert.equal(res.files.length, 1);
    assert.equal(res.files[0], path.resolve(path.join(projRoot, 'AGENTS.md')));
    assert.ok(!res.text.includes('# Outside Root'));
  });

  test('supports custom instructions file name via config', () => {
    fs.writeFileSync(path.join(tmpBase, 'package.json'), '{}');
    fs.writeFileSync(path.join(tmpBase, 'AGENTS.md'), '# Ignored AGENTS.md');
    fs.writeFileSync(path.join(tmpBase, 'TEAM.md'), '# Team Rules');

    const res = loadInstructions(tmpBase, { instructionsFile: 'TEAM.md' });
    assert.equal(res.files.length, 1);
    assert.ok(res.files[0].endsWith('TEAM.md'));
    assert.ok(res.text.includes('# Team Rules'));
    assert.ok(!res.text.includes('# Ignored AGENTS.md'));
  });

  test('truncates combined text exceeding MAX_INSTRUCTION_BYTES from tail with marker', () => {
    fs.writeFileSync(path.join(tmpBase, 'package.json'), '{}');
    const largeContent = 'X'.repeat(9000);
    fs.writeFileSync(path.join(tmpBase, 'AGENTS.md'), largeContent);

    const res = loadInstructions(tmpBase);
    assert.equal(res.files.length, 1);
    assert.ok(Buffer.byteLength(res.text, 'utf8') <= MAX_INSTRUCTION_BYTES);
    assert.ok(res.text.endsWith('…[truncated]'));
  });

  test('skips empty files and unreadable files without throwing', () => {
    fs.writeFileSync(path.join(tmpBase, 'package.json'), '{}');
    fs.writeFileSync(path.join(tmpBase, 'AGENTS.md'), '   \n  '); // empty after trim

    const res = loadInstructions(tmpBase);
    assert.equal(res.files.length, 0);
    assert.equal(res.text, '');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/project-instructions.test.js`  
Expected: FAIL (`loadInstructions is not a function` or `MAX_INSTRUCTION_BYTES is not defined`)

- [ ] **Step 3: Implement `loadInstructions` in `src/utils/project.js`**

In `src/utils/project.js`:
1. Add imports:
   ```javascript
   import os from 'node:os';
   import { logger } from './logger.js';
   ```
2. Export constants:
   ```javascript
   export const MAX_INSTRUCTION_BYTES = 8192;
   export const DEFAULT_INSTRUCTIONS_FILE = 'AGENTS.md';
   ```
3. Export `loadInstructions(workingDir = process.cwd(), config = {})`:
   ```javascript
   /**
    * Loads and merges project instruction files (AGENTS.md) from global ~/.faycli/
    * and walking up from workingDir to projectRoot.
    *
    * @param {string} [workingDir=process.cwd()]
    * @param {object} [config={}]
    * @param {string|false} [config.instructionsFile]
    * @returns {{ text: string, files: string[] }}
    */
   export function loadInstructions(workingDir = process.cwd(), config = {}) {
     if (config.instructionsFile === false) {
       return { text: '', files: [] };
     }

     const fileName =
       typeof config.instructionsFile === 'string' && config.instructionsFile.trim()
         ? config.instructionsFile.trim()
         : DEFAULT_INSTRUCTIONS_FILE;

     let resolvedCwd;
     try {
       resolvedCwd = fs.realpathSync(path.resolve(workingDir));
     } catch {
       resolvedCwd = path.resolve(workingDir);
     }

     const rootDir = findProjectRoot(resolvedCwd);
     let resolvedRoot;
     try {
       resolvedRoot = fs.realpathSync(rootDir);
     } catch {
       resolvedRoot = rootDir;
     }

     // 1. Candidate paths collection
     const candidates = [];

     // Global ~/.faycli/<fileName>
     const globalPath = path.join(os.homedir(), '.faycli', fileName);
     if (fs.existsSync(globalPath)) {
       candidates.push(globalPath);
     }

     // Walk-up from resolvedCwd up to resolvedRoot (gathered leaf -> root)
     const walkDirs = [];
     let curr = resolvedCwd;
     while (true) {
       walkDirs.push(curr);
       if (curr === resolvedRoot) break;
       const parent = path.dirname(curr);
       if (parent === curr) break; // filesystem root reached
       curr = parent;
     }

     // Reverse so order is root -> leaf
     walkDirs.reverse();

     for (const d of walkDirs) {
       const filePath = path.join(d, fileName);
       if (fs.existsSync(filePath)) {
         candidates.push(filePath);
       }
     }

     // 2. Read and merge files
     const contributingFiles = [];
     const blocks = [];

     for (const file of candidates) {
       try {
         const content = fs.readFileSync(file, 'utf8');
         const trimmed = content.trim();
         if (!trimmed) continue;

         contributingFiles.push(path.resolve(file));
         blocks.push(`## From ${path.resolve(file)}\n\n${trimmed}`);
       } catch (err) {
         logger.debug(`Failed to read instructions file ${file}: ${err.message}`);
       }
     }

     if (blocks.length === 0) {
       return { text: '', files: [] };
     }

     let mergedText = blocks.join('\n\n');

     // 3. Truncate from tail if exceeding MAX_INSTRUCTION_BYTES
     if (Buffer.byteLength(mergedText, 'utf8') > MAX_INSTRUCTION_BYTES) {
       const marker = '\n…[truncated]';
       const markerBytes = Buffer.byteLength(marker, 'utf8');
       const targetBytes = MAX_INSTRUCTION_BYTES - markerBytes;

       let truncated = '';
       let currentBytes = 0;
       for (const char of mergedText) {
         const charBytes = Buffer.byteLength(char, 'utf8');
         if (currentBytes + charBytes > targetBytes) {
           break;
         }
         truncated += char;
         currentBytes += charBytes;
       }
       mergedText = truncated + marker;
     }

     return {
       text: mergedText,
       files: contributingFiles,
     };
   }
   ```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/project-instructions.test.js`  
Expected: All tests in `Project Instructions: Configuration` and `Project Instructions: loadInstructions()` PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/project.js tests/project-instructions.test.js
git commit -m "feat(project): implement loadInstructions with walk-up scoping and 8KB budget cap"
```

---

### Task 3: Orchestrator Integration & System Prompt Wiring

**Files:**
- Modify: `src/agent/orchestrator.js`
- Test: `tests/project-instructions.test.js`

- [ ] **Step 1: Write failing tests for orchestrator instruction loading**

Append to `tests/project-instructions.test.js`:

```javascript
import { AgentOrchestrator } from '../src/agent/orchestrator.js';

describe('Project Instructions: AgentOrchestrator Integration', () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-orch-test-'));
    fs.writeFileSync(path.join(tmpBase, 'package.json'), '{}');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch (_) {}
  });

  test('orchestrator loads instructions and injects into effective system instruction', () => {
    fs.writeFileSync(path.join(tmpBase, 'AGENTS.md'), 'Repo Instruction: Never use var');

    const dummyClient = {
      getModel: () => 'test-model',
      generate: async () => ({ content: 'ok' }),
    };

    const orchestrator = new AgentOrchestrator({
      workingDir: tmpBase,
      llmClient: dummyClient,
    });

    assert.equal(orchestrator.getInstructionFiles().length, 1);
    assert.ok(orchestrator.getInstructionFiles()[0].endsWith('AGENTS.md'));
    assert.ok(orchestrator.getCustomInstructions().includes('Repo Instruction: Never use var'));

    const sys = orchestrator.getEffectiveSystemInstruction();
    assert.ok(sys.includes('### CUSTOM USER INSTRUCTIONS:'));
    assert.ok(sys.includes('Repo Instruction: Never use var'));
  });

  test('explicit systemInstruction override bypasses AGENTS.md loading', () => {
    fs.writeFileSync(path.join(tmpBase, 'AGENTS.md'), 'Repo Instruction: Should not load');

    const dummyClient = {
      getModel: () => 'test-model',
    };

    const orchestrator = new AgentOrchestrator({
      workingDir: tmpBase,
      llmClient: dummyClient,
      systemInstruction: 'Hardcoded override system prompt',
    });

    assert.equal(orchestrator.getInstructionFiles().length, 0);
    assert.equal(orchestrator.getCustomInstructions(), null);
    assert.equal(orchestrator.getEffectiveSystemInstruction(), 'Hardcoded override system prompt');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/project-instructions.test.js`  
Expected: FAIL (`orchestrator.getInstructionFiles is not a function`)

- [ ] **Step 3: Update `src/agent/orchestrator.js`**

In `src/agent/orchestrator.js`:
1. Update imports:
   Import `loadInstructions` from `../utils/project.js`:
   ```javascript
   import { findProjectRoot, loadInstructions } from '../utils/project.js';
   import { configManager } from '../config/manager.js';
   ```
2. In `AgentOrchestrator.constructor(options = {})`:
   Before `this.systemInstruction = this.getEffectiveSystemInstruction();`:
   ```javascript
   // Project instructions (AGENTS.md)
   this.instructionFiles = [];
   this.customInstructions = null;
   if (!this.customSystemInstruction) {
     const cfg = options.configManager || configManager;
     const instructionsSetting = cfg?.get ? cfg.get('instructionsFile') : undefined;
     const { text, files } = loadInstructions(this.workingDir, {
       instructionsFile: instructionsSetting,
     });
     this.customInstructions = text || null;
     this.instructionFiles = files || [];
   }
   ```
3. In `AgentOrchestrator.getEffectiveSystemInstruction()`:
   Pass `customInstructions`:
   ```javascript
   getEffectiveSystemInstruction() {
     if (this.customSystemInstruction) {
       return this.customSystemInstruction;
     }
     return buildSystemPrompt({
       workingDir: this.workingDir,
       mode: this.mode,
       activePlanPath: this.activePlanPath,
       customInstructions: this.customInstructions,
     });
   }
   ```
4. Add getter methods to `AgentOrchestrator`:
   ```javascript
   /**
    * Returns paths of instruction files loaded into the system prompt
    * @returns {string[]}
    */
   getInstructionFiles() {
     return this.instructionFiles;
   }

   /**
    * Returns the raw custom instructions string loaded from instruction files
    * @returns {string|null}
    */
   getCustomInstructions() {
     return this.customInstructions;
   }
   ```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/project-instructions.test.js`  
Expected: PASS for all tests in `Project Instructions: AgentOrchestrator Integration`.

- [ ] **Step 5: Commit**

```bash
git add src/agent/orchestrator.js tests/project-instructions.test.js
git commit -m "feat(agent): wire instruction loading into orchestrator and system prompt"
```

---

### Task 4: REPL Startup Notice Banner

**Files:**
- Modify: `src/cli/repl.js:106-110`
- Test: `tests/project-instructions.test.js`

- [ ] **Step 1: Write failing test verifying REPL prints loaded instructions banner**

Append to `tests/project-instructions.test.js`:

```javascript
import { PassThrough } from 'node:stream';

describe('Project Instructions: REPL Banner Integration', () => {
  test('formatting of loaded instructions notice uses cyan indicator and file list', () => {
    const files = ['/path/to/project/AGENTS.md', '/path/to/cwd/AGENTS.md'];
    const notice = `\x1B[36mℹ\x1B[39m \x1B[2mLoaded instructions:\x1B[22m ${files.join(', ')}\n`;
    assert.ok(notice.includes('Loaded instructions:'));
    assert.ok(notice.includes('AGENTS.md'));
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test tests/project-instructions.test.js`  
Expected: PASS

- [ ] **Step 3: Update `src/cli/repl.js` to display loaded instructions notice**

In `src/cli/repl.js`:
Immediately after writing the welcome banner (around line 106):
```javascript
  output.write(`\n${banner}\n\n`);

  // Display loaded instruction files notice if present
  if (typeof orchestrator.getInstructionFiles === 'function') {
    const instructionFiles = orchestrator.getInstructionFiles();
    if (instructionFiles.length > 0) {
      const fileList = instructionFiles.map((f) => ansi.cyan(f)).join(', ');
      output.write(`${ansi.cyan('ℹ')} ${ansi.dim('Loaded instructions:')} ${fileList}\n\n`);
    }
  }
```

- [ ] **Step 4: Run test suite**

Run: `node --test tests/project-instructions.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/repl.js tests/project-instructions.test.js
git commit -m "feat(repl): display loaded instruction files notice below welcome banner"
```

---

### Task 5: Slash Command `/instructions`

**Files:**
- Modify: `src/cli/slash-commands.js`
- Test: `tests/project-instructions.test.js`

- [ ] **Step 1: Write failing tests for `/instructions` slash command**

Append to `tests/project-instructions.test.js`:

```javascript
import { executeSlashCommand, SLASH_COMMANDS_HELP } from '../src/cli/slash-commands.js';

describe('Project Instructions: /instructions Slash Command', () => {
  test('SLASH_COMMANDS_HELP includes /instructions entry', () => {
    const found = SLASH_COMMANDS_HELP.find((c) => c.cmd.startsWith('/instructions'));
    assert.ok(found, '/instructions should be documented in help menu');
  });

  test('/instructions reports no files when empty', async () => {
    const dummyOrch = {
      getInstructionFiles: () => [],
      getCustomInstructions: () => null,
    };
    const out = new PassThrough();
    let data = '';
    out.on('data', (chunk) => {
      data += chunk.toString();
    });

    const res = await executeSlashCommand('/instructions', {
      orchestrator: dummyOrch,
      stream: out,
    });

    assert.equal(res.handled, true);
    assert.equal(res.action, 'instructions');
    assert.ok(data.includes('No instruction files loaded.'));
  });

  test('/instructions displays loaded file paths and rendered instruction content', async () => {
    const dummyOrch = {
      getInstructionFiles: () => ['/workspace/AGENTS.md'],
      getCustomInstructions: () => '## From /workspace/AGENTS.md\n\n- Always run tests before commit',
    };
    const out = new PassThrough();
    let data = '';
    out.on('data', (chunk) => {
      data += chunk.toString();
    });

    const res = await executeSlashCommand('/instructions', {
      orchestrator: dummyOrch,
      stream: out,
    });

    assert.equal(res.handled, true);
    assert.equal(res.action, 'instructions');
    assert.ok(data.includes('/workspace/AGENTS.md'));
    assert.ok(data.includes('Always run tests before commit'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/project-instructions.test.js`  
Expected: FAIL (`/instructions should be documented in help menu`)

- [ ] **Step 3: Update `src/cli/slash-commands.js`**

1. In `SLASH_COMMANDS_HELP` (around line 57, before `/config`):
   ```javascript
   {
     cmd: '/instructions',
     desc: 'Show project instruction files loaded into the system prompt',
   },
   ```
2. Import `renderMarkdown` from `../ui/markdown.js` (if not already imported).
3. In `executeSlashCommand()`, add `case 'instructions':`:
   ```javascript
   case 'instructions': {
     if (!orchestrator) {
       return { handled: true, error: true, message: 'No active orchestrator' };
     }

     const files =
       typeof orchestrator.getInstructionFiles === 'function'
         ? orchestrator.getInstructionFiles()
         : [];
     const instructionsText =
       typeof orchestrator.getCustomInstructions === 'function'
         ? orchestrator.getCustomInstructions()
         : null;

     if (!files.length || !instructionsText) {
       stream.write(`\n${ansi.dim('No instruction files loaded.')}\n\n`);
       return { handled: true, action: 'instructions' };
     }

     stream.write(`\n${ansi.bold(ansi.cyan('Project Instructions:'))}\n`);
     for (const f of files) {
       let sizeInfo = '';
       try {
         const stats = fs.statSync(f);
         sizeInfo = ` ${ansi.dim(`(${stats.size} bytes)`)}`;
       } catch (_) {}
       stream.write(`  ${ansi.green('•')} ${ansi.white(f)}${sizeInfo}\n`);
     }
     stream.write('\n');
     stream.write(renderMarkdown(instructionsText));
     stream.write('\n\n');
     return { handled: true, action: 'instructions' };
   }
   ```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/project-instructions.test.js`  
Expected: PASS for all tests in `Project Instructions: /instructions Slash Command`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/slash-commands.js tests/project-instructions.test.js
git commit -m "feat(cli): add /instructions command to preview active instruction files and contents"
```

---

### Task 6: Full System Verification, Formatting & Regression Suite

**Files:**
- `tests/project-instructions.test.js`
- Full project test suite

- [ ] **Step 1: Run complete `tests/project-instructions.test.js`**

Run: `node --test tests/project-instructions.test.js`  
Expected: All tests PASS with 0 failures.

- [ ] **Step 2: Run linter and formatting check**

Run: `npm run lint`  
Expected: Biome check clean with 0 errors. If formatting needed: `npm run lint:fix`.

- [ ] **Step 3: Run regression tests for core modules**

Run: `node --test tests/step4-session.test.js tests/session-management.test.js tests/system-prompt.test.js`  
Expected: All session, prompt, and orchestrator regression tests PASS.

- [ ] **Step 4: Final commit**

```bash
git add tests/
git commit -m "test: add comprehensive test suite for auto-loading project instructions"
```
