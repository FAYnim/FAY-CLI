# Parallel Tool Calls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Menjalankan tool read-only secara paralel dengan `Promise.all` saat LLM menghasilkan multiple tool calls dalam satu turn, mengurangi latency secara drastis tanpa merusak urutan history atau keamanan mutasi filesystem.

**Architecture:** Menerapkan sequential chunking yang membagi array `functionCalls` menjadi batch berurutan (kumpulan tool `READ_ONLY_TOOLS` dieksekusi paralel via `Promise.all()`, sedangkan tool mutasi dieksekusi sekuensial). Hasil response dikumpulkan dan disimpan ke `session` sesuai urutan asli untuk menjaga konsistensi konteks.

**Tech Stack:** Node.js ESM (>=20.0.0), `node:test`, `node:assert/strict`, `Promise.all()`.

---

## File Structure Map

- **`src/tools/registry.js`**: Deklarasi `READ_ONLY_TOOLS` (Set nama tool aman/idempotent).
- **`src/agent/tool-partitioner.js`**: Modul baru berisi fungsi murni `partitionToolCalls(functionCalls, readOnlyTools)` untuk membagi array tool calls menjadi batch parallel dan sequential.
- **`src/agent/orchestrator.js`**: Modifikasi loop eksekusi tool di `runTurn()` untuk mengeksekusi chunk paralel dengan error handling independen, callback event, dan preservasi urutan history session.
- **`src/cli/repl.js`**: Update callback `onBatchStart` dan penanganan spinner multi-tool agar tampilan CLI rapi.
- **`tests/parallel_tools.test.js`**: Test suite komprehensif menguji partitioner, speedup concurrency, error resilience, dan preservasi urutan.

---

### Task 1: Export `READ_ONLY_TOOLS` in Registry

**Files:**
- Modify: `src/tools/registry.js:15-35`
- Test: `tests/parallel_tools.test.js`

- [ ] **Step 1: Write the failing test for READ_ONLY_TOOLS**

Buat file baru `tests/parallel_tools.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/parallel_tools.test.js`
Expected: FAIL with `READ_ONLY_TOOLS is not exported` or `READ_ONLY_TOOLS is undefined`.

- [ ] **Step 3: Implement READ_ONLY_TOOLS in `src/tools/registry.js`**

Tambahkan ekspor `READ_ONLY_TOOLS` di `src/tools/registry.js`:

```javascript
/**
 * Set of tools that are idempotent and safe for concurrent execution
 */
export const READ_ONLY_TOOLS = new Set([
  'read_file',
  'grep_file',
  'search_files',
  'list_dir',
  'git_status',
  'git_diff',
  'web_fetch',
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/parallel_tools.test.js`
Expected: PASS (1 test passing).

- [ ] **Step 5: Commit**

```bash
git add src/tools/registry.js tests/parallel_tools.test.js
git commit -m "feat(tools): export READ_ONLY_TOOLS set for concurrent execution"
```

---

### Task 2: Implement Tool Partitioner Module

**Files:**
- Create: `src/agent/tool-partitioner.js`
- Test: `tests/parallel_tools.test.js`

- [ ] **Step 1: Write failing tests for `partitionToolCalls`**

Tambahkan block test di `tests/parallel_tools.test.js`:

