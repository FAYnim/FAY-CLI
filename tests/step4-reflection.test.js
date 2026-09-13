/**
 * Integration & Unit Tests: Reflection Checker
 * Step 4b: Self-Evaluation Loop — verify reflection check behavior
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { AgentOrchestrator } from '../src/agent/orchestrator.js';
import { createReflectionChecker, ReflectionChecker } from '../src/agent/reflection.js';
import { SessionManager } from '../src/agent/session.js';

describe('Step 4b: Reflection Checker', () => {
  let tempDir;
  let sessionManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faycli-reflection-test-'));
    sessionManager = new SessionManager({ sessionsDir: tempDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // ─── ReflectionChecker unit tests ───────────────────────────────────────────

  describe('ReflectionChecker class', () => {
    test('should record tool calls in sliding window', () => {
      const checker = new ReflectionChecker(null, { interval: 3, windowSize: 2 });

      checker.record(1, [{ name: 'read_file', args: { filePath: 'a.txt' } }]);
      checker.record(2, [{ name: 'write_file', args: { filePath: 'b.txt' } }]);
      checker.record(3, [{ name: 'list_dir', args: { dirPath: '.' } }]);

      const history = checker.getHistory();
      assert.equal(history.length, 2); // windowSize = 2
      assert.equal(history[0].iteration, 2);
      assert.equal(history[1].iteration, 3);
      assert.equal(history[1].calls[0].name, 'list_dir');
    });

    test('should return {finish:false} when no LLM client', async () => {
      const checker = new ReflectionChecker(null);
      checker.record(1, [{ name: 'read_file', args: { filePath: 'x' } }]);
      const result = await checker.check('do something', 1);
      assert.equal(result.finish, false);
      assert.equal(result.reason, 'no_llm_client');
    });

    test('should return {finish:false} when no tool calls recorded', async () => {
      const mockClient = {
        generate: async () => ({ text: '{ "finish": true, "reason": "done" }' }),
      };
      const checker = new ReflectionChecker(mockClient);
      const result = await checker.check('do something', 1);
      assert.equal(result.finish, false);
      assert.equal(result.reason, 'no_actions_yet');
    });

    test('should parse valid JSON response and return finish:true', async () => {
      const mockClient = {
        generate: async () => ({ text: '{ "finish": true, "reason": "task complete" }' }),
      };
      const checker = new ReflectionChecker(mockClient, { interval: 1 });
      checker.record(1, [{ name: 'write_file', args: { filePath: 'out.txt', content: 'hello' } }]);

      const result = await checker.check('create out.txt', 1);
      assert.equal(result.finish, true);
      assert.equal(result.reason, 'task complete');
    });

    test('should parse JSON wrapped in markdown fences', async () => {
      const mockClient = {
        generate: async () => ({
          text: '```json\n{ "finish": false, "reason": "still working" }\n```',
        }),
      };
      const checker = new ReflectionChecker(mockClient, { interval: 1 });
      checker.record(1, [{ name: 'read_file', args: { filePath: 'a.txt' } }]);

      const result = await checker.check('read a.txt', 1);
      assert.equal(result.finish, false);
      assert.equal(result.reason, 'still working');
    });

    test('should return {finish:false} on unparseable response', async () => {
      const mockClient = {
        generate: async () => ({
          text: 'I think we should keep going because the file is not ready yet.',
        }),
      };
      const checker = new ReflectionChecker(mockClient, { interval: 1 });
      checker.record(1, [{ name: 'read_file', args: { filePath: 'a.txt' } }]);

      const result = await checker.check('read a.txt', 1);
      assert.equal(result.finish, false);
      assert.equal(result.reason, 'parse_failed');
    });

    test('should return {finish:false} on LLM error', async () => {
      const mockClient = {
        generate: async () => {
          throw new Error('network timeout');
        },
      };
      const checker = new ReflectionChecker(mockClient, { interval: 1 });
      checker.record(1, [{ name: 'read_file', args: { filePath: 'a.txt' } }]);

      const result = await checker.check('read a.txt', 1);
      assert.equal(result.finish, false);
      assert.ok(result.reason.startsWith('error:'));
    });

    test('reset() should clear history', () => {
      const checker = new ReflectionChecker(null);
      checker.record(1, [{ name: 'read_file', args: {} }]);
      assert.equal(checker.getHistory().length, 1);
      checker.reset();
      assert.equal(checker.getHistory().length, 0);
    });

    test('factory function should create instance', () => {
      const checker = createReflectionChecker(null, { interval: 2 });
      assert.ok(checker instanceof ReflectionChecker);
      assert.equal(checker.interval, 2);
    });

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

    test('OpenAIClient buildRequestBody maps responseMimeType to response_format', async () => {
      const { OpenAIClient } = await import('../src/llm/openai.js');
      const client = new OpenAIClient({ apiKey: 'mock-key' });
      const body = client.buildRequestBody({
        contents: 'test',
        generationConfig: { responseMimeType: 'application/json' },
      });
      assert.deepEqual(body.response_format, { type: 'json_object' });
    });
  });

  // ─── Orchestrator integration tests ─────────────────────────────────────────

  describe('Orchestrator with Reflection', () => {
    test('should stop early when reflection returns finish:true', async () => {
      let callCount = 0;
      const mockGemini = {
        getModel: () => 'gemini-2.5-flash',
        generateStream: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              text: 'Writing output file...',
              functionCalls: [
                { name: 'write_file', args: { filePath: 'result.txt', content: 'done' } },
              ],
            };
          }
          return { text: 'Finished!', functionCalls: [] };
        },
        generate: async () => ({
          text: '{ "finish": true, "reason": "task complete after write" }',
        }),
      };

      const session = sessionManager.createSession({ workingDir: tempDir });
      const orchestrator = new AgentOrchestrator({
        llmClient: mockGemini,
        session,
        workingDir: tempDir,
        autoApprove: true,
        maxIterations: 10,
      });

      const result = await orchestrator.runTurn('Buat file result.txt dengan isi done', {
        reflectionInterval: 1,
      });

      // Reflection at iter 1 should say finish=true → loop breaks after 1 iteration
      assert.equal(result.success, true);
      assert.equal(result.iterations, 1);
      assert.equal(result.toolCalls.length, 1);
      assert.equal(result.loopLimitReached, false);
    });

    test('should continue when reflection returns finish:false', async () => {
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
      };

      const session = sessionManager.createSession({ workingDir: tempDir });
      const orchestrator = new AgentOrchestrator({
        llmClient: mockGemini,
        session,
        workingDir: tempDir,
        autoApprove: true,
        maxIterations: 10,
      });

      const result = await orchestrator.runTurn('Baca input.txt dan tulis ke output.txt', {
        reflectionInterval: 1,
      });

      // Reflection at iter 1 says false, iter 2 says false, iter 3 gives final answer
      assert.equal(result.success, true);
      assert.equal(result.iterations, 3);
      assert.equal(result.toolCalls.length, 2);
      assert.equal(result.text, 'Selesai!');
    });

    test('should skip reflection on last iteration (safety net)', async () => {
      let _streamCallCount = 0;
      const reflectionCalls = [];
      const mockGemini = {
        getModel: () => 'gemini-2.5-flash',
        generateStream: async () => {
          _streamCallCount++;
          return {
            text: 'Looping...',
            functionCalls: [{ name: 'list_dir', args: { dirPath: '.' } }],
          };
        },
        generate: async (opts) => {
          reflectionCalls.push(opts);
          return { text: '{ "finish": false, "reason": "still going" }' };
        },
      };

      const session = sessionManager.createSession({ workingDir: tempDir });
      const orchestrator = new AgentOrchestrator({
        llmClient: mockGemini,
        session,
        workingDir: tempDir,
        autoApprove: true,
        maxIterations: 3,
      });

      const result = await orchestrator.runTurn('Scan berulang', {
        reflectionInterval: 1,
      });

      // Reflection fires at iter 1 (not last), skipped at iter 2 (maxIter-1 = safety net)
      // Then breaks at iter 3 by loop ceiling
      assert.equal(result.loopLimitReached, true);
      assert.equal(result.success, false);
      assert.equal(result.iterations, 3);
      // Should have been called once (at iter 1, skipped at iter 2 which is last)
      assert.equal(reflectionCalls.length, 1);
    });

    test('should handle reflection LLM error gracefully without breaking loop', async () => {
      let streamCallCount = 0;
      const mockGemini = {
        getModel: () => 'gemini-2.5-flash',
        generateStream: async () => {
          streamCallCount++;
          if (streamCallCount === 1) {
            return {
              text: 'Reading...',
              functionCalls: [{ name: 'read_file', args: { filePath: 'a.txt' } }],
            };
          }
          return { text: 'Done!', functionCalls: [] };
        },
        generate: async () => {
          throw new Error('API down');
        },
      };

      const session = sessionManager.createSession({ workingDir: tempDir });
      const orchestrator = new AgentOrchestrator({
        llmClient: mockGemini,
        session,
        workingDir: tempDir,
        autoApprove: true,
        maxIterations: 5,
      });

      const result = await orchestrator.runTurn('Baca a.txt', {
        reflectionInterval: 1,
      });

      // Should continue despite reflection error
      assert.equal(result.success, true);
      assert.equal(result.iterations, 2);
      assert.equal(result.text, 'Done!');
    });

    test('should disable reflection when interval is 0', async () => {
      const mockGemini = {
        getModel: () => 'gemini-2.5-flash',
        generateStream: async () => ({
          text: 'Answer',
          functionCalls: [],
        }),
        generate: async () => {
          throw new Error('should not be called');
        },
      };

      const session = sessionManager.createSession({ workingDir: tempDir });
      const orchestrator = new AgentOrchestrator({
        llmClient: mockGemini,
        session,
        workingDir: tempDir,
        maxIterations: 5,
      });

      const result = await orchestrator.runTurn('Hi', {
        reflectionInterval: 0,
      });

      assert.equal(result.success, true);
      assert.equal(result.iterations, 1);
      assert.equal(result.text, 'Answer');
    });

    test('should use default reflectionInterval (3) when not specified', async () => {
      let streamCallCount = 0;
      const reflectionCalls = [];
      const mockGemini = {
        getModel: () => 'gemini-2.5-flash',
        generateStream: async () => {
          streamCallCount++;
          return {
            text: 'Working...',
            functionCalls: [{ name: 'list_dir', args: { dirPath: '.' } }],
          };
        },
        generate: async (opts) => {
          reflectionCalls.push(opts);
          return { text: '{ "finish": false, "reason": "keep going" }' };
        },
      };

      const session = sessionManager.createSession({ workingDir: tempDir });
      const orchestrator = new AgentOrchestrator({
        llmClient: mockGemini,
        session,
        workingDir: tempDir,
        autoApprove: true,
        maxIterations: 10,
      });

      await orchestrator.runTurn('Test default interval');

      // With default interval=3, reflection should fire at iteration 3
      assert.ok(reflectionCalls.length >= 1, 'Reflection should have been called at least once');
      assert.ok(streamCallCount >= 3, 'Should have run at least 3 stream calls');
    });
  });
});
