# MCP Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `faycli` able to connect MCP (Model Context Protocol) servers over stdio and expose their tools to the ReAct loop as first-class tools, without adding a single runtime dependency.

**Architecture:** A new `src/mcp/` module owns the whole protocol: a `McpClient` that spawns one child process per server and speaks newline-delimited JSON-RPC 2.0, a `schema.js` converter that turns MCP's standard JSON Schema into the Gemini function-declaration dialect, and a `McpManager` that reads config, connects enabled servers, and registers their tools into the existing tool registry. The registry gains a small dynamic-registration surface (`registerTool` / `unregisterTools` / `listDynamicTools`) so runtime tools behave exactly like the 12 builtins: they appear in `getToolDeclarations()`, they dispatch through `dispatchToolCall()`, and they route through `SecurityGuard`. `SecurityGuard` gets an explicit MCP gate because its `default:` branch currently allow-lists any unknown tool name.

**Tech Stack:** Node.js >= 20 pure ESM, `node:child_process`, `node:test`, Biome. Zero runtime dependencies.

**Deferred (explicitly not in this plan):** MCP *resources* and *prompts* (tools only), SSE/HTTP transport (stdio only), OAuth (none — stdio servers are local), a lazy meta-tool for tool discovery. The meta-tool is the escape hatch if context bloat becomes real; the trigger is "a user enables enough servers that tool declarations exceed ~15% of the context budget." Until then, per-server enable flags are sufficient.

---

## Design Decisions

**D1 — Registry stays the single dispatch path.** MCP tools are registered as real entries in `TOOLS_MAP` whose handler is `(args) => client.callTool(tool, args)`. No special case is added to `dispatchToolCall`, `normalizeToolArgs`, `partitionToolCalls`, or the orchestrator's execution loop. This is why the registry change is 3 small functions and not a refactor.

**D2 — Namespaced names.** `mcp__<server>__<tool>`. Double underscore separates server from tool, so a server id containing a single underscore still parses. This is the same convention the wider MCP ecosystem uses for flattened tool names.

**D3 — Connect at boot, gated by config.** A server only spawns when its config entry has `enabled: true`. Writing that entry via `/mcp add` *is* the user's consent — they typed the exact command. The runtime backstop is a `SecurityGuard` prompt on the first tool call to each server per session, which covers configs that were hand-edited or copied from elsewhere.

**D4 — Only one schema converter is needed.** `src/llm/types.js:155 formatTools()` wraps declarations for Gemini (which requires UPPERCASE `type`). `src/llm/openai.js:13 convertToJsonSchema()` recursively lowercases every `type`, so an UPPERCASE declaration round-trips back to standard JSON Schema for OpenAI-compatible providers. MCP's lowercase JSON Schema → Gemini UPPERCASE is therefore the only conversion written.

**D5 — Failures are collected, not thrown.** One broken MCP server must not prevent the REPL from starting. `connectAll()` returns `{ connected, failed, toolCount }` and logs warnings.

**D6 — `close()` sends stdin EOF only.** No SIGTERM/SIGKILL escalation in v1. A server that ignores EOF leaks a child until the parent exits. Marked with a `ponytail:` comment naming the upgrade path.

**D7 — `/mcp add` does not support quoted arguments.** The slash-command parser splits on `/\s+/`. Arguments containing spaces require hand-editing `~/.faycli/config.json`, which is fully supported and is the documented escape hatch.

---

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `src/mcp/protocol.js` | JSON-RPC framing (encode/decode newline-delimited), protocol version constant, tool-name namespacing helpers. No I/O, no heavy imports — safe to import from `security/`. |
| `src/mcp/schema.js` | JSON Schema → Gemini function-declaration dialect. Pure functions. |
| `src/mcp/client.js` | `McpClient` — spawn, handshake, request/response correlation, `tools/list`, `tools/call`, close. |
| `src/mcp/manager.js` | `McpManager` — config → connections → registry entries; `callTool`, `listConnected`, `closeAll`. |
| `tests/fixtures/mcp-echo-server.js` | Dependency-free MCP stdio server used by the client/manager tests. |
| `tests/mcp-schema.test.js` | Schema converter. |
| `tests/mcp-client.test.js` | Transport: handshake, call, timeout, close, stderr. |
| `tests/mcp-manager.test.js` | Config → registry wiring, partial failure, read-only hints. |
| `tests/mcp-security.test.js` | Guard gate: prompt-once, denial, autoApprove, plan mode. |
| `tests/mcp-slash.test.js` | `/mcp` subcommands and config persistence. |

**Modify:**

| Path | Change |
|---|---|
| `src/config/constants.js:93-107` | Add `mcpServers: {}` to `DEFAULT_CONFIG`. |
| `src/tools/registry.js` | Add `registerTool()`, `unregisterTools()`, `listDynamicTools()`; make `getToolDeclarations()` merge dynamic declarations. |
| `src/agent/orchestrator.js:134` | Accept `options.mcpManager`; re-read declarations each turn when the caller did not pin a tool list; filter `mcp__*` out of plan mode. |
| `src/security/guard.js:44,219` | Track approved MCP servers; block `mcp__*` in plan mode; add `_authorizeMcp()`. |
| `src/cli/slash-commands.js` | Add the `/mcp` case and its `/help` entry. |
| `src/cli/repl.js:58-115,368` | Construct `McpManager`, `connectAll()`, banner line, failure warnings, `closeAll()` on exit, pass manager into slash context. |
| `CLAUDE.md` | Document `src/mcp/` in the architecture section. |
| `README.md` | User-facing MCP section. |

---

## Task 1: Config default + protocol module

**Files:**
- Modify: `src/config/constants.js:93-107`
- Create: `src/mcp/protocol.js`
- Test: `tests/mcp-protocol.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-protocol.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MCP_PREFIX,
  MCP_PROTOCOL_VERSION,
  decodeMessages,
  encodeMessage,
  mcpToolName,
  parseMcpToolName,
} from '../src/mcp/protocol.js';

test('encodeMessage emits one line per message', () => {
  assert.equal(encodeMessage({ jsonrpc: '2.0', id: 1 }), '{"jsonrpc":"2.0","id":1}\n');
});

test('decodeMessages splits complete lines and keeps the tail', () => {
  const { messages, rest } = decodeMessages('{"a":1}\n{"b":2}\n{"c":');
  assert.deepEqual(messages, [{ a: 1 }, { b: 2 }]);
  assert.equal(rest, '{"c":');
});

test('decodeMessages drops malformed lines without losing the stream', () => {
  const { messages, rest } = decodeMessages('not json\n{"ok":true}\n');
  assert.deepEqual(messages, [{ ok: true }]);
  assert.equal(rest, '');
});

test('decodeMessages ignores blank lines', () => {
  const { messages } = decodeMessages('\n\n{"a":1}\n');
  assert.deepEqual(messages, [{ a: 1 }]);
});

test('mcpToolName and parseMcpToolName round-trip server ids with single underscores', () => {
  assert.equal(mcpToolName('my_server', 'read_file'), 'mcp__my_server__read_file');
  assert.deepEqual(parseMcpToolName('mcp__my_server__read_file'), {
    server: 'my_server',
    tool: 'read_file',
  });
});

test('parseMcpToolName rejects non-MCP and malformed names', () => {
  assert.equal(parseMcpToolName('read_file'), null);
  assert.equal(parseMcpToolName('mcp__noseparator'), null);
  assert.equal(parseMcpToolName('mcp__server__'), null);
  assert.equal(parseMcpToolName(undefined), null);
});

test('protocol version and prefix are the documented constants', () => {
  assert.equal(MCP_PREFIX, 'mcp__');
  assert.match(MCP_PROTOCOL_VERSION, /^\d{4}-\d{2}-\d{2}$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/mcp-protocol.test.js`
Expected: FAIL — `Cannot find module '.../src/mcp/protocol.js'`

- [ ] **Step 3: Write `src/mcp/protocol.js`**

```js
/**
 * MCP stdio framing and tool-name namespacing.
 *
 * The stdio transport carries one JSON-RPC 2.0 message per line; a message
 * MUST NOT contain an embedded newline (MCP spec, stdio transport). This file
 * has no I/O and no heavy imports so `security/guard.js` can import the name
 * helpers without pulling in `node:child_process`.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_PREFIX = 'mcp__';

/**
 * Serializes a JSON-RPC message for the wire.
 *
 * @param {object} msg
 * @returns {string} the message terminated by a newline
 */
export function encodeMessage(msg) {
  return `${JSON.stringify(msg)}\n`;
}

/**
 * Extracts complete messages from a text buffer.
 *
 * A line that is not valid JSON is dropped: a server writing stray text to
 * stdout is broken, and stalling the whole stream on one bad line is worse
 * than losing it.
 *
 * @param {string} buffer
 * @returns {{ messages: object[], rest: string }} parsed messages plus the
 *   unconsumed tail, which the caller must pass back in on the next chunk
 */
export function decodeMessages(buffer) {
  const messages = [];
  let rest = buffer;
  let idx = rest.indexOf('\n');
  while (idx !== -1) {
    const line = rest.slice(0, idx).trim();
    rest = rest.slice(idx + 1);
    if (line) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        /* silent-ok: malformed line from a misbehaving server */
      }
    }
    idx = rest.indexOf('\n');
  }
  return { messages, rest };
}

/**
 * Namespaces a server + tool pair into a registry-safe tool name.
 *
 * @param {string} server
 * @param {string} tool
 * @returns {string}
 */
export function mcpToolName(server, tool) {
  return `${MCP_PREFIX}${server}__${tool}`;
}

/**
 * Parses a namespaced MCP tool name back into its parts.
 *
 * @param {string} fullName
 * @returns {{ server: string, tool: string }|null} null when the name is not
 *   a well-formed MCP tool name
 */
export function parseMcpToolName(fullName) {
  if (typeof fullName !== 'string' || !fullName.startsWith(MCP_PREFIX)) {
    return null;
  }
  const rest = fullName.slice(MCP_PREFIX.length);
  const sep = rest.indexOf('__');
  if (sep <= 0 || sep >= rest.length - 2) {
    return null;
  }
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}
```

- [ ] **Step 4: Add `mcpServers` to the default config**

In `src/config/constants.js`, inside `DEFAULT_CONFIG`, add `mcpServers` after `instructionsFile`:

```js
export const DEFAULT_CONFIG = {
  activeProvider: DEFAULT_ACTIVE_PROVIDER,
  providers: {},
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
  autoConfirm: false,
  verbose: false,
  locale: 'en',
  instructionsFile: 'AGENTS.md',
  // MCP servers keyed by id. Each entry is
  // { enabled, command, args[], env{}, cwd?, timeoutMs? }.
  // Empty by default: no server is ever spawned unless the user adds one.
  mcpServers: {},
  checkpoint: {
    enabled: true,
    keep: 10,
    maxFileSize: 1048576, // 1 MB cap
  },
};
```

