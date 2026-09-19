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
