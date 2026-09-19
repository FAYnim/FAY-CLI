import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { AgentOrchestrator } from '../src/agent/orchestrator.js';

describe('orchestrator & repl: mention expansion in ReAct loop', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fay-repl-mention-'));
  fs.writeFileSync(path.join(tmpDir, 'data.txt'), 'secret_key_123');

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('runTurn records displayPrompt in session while LLM gets full prompt', async () => {
    let capturedContents = null;

    const mockLlmClient = {
      getModel: () => 'mock-model',
      generateStream: async ({ contents }) => {
        capturedContents = contents;
        return { text: 'I received the file.', functionCalls: [], usage: { promptTokens: 10, totalTokens: 10 } };
      },
    };

    const orchestrator = new AgentOrchestrator({
      workingDir: tmpDir,
      llmClient: mockLlmClient,
      maxIterations: 1,
    });

    const fullPrompt = 'Check this:\n\n<context_file path="data.txt">\nsecret_key_123\n</context_file>';
    const displayPrompt = 'Check this: @data.txt';

    await orchestrator.runTurn(fullPrompt, { displayPrompt });

    // Session user message should show the clean displayPrompt
    const messages = orchestrator.getSession().getMessages();
    const userMsg = messages.find((m) => m.role === 'user');
    assert.ok(userMsg);
    assert.equal(userMsg.parts[0].text, displayPrompt);

    // LLM must have received the fullPrompt with context_file
    const llmUserTurn = capturedContents.find((m) => m.role === 'user');
    assert.ok(llmUserTurn.parts[0].text.includes('<context_file path="data.txt">'));
  });
});