- [ ] **Step 5: Run the tests**

Run: `node --test tests/mcp-protocol.test.js`
Expected: PASS — 7 tests

Run: `npm test`
Expected: PASS — no regressions from the `DEFAULT_CONFIG` change

- [ ] **Step 6: Commit**

```bash
git add src/mcp/protocol.js src/config/constants.js tests/mcp-protocol.test.js
git commit -m "feat(mcp): add stdio framing helpers and mcpServers config default"
```

---

## Task 2: JSON Schema → Gemini converter

**Files:**
- Create: `src/mcp/schema.js`
- Test: `tests/mcp-schema.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-schema.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDeclaration, jsonSchemaToGemini } from '../src/mcp/schema.js';

test('jsonSchemaToGemini uppercases types recursively', () => {
  const out = jsonSchemaToGemini({
    type: 'object',
    properties: {
      path: { type: 'string', description: 'file path' },
      limit: { type: 'integer' },
      ratio: { type: 'number' },
      dry: { type: 'boolean' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['path'],
  });

  assert.equal(out.type, 'OBJECT');
  assert.equal(out.properties.path.type, 'STRING');
  assert.equal(out.properties.path.description, 'file path');
  assert.equal(out.properties.limit.type, 'INTEGER');
  assert.equal(out.properties.ratio.type, 'NUMBER');
  assert.equal(out.properties.dry.type, 'BOOLEAN');
  assert.equal(out.properties.tags.type, 'ARRAY');
  assert.equal(out.properties.tags.items.type, 'STRING');
  assert.deepEqual(out.required, ['path']);
});

test('jsonSchemaToGemini keeps enum values as strings', () => {
  const out = jsonSchemaToGemini({
    type: 'object',
    properties: { mode: { type: 'string', enum: ['fast', 'safe'] } },
  });
  assert.deepEqual(out.properties.mode.enum, ['fast', 'safe']);
  assert.equal(out.properties.mode.type, 'STRING');
});

test('jsonSchemaToGemini drops keywords Gemini rejects', () => {
  const out = jsonSchemaToGemini({
    type: 'object',
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'x',
    properties: {
      a: { type: 'string', default: 'x', examples: ['y'], title: 'A', pattern: '^x$' },
    },
  });

  assert.equal(out.additionalProperties, undefined);
  assert.equal(out.$schema, undefined);
  assert.equal(out.$id, undefined);
  assert.equal(out.properties.a.default, undefined);
  assert.equal(out.properties.a.examples, undefined);
  assert.equal(out.properties.a.title, undefined);
  assert.equal(out.properties.a.pattern, undefined);
  assert.equal(out.properties.a.type, 'STRING');
});

test('jsonSchemaToGemini defaults a schema with no type to STRING', () => {
  assert.equal(jsonSchemaToGemini({}).type, 'STRING');
  assert.equal(jsonSchemaToGemini({ description: 'anything' }).type, 'STRING');
  assert.equal(jsonSchemaToGemini(null), undefined);
  assert.equal(jsonSchemaToGemini(undefined), undefined);
});

test('jsonSchemaToGemini collapses anyOf and oneOf to their first branch', () => {
  const anyOut = jsonSchemaToGemini({
    anyOf: [{ type: 'string', description: 'as text' }, { type: 'number' }],
  });
  assert.equal(anyOut.type, 'STRING');
  assert.equal(anyOut.description, 'as text');

  const oneOut = jsonSchemaToGemini({ oneOf: [{ type: 'integer' }] });
  assert.equal(oneOut.type, 'INTEGER');
});

test('jsonSchemaToGemini leaves nested property objects without a type alone', () => {
  const out = jsonSchemaToGemini({
    type: 'object',
    properties: { nested: { type: 'object', properties: { deep: { type: 'boolean' } } } },
  });
  assert.equal(out.properties.nested.type, 'OBJECT');
  assert.equal(out.properties.nested.properties.deep.type, 'BOOLEAN');
});

test('buildDeclaration always emits an OBJECT parameter schema', () => {
  const decl = buildDeclaration('mcp__fs__read', {
    name: 'read',
    description: 'Read a file',
    inputSchema: { type: 'string' },
  });

  assert.equal(decl.name, 'mcp__fs__read');
  assert.equal(decl.description, 'Read a file');
  assert.equal(decl.parameters.type, 'OBJECT');
  assert.deepEqual(decl.parameters.properties, {});
});

test('buildDeclaration synthesizes a description when the tool has none', () => {
  const decl = buildDeclaration('mcp__fs__read', { name: 'read' });
  assert.equal(decl.description, 'MCP tool "read"');
  assert.equal(decl.parameters.type, 'OBJECT');
});

test('buildDeclaration survives the OpenAI schema round-trip', async () => {
  const { convertToJsonSchema } = await import('../src/llm/openai.js');
  const decl = buildDeclaration('mcp__fs__read', {
    name: 'read',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, deep: { type: 'boolean' } },
      required: ['path'],
    },
  });

  const back = convertToJsonSchema(decl.parameters);
  assert.equal(back.type, 'object');
  assert.equal(back.properties.path.type, 'string');
  assert.equal(back.properties.deep.type, 'boolean');
  assert.deepEqual(back.required, ['path']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/mcp-schema.test.js`
Expected: FAIL — `Cannot find module '.../src/mcp/schema.js'`

- [ ] **Step 3: Write `src/mcp/schema.js`**

```js
/**
 * Converts standard JSON Schema (as returned by MCP `tools/list`) into the
 * Gemini function-declaration dialect, which requires UPPERCASE `type` values
 * and rejects keywords it does not model.
 *
 * Only one direction is implemented: the OpenAI adapter already lowercases
 * every `type` recursively via `convertToJsonSchema()` in `src/llm/openai.js`,
 * so an UPPERCASE declaration round-trips back to standard JSON Schema.
 */

const TYPE_MAP = {
  object: 'OBJECT',
  array: 'ARRAY',
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
};

// Keywords Gemini's Schema object does not model. Forwarding an unknown key
// makes the whole generateContent request fail with 400, so they are dropped
// rather than passed through. The cost is that constraints like `pattern` and
// `additionalProperties` stop reaching the model — acceptable, because the
// MCP server validates its own inputs regardless.
const DROP_KEYS = new Set([
  '$schema',
  '$id',
  '$ref',
  'definitions',
  '$defs',
  'additionalProperties',
  'patternProperties',
  'unevaluatedProperties',
  'examples',
  'default',
  'title',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'const',
  'not',
]);

/**
 * @param {object} schema - a JSON Schema node
 * @returns {object|undefined} the Gemini Schema node, or undefined for a
 *   non-object input
 */
export function jsonSchemaToGemini(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return undefined;
  }

  const out = {};

  if (typeof schema.type === 'string' && TYPE_MAP[schema.type]) {
    out.type = TYPE_MAP[schema.type];
  }
  if (typeof schema.description === 'string' && schema.description.trim()) {
    out.description = schema.description;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    out.enum = schema.enum.map((v) => String(v));
  }
  if (Array.isArray(schema.required) && schema.required.length > 0) {
    const required = schema.required.filter((r) => typeof r === 'string' && r);
    if (required.length > 0) out.required = required;
  }

  if (schema.properties && typeof schema.properties === 'object') {
    const props = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      const converted = jsonSchemaToGemini(value);
      if (converted) props[key] = converted;
    }
    out.properties = props;
  }

  if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    const converted = jsonSchemaToGemini(schema.items);
    if (converted) out.items = converted;
  }

  // anyOf/oneOf have no Gemini equivalent. Taking the first branch preserves a
  // description that would otherwise be lost entirely; it can under-describe a
  // union, which the MCP server's own validation still catches.
  const alternative = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : null;
  if (alternative && alternative.length > 0 && !out.type) {
    const first = jsonSchemaToGemini(alternative[0]);
    if (first) {
      for (const [k, v] of Object.entries(first)) {
        if (out[k] === undefined) out[k] = v;
      }
    }
  }

  // Gemini rejects a Schema with no `type`. A description-only node becomes a
  // free-form STRING, which is the permissive reading.
  if (!out.type) {
    out.type = 'STRING';
  }

  return out;
}

/**
 * Builds a complete Gemini function declaration from an MCP tool descriptor.
 *
 * @param {string} fullName - namespaced name, e.g. `mcp__fs__read_file`
 * @param {{ name: string, description?: string, inputSchema?: object }} tool
 * @returns {{ name: string, description: string, parameters: object }}
 */
export function buildDeclaration(fullName, tool) {
  const parameters = jsonSchemaToGemini(tool?.inputSchema);

  return {
    name: fullName,
    description:
      typeof tool?.description === 'string' && tool.description.trim()
        ? tool.description
        : `MCP tool "${tool?.name ?? fullName}"`,
    // MCP tools always take an object argument bag. A server that declares a
    // scalar inputSchema would produce a non-OBJECT declaration Gemini rejects,
    // so it is normalized to an empty object schema.
    parameters:
      parameters && parameters.type === 'OBJECT'
        ? parameters
        : { type: 'OBJECT', properties: {} },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/mcp-schema.test.js`
Expected: PASS — 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/mcp/schema.js tests/mcp-schema.test.js
git commit -m "feat(mcp): convert MCP JSON Schema to Gemini function declarations"
```

---

## Task 3: MCP stdio client

**Files:**
- Create: `src/mcp/client.js`
- Create: `tests/fixtures/mcp-echo-server.js`
- Test: `tests/mcp-client.test.js`

- [ ] **Step 1: Write the fixture server**

Create `tests/fixtures/mcp-echo-server.js`. This is a real MCP server, not a mock — the client tests drive it over an actual pipe.

```js
#!/usr/bin/env node
/**
 * Minimal MCP stdio server used by the client and manager tests.
 *
 * Speaks newline-delimited JSON-RPC 2.0 and exposes two tools:
 *   echo(text)     -> returns the text back
 *   fail(message)  -> returns an isError result
 *
 * Environment knobs:
 *   MCP_ECHO_STDERR=1  also write a line to stderr (stderr isolation test)
 *   MCP_ECHO_SILENT=1  never answer `initialize` (timeout test)
 */

let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch {
        /* ignore malformed input */
      }
    }
    idx = buffer.indexOf('\n');
  }
});

if (process.env.MCP_ECHO_STDERR === '1') {
  process.stderr.write('echo server ready\n');
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the provided text back',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'text to echo' } },
      required: ['text'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'fail',
    description: 'Always returns an error result',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
    },
  },
];

