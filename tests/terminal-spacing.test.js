/**
 * Unit Tests: Terminal Output Spacing
 * Verifies that consecutive tool calls, streaming tokens, and turn-end
 * output do not produce excessive blank lines (more than 1 consecutive
 * empty line) in the terminal output.
 */

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';
import { Session } from '../src/agent/session.js';
import { startRepl } from '../src/cli/repl.js';
import { runSingleShot } from '../src/cli/single-shot.js';

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

/**
 * Count the maximum number of consecutive blank lines found in a string.
 * Returns the highest run of empty lines seen.
 */
function maxConsecutiveBlankLines(str) {
  // Strip ANSI escape codes for clean inspection
  // eslint-disable-next-line no-control-regex
  const clean = str.replace(/\x1b\[[0-9;]*[mGKHFA-Za-z]/g, '');
  const lines = clean.split('\n');
  let max = 0;
  let current = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      current++;
      if (current > max) max = current;
    } else {
      current = 0;
    }
  }
  return max;
}

/**
 * Extracts the "agent body" portion of terminal output — the section
 * between the first tool call marker (⚡ [TOOL]) and the status bar line,
 * to avoid counting blank lines in REPL chrome (header, goodbye, prompts).
 */
function extractAgentBody(str) {
  // Strip ANSI escape codes
  // eslint-disable-next-line no-control-regex
  const clean = str.replace(/\x1b\[[0-9;]*[mGKHFA-Za-z]/g, '');
  const firstTool = clean.indexOf('[TOOL]');
  if (firstTool === -1) return clean;
  // Status bar contains "tok │" which is unique to the status line
  const statusBar = clean.indexOf('tok │', firstTool);
  if (statusBar === -1) return clean.slice(firstTool);
  // Find start of status bar line
  const lineStart = clean.lastIndexOf('\n', statusBar);
  return clean.slice(firstTool, lineStart);
}

/**
 * Creates a fake orchestrator that simulates multiple consecutive tool calls
 * followed by a streaming text response.
 */
function createMultiToolOrchestrator(session) {
  return {
    provider: 'gemini',
    workingDir: '/tmp/fake',
    maxIterations: 30,
    maxContextTokens: undefined,
    llmClient: { getModel: () => 'gemini-2.5-flash' },
    getSession: () => session,
    async runTurn(_prompt, opts = {}) {
      opts.onIterationStart?.(1);

      // Simulate 3 consecutive tool calls
      opts.onToolCall?.({ name: 'read_file', args: { path: 'src/foo.js' } });
      opts.onToolResult?.('read_file', { status: 'ok', content: 'file contents' });

      opts.onToolCall?.({ name: 'grep_file', args: { pattern: 'foo' } });
      opts.onToolResult?.('grep_file', { status: 'ok', content: 'line 1: foo' });

      opts.onToolCall?.({ name: 'read_file', args: { path: 'src/bar.js' } });
      opts.onToolResult?.('read_file', { status: 'ok', content: 'bar contents' });

      // Simulate streaming tokens after tools are done
      opts.onToken?.('\nHere is my analysis:\n');
      opts.onToken?.('Everything looks good.\n');

      return {
        success: true,
        text: 'Here is my analysis:\nEverything looks good.',
        iterations: 1,
        toolCalls: [],
        loopLimitReached: false,
        session,
      };
    },
  };
}

/**
 * Creates a fake orchestrator that simulates tool calls followed by
 * a multi-iteration turn (iteration 2 starts after tools).
 */
function createMultiIterationOrchestrator(session) {
  return {
    provider: 'gemini',
    workingDir: '/tmp/fake',
    maxIterations: 30,
    maxContextTokens: undefined,
    llmClient: { getModel: () => 'gemini-2.5-flash' },
    getSession: () => session,
    async runTurn(_prompt, opts = {}) {
      // Iteration 1: tool call
      opts.onIterationStart?.(1);
      opts.onToolCall?.({ name: 'read_file', args: { path: 'src/foo.js' } });
      opts.onToolResult?.('read_file', { status: 'ok', content: 'file contents' });

      // Iteration 2: LLM responds with text
      opts.onIterationStart?.(2);
      opts.onToken?.('\n\nThe result is done.\n');

      return {
        success: true,
        text: 'The result is done.',
        iterations: 2,
        toolCalls: [],
        loopLimitReached: false,
        session,
      };
    },
  };
}

describe('Terminal Spacing: consecutive tool calls (REPL)', () => {
  test('no more than 1 consecutive blank line between tool calls', async () => {
    const session = new Session({});
    const io = createIO();
    const orchestrator = createMultiToolOrchestrator(session);

    const replDone = startRepl({
      orchestrator,
      configMgr: stubConfigMgr,
      input: io.input,
      output: io.output,
      logger: silentLogger,
    });

    io.input.write('analyze\n');
    await new Promise((r) => setTimeout(r, 60));
    io.input.write('/exit\n');
    await new Promise((r) => setTimeout(r, 30));
    io.input.end();
    await replDone;

    const text = io.getText();
    const body = extractAgentBody(text);
    const maxBlanks = maxConsecutiveBlankLines(body);
    assert.ok(
      maxBlanks <= 1,
      `Expected max 1 consecutive blank line between tool calls, got ${maxBlanks}.\nBody:\n${body}`,
    );
  });

  test('no more than 1 consecutive blank line at turn end', async () => {
    const session = new Session({});
    const io = createIO();
    const orchestrator = createMultiToolOrchestrator(session);

    const replDone = startRepl({
      orchestrator,
      configMgr: stubConfigMgr,
      input: io.input,
      output: io.output,
      logger: silentLogger,
    });

    io.input.write('analyze\n');
    await new Promise((r) => setTimeout(r, 60));
    io.input.write('/exit\n');
    await new Promise((r) => setTimeout(r, 30));
    io.input.end();
    await replDone;

    const text = io.getText();
    const body = extractAgentBody(text);
    const maxBlanks = maxConsecutiveBlankLines(body);
    assert.ok(
      maxBlanks <= 1,
      `Expected max 1 consecutive blank line at turn end, got ${maxBlanks}.\nBody:\n${body}`,
    );
  });

  test('no more than 1 consecutive blank line between multi-iteration turns', async () => {
    const session = new Session({});
    const io = createIO();
    const orchestrator = createMultiIterationOrchestrator(session);

    const replDone = startRepl({
      orchestrator,
      configMgr: stubConfigMgr,
      input: io.input,
      output: io.output,
      logger: silentLogger,
    });

    io.input.write('analyze\n');
    await new Promise((r) => setTimeout(r, 60));
    io.input.write('/exit\n');
    await new Promise((r) => setTimeout(r, 30));
    io.input.end();
    await replDone;

    const text = io.getText();
    const body = extractAgentBody(text);
    const maxBlanks = maxConsecutiveBlankLines(body);
    assert.ok(
      maxBlanks <= 1,
      `Expected max 1 consecutive blank line in multi-iteration turn, got ${maxBlanks}.\nBody:\n${body}`,
    );
  });
});

describe('Terminal Spacing: consecutive tool calls (single-shot)', () => {
  test('no more than 1 consecutive blank line between tool calls', async () => {
    const session = new Session({});
    const orchestrator = createMultiToolOrchestrator(session);
    const output = new PassThrough();
    let text = '';
    output.on('data', (chunk) => { text += chunk.toString(); });

    await runSingleShot('analyze', {
      orchestrator,
      configMgr: stubConfigMgr,
      stream: output,
      logger: silentLogger,
    });
    output.end();

    const maxBlanks = maxConsecutiveBlankLines(text);
    assert.ok(
      maxBlanks <= 1,
      `single-shot: Expected max 1 consecutive blank line, got ${maxBlanks}.\nOutput:\n${text}`,
    );
  });
});
