# Reflection Robustness & JSON Parsing Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate recurrent reflection parse failures (`response not parseable as JSON, continuing`) by properly transmitting system instructions, enforcing JSON mode, adding schema guidance to the user prompt, making `parseReflectionResponse` resilient to markdown/embedded braces/field aliases, and mapping `response_format` in the OpenAI LLM client.

**Architecture:** 
1. Pass `REFLECTION_SYSTEM_INSTRUCTION` and `generationConfig: { responseMimeType: 'application/json' }` to `this.llmClient.generate()` in `ReflectionChecker.check()`.
2. Include explicit JSON schema (`{"finish": boolean, "reason": string}`) directly in `buildReflectionPrompt()` as in-context guardrails.
3. Enhance `parseReflectionResponse()` with multi-stage extraction (fence stripping, first-`{` to last-`}` boundary parsing) and field normalization (supporting boolean strings `"true"`/`"false"` and aliases like `completed`/`done`/`explanation`).
4. Ensure `OpenAIClient.buildRequestBody()` maps `generationConfig.responseMimeType: 'application/json'` to `response_format: { type: 'json_object' }`.
5. Fix mock in `tests/step4-reflection.test.js` where `llmClient.generate` was missing, and add comprehensive unit test cases.

**Tech Stack:** Pure Node.js ESM (>=20.0.0), Node.js `node:test`, `node:assert/strict`.

---

### File Structure & Responsibilities

- **`src/agent/reflection.js`**: Core self-evaluation component.
  - Export `REFLECTION_SYSTEM_INSTRUCTION` (removing the unused leading underscore).
  - Update `buildReflectionPrompt()` to embed explicit JSON format instructions.
  - Update `check()` to pass `systemInstruction` and `generationConfig: { responseMimeType: 'application/json' }`.
  - Rewrite `parseReflectionResponse()` to use robust fence extraction, first `{` to last `}` slice parsing, and lenient schema normalization (`finish` booleans/strings, `completed`/`done` aliases, and fallback reason strings).
- **`src/llm/openai.js`**: OpenAI adapter.
  - Update `buildRequestBody()` to map `generationConfig.responseMimeType === 'application/json'` to `payload.response_format = { type: 'json_object' }`.
- **`tests/step4-reflection.test.js`**: Reflection unit and integration tests.
  - Add tests for system instruction passing, generationConfig options, embedded braces in `reason`, markdown fences with conversational pre/postamble, string boolean normalization, and synonym key extraction.
  - Fix `mockGemini` in orchestrator integration test to define `generate()`.

---

### Task 1: Prompt & System Instruction Integration in Reflection

**Files:**
- Modify: `src/agent/reflection.js:14-50, 145-155`
- Test: `tests/step4-reflection.test.js`

- [ ] **Step 1: Write failing test verifying systemInstruction, generationConfig, and prompt schema**

In `tests/step4-reflection.test.js`, add tests in `describe('ReflectionChecker class', ...)`:

```javascript
    test('should pass systemInstruction and generationConfig to llmClient.generate', async () => {
      let capturedOptions = null;
      const mockClient = {
        generate: async (opts) => {
          capturedOptions = opts;
          return { text: '{ "finish": true, "reason": "task complete" }' };
        },
      };
      const checker = new ReflectionChecker(mockClient, { interval: 1 });
      checker.record(1, [{ name: 'read_file', args: { filePath: 'foo.txt' } }]);

      await checker.check('analyze foo.txt', 1);

      assert.ok(capturedOptions, 'generate should have been called');
      assert.ok(capturedOptions.systemInstruction, 'systemInstruction must be passed');
      assert.match(
        typeof capturedOptions.systemInstruction === 'string'
          ? capturedOptions.systemInstruction
          : capturedOptions.systemInstruction?.parts?.[0]?.text || '',
        /AI agent progress evaluator/
      );
      assert.equal(
        capturedOptions.generationConfig?.responseMimeType,
        'application/json'
      );
      assert.match(
        capturedOptions.contents[0].parts[0].text,
        /"finish":\s*(true|false)/i
      );
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/step4-reflection.test.js`  
Expected: FAIL with assertion error (`systemInstruction must be passed`).

- [ ] **Step 3: Update `src/agent/reflection.js`**

1. Rename `_REFLECTION_SYSTEM_INSTRUCTION` to `export const REFLECTION_SYSTEM_INSTRUCTION`.
2. Update `buildReflectionPrompt()` to include explicit schema expectations:

```javascript
export function buildReflectionPrompt(originalPrompt, iterationCount, recentToolCalls) {
  const callsDetail =
    recentToolCalls.length > 0
      ? recentToolCalls.map((c) => `  - ${c.name}(${JSON.stringify(c.args)})`).join('\n')
      : '  (none yet)';

  return `TASK: ${originalPrompt}

PROGRESS:
- Current iteration: ${iterationCount}
- Recent tool calls made:
${callsDetail}

EVALUATE: Has the task been completed?
Respond ONLY with a JSON object in this exact format:
{
  "finish": true or false,
  "reason": "Brief explanation"
}`;
}
```

3. Update `ReflectionChecker.check()` to pass `systemInstruction` and `generationConfig`:

```javascript
      const result = await this.llmClient.generate({
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        systemInstruction: REFLECTION_SYSTEM_INSTRUCTION,
        generationConfig: { responseMimeType: 'application/json' },
        timeoutMs: 15000,
      });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/step4-reflection.test.js`  
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/agent/reflection.js tests/step4-reflection.test.js
git commit -m "fix(reflection): pass system instruction and generationConfig to llmClient"
```

---

### Task 2: Resilient JSON Parsing and Field Normalization

**Files:**
- Modify: `src/agent/reflection.js:53-85`
- Test: `tests/step4-reflection.test.js`

- [ ] **Step 1: Write failing tests for robust JSON parsing edge cases**

In `tests/step4-reflection.test.js`, add test cases in `describe('ReflectionChecker class', ...)`:

```javascript
    test('should parse JSON with conversational preamble and markdown fence', async () => {
      const mockClient = {
        generate: async () => ({
          text: 'Here is the progress evaluation:\n```json\n{\n  "finish": false,\n  "reason": "web_fetch finished but result not analyzed"\n}\n```\nHope that helps!',
        }),
      };
      const checker = new ReflectionChecker(mockClient, { interval: 1 });
      checker.record(1, [{ name: 'web_fetch', args: { url: 'https://example.com' } }]);

      const result = await checker.check('fetch example.com', 1);
      assert.equal(result.finish, false);
      assert.equal(result.reason, 'web_fetch finished but result not analyzed');
    });

    test('should parse JSON containing curly braces inside reason string', async () => {
      const mockClient = {
        generate: async () => ({
          text: '{"finish": false, "reason": "web_fetch returned { status: 200, data: [1, 2] } needing summary"}',
        }),
      };
      const checker = new ReflectionChecker(mockClient, { interval: 1 });
      checker.record(1, [{ name: 'web_fetch', args: { url: 'https://example.com' } }]);

      const result = await checker.check('fetch and summarize', 1);
      assert.equal(result.finish, false);
      assert.ok(result.reason.includes('{ status: 200'));
    });

    test('should normalize string boolean and field aliases (completed / explanation)', async () => {
      const mockClient = {
        generate: async () => ({
          text: '{\n  "completed": "true",\n  "explanation": "All objectives met successfully"\n}',
        }),
      };
      const checker = new ReflectionChecker(mockClient, { interval: 1 });
      checker.record(1, [{ name: 'write_file', args: { filePath: 'res.txt' } }]);

      const result = await checker.check('generate res.txt', 1);
      assert.equal(result.finish, true);
      assert.equal(result.reason, 'All objectives met successfully');
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/step4-reflection.test.js`  
Expected: FAIL on the new test cases.

- [ ] **Step 3: Implement robust `parseReflectionResponse` in `src/agent/reflection.js`**

Replace `parseReflectionResponse` in `src/agent/reflection.js`:

```javascript
/**
 * Helper to normalize raw parsed object into { finish: boolean, reason: string }
 * @param {any} parsed
 * @returns {{finish: boolean, reason: string}|null}
 */
function normalizeReflectionObject(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  // Resolve finish status
  let finish = undefined;
  const rawFinish = parsed.finish ?? parsed.completed ?? parsed.done ?? parsed.is_finished ?? parsed.isComplete;
  if (typeof rawFinish === 'boolean') {
    finish = rawFinish;
  } else if (typeof rawFinish === 'string') {
    const lower = rawFinish.trim().toLowerCase();
    if (lower === 'true' || lower === 'yes' || lower === '1') finish = true;
    else if (lower === 'false' || lower === 'no' || lower === '0') finish = false;
  }

  if (typeof finish !== 'boolean') {
    return null;
  }

  // Resolve reason
  const rawReason = parsed.reason ?? parsed.explanation ?? parsed.message ?? parsed.details ?? parsed.summary;
  let reason = '';
  if (typeof rawReason === 'string') {
    reason = rawReason.trim();
  } else if (rawReason != null) {
    reason = String(rawReason).trim();
  }

  if (!reason) {
    reason = finish ? 'Task goal achieved' : 'Task in progress';
  }

  return { finish, reason };
}

/**
 * Parses a reflection response string into { finish, reason }
 * Handles markdown fences, preamble/postamble text, nested braces, and field aliases.
 *
 * @param {string} text
 * @returns {{finish: boolean, reason: string}|null}
 */
export function parseReflectionResponse(text) {
  if (!text || typeof text !== 'string') return null;

  const trimmed = text.trim();

  // 1. Direct JSON parse (if already clean JSON)
  try {
    const parsed = JSON.parse(trimmed);
    const normalized = normalizeReflectionObject(parsed);
    if (normalized) return normalized;
  } catch {}

  // 2. Extract content from markdown code fence block if present: ```json ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1]) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      const normalized = normalizeReflectionObject(parsed);
      if (normalized) return normalized;
    } catch {}
  }

  // 3. Robust substring extraction: between outermost curly braces
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(candidate);
      const normalized = normalizeReflectionObject(parsed);
      if (normalized) return normalized;
    } catch {}
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/step4-reflection.test.js`  
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/agent/reflection.js tests/step4-reflection.test.js
git commit -m "fix(reflection): robust JSON parsing and field normalization in parseReflectionResponse"
```