function handle(msg) {
  // Notifications carry no id and expect no reply.
  if (msg.id === undefined || msg.id === null) return;

  if (msg.method === 'initialize') {
    if (process.env.MCP_ECHO_SILENT === '1') return;
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'echo', version: '0.0.1' },
      },
    });
    return;
  }

  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    return;
  }

  if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params || {};
    if (name === 'echo') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: String(args.text ?? '') }] },
      });
      return;
    }
    if (name === 'fail') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: args.message || 'boom' }],
          isError: true,
        },
      });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `Unknown tool: ${name}` },
    });
    return;
  }

  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/mcp-client.test.js`:

```js
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { McpClient, flattenContent } from '../src/mcp/client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, 'fixtures', 'mcp-echo-server.js');

function makeClient(env = {}, timeoutMs = 5000) {
  return new McpClient({
    name: 'echo',
    command: process.execPath,
    args: [SERVER],
    env,
    timeoutMs,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('connect performs the handshake and lists tools', async () => {
  const client = makeClient();
  await client.connect();
  try {
    assert.deepEqual(
      client.tools.map((t) => t.name).sort(),
      ['echo', 'fail'],
    );
  } finally {
    await client.close();
  }
});

test('callTool returns flattened text content', async () => {
  const client = makeClient();
  await client.connect();
  try {
    assert.equal(await client.callTool('echo', { text: 'halo' }), 'halo');
  } finally {
    await client.close();
  }
});

test('callTool throws when the server marks the result as an error', async () => {
  const client = makeClient();
  await client.connect();
  try {
    await assert.rejects(() => client.callTool('fail', { message: 'nope' }), /nope/);
  } finally {
    await client.close();
  }
});

test('callTool surfaces a JSON-RPC error response', async () => {
  const client = makeClient();
  await client.connect();
  try {
    await assert.rejects(() => client.callTool('does_not_exist', {}), /Unknown tool/);
  } finally {
    await client.close();
  }
});

test('a server that never answers initialize times out', async () => {
  const client = makeClient({ MCP_ECHO_SILENT: '1' }, 300);
  await assert.rejects(() => client.connect(), /timed out/);
  await client.close();
});

test('close rejects in-flight requests', async () => {
  const client = makeClient({ MCP_ECHO_SILENT: '1' }, 10000);
  const pending = client.connect().catch((err) => err);
  // Wait for the spawn to happen before closing, otherwise there is nothing
  // to reject.
  for (let i = 0; i < 50 && !client.child; i++) await sleep(10);
  await client.close();
  const err = await pending;
  assert.ok(err instanceof Error, 'connect must reject once the client closes');
});

test('stderr output does not corrupt the message stream', async () => {
  const client = makeClient({ MCP_ECHO_STDERR: '1' });
  await client.connect();
  try {
    assert.equal(await client.callTool('echo', { text: 'ok' }), 'ok');
  } finally {
    await client.close();
  }
});

test('requests after close reject instead of hanging', async () => {
  const client = makeClient();
  await client.connect();
  await client.close();
  await assert.rejects(() => client.request('tools/list', {}), /not running/);
});

test('flattenContent joins text blocks and marks non-text ones', () => {
  assert.equal(
    flattenContent([
      { type: 'text', text: 'a' },
      { type: 'image', data: 'xx' },
      { type: 'text', text: 'b' },
    ]),
    'a\n[image content omitted]\nb',
  );
  assert.equal(flattenContent(undefined), '');
  assert.equal(flattenContent([]), '');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/mcp-client.test.js`
Expected: FAIL — `Cannot find module '.../src/mcp/client.js'`

- [ ] **Step 4: Write `src/mcp/client.js`**

```js
/**
 * MCP client over stdio.
 *
 * One child process per server, JSON-RPC 2.0 with newline-delimited framing,
 * no external dependency. Requests are correlated by id with a per-request
 * timeout so a wedged server cannot hang the ReAct loop.
 */

import { spawn } from 'node:child_process';
import { MCP_PROTOCOL_VERSION, decodeMessages, encodeMessage } from './protocol.js';

export class McpClient {
  /**
   * @param {object} options
   * @param {string} options.name - server id from config (used in messages)
   * @param {string} options.command - executable to spawn
   * @param {string[]} [options.args=[]]
   * @param {object} [options.env={}] - extra env vars merged over process.env
   * @param {string} [options.cwd]
   * @param {number} [options.timeoutMs=20000] - per-request timeout
   * @param {import('../utils/logger.js').Logger} [options.logger]
   */
  constructor(options) {
    this.name = options.name;
    this.command = options.command;
    this.args = options.args || [];
    this.env = options.env || {};
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.logger = options.logger;

    this.child = null;
    this.buffer = '';
    /** @type {Map<number, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
    this.pending = new Map();
    this.nextId = 1;
    /** @type {Array<{name: string, description?: string, inputSchema?: object}>} */
    this.tools = [];
    this.closed = false;
  }

  /**
   * Spawns the server, completes the MCP handshake and caches its tool list.
   *
   * @returns {Promise<McpClient>} this
   */
  async connect() {
    if (this.child) return this;

    // ponytail: shell:true only on win32, because npx/npm ship as .cmd files
    // that Node cannot spawn directly. The command string comes from the user's
    // own config file, so the shell-injection surface is self-inflicted and no
    // wider than the `execute_command` tool that already exists. Upgrade path:
    // resolve the executable with `where`/`which` first and drop the shell.
    const useShell = process.platform === 'win32';

    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: useShell,
    });

    this.child.on('error', (err) => {
      this.closed = true;
      this._failAll(err);
    });
    this.child.on('exit', (code, signal) => {
      this.closed = true;
      this._failAll(
        new Error(`MCP server "${this.name}" exited (code=${code} signal=${signal})`),
      );
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onData(chunk));

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      const line = String(chunk).trim();
      if (line) this.logger?.debug?.(`[mcp:${this.name}] ${line}`);
    });

    await this._handshake();
    this.tools = await this._listTools();
    return this;
  }

  async _handshake() {
    await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'faycli', version: '1.0.0' },
    });
    // Required by the spec before any other request. A notification, so it
    // gets no reply and must not be awaited.
    this.notify('notifications/initialized', {});
  }

  async _listTools() {
    const result = await this.request('tools/list', {});
    const list = Array.isArray(result?.tools) ? result.tools : [];
    return list.filter((t) => t && typeof t.name === 'string' && t.name);
  }

  /**
   * Calls a tool and flattens its content blocks into a plain string.
   *
   * @param {string} toolName - bare MCP tool name, not namespaced
   * @param {object} [args={}]
   * @returns {Promise<string>}
   * @throws {Error} when the server reports `isError` or returns a JSON-RPC error
   */
  async callTool(toolName, args = {}) {
    const result = await this.request('tools/call', { name: toolName, arguments: args });
    const text = flattenContent(result?.content);
    if (result?.isError) {
      throw new Error(text || `MCP tool "${toolName}" reported an error`);
    }
    return text || JSON.stringify(result ?? {});
  }

  _onData(chunk) {
    this.buffer += chunk;
    const { messages, rest } = decodeMessages(this.buffer);
    this.buffer = rest;
    for (const msg of messages) this._dispatch(msg);
  }

  _dispatch(msg) {
    if (msg.id === undefined || msg.id === null) return; // notification
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) {
      entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    } else {
      entry.resolve(msg.result);
    }
  }

  _failAll(err) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  /**
   * Sends a JSON-RPC request and resolves with its result.
   *
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  request(method, params) {
    if (this.closed || !this.child) {
      return Promise.reject(new Error(`MCP server "${this.name}" is not running`));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref();

      this.pending.set(id, { resolve, reject, timer });

      this.child.stdin.write(encodeMessage({ jsonrpc: '2.0', id, method, params }), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * Sends a JSON-RPC notification (no id, no reply expected).
   *
   * @param {string} method
   * @param {object} [params]
   */
  notify(method, params) {
    if (this.closed || !this.child) return;
    this.child.stdin.write(encodeMessage({ jsonrpc: '2.0', method, params }));
  }

  /**
   * Ends stdin and drops the reference to the child.
   *
   * ponytail: stdin EOF only, no SIGTERM/SIGKILL escalation. A server that
   * ignores EOF leaks a child process until faycli exits. Add a kill timer if
   * that ever shows up in practice.
   */
  async close() {
    if (!this.child) return;
    this.closed = true;
    this._failAll(new Error(`MCP server "${this.name}" closed`));
    try {
      this.child.stdin.end();
    } catch {
      /* silent-ok: stdin may already be destroyed */
    }
    this.child = null;
  }
}

/**
 * Flattens MCP content blocks into a single string.
 *
 * Non-text blocks (images, embedded resources) are replaced with a marker
 * rather than dropped, so the model knows something was elided.
 *
 * @param {Array<object>|undefined} content
 * @returns {string}
 */
export function flattenContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      if (block.type === 'text') return block.text || '';
      return `[${block.type || 'unknown'} content omitted]`;
    })
    .filter(Boolean)
    .join('\n');
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test tests/mcp-client.test.js`
Expected: PASS — 9 tests

- [ ] **Step 6: Commit**

```bash
git add src/mcp/client.js tests/fixtures/mcp-echo-server.js tests/mcp-client.test.js
git commit -m "feat(mcp): add stdio JSON-RPC client with handshake and tool calls"
```

---

## Task 4: Dynamic tool registration in the registry

**Files:**
- Modify: `src/tools/registry.js:19-45` (add registration state near `READ_ONLY_TOOLS`), `src/tools/registry.js:284-301` (`getToolDeclarations`)
- Test: `tests/registry-dynamic.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/registry-dynamic.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  READ_ONLY_TOOLS,
  TOOLS_MAP,
  getTool,
  getToolDeclarations,
  listDynamicTools,
  registerTool,
  unregisterTools,
} from '../src/tools/registry.js';

function spec(overrides = {}) {
  return {
    declaration: {
      name: 'mcp__test__ping',
      description: 'ping',
      parameters: { type: 'OBJECT', properties: {} },
    },
    handler: async () => 'pong',
    ...overrides,
  };
}

test('registerTool makes the tool dispatchable and declarable', () => {
  try {
    registerTool('mcp__test__ping', spec());
    assert.equal(typeof getTool('mcp__test__ping'), 'function');
    assert.ok(getToolDeclarations().some((d) => d.name === 'mcp__test__ping'));
    // The builtin declarations must still be present.
    assert.ok(getToolDeclarations().some((d) => d.name === 'read_file'));
  } finally {
    unregisterTools();
  }
});

test('getToolDeclarations returns a fresh clone each call', () => {
  try {
    registerTool('mcp__test__ping', spec());
    const first = getToolDeclarations();
    const target = first.find((d) => d.name === 'mcp__test__ping');
    target.description = 'mutated';
    const second = getToolDeclarations();
    assert.equal(second.find((d) => d.name === 'mcp__test__ping').description, 'ping');
  } finally {
    unregisterTools();
  }
});

test('registerTool rejects a spec without a handler', () => {
  assert.throws(() => registerTool('mcp__test__bad', { declaration: {} }), /handler/);
  assert.throws(() => registerTool('', spec()), /name/);
});