```javascript
import { partitionToolCalls } from '../src/agent/tool-partitioner.js';

describe('Parallel Tools: Partitioner', () => {
  test('should return empty array for empty function calls', () => {
    const chunks = partitionToolCalls([], READ_ONLY_TOOLS);
    assert.deepEqual(chunks, []);
  });

  test('should partition consecutive read tools into a single parallel chunk', () => {
    const calls = [
      { name: 'read_file', args: { filePath: 'a.js' } },
      { name: 'grep_file', args: { query: 'test' } },
      { name: 'list_dir', args: { dirPath: '.' } },
    ];
    const chunks = partitionToolCalls(calls, READ_ONLY_TOOLS);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].type, 'parallel');
    assert.equal(chunks[0].calls.length, 3);
    assert.equal(chunks[0].calls[0].originalIndex, 0);
    assert.equal(chunks[0].calls[1].originalIndex, 1);
    assert.equal(chunks[0].calls[2].originalIndex, 2);
  });

  test('should partition mutating tools as separate sequential chunks', () => {
    const calls = [
      { name: 'write_file', args: { filePath: 'a.js', content: 'x' } },
      { name: 'execute_command', args: { command: 'ls' } },
    ];
    const chunks = partitionToolCalls(calls, READ_ONLY_TOOLS);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].type, 'sequential');
    assert.equal(chunks[0].call.name, 'write_file');
    assert.equal(chunks[0].call.originalIndex, 0);
    assert.equal(chunks[1].type, 'sequential');
    assert.equal(chunks[1].call.name, 'execute_command');
    assert.equal(chunks[1].call.originalIndex, 1);
  });

  test('should correctly interleave parallel and sequential chunks', () => {
    const calls = [
      { name: 'read_file', args: { filePath: 'a.js' } },
      { name: 'grep_file', args: { query: 'foo' } },
      { name: 'patch_file', args: { filePath: 'a.js' } },
      { name: 'search_files', args: { pattern: '*.js' } },
    ];
    const chunks = partitionToolCalls(calls, READ_ONLY_TOOLS);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].type, 'parallel');
    assert.equal(chunks[0].calls.length, 2);
    assert.equal(chunks[1].type, 'sequential');
    assert.equal(chunks[1].call.name, 'patch_file');
    assert.equal(chunks[2].type, 'parallel');
    assert.equal(chunks[2].calls.length, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/parallel_tools.test.js`
Expected: FAIL with `Cannot find module '../src/agent/tool-partitioner.js'`.

- [ ] **Step 3: Implement `src/agent/tool-partitioner.js`**

Buat file `src/agent/tool-partitioner.js`:

```javascript
/**
 * Partitions an array of function calls into sequential chunks and parallel chunks.
 *
 * Consecutive read-only tools are grouped into `{ type: 'parallel', calls: [...] }`.
 * Mutating or interactive tools are isolated as `{ type: 'sequential', call: ... }`.
 * Each item in a chunk includes its `originalIndex` to preserve response ordering.
 *
 * @param {Array<{name: string, args: object}>} functionCalls
 * @param {Set<string>} readOnlyTools
 * @returns {Array<{ type: 'parallel', calls: Array<object> } | { type: 'sequential', call: object }>}
 */
export function partitionToolCalls(functionCalls, readOnlyTools) {
  if (!Array.isArray(functionCalls) || functionCalls.length === 0) {
    return [];
  }

  const chunks = [];
  let currentParallelChunk = null;

  for (let i = 0; i < functionCalls.length; i++) {
    const fc = functionCalls[i];
    const isReadOnly = readOnlyTools.has(fc.name);

    if (isReadOnly) {
      if (!currentParallelChunk) {
        currentParallelChunk = {
          type: 'parallel',
          calls: [],
        };
        chunks.push(currentParallelChunk);
      }
      currentParallelChunk.calls.push({
        ...fc,
        originalIndex: i,
      });
    } else {
      currentParallelChunk = null;
      chunks.push({
        type: 'sequential',
        call: {
          ...fc,
          originalIndex: i,
        },
      });
    }
  }

  return chunks;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/parallel_tools.test.js`
Expected: PASS (all partitioner tests passing).

- [ ] **Step 5: Commit**

```bash
git add src/agent/tool-partitioner.js tests/parallel_tools.test.js
git commit -m "feat(agent): implement tool call partitioner for parallel execution"
```

---

### Task 3: Integrate Parallel Execution into `AgentOrchestrator`

**Files:**
- Modify: `src/agent/orchestrator.js:20-35`, `src/agent/orchestrator.js:367-420`
- Test: `tests/parallel_tools.test.js`

- [ ] **Step 1: Write integration test for concurrent speedup and order preservation**

Tambahkan block test di `tests/parallel_tools.test.js`:

```javascript
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentOrchestrator } from '../src/agent/orchestrator.js';
import { SessionManager } from '../src/agent/session.js';

describe('Parallel Tools: Orchestrator Integration', () => {
  let tempDir;
  let sessionManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faycli-parallel-test-'));
    sessionManager = new SessionManager({ sessionsDir: tempDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  test('should execute multiple read_file calls concurrently and preserve message order', async () => {
    const fileA = path.join(tempDir, 'a.txt');
    const fileB = path.join(tempDir, 'b.txt');
    fs.writeFileSync(fileA, 'Content A', 'utf8');
    fs.writeFileSync(fileB, 'Content B', 'utf8');

    let turn = 0;
    const mockLlm = {
      getModel: () => 'gemini-2.5-flash',
      generateStream: async () => {
        turn++;
        if (turn === 1) {
          return {
            text: '',
            functionCalls: [
              { name: 'read_file', args: { filePath: 'a.txt' } },
              { name: 'read_file', args: { filePath: 'b.txt' } },
            ],
            finishReason: 'TOOL_CALL',
          };
        }
        return {
          text: 'Both files read successfully.',
          functionCalls: [],
          finishReason: 'STOP',
        };
      },
    };

    const session = sessionManager.createSession({ workingDir: tempDir });
    const orchestrator = new AgentOrchestrator({
      llmClient: mockLlm,
      session,
      workingDir: tempDir,
    });

    const batchEvents = [];
    const result = await orchestrator.runTurn('Baca kedua file', {
      onBatchStart: (info) => batchEvents.push(info),
    });

    assert.equal(result.success, true);
    assert.equal(batchEvents.length, 1);
    assert.equal(batchEvents[0].parallel, true);
    assert.equal(batchEvents[0].total, 2);

    // Verify session function response order matches original calls
    const messages = session.getMessages();
    const funcResponses = messages.filter((m) => m.role === 'function');
    assert.equal(funcResponses.length, 2);
    assert.equal(funcResponses[0].parts[0].functionResponse.name, 'read_file');
    assert.equal(funcResponses[0].parts[0].functionResponse.response.content, 'Content A');
    assert.equal(funcResponses[1].parts[0].functionResponse.name, 'read_file');
    assert.equal(funcResponses[1].parts[0].functionResponse.response.content, 'Content B');
  });

  test('should handle independent error in parallel batch without aborting sibling tools', async () => {
    const fileA = path.join(tempDir, 'exists.txt');
    fs.writeFileSync(fileA, 'Existing content', 'utf8');

    let turn = 0;
    const mockLlm = {
      getModel: () => 'gemini-2.5-flash',
      generateStream: async () => {
        turn++;
        if (turn === 1) {
          return {
            text: '',
            functionCalls: [
              { name: 'read_file', args: { filePath: 'non_existent.txt' } },
              { name: 'read_file', args: { filePath: 'exists.txt' } },
            ],
            finishReason: 'TOOL_CALL',
          };
        }
        return {
          text: 'Handled error gracefully.',
          functionCalls: [],
          finishReason: 'STOP',
        };
      },
    };

    const session = sessionManager.createSession({ workingDir: tempDir });
    const orchestrator = new AgentOrchestrator({
      llmClient: mockLlm,
      session,
      workingDir: tempDir,
    });

    const result = await orchestrator.runTurn('Coba baca file', {});
    assert.equal(result.success, true);

    const messages = session.getMessages();
    const funcResponses = messages.filter((m) => m.role === 'function');
    assert.equal(funcResponses.length, 2);

    // First tool failed
    assert.equal(funcResponses[0].parts[0].functionResponse.response.error, true);
    // Second tool succeeded
    assert.equal(funcResponses[1].parts[0].functionResponse.response.content, 'Existing content');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/parallel_tools.test.js`
Expected: FAIL (onBatchStart not called, or orchestrator not executing partitioned chunks).

- [ ] **Step 3: Modify `src/agent/orchestrator.js` to execute partitioned chunks**

1. Import `READ_ONLY_TOOLS` and `partitionToolCalls` at top of `src/agent/orchestrator.js`:

```javascript
import { READ_ONLY_TOOLS } from '../tools/registry.js';
import { partitionToolCalls } from './tool-partitioner.js';
```

2. Replace Step 5 in `runTurn()` (around line 367) with:

```javascript
      // Step 5: Execute tool calls through Security Guard and Actuators (Partitioned Concurrency)
      const chunks = partitionToolCalls(functionCalls, READ_ONLY_TOOLS);
      const turnResponses = new Array(functionCalls.length);

      const executeSingleCall = async (fc, originalIndex) => {
        const { name, args } = fc;

        if (typeof options.onToolCall === 'function') {
          options.onToolCall(fc);
        }

        const toolExecution = await dispatchToolCall(name, args, {
          securityGuard: this.securityGuard,
          baseDir: this.workingDir,
          logger: this.logger,
          signal,
        });

        let responsePayload;
        if (toolExecution.error) {
          responsePayload = {
            error: true,
            status: 'error',
            message: toolExecution.message || 'Tool execution failed',
          };
          this.logger.warn(`Tool "${name}" failed: ${toolExecution.message}`);
        } else {
          responsePayload =
            toolExecution.result !== undefined ? toolExecution.result : { status: 'ok' };
        }

        const record = {
          name,
          args,
          response: responsePayload,
          iteration: currentIteration,
        };

        if (typeof options.onToolResult === 'function') {
          options.onToolResult(name, responsePayload);
        }

        return { originalIndex, name, responsePayload, record };
      };

      for (const chunk of chunks) {
        if (chunk.type === 'parallel') {
          if (typeof options.onBatchStart === 'function') {
            options.onBatchStart({ total: chunk.calls.length, parallel: true });
          }

          const chunkResults = await Promise.all(
            chunk.calls.map((c) => executeSingleCall(c, c.originalIndex)),
          );

          for (const res of chunkResults) {
            turnResponses[res.originalIndex] = res;
          }
        } else {
          if (typeof options.onBatchStart === 'function') {
            options.onBatchStart({ total: 1, parallel: false });
          }

          const res = await executeSingleCall(chunk.call, chunk.call.originalIndex);
          turnResponses[res.originalIndex] = res;
        }
      }

      // Record tool executions and commit responses to session in strict original order
      for (let i = 0; i < turnResponses.length; i++) {
        const item = turnResponses[i];
        if (item) {
          executedToolCalls.push(item.record);
          this.session.addFunctionResponseMessage(item.name, item.responsePayload);
        }
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/parallel_tools.test.js`
Expected: PASS (all unit & integration tests passing).

- [ ] **Step 5: Run all existing unit tests to check for regressions**

Run: `npm test`
Expected: ALL test suites PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/orchestrator.js tests/parallel_tools.test.js
git commit -m "feat(orchestrator): execute read-only tool calls in parallel with preserved order"
```

---

### Task 4: Enhance Terminal UI & Spinner in REPL

**Files:**
- Modify: `src/cli/repl.js:267-285`
- Test: `tests/plan-mode-repl.test.js` or `tests/session-status-repl.test.js`

- [ ] **Step 1: Check existing tool call UI callbacks in `src/cli/repl.js`**

Periksa baris 267-285 di `src/cli/repl.js`:
Saat ini ada `onToolCall` dan `onToolResult`. Kita tambahkan handler `onBatchStart` untuk mengabarkan bila terdapat eksekusi paralel.

- [ ] **Step 2: Add `onBatchStart` handler in `src/cli/repl.js`**

Modifikasi opsi `orchestrator.runTurn` di `src/cli/repl.js`:

```javascript
        onBatchStart: ({ total, parallel }) => {
          if (parallel && total > 1) {
            spinner.start(t('runningParallelTools', { count: total }) || `Running ${total} tools in parallel…`);
          }
        },
        onToolCall: (call) => {
          if (spinner.isSpinning()) {
            spinner.stop();
          }
          const argsStr = JSON.stringify(call.args || {}).slice(0, 50);
          output.write(
            `\n${ansi.magenta('⚡ [TOOL]')} ${ansi.bold(call.name)} ${ansi.dim(argsStr)}\n`,
          );
          spinner.start(t('runningTool', { tool: call.name }));
        },
```

Tambahkan translation string di `src/i18n/locales/en.json` dan `src/i18n/locales/id.json`:
- `en.json`: `"runningParallelTools": "Running {count} tools in parallel…"`
- `id.json`: `"runningParallelTools": "Menjalankan {count} tool secara paralel…"`

- [ ] **Step 3: Run i18n & repl tests**

Run: `node --test tests/i18n.test.js tests/plan-mode-repl.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/cli/repl.js src/i18n/locales/en.json src/i18n/locales/id.json
git commit -m "feat(ui): display parallel tool batch progress in REPL spinner"
```

---

### Task 5: Final Validation & Formatting

**Files:**
- Modify: Codebase formatting
- Test: Full test suite

- [ ] **Step 1: Run format and lint checks**

Run: `npm run lint`
Expected: Biome check clean with 0 errors.

- [ ] **Step 2: Run entire test suite**

Run: `npm test`
Expected: All test suites pass.

- [ ] **Step 3: Commit if any formatting adjustments were made**

```bash
git add -u
git commit -m "chore: format and lint parallel tools implementation"
```
