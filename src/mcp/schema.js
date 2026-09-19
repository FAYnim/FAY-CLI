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
      parameters && parameters.type === 'OBJECT' ? parameters : { type: 'OBJECT', properties: {} },
  };
}