test('unregisterTools with no argument drops every dynamic tool but keeps builtins', () => {
  try {
    registerTool('mcp__test__ping', spec());
    registerTool('mcp__test__pong', spec({ declaration: { name: 'mcp__test__pong' } }));
    assert.equal(listDynamicTools().length, 2);

    unregisterTools();

    assert.equal(listDynamicTools().length, 0);
    assert.equal(getTool('mcp__test__ping'), undefined);
    assert.equal(TOOLS_MAP.read_file !== undefined, true);
    assert.ok(getToolDeclarations().every((d) => !d.name.startsWith('mcp__test__')));
  } finally {
    unregisterTools();
  }
});

test('unregisterTools with explicit names drops only those', () => {
  try {
    registerTool('mcp__test__ping', spec());
    registerTool('mcp__test__pong', spec({ declaration: { name: 'mcp__test__pong' } }));
    unregisterTools(['mcp__test__ping']);
    assert.deepEqual(listDynamicTools(), ['mcp__test__pong']);
  } finally {
    unregisterTools();
  }
});

test('readOnly: true adds the tool to READ_ONLY_TOOLS, and unregistering removes it', () => {
  try {
    registerTool('mcp__test__ping', spec({ readOnly: true }));
    assert.ok(READ_ONLY_TOOLS.has('mcp__test__ping'));
    unregisterTools(['mcp__test__ping']);
    assert.ok(!READ_ONLY_TOOLS.has('mcp__test__ping'));
  } finally {
    unregisterTools();
  }
});

test('registering an existing name without readOnly clears a previous readOnly mark', () => {
  try {
    registerTool('mcp__test__ping', spec({ readOnly: true }));
    registerTool('mcp__test__ping', spec({ readOnly: false }));
    assert.ok(!READ_ONLY_TOOLS.has('mcp__test__ping'));
  } finally {
    unregisterTools();
  }
});

test('a registered tool dispatches through dispatchToolCall', async () => {
  const { dispatchToolCall } = await import('../src/tools/registry.js');
  try {
    registerTool('mcp__test__ping', spec());
    const res = await dispatchToolCall('mcp__test__ping', {});
    assert.equal(res.success, true);
    assert.equal(res.result, 'pong');
  } finally {
    unregisterTools();
  }
});

test('normalizeToolArgs passes unknown tools through untouched', async () => {
  const { normalizeToolArgs } = await import('../src/tools/registry.js');
  const args = { arbitrary: 1, nested: { a: 2 } };
  assert.deepEqual(normalizeToolArgs('mcp__test__ping', args), args);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/registry-dynamic.test.js`
Expected: FAIL — `registerTool is not a function`

- [ ] **Step 3: Add the dynamic registration surface**

In `src/tools/registry.js`, immediately after the `READ_ONLY_TOOLS` declaration (currently around line 45), insert:

```js
/**
 * Declarations registered at runtime (MCP servers). Kept separate from the
 * builtin TOOL_DECLARATIONS so a reconnect can replace one server's tools
 * without rebuilding the static table.
 *
 * @type {Map<string, object>}
 */
const dynamicDeclarations = new Map();

/**
 * Registers a runtime tool so it behaves exactly like a builtin: it appears in
 * `getToolDeclarations()`, dispatches through `dispatchToolCall()`, and routes
 * through `SecurityGuard`.
 *
 * Re-registering an existing name replaces the handler and declaration, which
 * is what a reconnect needs.
 *
 * @param {string} name - namespaced tool name, e.g. `mcp__fs__read_file`
 * @param {{ declaration?: object, handler: Function, readOnly?: boolean }} spec
 * @returns {void}
 */
export function registerTool(name, spec) {
  if (!name || typeof name !== 'string') {
    throw new TypeError('registerTool: name must be a non-empty string');
  }
  if (!spec || typeof spec.handler !== 'function') {
    throw new TypeError(`registerTool: "${name}" requires a handler function`);
  }

  TOOLS_MAP[name] = spec.handler;

  if (spec.declaration) {
    dynamicDeclarations.set(name, spec.declaration);
  }

  if (spec.readOnly) {
    READ_ONLY_TOOLS.add(name);
  } else {
    READ_ONLY_TOOLS.delete(name);
  }
}

/**
 * Removes runtime-registered tools.
 *
 * @param {string[]} [names] - names to drop; omit to drop every dynamic tool
 * @returns {void}
 */
export function unregisterTools(names) {
  const targets = Array.isArray(names) ? names : [...dynamicDeclarations.keys()];
  for (const name of targets) {
    delete TOOLS_MAP[name];
    dynamicDeclarations.delete(name);
    READ_ONLY_TOOLS.delete(name);
  }
}

/**
 * Lists the names registered at runtime (not the 12 builtins).
 *
 * @returns {string[]}
 */
export function listDynamicTools() {
  return [...dynamicDeclarations.keys()];
}
```

- [ ] **Step 4: Merge dynamic declarations into `getToolDeclarations`**

Replace the existing `getToolDeclarations` function in `src/tools/registry.js` (around lines 284-291):

```js
/**
 * Returns the full Gemini function declarations array: the 12 builtins plus
 * anything registered at runtime.
 *
 * Each entry is a fresh deep clone, so a caller that mutates the result (the
 * OpenAI adapter lowercases schema types in place) cannot corrupt the source
 * tables.
 *
 * @returns {Array<object>}
 */
export function getToolDeclarations() {
  const builtin = JSON.parse(JSON.stringify(TOOL_DECLARATIONS));
  if (dynamicDeclarations.size === 0) return builtin;
  const dynamic = [...dynamicDeclarations.values()].map((d) => JSON.parse(JSON.stringify(d)));
  return [...builtin, ...dynamic];
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test tests/registry-dynamic.test.js`
Expected: PASS — 9 tests

Run: `npm test`
Expected: PASS — no regressions

- [ ] **Step 6: Commit**

```bash
git add src/tools/registry.js tests/registry-dynamic.test.js
git commit -m "feat(tools): add dynamic tool registration to the registry"
```

---

## Task 5: McpManager

**Files:**
- Create: `src/mcp/manager.js`
- Test: `tests/mcp-manager.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-manager.test.js`:

```js
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { McpManager, mcpToolName, parseMcpToolName } from '../src/mcp/manager.js';
import {
  READ_ONLY_TOOLS,
  TOOLS_MAP,
  getTool,
  getToolDeclarations,
  listDynamicTools,
  unregisterTools,
} from '../src/tools/registry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, 'fixtures', 'mcp-echo-server.js');

function serverConfig(extra = {}) {
  return { enabled: true, command: process.execPath, args: [SERVER], ...extra };
}

test('mcpToolName and parseMcpToolName are re-exported and round-trip', () => {
  assert.equal(mcpToolName('fs', 'read_file'), 'mcp__fs__read_file');
  assert.deepEqual(parseMcpToolName('mcp__fs__read_file'), {
    server: 'fs',
    tool: 'read_file',
  });
});

test('connectAll skips disabled servers and registers tools of enabled ones', async () => {
  unregisterTools();
  const mgr = new McpManager({
    servers: {
      off: serverConfig({ enabled: false }),
      echo: serverConfig(),
    },
  });

  try {
    const result = await mgr.connectAll();
    assert.deepEqual(result.connected, ['echo']);
    assert.equal(result.failed.length, 0);
    assert.equal(result.toolCount, 2);

    assert.deepEqual(listDynamicTools().sort(), ['mcp__echo__echo', 'mcp__echo__fail']);
    assert.equal(typeof getTool('mcp__echo__echo'), 'function');

    const names = getToolDeclarations().map((d) => d.name);
    assert.ok(names.includes('mcp__echo__echo'));
    assert.ok(names.includes('read_file'), 'builtins must survive');
  } finally {
    await mgr.closeAll();
    unregisterTools();
  }
});

test('a server that cannot start is recorded in failures, not thrown', async () => {
  unregisterTools();
  const mgr = new McpManager({
    servers: {
      bad: { enabled: true, command: 'faycli-definitely-not-a-real-binary-xyz' },
      good: serverConfig(),
    },
  });

  try {
    const result = await mgr.connectAll();
    assert.deepEqual(result.connected, ['good']);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].server, 'bad');
    assert.ok(result.failed[0].message.length > 0);
    // The working server's tools must still be registered.
    assert.ok(listDynamicTools().includes('mcp__good__echo'));
  } finally {
    await mgr.closeAll();
    unregisterTools();
  }
});

test('a server entry with no command is reported as a failure', async () => {
  unregisterTools();
  const mgr = new McpManager({ servers: { broken: { enabled: true } } });
  try {
    const result = await mgr.connectAll();
    assert.deepEqual(result.connected, []);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].message, /command/);
  } finally {
    await mgr.closeAll();
    unregisterTools();
  }
});

test('callTool routes through the namespaced name', async () => {
  unregisterTools();
  const mgr = new McpManager({ servers: { echo: serverConfig() } });
  await mgr.connectAll();
  try {
    assert.equal(await mgr.callTool('mcp__echo__echo', { text: 'hi' }), 'hi');
    await assert.rejects(() => mgr.callTool('mcp__echo__nope', {}), /Unknown MCP tool/);
    await assert.rejects(() => mgr.callTool('not_namespaced', {}), /Unknown MCP tool/);
  } finally {
    await mgr.closeAll();
    unregisterTools();
  }
});

test('a registered tool handler runs end to end through dispatchToolCall', async () => {
  unregisterTools();
  const { dispatchToolCall } = await import('../src/tools/registry.js');
  const mgr = new McpManager({ servers: { echo: serverConfig() } });
  await mgr.connectAll();
  try {
    const res = await dispatchToolCall('mcp__echo__echo', { text: 'via-registry' });
    assert.equal(res.success, true);
    assert.equal(res.result, 'via-registry');

    const failed = await dispatchToolCall('mcp__echo__fail', { message: 'kaboom' });
    assert.equal(failed.error, true);
    assert.match(failed.message, /kaboom/);
  } finally {
    await mgr.closeAll();
    unregisterTools();
  }
});

test('readOnlyHint tools join READ_ONLY_TOOLS, others do not', async () => {
  unregisterTools();
  const mgr = new McpManager({ servers: { echo: serverConfig() } });
  await mgr.connectAll();
  try {
    assert.ok(READ_ONLY_TOOLS.has('mcp__echo__echo'));
    assert.ok(!READ_ONLY_TOOLS.has('mcp__echo__fail'));
  } finally {
    await mgr.closeAll();
    unregisterTools();
  }
});

test('listConnected reports the connected ids', async () => {
  unregisterTools();
  const mgr = new McpManager({
    servers: { echo: serverConfig(), off: serverConfig({ enabled: false }) },
  });
  await mgr.connectAll();
  try {
    assert.deepEqual(mgr.listConnected(), ['echo']);
  } finally {
    await mgr.closeAll();
    unregisterTools();
  }
});