---

### Task 3: Support JSON Mode in OpenAI LLM Client

**Files:**
- Modify: `src/llm/openai.js:156-165`
- Test: `tests/step4-reflection.test.js`

- [ ] **Step 1: Write test for OpenAI client generationConfig JSON mode mapping**

In `tests/step4-reflection.test.js` (or OpenAI client tests), verify that `OpenAIClient.buildRequestBody` adds `response_format`:

```javascript
    test('OpenAIClient buildRequestBody maps responseMimeType to response_format', async () => {
      const { OpenAIClient } = await import('../src/llm/openai.js');
      const client = new OpenAIClient({ apiKey: 'mock-key' });
      const body = client.buildRequestBody({
        contents: 'test',
        generationConfig: { responseMimeType: 'application/json' },
      });
      assert.deepEqual(body.response_format, { type: 'json_object' });
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/step4-reflection.test.js`  
Expected: FAIL with `undefined != { type: 'json_object' }`.

- [ ] **Step 3: Update `src/llm/openai.js` in `buildRequestBody`**

In `src/llm/openai.js`, around line 156:

```javascript
    if (generationConfig) {
      if (generationConfig.temperature !== undefined) {
        payload.temperature = generationConfig.temperature;
      }
      if (generationConfig.maxOutputTokens !== undefined) {
        payload.max_tokens = generationConfig.maxOutputTokens;
      }
      if (
        generationConfig.responseMimeType === 'application/json' ||
        generationConfig.response_format?.type === 'json_object'
      ) {
        payload.response_format = { type: 'json_object' };
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/step4-reflection.test.js`  
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/llm/openai.js tests/step4-reflection.test.js
git commit -m "feat(llm/openai): map generationConfig.responseMimeType to response_format json_object"
```

---

### Task 4: Fix Mock in Orchestrator Integration Test & Verify All Tests

**Files:**
- Modify: `tests/step4-reflection.test.js:180-205`
- Test: All tests (`tests/*.test.js`)

- [ ] **Step 1: Update mock in `tests/step4-reflection.test.js`**

In `tests/step4-reflection.test.js`, locate `test('should continue when reflection returns finish:false')` around line 180.
Update `mockGemini` so it defines both `generateStream` and `generate`:

```javascript
      let callCount = 0;
      const mockGemini = {
        getModel: () => 'gemini-2.5-flash',
        generateStream: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              text: 'Membaca file terlebih dahulu.',
              functionCalls: [{ name: 'read_file', args: { filePath: 'input.txt' } }],
            };
          } else if (callCount === 2) {
            return {
              text: 'Menulis hasil.',
              functionCalls: [
                { name: 'write_file', args: { filePath: 'output.txt', content: 'processed' } },
              ],
            };
          }
          return { text: 'Selesai!', functionCalls: [] };
        },
        generate: async () => ({
          text: JSON.stringify({ finish: false, reason: 'Masih perlu memproses' }),
        }),
      };
```

- [ ] **Step 2: Run reflection test suite**

Run: `node --test tests/step4-reflection.test.js`  
Expected: PASS with 0 warnings regarding `this.llmClient.generate is not a function`.

- [ ] **Step 3: Run full test suite across codebase**

Run: `npm test`  
Expected: All test suites PASS without regressions.

- [ ] **Step 4: Commit changes**

```bash
git add tests/step4-reflection.test.js
git commit -m "test(reflection): fix mock generate in orchestrator integration test"
```
