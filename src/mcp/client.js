/**
 * MCP client over stdio.
 *
 * One child process per server, JSON-RPC 2.0 with newline-delimited framing,
 * no external dependency. Requests are correlated by id with a per-request
 * timeout so a wedged server cannot hang the ReAct loop.
 */

import { spawn } from 'node:child_process';
import { decodeMessages, encodeMessage, MCP_PROTOCOL_VERSION } from './protocol.js';

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
    const command =
      useShell && this.command.includes(' ') && !this.command.startsWith('"')
        ? `"${this.command}"`
        : this.command;
    const args = useShell
      ? this.args.map((a) =>
          typeof a === 'string' && a.includes(' ') && !a.startsWith('"') ? `"${a}"` : a,
        )
      : this.args;

    this.child = spawn(command, args, {
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
      this._failAll(new Error(`MCP server "${this.name}" exited (code=${code} signal=${signal})`));
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