test('closeAll leaves TOOLS_MAP clean after unregisterTools', async () => {
  unregisterTools();
  const mgr = new McpManager({ servers: { echo: serverConfig() } });
  await mgr.connectAll();
  await mgr.closeAll();
  unregisterTools();
  assert.equal(TOOLS_MAP.mcp__echo__echo, undefined);
  assert.equal(mgr.listConnected().length, 0);
});

test('an empty server map is a no-op', async () => {
  unregisterTools();
  const mgr = new McpManager({ servers: {} });
  const result = await mgr.connectAll();
  assert.deepEqual(result, { connected: [], failed: [], toolCount: 0 });
  await mgr.closeAll();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/mcp-manager.test.js`
Expected: FAIL — `Cannot find module '.../src/mcp/manager.js'`

- [ ] **Step 3: Write `src/mcp/manager.js`**

```js
/**
 * MCP server lifecycle.
 *
 * Reads the `mcpServers` config map, connects every entry with
 * `enabled: true`, and registers each server's tools into the shared tool
 * registry under an `mcp__<server>__<tool>` name.
 *
 * A server that fails to start is recorded in `failures` rather than thrown:
 * one broken server must not prevent the REPL from starting or hide the
 * servers that did connect.
 */

import { registerTool, unregisterTools } from '../tools/registry.js';
import { McpClient } from './client.js';
import { mcpToolName, parseMcpToolName } from './protocol.js';
import { buildDeclaration } from './schema.js';

export { mcpToolName, parseMcpToolName };

export class McpManager {
  /**
   * @param {object} [options={}]
   * @param {Record<string, object>} [options.servers={}] - the `mcpServers` config map
   * @param {import('../utils/logger.js').Logger} [options.logger]
   */
  constructor(options = {}) {
    this.serversConfig = options.servers || {};
    this.logger = options.logger;

    /** @type {Map<string, McpClient>} */
    this.clients = new Map();
    /** @type {Array<{server: string, message: string}>} */
    this.failures = [];
    /** @type {Map<string, {server: string, tool: string}>} */
    this.toolMap = new Map();
  }

  /**
   * Connects every enabled server and registers its tools.
   *
   * @returns {Promise<{ connected: string[], failed: Array<{server: string, message: string}>, toolCount: number }>}
   */
  async connectAll() {
    const connected = [];

    for (const [id, cfg] of Object.entries(this.serversConfig)) {
      if (!cfg || typeof cfg !== 'object') continue;
      if (cfg.enabled !== true) continue;

      if (!cfg.command || typeof cfg.command !== 'string') {
        this.failures.push({ server: id, message: 'missing "command" in config' });
        continue;
      }

      try {
        await this.connectServer(id, cfg);
        connected.push(id);
      } catch (err) {
        const message = err?.message || String(err);
        this.failures.push({ server: id, message });
        this.logger?.warn?.(`[mcp] server "${id}" failed to start: ${message}`);
      }
    }

    return { connected, failed: this.failures, toolCount: this.toolMap.size };
  }

  /**
   * Connects one server and registers its tools. Throws on failure so the
   * caller can decide whether to record it or surface it (the `/mcp add`
   * command shows the error inline).
   *
   * @param {string} id
   * @param {object} cfg
   * @returns {Promise<McpClient>}
   */
  async connectServer(id, cfg) {
    // Drop any previous registration for this server first, so a reconnect
    // cannot leave stale tools pointing at a dead client.
    this._unregisterServer(id);

    const client = new McpClient({
      name: id,
      command: cfg.command,
      args: Array.isArray(cfg.args) ? cfg.args : [],
      env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
      cwd: typeof cfg.cwd === 'string' ? cfg.cwd : undefined,
      timeoutMs: typeof cfg.timeoutMs === 'number' ? cfg.timeoutMs : undefined,
      logger: this.logger,
    });

    await client.connect();
    this.clients.set(id, client);

    for (const tool of client.tools) {
      const fullName = mcpToolName(id, tool.name);
      this.toolMap.set(fullName, { server: id, tool: tool.name });
      registerTool(fullName, {
        declaration: buildDeclaration(fullName, tool),
        handler: (args) => client.callTool(tool.name, args),
        readOnly: tool.annotations?.readOnlyHint === true,
      });
    }

    return client;
  }

  /**
   * Removes one server's client and its registered tools.
   *
   * @param {string} id
   * @returns {void}
   */
  _unregisterServer(id) {
    const names = [];
    for (const [fullName, entry] of this.toolMap) {
      if (entry.server === id) names.push(fullName);
    }
    if (names.length > 0) {
      unregisterTools(names);
      for (const name of names) this.toolMap.delete(name);
    }
    const client = this.clients.get(id);
    if (client) {
      // Fire and forget: the caller is about to replace this connection.
      client.close().catch(() => {});
      this.clients.delete(id);
    }
  }

  /**
   * Runs an MCP tool by its namespaced name.
   *
   * @param {string} fullName - e.g. `mcp__fs__read_file`
   * @param {object} [args={}]
   * @returns {Promise<string>}
   */
  async callTool(fullName, args = {}) {
    const entry = this.toolMap.get(fullName);
    if (!entry) {
      throw new Error(`Unknown MCP tool "${fullName}"`);
    }
    const client = this.clients.get(entry.server);
    if (!client) {
      throw new Error(`MCP server "${entry.server}" is not connected`);
    }
    return client.callTool(entry.tool, args);
  }

  /**
   * @returns {string[]} ids of the servers that connected this session
   */
  listConnected() {
    return [...this.clients.keys()];
  }

  /**
   * Closes every connection. Safe to call more than once.
   *
   * @returns {Promise<void>}
   */
  async closeAll() {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => {})));
    this.clients.clear();
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/mcp-manager.test.js`
Expected: PASS — 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/mcp/manager.js tests/mcp-manager.test.js
git commit -m "feat(mcp): add McpManager to connect servers and register their tools"
```

---

## Task 6: Orchestrator picks up runtime tools and filters them in plan mode

**Files:**
- Modify: `src/agent/orchestrator.js:52-138` (constructor), `src/agent/orchestrator.js:209-219` (`getEffectiveTools`)
- Test: `tests/orchestrator-dynamic-tools.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/orchestrator-dynamic-tools.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentOrchestrator } from '../src/agent/orchestrator.js';
import { registerTool, unregisterTools } from '../src/tools/registry.js';

const PING = {
  declaration: {
    name: 'mcp__test__ping',
    description: 'ping',
    parameters: { type: 'OBJECT', properties: {} },
  },
  handler: async () => 'pong',
};

function makeOrchestrator(options = {}) {
  return new AgentOrchestrator({
    workingDir: process.cwd(),
    provider: 'gemini',
    apiKey: 'test-key',
    ...options,
  });
}

test('a tool registered after construction shows up in getEffectiveTools', () => {
  unregisterTools();
  const orch = makeOrchestrator();
  try {
    assert.ok(!orch.getEffectiveTools().some((t) => t.name === 'mcp__test__ping'));
    registerTool('mcp__test__ping', PING);
    assert.ok(orch.getEffectiveTools().some((t) => t.name === 'mcp__test__ping'));
  } finally {
    unregisterTools();
  }
});

test('an explicitly pinned tool list is not re-read from the registry', () => {
  unregisterTools();
  const pinned = [
    { name: 'read_file', description: 'x', parameters: { type: 'OBJECT', properties: {} } },
  ];
  const orch = makeOrchestrator({ tools: pinned });
  try {
    registerTool('mcp__test__ping', PING);
    assert.deepEqual(
      orch.getEffectiveTools().map((t) => t.name),
      ['read_file'],
    );
  } finally {
    unregisterTools();
  }
});

test('plan mode hides MCP tools along with the mutating builtins', () => {
  unregisterTools();
  const orch = makeOrchestrator();
  try {
    registerTool('mcp__test__ping', PING);
    orch.setMode('plan');
    const names = orch.getEffectiveTools().map((t) => t.name);
    assert.ok(!names.includes('mcp__test__ping'));
    assert.ok(!names.includes('patch_file'));
    assert.ok(!names.includes('execute_command'));
    assert.ok(!names.includes('git_add_commit'));
    assert.ok(names.includes('read_file'));
  } finally {
    unregisterTools();
  }
});

test('build mode exposes MCP tools and the mutating builtins', () => {
  unregisterTools();
  const orch = makeOrchestrator();
  try {
    registerTool('mcp__test__ping', PING);
    orch.setMode('build');
    const names = orch.getEffectiveTools().map((t) => t.name);
    assert.ok(names.includes('mcp__test__ping'));
    assert.ok(names.includes('patch_file'));
  } finally {
    unregisterTools();
  }
});

test('options.mcpManager is stored on the instance', () => {
  const fake = { listConnected: () => [] };
  const orch = makeOrchestrator({ mcpManager: fake });
  assert.equal(orch.mcpManager, fake);
});

test('mcpManager defaults to null when not supplied', () => {
  const orch = makeOrchestrator();
  assert.equal(orch.mcpManager, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/orchestrator-dynamic-tools.test.js`
Expected: FAIL — the first test fails because `getEffectiveTools()` returns the frozen list captured in the constructor

- [ ] **Step 3: Store the MCP manager and remember whether tools were pinned**

In `src/agent/orchestrator.js`, in the constructor, replace the `// Tools` block:

```js
    // Tools
    this.tools = options.tools || getToolDeclarations();
    // When the caller did not pin a tool list, re-read the registry on every
    // turn so tools registered at runtime (MCP servers) become visible without
    // restarting the session. A pinned list is honoured verbatim, which is what
    // tests and embedding callers rely on.
    this._dynamicTools = !options.tools;

    // MCP manager (optional) — used by the REPL to connect servers at boot and
    // by the /mcp slash command to connect one on demand.
    this.mcpManager = options.mcpManager || null;
```

- [ ] **Step 4: Re-read declarations and filter MCP tools in plan mode**

Replace `getEffectiveTools` in `src/agent/orchestrator.js`:

```js
  /**
   * Returns effective tools allowed for the current mode.
   *
   * When no tool list was pinned at construction, the registry is re-read so
   * tools registered at runtime (MCP servers) are picked up without a restart.
   *
   * @returns {Array<object>}
   */
  getEffectiveTools() {
    const tools = this._dynamicTools ? getToolDeclarations() : this.tools;

    if (this.mode !== 'plan') {
      return tools;
    }

    // Plan mode is read-only research. MCP tools are filtered out rather than
    // advertised-then-denied, because a tool the model can see but never call
    // wastes context and produces confusing failure loops. SecurityGuard
    // enforces the same rule independently.
    const disallowedInPlan = new Set(['patch_file', 'execute_command', 'git_add_commit']);
    return tools.filter((t) => !disallowedInPlan.has(t.name) && !t.name.startsWith('mcp__'));
  }
```

- [ ] **Step 5: Run the tests**

Run: `node --test tests/orchestrator-dynamic-tools.test.js`
Expected: PASS — 6 tests

Run: `npm test`
Expected: PASS — no regressions

- [ ] **Step 6: Commit**

```bash
git add src/agent/orchestrator.js tests/orchestrator-dynamic-tools.test.js
git commit -m "feat(agent): pick up runtime-registered tools each turn"
```

---

## Task 7: SecurityGuard MCP gate

**Files:**
- Modify: `src/security/guard.js:1-46` (imports + constructor), `src/security/guard.js:218-241` (plan-mode block and switch entry), and append `_authorizeMcp`
- Test: `tests/mcp-security.test.js`

**Why this task exists:** `SecurityGuard.authorize()` is a `switch` over tool names with a `default: return { allowed: true }` branch. Every MCP tool would fall through to that default and run with no gate at all. This is the single most important task in the plan.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-security.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SecurityGuard } from '../src/security/guard.js';

