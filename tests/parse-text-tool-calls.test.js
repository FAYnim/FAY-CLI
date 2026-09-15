/**
 * Snapshot tests for parseTextToolCalls (src/llm/openai.js).
 *
 * These tests lock in the exact extraction behavior for every known model
 * output format the parser handles, so the implementation can be refactored
 * without changing observable results.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseTextToolCalls } from '../src/llm/openai.js';

describe('parseTextToolCalls', () => {
  test('returns [] for null, undefined, non-string and empty input', () => {
    assert.deepEqual(parseTextToolCalls(null), []);
    assert.deepEqual(parseTextToolCalls(undefined), []);
    assert.deepEqual(parseTextToolCalls(42), []);
    assert.deepEqual(parseTextToolCalls(''), []);
  });

  test('returns [] for plain text without tool calls', () => {
    assert.deepEqual(parseTextToolCalls('Hello, I cannot help with that.'), []);
    assert.deepEqual(
      parseTextToolCalls('The file read_file is mentioned but no JSON follows.'),
      [],
    );
  });

  describe('pattern: <tool_calls>/<tool_call> container blocks', () => {
    test('container with name, separator and JSON args', () => {
      const text =
        '<tool_calls>write_file<tool_sep>{"filePath": "notes.txt", "content": "hello"}</tool_calls>';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'write_file', args: { filePath: 'notes.txt', content: 'hello' } },
      ]);
    });

    test('container with explicit <tool_name> tag and JSON args', () => {
      const text = '<tool_calls><tool_name>read_file</tool_name>{"filePath": "a.txt"}</tool_calls>';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'read_file', args: { filePath: 'a.txt' } },
      ]);
    });

    test('tool_call wrapping JSON yields single clean call', () => {
      const text =
        '<tool_call>{"name": "read_file", "arguments": {"filePath": "src/index.js"}}</tool_call>';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'read_file', args: { filePath: 'src/index.js' } },
      ]);
    });

    test('plural container unwraps {name, arguments} cleanly', () => {
      const text = '<tool_calls>{"name": "read_file", "arguments": {"path": "a.txt"}}</tool_calls>';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'read_file', args: { path: 'a.txt' } },
      ]);
    });

    test('malformed JSON inside container yields no call', () => {
      const text =
        '<tool_calls>write_file<tool_sep>{"filePath": "a.txt", "content": }</tool_calls>';
      assert.deepEqual(parseTextToolCalls(text), []);
    });
  });

  describe('pattern: <tool_call>/<function_call> wrapping JSON', () => {
    test('function_call variant with arguments object (single call, container pass does not match)', () => {
      const text =
        '<function_call>{"name": "execute_command", "arguments": {"command": "ls -la"}}</function_call>';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'execute_command', args: { command: 'ls -la' } },
      ]);
    });

    test('arguments provided as JSON-encoded string yields single clean call', () => {
      const text =
        '<tool_call>{"name": "execute_command", "arguments": "{\\"command\\": \\"pwd\\"}"}</tool_call>';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'execute_command', args: { command: 'pwd' } },
      ]);
    });

    test('name resolved from "tool" key and args from "parameters" key', () => {
      const text = '<tool_call>{"tool": "list_dir", "parameters": {"dirPath": "/tmp"}}</tool_call>';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'list_dir', args: { dirPath: '/tmp' } },
      ]);
    });

    test('name resolved from "function" key', () => {
      const text =
        '<tool_call>{"function": "patch_file", "arguments": {"searchString": "x", "replaceString": "y"}}</tool_call>';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'patch_file', args: { searchString: 'x', replaceString: 'y' } },
      ]);
    });

    test('invalid tool name is rejected', () => {
      const text =
        '<tool_call>{"name": "delete_everything", "arguments": {"path": "/"}}</tool_call>';
      assert.deepEqual(parseTextToolCalls(text), []);
    });

    test('JSON without a name key yields no call (no standalone fallback)', () => {
      const text = '<tool_call>{"filePath": "orphan.txt", "content": "hi"}</tool_call>';
      assert.deepEqual(parseTextToolCalls(text), []);
    });
  });

  describe('pattern: underscore XML blocks (<tool_call><_function_call>/< _action>)', () => {
    test('_action block with tool_name and command tag', () => {
      const text =
        '<tool_call><_action><tool_name>execute_command</tool_name><command>ls</command></action>';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'execute_command', args: { command: 'ls' } },
      ]);
    });

    test('_function_call block maps <path> to filePath', () => {
      const text =
        '<tool_call><_function_call><tool_name>read_file</tool_name><path>/tmp/x.txt</path></function_call>';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'read_file', args: { filePath: '/tmp/x.txt' } },
      ]);
    });

    test('action_name tag variant', () => {
      const text =
        '<tool_call><_action><action_name>list_dir</action_name><dirPath>/sdcard</dirPath></action>';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'list_dir', args: { dirPath: '/sdcard' } },
      ]);
    });

    test('block without tool_name/action_name yields no call', () => {
      const text = '<tool_call><_action><command>ls</command></action>';
      assert.deepEqual(parseTextToolCalls(text), []);
    });
  });

  describe('pattern: <function=name> parameter blocks', () => {
    test('function= opener with parameter= tags', () => {
      const text =
        '<function=write_file><parameter=filePath>/tmp/a.txt</parameter><parameter=content>hello world</parameter></function>';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'write_file', args: { filePath: '/tmp/a.txt', content: 'hello world' } },
      ]);
    });

    test('parameter name="key" attribute variant', () => {
      const text =
        '<function=execute_command><parameter name="command">df -h</parameter></function>';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'execute_command', args: { command: 'df -h' } },
      ]);
    });

    test('path parameter is mapped to filePath', () => {
      const text = '<function=read_file><parameter=path>docs/README.md</parameter></function>';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'read_file', args: { filePath: 'docs/README.md' } },
      ]);
    });

    test('unquoted parameter name variant', () => {
      const text = '<function=list_dir><parameter name=dirPath>/home</parameter></function>';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'list_dir', args: { dirPath: '/home' } },
      ]);
    });
  });

  describe('pattern: markdown JSON code fences', () => {
    test('```json fence with name and parameters', () => {
      const text = '```json\n{"name": "read_file", "parameters": {"filePath": "README.md"}}\n```';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'read_file', args: { filePath: 'README.md' } },
      ]);
    });

    test('plain fence (no language) with args key', () => {
      const text = '```\n{"name": "list_dir", "args": {"dirPath": "/"}}\n```';
      assert.deepEqual(parseTextToolCalls(text), [{ name: 'list_dir', args: { dirPath: '/' } }]);
    });

    test('tool_name key and action_input key (ReAct style)', () => {
      const text =
        '```json\n{"tool_name": "execute_command", "action_input": {"command": "uptime"}}\n```';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'execute_command', args: { command: 'uptime' } },
      ]);
    });

    test('fence with non-JSON content yields no call', () => {
      const text = '```json\nthis is not json\n```';
      assert.deepEqual(parseTextToolCalls(text), []);
    });

    test('fence JSON without name key yields no call', () => {
      const text = '```json\n{"filePath": "x.txt", "content": "hi"}\n```';
      assert.deepEqual(parseTextToolCalls(text), []);
    });

    test('fence JSON with trailing text and no tool name yields no call', () => {
      const text = '```json\n{"command": "ls"} trailing text\n```';
      assert.deepEqual(parseTextToolCalls(text), []);
    });
  });

  describe('pattern: Action / Action Input (ReAct text)', () => {
    test('extracts the call from Action lines', () => {
      const text =
        'Let me check the directory.\nAction: execute_command\nAction Input: {"command": "ls -la"}';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'execute_command', args: { command: 'ls -la' } },
      ]);
    });

    test('only the first Action block is extracted', () => {
      const text = [
        'Action: execute_command',
        'Action Input: {"command": "ls"}',
        'Action: list_dir',
        'Action Input: {"dirPath": "/tmp"}',
      ].join('\n');
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'execute_command', args: { command: 'ls' } },
      ]);
    });

    test('malformed Action Input JSON yields no call', () => {
      const text = 'Action: execute_command\nAction Input: {"command": }';
      assert.deepEqual(parseTextToolCalls(text), []);
    });
  });

  describe('pattern: bare tool name followed by JSON', () => {
    test('tool name on its own line followed by JSON object', () => {
      const text = 'Sure, running it now.\nexecute_command\n{"command": "echo hi"}';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'execute_command', args: { command: 'echo hi' } },
      ]);
    });

    test('tool name followed by JSON with arbitrary delimiter', () => {
      const text = 'write_file<tool_sep>{"filePath": "b.txt", "content": "data"}';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'write_file', args: { filePath: 'b.txt', content: 'data' } },
      ]);
    });

    test('tool name after opening tool_call tag', () => {
      const text = '<tool_call>execute_command: {"command": "whoami"}';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'execute_command', args: { command: 'whoami' } },
      ]);
    });
  });

  describe('security H-2: standalone JSON without tool name is strictly ignored', () => {
    test('{filePath, content} returns []', () => {
      assert.deepEqual(parseTextToolCalls('{"filePath": "c.txt", "content": "hi"}'), []);
    });

    test('{content} alone returns []', () => {
      assert.deepEqual(parseTextToolCalls('{"content": "just data"}'), []);
    });

    test('{searchString, replaceString} returns []', () => {
      assert.deepEqual(parseTextToolCalls('{"searchString": "a", "replaceString": "b"}'), []);
    });

    test('{command} returns []', () => {
      assert.deepEqual(parseTextToolCalls('{"command": "ls"}'), []);
    });

    test('{dirPath, depth} returns []', () => {
      assert.deepEqual(parseTextToolCalls('{"dirPath": "/sdcard", "depth": 1}'), []);
    });

    test('{filePath} alone returns []', () => {
      assert.deepEqual(parseTextToolCalls('{"filePath": "x.txt"}'), []);
    });

    test('JSON with no characteristic parameters is ignored', () => {
      assert.deepEqual(parseTextToolCalls('{"foo": "bar", "count": 3}'), []);
    });
  });

  describe('<think> reasoning preprocessing', () => {
    test('tool call inside a think block is not extracted', () => {
      const text =
        '<think>I could use write_file here {"filePath": "draft.txt", "content": "x"}</think>' +
        '<tool_call>{"name": "read_file", "arguments": {"filePath": "a.txt"}}</tool_call>';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'read_file', args: { filePath: 'a.txt' } },
      ]);
    });

    test('stray think tags are stripped and do not hide calls after them', () => {
      const text = 'reasoning</think>\nexecute_command\n{"command": "echo done"}';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'execute_command', args: { command: 'echo done' } },
      ]);
    });
  });

  describe('multiple calls, ordering and deduplication', () => {
    test('two tool_call blocks are parsed cleanly in order without duplicates', () => {
      const text =
        '<tool_call>{"name": "read_file", "arguments": {"filePath": "a.txt"}}</tool_call>\n' +
        '<tool_call>{"name": "execute_command", "arguments": {"command": "ls"}}</tool_call>';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'read_file', args: { filePath: 'a.txt' } },
        { name: 'execute_command', args: { command: 'ls' } },
      ]);
    });

    test('two function= blocks are returned in output order', () => {
      const text =
        '<function=read_file><parameter=filePath>a.txt</parameter></function>\n' +
        '<function=execute_command><parameter=command>ls</parameter></function>';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'read_file', args: { filePath: 'a.txt' } },
        { name: 'execute_command', args: { command: 'ls' } },
      ]);
    });

    test('identical duplicate tagged blocks collapse to one call', () => {
      const text =
        '<tool_call>{"name": "read_file", "arguments": {"filePath": "a.txt"}}</tool_call>\n' +
        '<tool_call>{"name": "read_file", "arguments": {"filePath": "a.txt"}}</tool_call>';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'read_file', args: { filePath: 'a.txt' } },
      ]);
    });

    test('same tool name with different args is kept twice', () => {
      const text =
        '<function=write_file><parameter=filePath>a.txt</parameter><parameter=content>one</parameter></function>\n' +
        '<function=write_file><parameter=filePath>b.txt</parameter><parameter=content>two</parameter></function>';
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'write_file', args: { filePath: 'a.txt', content: 'one' } },
        { name: 'write_file', args: { filePath: 'b.txt', content: 'two' } },
      ]);
    });
  });

  describe('realistic full model responses', () => {
    test('DeepSeek-R1 style: reasoning then tagged JSON call', () => {
      const text = [
        '<think>',
        'The user wants to see the files in the current directory.',
        'I should run list_dir on the project root.',
        '</think>',
        'I will list the files for you.',
        '<tool_call>{"name": "list_dir", "arguments": {"dirPath": ".", "depth": 1}}</tool_call>',
      ].join('\n');
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'list_dir', args: { dirPath: '.', depth: 1 } },
      ]);
    });

    test('markdown response ending with a fenced write_file call', () => {
      const text = [
        'Here is my plan:',
        '',
        '1. Create the config file',
        '',
        '```json',
        '{"name": "write_file", "arguments": {"filePath": "config.json", "content": "{\\"debug\\": true}"}}',
        '```',
      ].join('\n');
      assert.deepEqual(parseTextToolCalls(text), [
        { name: 'write_file', args: { filePath: 'config.json', content: '{"debug": true}' } },
      ]);
    });
  });
});
