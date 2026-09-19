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