function guardWith(handler, extra = {}) {
  return new SecurityGuard({
    baseDir: process.cwd(),
    confirmationHandler: handler,
    ...extra,
  });
}

test('the first MCP tool call prompts, and later calls on the same server do not', async () => {
  const prompts = [];
  const guard = guardWith(async (msg) => {
    prompts.push(msg);
    return true;
  });

  const first = await guard.authorize('mcp__echo__echo', { text: 'a' });
  assert.equal(first.allowed, true);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /echo/);

  const second = await guard.authorize('mcp__echo__fail', {});
  assert.equal(second.allowed, true);
  assert.equal(prompts.length, 1, 'a second call on the same server must not re-prompt');
});

test('a different server prompts separately', async () => {
  let calls = 0;
  const guard = guardWith(async () => {
    calls++;
    return true;
  });

  await guard.authorize('mcp__alpha__ping', {});
  await guard.authorize('mcp__beta__ping', {});
  assert.equal(calls, 2, 'each server is approved on its own');
});

test('a denial blocks the call and is not remembered as approval', async () => {
  let calls = 0;
  const guard = guardWith(async () => {
    calls++;
    return false;
  });

  const denied = await guard.authorize('mcp__echo__echo', {});
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /denied/);

  const again = await guard.authorize('mcp__echo__echo', {});
  assert.equal(again.allowed, false);
  assert.equal(calls, 2, 'a denial must not mark the server approved');
});

test('autoApprove skips the MCP prompt entirely', async () => {
  let calls = 0;
  const guard = guardWith(
    async () => {
      calls++;
      return true;
    },
    { autoApprove: true },
  );

  const res = await guard.authorize('mcp__echo__echo', {});
  assert.equal(res.allowed, true);
  assert.equal(calls, 0);
});

test('MCP tools are blocked in plan mode without prompting', async () => {
  let calls = 0;
  const guard = guardWith(async () => {
    calls++;
    return true;
  });
  guard.setMode('plan');

  const res = await guard.authorize('mcp__echo__echo', {});
  assert.equal(res.allowed, false);
  assert.match(res.reason, /Plan Mode/);
  assert.equal(calls, 0);
});

test('a malformed MCP tool name is rejected without prompting', async () => {
  let calls = 0;
  const guard = guardWith(async () => {
    calls++;
    return true;
  });

  const res = await guard.authorize('mcp__noseparator', {});
  assert.equal(res.allowed, false);
  assert.match(res.reason, /Malformed/);
  assert.equal(calls, 0);
});

test('builtin tools are unaffected by the MCP gate', async () => {
  let calls = 0;
  const guard = guardWith(async () => {
    calls++;
    return true;
  });

  // read_file inside the jail needs no confirmation at all.
  const res = await guard.authorize('read_file', { filePath: 'package.json' });
  assert.equal(res.allowed, true);
  assert.equal(calls, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/mcp-security.test.js`
Expected: FAIL — `assert.equal(first.allowed, true)` passes but `prompts.length` is 0, because the `default:` branch allow-lists MCP tools silently

- [ ] **Step 3: Import the name parser and track approvals**

In `src/security/guard.js`, add to the import block:

```js
import { parseMcpToolName } from '../mcp/protocol.js';
```

In the constructor, after `this.mode = options.mode || 'build';`, add:

```js
    /**
     * MCP servers the user approved during this session. Approval is per
     * server, not per tool, so a 20-tool server prompts once.
     * @type {Set<string>}
     */
    this._approvedMcpServers = new Set();
```

- [ ] **Step 4: Block MCP tools in plan mode and route them before the switch**

In `authorize()`, inside the existing `if (this.mode === 'plan') { ... }` block, add the MCP check right after the `patch_file` check:

```js
    if (this.mode === 'plan') {
      if (toolName === 'execute_command' || toolName === 'patch_file') {
        return {
          allowed: false,
          reason: `Tool "${toolName}" is not permitted in Plan Mode. Use /build to switch mode.`,
        };
      }
      if (typeof toolName === 'string' && toolName.startsWith('mcp__')) {
        return {
          allowed: false,
          reason: `MCP tools are not permitted in Plan Mode. Use /build to switch mode.`,
        };
      }
      if (toolName === 'write_file') {
        // ...unchanged...
      }
    }
```

Then, immediately before `switch (toolName) {`, insert:

```js
    // MCP tools spawn third-party processes with whatever filesystem and
    // network access their server has. They have no case in the builtin switch
    // below, which would otherwise fall through to `default: allowed`, so they
    // are routed explicitly.
    if (typeof toolName === 'string' && toolName.startsWith('mcp__')) {
      return this._authorizeMcp(toolName, args);
    }
```

- [ ] **Step 5: Add `_authorizeMcp` to the class**

Insert this method into `SecurityGuard`, directly before the closing brace of the class (after `authorize()`):

```js
  /**
   * Runtime gate for MCP tool calls.
   *
   * The server binary itself was approved when the user added it to config
   * (the `/mcp add` command writes the exact command line). This gate is the
   * backstop for a config that was hand-edited, copied from a repo, or
   * shipped by a dotfiles setup — cases where the user never saw the command.
   *
   * Approval is memoized per server for the life of the session: a server with
   * twenty tools prompts once, not twenty times.
   *
   * @param {string} toolName - namespaced name, e.g. `mcp__fs__read_file`
   * @param {object} args
   * @returns {Promise<{ allowed: boolean, reason?: string }>}
   */
  async _authorizeMcp(toolName, args) {
    const parsed = parseMcpToolName(toolName);
    if (!parsed) {
      return { allowed: false, reason: `Malformed MCP tool name "${toolName}".` };
    }

    if (this.autoApprove || this._approvedMcpServers.has(parsed.server)) {
      return { allowed: true };
    }

    let argPreview = '';
    try {
      argPreview = JSON.stringify(args ?? {}, null, 2).slice(0, 400);
    } catch {
      argPreview = '[arguments not serializable]';
    }

    const confirmed = await this.promptConfirmation({
      description: `AI ingin memakai tool dari MCP server "${parsed.server}":`,
      target: `${toolName}\n\n${argPreview}`,
      question: `Apakah anda mengizinkan server "${parsed.server}" menjalankan tool ini?`,
    });

    if (!confirmed) {
      return {
        allowed: false,
        reason: `User denied MCP tool "${toolName}" from server "${parsed.server}".`,
      };
    }

    this._approvedMcpServers.add(parsed.server);
    return { allowed: true };
  }
```

- [ ] **Step 6: Run the tests**

Run: `node --test tests/mcp-security.test.js`
Expected: PASS — 7 tests

Run: `npm test`
Expected: PASS — no regressions in the existing guard tests

- [ ] **Step 7: Commit**

```bash
git add src/security/guard.js tests/mcp-security.test.js
git commit -m "feat(security): gate MCP tool calls behind per-server confirmation"
```

---

## Task 8: `/mcp` slash command

**Files:**
- Modify: `src/cli/slash-commands.js` (add the `/help` entry and the `case 'mcp'`)
- Test: `tests/mcp-slash.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-slash.test.js`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ConfigManager } from '../src/config/manager.js';
import { executeSlashCommand } from '../src/cli/slash-commands.js';

function tmpConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'faycli-mcp-'));
}

function collector() {
  const chunks = [];
  return { write: (s) => chunks.push(s), text: () => chunks.join('') };
}

test('/mcp with no servers prints an empty-state hint', async () => {
  const configMgr = new ConfigManager(tmpConfigDir());
  const stream = collector();

  const res = await executeSlashCommand('/mcp', { configMgr, stream });

  assert.equal(res.handled, true);
  assert.equal(res.error, undefined);
  assert.match(stream.text(), /No MCP servers configured/);
});

test('/mcp list shows configured servers with their command', async () => {
  const configMgr = new ConfigManager(tmpConfigDir());
  await executeSlashCommand('/mcp add echo node server.js', {
    configMgr,
    stream: collector(),
  });

  const stream = collector();
  const res = await executeSlashCommand('/mcp list', { configMgr, stream });

  assert.equal(res.count, 1);
  assert.match(stream.text(), /echo/);
  assert.match(stream.text(), /node server\.js/);
});

test('/mcp add persists an enabled entry that survives a reload', async () => {
  const dir = tmpConfigDir();
  const configMgr = new ConfigManager(dir);
  const stream = collector();

  const res = await executeSlashCommand('/mcp add echo node server.js --flag=x', {
    configMgr,
    stream,
  });

  assert.equal(res.handled, true);
  assert.equal(res.error, undefined);
  assert.equal(res.server, 'echo');

  const fresh = new ConfigManager(dir).get('mcpServers.echo');
  assert.equal(fresh.enabled, true);
  assert.equal(fresh.command, 'node');
  assert.deepEqual(fresh.args, ['server.js', '--flag=x']);
});

test('/mcp add without a command reports usage and writes nothing', async () => {
  const dir = tmpConfigDir();
  const configMgr = new ConfigManager(dir);
  const stream = collector();

  const res = await executeSlashCommand('/mcp add', { configMgr, stream });

  assert.equal(res.error, true);
  assert.match(stream.text(), /Usage/);
  assert.equal(new ConfigManager(dir).get('mcpServers'), undefined);
});

test('/mcp remove deletes the entry from disk', async () => {
  const dir = tmpConfigDir();
  const configMgr = new ConfigManager(dir);
  await executeSlashCommand('/mcp add echo node server.js', {
    configMgr,
    stream: collector(),
  });

  await executeSlashCommand('/mcp remove echo', { configMgr, stream: collector() });

  assert.equal(new ConfigManager(dir).get('mcpServers.echo'), undefined);
});

test('/mcp remove on an unknown id reports not found', async () => {
  const configMgr = new ConfigManager(tmpConfigDir());
  const stream = collector();

  const res = await executeSlashCommand('/mcp remove ghost', { configMgr, stream });

  assert.equal(res.error, true);
  assert.match(stream.text(), /No MCP server named/);
});

test('/mcp disable and /mcp enable flip the flag on disk', async () => {
  const dir = tmpConfigDir();
  const configMgr = new ConfigManager(dir);
  await executeSlashCommand('/mcp add echo node server.js', {
    configMgr,
    stream: collector(),
  });

  await executeSlashCommand('/mcp disable echo', { configMgr, stream: collector() });
  assert.equal(new ConfigManager(dir).get('mcpServers.echo.enabled'), false);

  await executeSlashCommand('/mcp enable echo', { configMgr, stream: collector() });
  assert.equal(new ConfigManager(dir).get('mcpServers.echo.enabled'), true);
});

test('/mcp enable on an unknown id reports not found', async () => {
  const configMgr = new ConfigManager(tmpConfigDir());
  const stream = collector();

  const res = await executeSlashCommand('/mcp enable ghost', { configMgr, stream });

  assert.equal(res.error, true);
  assert.match(stream.text(), /No MCP server named/);
});

test('/mcp add hot-connects when an orchestrator with an mcpManager is present', async () => {
  const configMgr = new ConfigManager(tmpConfigDir());
  const connected = [];
  const orchestrator = {
    mcpManager: {
      toolMap: new Map(),
      clients: new Map(),
      async connectServer(id, cfg) {
        connected.push({ id, cfg });
      },
    },
  };
  const stream = collector();

  await executeSlashCommand('/mcp add echo node server.js', {
    configMgr,
    stream,
    orchestrator,
  });

  assert.equal(connected.length, 1);
  assert.equal(connected[0].id, 'echo');
  assert.equal(connected[0].cfg.command, 'node');
});

test('/mcp add reports a spawn failure without losing the config entry', async () => {
  const dir = tmpConfigDir();
  const configMgr = new ConfigManager(dir);
  const orchestrator = {
    mcpManager: {
      toolMap: new Map(),
      clients: new Map(),
      async connectServer() {
        throw new Error('spawn nope ENOENT');
      },
    },
  };
  const stream = collector();

  const res = await executeSlashCommand('/mcp add echo node server.js', {
    configMgr,
    stream,
    orchestrator,
  });

  assert.equal(res.handled, true);
  assert.match(stream.text(), /failed to start/);
  assert.equal(new ConfigManager(dir).get('mcpServers.echo.command'), 'node');
});

test('an unknown /mcp subcommand reports usage', async () => {
  const configMgr = new ConfigManager(tmpConfigDir());
  const stream = collector();

  const res = await executeSlashCommand('/mcp frobnicate', { configMgr, stream });

  assert.equal(res.error, true);
  assert.match(stream.text(), /Usage/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/mcp-slash.test.js`
Expected: FAIL — `/mcp` hits the `default:` branch and prints `Unknown slash command`

- [ ] **Step 3: Add the help entry**

In `src/cli/slash-commands.js`, inside `SLASH_COMMANDS_HELP`, add after the `/undo` entry:

```js
  {
    cmd: '/mcp [list]',
    desc: 'List configured MCP servers and their connection state',
  },
  {
    cmd: '/mcp add <id> <command> [args...]',
    desc: 'Register an MCP server and connect it now (no quoting — edit config.json for args with spaces)',
  },
  { cmd: '/mcp remove <id>', desc: 'Delete an MCP server from config' },
  { cmd: '/mcp enable|disable <id>', desc: 'Turn an MCP server on or off for future sessions' },
```

- [ ] **Step 4: Add the `/mcp` case**

In `src/cli/slash-commands.js`, add this case inside `executeSlashCommand`'s switch, immediately before `case 'exit':`:

```js
    case 'mcp': {
      const servers = configMgr.get('mcpServers') || {};
      const sub = (args[0] || 'list').toLowerCase();
      const writeUsage = () => {
        stream.write(
          `\n${ansi.yellow('⚠')} Usage:\n` +
            `  ${ansi.cyan('/mcp')} ${ansi.dim('— list configured servers')}\n` +
            `  ${ansi.cyan('/mcp add <id> <command> [args...]')}\n` +
            `  ${ansi.cyan('/mcp remove <id>')}\n` +
            `  ${ansi.cyan('/mcp enable|disable <id>')}\n` +
            `${ansi.dim('Arguments containing spaces must be set by editing ~/.faycli/config.json directly.')}\n\n`,
        );
      };

      // Reads the raw config object rather than using configMgr.delete(),
      // because delete() only understands flat keys and would remove a literal
      // "mcpServers.echo" key instead of the nested entry.
      const mutateServers = (fn) => {
        const cfg = configMgr.loadConfig();
        if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') cfg.mcpServers = {};
        const result = fn(cfg.mcpServers);
        configMgr.saveConfig(cfg);
        return result;
      };

      if (sub === 'list' || sub === 'ls') {
        const ids = Object.keys(servers);
        if (ids.length === 0) {
          stream.write(
            `\n${ansi.dim('No MCP servers configured.')}\n` +
              `Add one with ${ansi.cyan('/mcp add <id> <command> [args...]')}\n\n`,
          );
          return { handled: true, action: 'mcp_list', count: 0 };
        }

        const connected = new Set(orchestrator?.mcpManager?.listConnected?.() || []);
        const lines = ids.map((id) => {
          const cfg = servers[id] || {};
          let state;
          if (!cfg.enabled) {
            state = ansi.dim('disabled');
          } else if (connected.has(id)) {
            state = ansi.green('connected');
          } else {
            state = ansi.yellow('enabled, not connected');
          }
          const cmd = [cfg.command, ...(cfg.args || [])].filter(Boolean).join(' ');
          return `  ${ansi.bold(id.padEnd(16))} ${state}\n${ansi.dim(`    ${cmd}`)}`;
        });

        const box = renderBox(lines.join('\n'), {
          title: `MCP Servers (${ids.length})`,
          borderColor: 'cyan',
          borderStyle: 'round',
          minWidth: 50,
        });
        stream.write(`\n${box}\n\n`);
        return { handled: true, action: 'mcp_list', count: ids.length };
      }

      if (sub === 'add') {
        const id = args[1];
        const command = args[2];
        const cmdArgs = args.slice(3);

        if (!id || !command) {
          writeUsage();
          return { handled: true, action: 'mcp_add_usage', error: true };
        }

        mutateServers((map) => {
          map[id] = { enabled: true, command, args: cmdArgs };
        });

        let note = 'Restart faycli to connect it.';
        const mgr = orchestrator?.mcpManager;
        if (mgr && typeof mgr.connectServer === 'function') {
          try {
            await mgr.connectServer(id, { enabled: true, command, args: cmdArgs });
            const count = mgr.clients?.get?.(id)?.tools?.length ?? 0;
            note = `Connected — ${count} tool(s) available now.`;
          } catch (err) {
            note = `Saved, but it failed to start: ${err.message}`;
          }
        }

        stream.write(
          `\n${ansi.green('✔')} MCP server ${ansi.bold(id)} saved. ${ansi.dim(note)}\n\n`,
        );
        return { handled: true, action: 'mcp_add', server: id };
      }

      if (sub === 'remove' || sub === 'rm') {
        const id = args[1];
        if (!id) {
          writeUsage();
          return { handled: true, action: 'mcp_remove_usage', error: true };
        }
        if (!servers[id]) {
          stream.write(`\n${ansi.yellow('⚠')} No MCP server named ${ansi.bold(id)}.\n\n`);
          return { handled: true, action: 'mcp_remove_missing', error: true, message: id };
        }

        mutateServers((map) => {
          delete map[id];
        });
        orchestrator?.mcpManager?._unregisterServer?.(id);

        stream.write(
          `\n${ansi.green('✔')} MCP server ${ansi.bold(id)} removed. ${ansi.dim('Restart faycli to drop its tools.')}\n\n`,
        );
        return { handled: true, action: 'mcp_remove', server: id };
      }

      if (sub === 'enable' || sub === 'disable') {
        const id = args[1];
        if (!id) {
          writeUsage();
          return { handled: true, action: 'mcp_toggle_usage', error: true };
        }
        if (!servers[id]) {
          stream.write(`\n${ansi.yellow('⚠')} No MCP server named ${ansi.bold(id)}.\n\n`);
          return { handled: true, action: 'mcp_toggle_missing', error: true, message: id };
        }

        const enabled = sub === 'enable';
        configMgr.set(`mcpServers.${id}.enabled`, enabled);

        stream.write(
          `\n${ansi.green('✔')} MCP server ${ansi.bold(id)} ${enabled ? 'enabled' : 'disabled'}.` +
            `${ansi.dim(enabled ? ' Restart faycli to connect it.' : ' Restart faycli to drop its tools.')}\n\n`,
        );
        return { handled: true, action: `mcp_${sub}`, server: id };
      }

      writeUsage();
      return { handled: true, action: 'mcp_usage', error: true };
    }
```

- [ ] **Step 5: Run the tests**

Run: `node --test tests/mcp-slash.test.js`
Expected: PASS — 11 tests

Run: `npm test`
Expected: PASS — no regressions

- [ ] **Step 6: Commit**

```bash
git add src/cli/slash-commands.js tests/mcp-slash.test.js
git commit -m "feat(cli): add /mcp slash command for server management"
```

---

## Task 9: REPL wiring

**Files:**
- Modify: `src/cli/repl.js:1-25` (imports), `src/cli/repl.js:58-115` (orchestrator + banner), `src/cli/repl.js:200-212` (slash context), `src/cli/repl.js:366-370` (shutdown)
- Test: `tests/mcp-repl-wiring.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-repl-wiring.test.js`. This test drives `startRepl` with a scripted input stream and asserts the shutdown path closes MCP connections.

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { ConfigManager } from '../src/config/manager.js';
import { startRepl } from '../src/cli/repl.js';

function tmpConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'faycli-repl-mcp-'));
}

function collector() {
  const chunks = [];
  return {
    write: (s) => {
      chunks.push(s);
      return true;
    },
    text: () => chunks.join(''),
    isTTY: false,
  };
}

test('a broken MCP server is reported but the REPL still starts and exits', async () => {
  const configDir = tmpConfigDir();
  const configMgr = new ConfigManager(configDir);
  configMgr.set('mcpServers.broken', {
    enabled: true,
    command: 'faycli-definitely-not-a-real-binary-xyz',
  });

  const output = collector();
  const input = Readable.from(['/exit\n']);

  await startRepl({
    configMgr,
    input,
    output,
    autoApprove: true,
    securityGuard: undefined,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });

  const text = output.text();
  assert.match(text, /broken/, 'the failing server must be named in the output');
});

test('an mcpServers entry that is disabled never spawns anything', async () => {
  const configDir = tmpConfigDir();
  const configMgr = new ConfigManager(configDir);
  configMgr.set('mcpServers.off', {
    enabled: false,
    command: 'faycli-definitely-not-a-real-binary-xyz',
  });

  const output = collector();
  const input = Readable.from(['/exit\n']);

  await startRepl({
    configMgr,
    input,
    output,
    autoApprove: true,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });

  assert.doesNotMatch(
    output.text(),
    /failed/,
    'a disabled server must not be spawned, so it cannot fail',
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/mcp-repl-wiring.test.js`
Expected: FAIL — the first test's output has no `broken` mention because nothing reads `mcpServers` yet

- [ ] **Step 3: Import `McpManager` and connect at boot**

In `src/cli/repl.js`, add to the imports (keep alphabetical order among the `../` imports):

```js
import { McpManager } from '../mcp/manager.js';
```

Then, in `startRepl`, immediately after the orchestrator is created and the `securityGuard` callbacks are attached (i.e. after the `if (securityGuard) { ... }` block, before `const session = orchestrator.getSession();`), insert:

```js
  // MCP servers: connect the ones the user enabled. A server that fails to
  // start is collected rather than thrown, so one broken entry cannot block
  // the REPL. Failures are reported after the banner.
  const mcpManager =
    orchestrator.mcpManager ||
    new McpManager({
      servers: configMgr.get('mcpServers') || {},
      logger,
    });
  orchestrator.mcpManager = mcpManager;
  const mcpStatus = await mcpManager.connectAll();
```

- [ ] **Step 4: Surface MCP state in the banner and report failures**

In the `renderBanner({ ... details: [...] })` call, add an entry to `details` after the `WorkDir` line:

```js
        ...(mcpStatus.connected.length > 0
          ? [
              `MCP     : ${ansi.bold(ansi.green(`${mcpStatus.connected.length} server(s)`))} ${ansi.dim(mcpStatus.connected.join(', '))}`,
            ]
          : []),
```

Then, immediately after the existing `if (typeof orchestrator.getInstructionFiles === 'function') { ... }` block and before `let isBusy = false;`, insert:

```js
  if (mcpStatus.failed.length > 0) {
    for (const failure of mcpStatus.failed) {
      output.write(
        `${ansi.yellow('⚠')} ${ansi.dim(`MCP server "${failure.server}" failed:`)} ${failure.message}\n`,
      );
    }
    output.write('\n');
  }
```

- [ ] **Step 5: Pass the manager into the slash-command context**

In the `executeSlashCommand(line, { ... })` call inside the main loop, add `mcpManager` to the context object:

```js
        slashResult = await executeSlashCommand(line, {
          orchestrator,
          configMgr,
          logger,
          stream: output,
          input,
          thoughtDisplay,
          mcpManager,
          onWizardActive: (active) => {
            _wizardActive = active;
          },
        });
```

- [ ] **Step 6: Close connections on exit**

At the end of `startRepl`, replace the final two lines:

```js
  process.removeListener('SIGINT', onProcessSigint);
  await mcpManager.closeAll();
  closePromptLine(input);
```

- [ ] **Step 7: Run the tests**

Run: `node --test tests/mcp-repl-wiring.test.js`
Expected: PASS — 2 tests

Run: `npm test`
Expected: PASS — no regressions

- [ ] **Step 8: Verify manually against a real MCP server**

Run the CLI, add a real server, and confirm a tool call round-trips:

```bash
node bin/faycli.js
```

Then inside the REPL:

```
/mcp add fs npx -y @modelcontextprotocol/server-filesystem .
/mcp
```

Expected: `/mcp add` prints `Connected — N tool(s) available now.` and `/mcp` lists `fs` as `connected`. Then ask the agent to list files in the workspace and confirm it calls an `mcp__fs__*` tool and that the confirmation prompt appears exactly once.

- [ ] **Step 9: Commit**

```bash
git add src/cli/repl.js tests/mcp-repl-wiring.test.js
git commit -m "feat(repl): connect MCP servers at boot and close them on exit"
```

---

## Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md` (Architecture section)
- Modify: `README.md`

- [ ] **Step 1: Document the module in `CLAUDE.md`**

In the `## Architecture & System Design` section, after the `### Actuator Tools (src/tools/)` block, insert:

```markdown
### MCP Client (`src/mcp/`)

- **Transport (`src/mcp/client.js`)**: `McpClient` spawns one child process per server and speaks newline-delimited JSON-RPC 2.0 over stdio. Per-request timeout, stderr isolated from the message stream, `close()` ends stdin. No runtime dependency.
- **Framing & Naming (`src/mcp/protocol.js`)**: `encodeMessage` / `decodeMessages` for line framing; `mcpToolName` / `parseMcpToolName` for the `mcp__<server>__<tool>` namespace. No I/O and no heavy imports, so `security/guard.js` can import it directly.
- **Schema Conversion (`src/mcp/schema.js`)**: `jsonSchemaToGemini()` maps MCP's standard JSON Schema to the Gemini declaration dialect (UPPERCASE `type`, unsupported keywords dropped). Only one direction is needed — `convertToJsonSchema()` in `llm/openai.js` lowercases types on the way back out.
- **Lifecycle (`src/mcp/manager.js`)**: `McpManager.connectAll()` reads `mcpServers` from config, connects every entry with `enabled: true`, and registers each tool via `registerTool()`. Failures are collected in `failures`, never thrown.
- **Security**: MCP tools are gated in `SecurityGuard._authorizeMcp()` — one confirmation per server per session, never auto-approved when `autoApprove` is off, and blocked entirely in Plan Mode. Spawning a server is equivalent to `execute_command`, so config entries are never enabled by default.
- **Dynamic registry**: `registerTool()` / `unregisterTools()` / `listDynamicTools()` in `tools/registry.js` let runtime tools behave exactly like the 12 builtins. `AgentOrchestrator` re-reads `getToolDeclarations()` each turn when no tool list was pinned, so a `/mcp add` takes effect without a restart.
```

- [ ] **Step 2: Add a user-facing README section**

In `README.md`, add a `## MCP Servers` section after the existing tools documentation. Content:

```markdown
## MCP Servers

`faycli` can connect [MCP](https://modelcontextprotocol.io) servers over stdio and expose
their tools to the agent alongside the 12 built-in tools. No extra dependency is required.

### Adding a server

```
/mcp add <id> <command> [args...]
```

For example, the reference filesystem server:

```
/mcp add fs npx -y @modelcontextprotocol/server-filesystem /home/user/projects
```

The server is saved to `~/.faycli/config.json` under `mcpServers` and connected immediately.
Its tools appear to the model as `mcp__fs__read_file`, `mcp__fs__write_file`, and so on.

Arguments containing spaces cannot be expressed with `/mcp add` — edit `~/.faycli/config.json`
directly for those:

```json
{
  "mcpServers": {
    "fs": {
      "enabled": true,
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/my projects"],
      "env": { "SOME_TOKEN": "..." }
    }
  }
}
```

### Managing servers

| Command | Effect |
|---|---|
| `/mcp` or `/mcp list` | Show every configured server, its command, and whether it connected this session |
| `/mcp add <id> <command> [args...]` | Register and connect a server |
| `/mcp remove <id>` | Delete a server from config |
| `/mcp enable <id>` / `/mcp disable <id>` | Toggle a server for future sessions |

### Security

Spawning an MCP server is equivalent to running `execute_command` — the server runs with your
user's full permissions. Three things follow from that:

1. **Servers are never enabled by default.** A server only starts if its config entry has
   `"enabled": true`.
2. **The first tool call to each server prompts for confirmation, once per session.** This
   covers configs that were hand-edited, copied from a repository, or shipped in a dotfiles
   setup — cases where you never saw the command line.
3. **MCP tools are blocked in Plan Mode**, the same as `execute_command` and `patch_file`.

### Known limitations

- Tools only. MCP *resources* and *prompts* are not exposed.
- stdio transport only. SSE and streamable-HTTP servers are not supported.
- `close()` ends stdin without escalating to `SIGTERM`. A server that ignores EOF lingers until
  `faycli` exits.
```

- [ ] **Step 3: Run lint and format**

Run: `npm run lint`
Expected: PASS — no Biome errors

If Biome reports formatting issues:

```bash
npm run lint:fix
```

- [ ] **Step 4: Run the full suite**

Run: `npm run test:all`
Expected: PASS — unit tests plus E2E. E2E requires live API credentials; if they are not configured, `npm test` alone is the acceptance gate.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: document the MCP client, its security model, and its limits"
```

---

## Risks

**Context bloat.** Each enabled server adds its full tool list to every `generateContent` request. Three servers with 15 tools each is roughly 45 extra schemas per iteration, and compaction cannot shrink the declaration block because it is not conversation history. Mitigations already in the plan: servers are off by default, so the count is always a deliberate user choice; `mcp__*` tools are filtered out of plan mode. If this becomes a real problem, the escape hatch is a meta-tool (`mcp_find_tools(query)` returning matching declarations) plus an on-demand declaration registry — deferred, with the trigger being tool declarations exceeding roughly 15% of the context budget.

**Untrusted server output reaches the model.** A malicious server can return text instructing the model to do something. This is the same exposure as `web_fetch`, and the same mitigations apply: `SecurityGuard` still gates every resulting tool call, and plan mode remains read-only.

**Windows spawning.** `process.platform === 'win32'` forces `shell: true` because `npx`/`npm` are `.cmd` shims. This means a command string from config is interpreted by `cmd.exe`. The config is user-owned, so this is self-inflicted rather than an escalation, but it is worth knowing. The upgrade path — resolving the executable with `where`/`which` and dropping the shell — is marked with a `ponytail:` comment in `src/mcp/client.js`.

**Child process leaks.** `close()` ends stdin only. A server that ignores EOF keeps running until `faycli` exits. Acceptable for v1; add a kill timer if it shows up.

**Fixture drift.** `tests/fixtures/mcp-echo-server.js` implements the protocol by hand. If the MCP spec's stdio framing changes, the fixture and the client could drift together and the tests would keep passing against a wrong implementation. The manual verification step in Task 9 (`/mcp add fs npx -y @modelcontextprotocol/server-filesystem .`) is the guard against that — it exercises a real third-party server.

---

## Done Criteria

- [ ] `npm test` passes with the 10 new test files included.
- [ ] `npm run lint` passes.
- [ ] `npm ls --prod` shows no runtime dependencies — the zero-dependency constraint is intact.
- [ ] `/mcp add fs npx -y @modelcontextprotocol/server-filesystem .` connects, and the model can call an `mcp__fs__*` tool.
- [ ] The first `mcp__fs__*` call in a session prompts for confirmation exactly once; a second call to any `mcp__fs__*` tool does not prompt again.
- [ ] An MCP tool call is refused in Plan Mode.
- [ ] A server with `"enabled": false` is never spawned.
- [ ] A server whose command does not exist produces a warning in the banner and the REPL still starts.
- [ ] `faycli` exits cleanly with no orphaned child processes.
- [ ] `getToolDeclarations()` returns the 12 builtins plus the registered MCP tools, and the builtin declarations are byte-identical to before this change.