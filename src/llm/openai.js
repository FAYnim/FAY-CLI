/**
 * OpenAI-compatible Chat Completions adapter.
 * Translates Gemini request shape -> OpenAI, parses SSE stream back into Gemini-compatible result.
 */

import { logger } from '../utils/logger.js';
import { BaseLlmClient } from './base.js';

/**
 * Recursively converts Gemini UPPERCASE schema types to standard lowercase JSON Schema types.
 * @param {object} schema
 * @returns {object}
 */
export function convertToJsonSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) {
    return schema.map((item) => {
      if (item && typeof item === 'object') return convertToJsonSchema(item);
      return item;
    });
  }

  const res = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'type' && typeof v === 'string') {
      res[k] = v.toLowerCase();
    } else if (v && typeof v === 'object') {
      res[k] = convertToJsonSchema(v);
    } else {
      res[k] = v;
    }
  }
  return res;
}

export class OpenAIClient extends BaseLlmClient {
  constructor(options = {}) {
    super(options);
    this.apiVersion = options.apiVersion || 'v1';
    if (!this.baseUrl) {
      this.baseUrl = 'https://api.openai.com/v1';
    }
  }

  getEndpoint(action = 'chat/completions', _isStream = false) {
    let base = (this.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    if (!base.endsWith('/v1') && !base.includes('/v1/')) {
      base = `${base}/v1`;
    }
    const cleanAction = action.replace(/^\/+/, '');
    return `${base}/${cleanAction}`;
  }

  buildRequestBody({ contents, tools, systemInstruction, generationConfig }) {
    const messages = [];

    // System instruction -> top-level system message
    if (systemInstruction) {
      const text =
        typeof systemInstruction === 'string'
          ? systemInstruction
          : systemInstruction.parts?.[0]?.text || '';
      if (text) messages.push({ role: 'system', content: text });
    }

    if (Array.isArray(contents)) {
      const toolCallIdQueue = [];

      for (const msg of contents) {
        if (msg.role === 'user') {
          const text = (msg.parts || []).map((p) => p.text || '').join('');
          messages.push({ role: 'user', content: text });
        } else if (msg.role === 'model') {
          const texts = [];
          const toolCalls = [];
          for (let pIdx = 0; pIdx < (msg.parts || []).length; pIdx++) {
            const part = msg.parts[pIdx];
            if (part.text) texts.push(part.text);
            if (part.functionCall) {
              const callId =
                part.functionCall.id ||
                part.functionCall.toolCallId ||
                `call_${Date.now()}_${pIdx}`;
              toolCallIdQueue.push({ name: part.functionCall.name, id: callId });
              toolCalls.push({
                id: callId,
                type: 'function',
                function: {
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args || {}),
                },
              });
            }
          }
          if (texts.length || toolCalls.length) {
            const entry = { role: 'assistant' };
            if (texts.length) entry.content = texts.join('');
            if (toolCalls.length) entry.tool_calls = toolCalls;
            messages.push(entry);
          }
        } else if (msg.role === 'function') {
          for (const part of msg.parts || []) {
            if (part.functionResponse) {
              let callId = part.functionResponse.toolCallId || part.functionResponse.id;
              if (!callId) {
                const qIdx = toolCallIdQueue.findIndex(
                  (q) => q.name === part.functionResponse.name,
                );
                if (qIdx !== -1) {
                  callId = toolCallIdQueue[qIdx].id;
                  toolCallIdQueue.splice(qIdx, 1);
                } else if (toolCallIdQueue.length > 0) {
                  callId = toolCallIdQueue.shift().id;
                } else {
                  callId = `call_${Date.now()}_0`;
                }
              }
              messages.push({
                role: 'tool',
                tool_call_id: callId,
                content: JSON.stringify(part.functionResponse.response),
              });
            }
          }
        }
      }
    }

    const payload = {
      model: this.model || 'gpt-4o-mini',
      messages,
    };

    // Tools: flat OpenAI shape
    if (tools && tools.length > 0) {
      const oaTools = [];
      for (const t of tools) {
        const fds = Array.isArray(t.functionDeclarations) ? t.functionDeclarations : [t];
        for (const fd of fds) {
          if (fd?.name) {
            oaTools.push({
              type: 'function',
              function: {
                name: fd.name,
                description: fd.description || '',
                parameters: convertToJsonSchema(fd.parameters),
              },
            });
          }
        }
      }
      if (oaTools.length) {
        payload.tools = oaTools;
        payload.tool_choice = 'auto';
      }
    }

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

    return payload;
  }

  async generateStream(options = {}) {
    this._validateApiKey();
    const payload = this.buildRequestBody({
      contents: options.contents,
      tools: options.tools,
      systemInstruction: options.systemInstruction,
      generationConfig: options.generationConfig,
    });
    payload.stream = true;
    // Ask compatible servers for a final usage chunk (OpenAI requires this
    // field). Servers that reject unknown body fields get one silent retry
    // without it — see the 400 fallback below.
    payload.stream_options = { include_usage: true };

    const endpoint = this.getEndpoint('chat/completions', true);
    const parentSignal = options.signal;

    return await this._requestWithRetry(
      async () => {
        let response = await this.fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: parentSignal,
        });

        // Some OpenAI-compatible servers reject unknown body fields with 400.
        // Retry once without stream_options; a 400 generates nothing, so
        // re-sending has no billing or side-effect risk.
        if (!response.ok && response.status === 400 && payload.stream_options) {
          const original = response;
          delete payload.stream_options;
          response = await this.fetch(endpoint, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: parentSignal,
          });
          if (!response.ok) {
            await this._handleErrorResponse(original);
          }
        }

        if (!response.ok) await this._handleErrorResponse(response);

        return await this._parseOpenAISSE(response.body, options, parentSignal);
      },
      { signal: parentSignal, logger: this.logger, locale: this.locale },
    );
  }

  async _parseOpenAISSE(body, options, parentSignal) {
    const tokens = [];
    const functionCalls = [];
    let finishReason = null;
    let usage = null;
    const toolCallBuffers = {}; // index -> { name, argsParts }

    const decoder = new TextDecoder();
    let buffer = '';

    const emitToolCalls = () => {
      for (const idx of Object.keys(toolCallBuffers)) {
        const b = toolCallBuffers[idx];
        let args = {};
        if (b.argsParts.length) {
          try {
            args = JSON.parse(b.argsParts.join(''));
          } catch {
            args = {};
          }
        }
        functionCalls.push({ name: b.name, args });
        if (typeof options.onFunctionCall === 'function') {
          options.onFunctionCall({ name: b.name, args });
        }
      }
      Object.keys(toolCallBuffers).forEach((k) => {
        delete toolCallBuffers[k];
      });
    };

    const onChunk = (line) => {
      line = line.trim();
      if (!line || line === 'data: [DONE]') return;
      if (!line.startsWith('data:')) return;
      const jsonStr = line.slice(5).trim();
      if (!jsonStr) return;
      let data;
      try {
        data = JSON.parse(jsonStr);
      } catch {
        return;
      }

      // Usage arrives on the terminal empty-choices chunk (OpenAI with
      // stream_options) or sometimes on the last regular chunk.
      if (data.usage) {
        usage = {
          promptTokenCount: data.usage.prompt_tokens ?? 0,
          candidatesTokenCount: data.usage.completion_tokens ?? 0,
          totalTokenCount: data.usage.total_tokens ?? 0,
        };
      }

      if (data.choices && data.choices.length === 0) {
        finishReason = 'STOP';
        return;
      }

      const choice = data.choices?.[0];
      if (!choice?.delta) return;

      if (choice.delta.content) {
        tokens.push(choice.delta.content);
        if (typeof options.onToken === 'function') options.onToken(choice.delta.content);
        if (typeof options.onChunk === 'function') options.onChunk(choice.delta.content);
      }

      if (choice.delta.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const i = tc.index ?? 0;
          if (!toolCallBuffers[i]) toolCallBuffers[i] = { name: '', argsParts: [] };
          if (tc.function?.name) toolCallBuffers[i].name = tc.function.name;
          if (tc.function?.arguments) toolCallBuffers[i].argsParts.push(tc.function.arguments);
        }
      }

      const fr = choice.finish_reason ?? choice.delta?.finish_reason;
      if (fr !== undefined) {
        const map = { stop: 'STOP', length: 'MAX_TOKENS', tool_calls: 'STOP' };
        finishReason = map[fr] ?? fr ?? null;
        if (typeof options.onFinish === 'function') options.onFinish(finishReason);
        if (finishReason !== null) {
          emitToolCalls();
        }
      }

      if (parentSignal?.aborted) throw parentSignal.reason || new Error('Aborted');
    };

    if (body) {
      const reader = body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nlIdx;
        while (buffer.includes('\n')) {
          nlIdx = buffer.indexOf('\n');
          const line = buffer.slice(0, nlIdx);
          buffer = buffer.slice(nlIdx + 1);
          onChunk(line);
        }
      }
      if (buffer.trim()) onChunk(buffer);
    }

    emitToolCalls();

    if (functionCalls.length === 0) {
      const rawText = tokens.join('');
      const fallbackCalls = parseTextToolCalls(rawText);
      if (fallbackCalls.length > 0) {
        const taggedFallback = fallbackCalls.map((fc) => ({ ...fc, isFallback: true }));
        functionCalls.push(...taggedFallback);
        for (const fc of taggedFallback) {
          if (typeof options.onFunctionCall === 'function') {
            options.onFunctionCall(fc);
          }
        }
      }
    }

    return {
      text: tokens.join(''),
      functionCalls,
      finishReason,
      usage,
      raw: null,
    };
  }

  async generate(options = {}) {
    this._validateApiKey();
    const payload = this.buildRequestBody({
      contents: options.contents,
      tools: options.tools,
      systemInstruction: options.systemInstruction,
      generationConfig: options.generationConfig,
    });
    const endpoint = this.getEndpoint('chat/completions', false);
    const parentSignal = options.signal;

    return await this._requestWithRetry(
      async () => {
        const response = await this.fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: parentSignal,
        });

        if (!response.ok) await this._handleErrorResponse(response);

        const data = await response.json();
        return this._extractNonStreamResult(data);
      },
      { signal: parentSignal, logger: this.logger, locale: this.locale },
    );
  }

  _validateApiKey() {
    if (!this.apiKey || typeof this.apiKey !== 'string' || this.apiKey.trim() === '') {
      throw new Error(
        "OpenAI API key is not configured. Set OPENAI_API_KEY or run 'faycli provider add openai'.",
      );
    }
  }

  async _handleErrorResponse(response) {
    let errorDetails = null;
    let errorMessage = '';
    try {
      errorDetails = await response.json();
      if (errorDetails?.error?.message) errorMessage = errorDetails.error.message;
    } catch (err) {
      logger.debug('openai._handleErrorResponse: response.json() failed', err);
    }
    if (!errorMessage) {
      try {
        errorMessage = await response.text();
      } catch (err) {
        logger.debug('openai._handleErrorResponse: response.text() failed', err);
      }
      if (!errorMessage) errorMessage = `HTTP error ${response.status} ${response.statusText}`;
    }
    const error = new Error(`OpenAI API Error (${response.status}): ${errorMessage}`);
    error.status = response.status;
    error.statusCode = response.status;
    error.details = errorDetails;
    throw error;
  }

  _extractNonStreamResult(data) {
    let text = '';
    const functionCalls = [];
    let finishReason = null;

    const choice = data.choices?.[0];
    if (choice) {
      if (choice.message?.content) text = choice.message.content;
      if (choice.message?.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          let args = {};
          if (tc.function?.arguments) {
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {
              args = {};
            }
          }
          functionCalls.push({ name: tc.function.name, args });
        }
      }
      const map = { stop: 'STOP', length: 'MAX_TOKENS', tool_calls: 'STOP' };
      finishReason = map[choice.finish_reason] ?? choice.finish_reason ?? null;
    }

    if (functionCalls.length === 0 && text) {
      const fallbackCalls = parseTextToolCalls(text);
      if (fallbackCalls.length > 0) {
        functionCalls.push(...fallbackCalls.map((fc) => ({ ...fc, isFallback: true })));
      }
    }

    let usage = null;
    if (data.usage) {
      usage = {
        promptTokenCount: data.usage.prompt_tokens ?? 0,
        candidatesTokenCount: data.usage.completion_tokens ?? 0,
        totalTokenCount: data.usage.total_tokens ?? 0,
      };
    }

    return { text, functionCalls, finishReason, usage, raw: data };
  }
}

/** Tool names accepted when they are extracted from model text output. */
const TEXT_TOOL_NAMES = [
  'read_file',
  'write_file',
  'patch_file',
  'list_dir',
  'load_skill',
  'execute_command',
  'grep_file',
  'search_files',
  'git_status',
  'git_diff',
  'git_add_commit',
  'web_fetch',
  'web_search',
];
const TEXT_TOOL_NAMES_SOURCE = TEXT_TOOL_NAMES.join('|');
const TEXT_TOOL_NAME_PATTERN = new RegExp(`(${TEXT_TOOL_NAMES_SOURCE})`, 'i');

/**
 * Key order in which a JSON payload may name the tool to call and its
 * arguments (first present key wins). A string arguments value is parsed as
 * JSON. The two shapes belong to the two JSON block constructs below.
 */
const TAGGED_JSON_SHAPE = {
  nameKeys: ['name', 'tool', 'function'],
  argsKeys: ['arguments', 'args', 'parameters'],
};
const FENCED_JSON_SHAPE = {
  nameKeys: ['name', 'tool', 'function', 'tool_name', 'action'],
  argsKeys: ['arguments', 'parameters', 'args', 'action_input'],
};

/** Removes reasoning segments and stray think tags from model text output. */
function stripThinkSegments(rawText) {
  return rawText
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/think>/gi, '')
    .replace(/<think>/gi, '');
}

/** Parses the first {...last} JSON object found in `str`, or returns null. */
function extractJsonLoose(str) {
  if (!str) return null;
  const firstBrace = str.indexOf('{');
  const lastBrace = str.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(str.slice(firstBrace, lastBrace + 1));
    } catch (err) {
      logger.debug('openai.extractJsonLoose: JSON.parse failed', err);
    }
  }
  return null;
}

/**
 * Resolves `{ name, args }` from a parsed JSON payload. `nameKeys` and
 * `argsKeys` are tried in order; a string arguments value is parsed as JSON.
 * Returns null when the payload does not name a tool or the arguments are
 * malformed.
 */
function resolveJsonCall(obj, shape) {
  const name = shape.nameKeys.map((key) => obj[key]).find(Boolean);
  if (!name) return null;
  try {
    const args =
      typeof obj.arguments === 'string'
        ? JSON.parse(obj.arguments)
        : shape.argsKeys.map((key) => obj[key]).find(Boolean) || {};
    return { name, args };
  } catch {
    return null;
  }
}

/**
 * Collects `key: value` pairs from XML-style parameter tags inside `block`.
 * The `path` key is mapped to `filePath` and values are trimmed, matching how
 * tool arguments are consumed downstream.
 */
function extractParamTagArgs(block, tagPattern, { exclude = [] } = {}) {
  const args = {};
  for (const match of block.matchAll(tagPattern)) {
    const key = match[1];
    if (exclude.includes(key)) continue;
    const mappedKey = key === 'path' ? 'filePath' : key;
    args[mappedKey] = match[2].trim();
  }
  return args;
}

/**
 * Block constructs that may carry an embedded tool call, scanned in order.
 * Each `interpret` receives one `pattern` match plus the collector and pushes
 * candidate calls onto it, so construct order fully determines call order.
 */
const BLOCK_EXTRACTORS = [
  {
    // <tool_calls>...</tool_calls> plural containers: the tool is named inside the
    // container block and arguments are parsed from the payload.
    // (Singular <tool_call> blocks are handled by the dedicated passes below).
    pattern: /<tool_calls>([\s\S]*?)<\/tool_calls>/gi,
    interpret(match, addCall) {
      const block = match[1];
      const nameMatch = block.match(TEXT_TOOL_NAME_PATTERN);
      if (!nameMatch) return;
      const parsed = extractJsonLoose(block);
      if (!parsed) return;
      // If the parsed JSON already encapsulates { name, arguments }, unwrap it cleanly
      const unwrapped = resolveJsonCall(parsed, TAGGED_JSON_SHAPE);
      if (unwrapped) {
        addCall(unwrapped.name, unwrapped.args);
      } else {
        addCall(nameMatch[1], parsed);
      }
    },
  },
  {
    // <tool_call><_function_call>/< _action> XML blocks: the tool comes from a
    // <tool_name>/<action_name> tag, every remaining tag is a string argument.
    pattern: /<(?:tool_call>)?<_(?:function_call|action)>([\s\S]*?)<\/(?:function_call|action)>/gi,
    interpret(match, addCall) {
      const block = match[1];
      const nameMatch =
        block.match(/<tool_name>([\s\S]*?)<\/tool_name>/i) ||
        block.match(/<action_name>([\s\S]*?)<\/action_name>/i);
      if (!nameMatch) return;
      const args = extractParamTagArgs(block, /<([a-zA-Z0-9_]+)>([\s\S]*?)<\/\1>/g, {
        exclude: ['tool_name', 'action_name'],
      });
      addCall(nameMatch[1].trim(), args);
    },
  },
  {
    // <function=tool_name> blocks: the tool is in the opener tag and the
    // arguments come from <parameter> tags.
    pattern: /<function=([a-zA-Z0-9_]+)>([\s\S]*?)<\/function>/gi,
    interpret(match, addCall) {
      const args = extractParamTagArgs(
        match[2],
        /<parameter(?:=|\s+name=)["']?([a-zA-Z0-9_]+)["']?>([\s\S]*?)<\/parameter>/gi,
      );
      addCall(match[1].trim(), args);
    },
  },
  {
    // <tool_call>/<function_call> tags wrapping a single JSON payload.
    pattern: /<(?:tool_call|function_call)>\s*(\{[\s\S]*?\})\s*<\/(?:tool_call|function_call)>/gi,
    interpret(match, addCall) {
      try {
        const call = resolveJsonCall(JSON.parse(match[1]), TAGGED_JSON_SHAPE);
        if (call) addCall(call.name, call.args);
      } catch (err) {
        logger.debug('openai.parseTextToolCalls: tagged-json parse failed', err);
      }
    },
  },
  {
    // Markdown code fences containing a single JSON payload.
    pattern: /```(?:json)?\s*(\{[\s\S]*?\})\s*```/gi,
    interpret(match, addCall) {
      try {
        const call = resolveJsonCall(JSON.parse(match[1]), FENCED_JSON_SHAPE);
        if (call) addCall(call.name, call.args);
      } catch (err) {
        logger.debug('openai.parseTextToolCalls: fenced-json parse failed', err);
      }
    },
  },
  {
    // [Tool Call: tool_name({...})] or [tool_call: tool_name: {...}] or [call: tool_name({...})]
    // Matches bracketed pseudo-call syntax emitted when models output tool calls in prose.
    pattern: /\[(?:Tool Call|tool_call|call|TOOL|Tool_Call):\s*([a-zA-Z0-9_]+)(?:(?:\s*\(([\s\S]*?)\))|(?:\s*:\s*(\{[\s\S]*?\}))|(?:\s+(\{[\s\S]*?\})))?\s*\]/gi,
    interpret(match, addCall) {
      const toolName = match[1]?.trim();
      const rawPayload = (match[2] ?? match[3] ?? match[4])?.trim();
      if (!toolName) return;
      if (!rawPayload || rawPayload === '{}' || rawPayload === '()') {
        addCall(toolName, {});
        return;
      }
      try {
        const parsed = JSON.parse(rawPayload);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          addCall(toolName, parsed);
        }
      } catch (err) {
        const loose = extractJsonLoose(rawPayload);
        if (loose && typeof loose === 'object' && !Array.isArray(loose)) {
          addCall(toolName, loose);
        } else {
          logger.debug('openai.parseTextToolCalls: bracketed call parse failed', err);
        }
      }
    },
  },
];

/** Extracts the first `Action:` / `Action Input:` pair (ReAct-style output). */
function extractActionLineCall(text, addCall) {
  const actionMatch = text.match(
    /Action:\s*([a-zA-Z0-9_]+)[\s\S]*?Action\s*Input:\s*(\{[\s\S]*?\})/i,
  );
  if (!actionMatch) return;
  try {
    addCall(actionMatch[1].trim(), JSON.parse(actionMatch[2]));
  } catch (err) {
    logger.debug('openai.parseTextToolCalls: action-line args failed', err);
  }
}

/**
 * Extracts a bare tool name followed by a JSON object.
 * Strictly requires the tool name to be at the start of a line (or immediately
 * following an opening <tool_call> tag) with a valid delimiter (: | <tool_sep> | \n | whitespace | ( ),
 * preventing false-positive execution from tool names mentioned in prose mid-sentence.
 */
function extractInlineNameCalls(text, addCall) {
  const inlinePattern = new RegExp(
    `(?:^|\\n|<tool_call>)\\s*(${TEXT_TOOL_NAMES_SOURCE})(?:\\s*:\\s*|\\s*<tool_sep>\\s*|\\s*\\n\\s*|\\s+|\\s*\\()(\\{[\\s\\S]*?\\})\\)?`,
    'gi',
  );
  for (const match of text.matchAll(inlinePattern)) {
    try {
      addCall(match[1], JSON.parse(match[2]));
    } catch (err) {
      logger.debug('openai.parseTextToolCalls: inline-name args failed', err);
    }
  }
}

/**
 * Extracts embedded XML or JSON tool calls from raw assistant text (e.g. from
 * DeepSeek-R1 / Qwen models that answer in prose instead of using native tool
 * calling).
 *
 * The parser is a small pipeline:
 *   1. strip <think> reasoning segments
 *   2. scan for every known block construct (tagged containers, underscore XML
 *      blocks, <function=…> blocks, tagged JSON, fenced JSON), in order
 *   3. scan for ReAct `Action:` lines, then bare `tool_name {…}` pairs
 * Every candidate is validated against the known tool names and deduplicated
 * in a single place. Standalone JSON without an explicit tool name is never
 * executed (audit H-2).
 *
 * @param {string} rawText
 * @returns {Array<{ name: string, args: object }>}
 */
export function parseTextToolCalls(rawText) {
  const calls = [];
  if (!rawText || typeof rawText !== 'string') return calls;

  const addCall = (name, args) => {
    if (!name || !args || typeof args !== 'object') return;
    const cleanName = name.trim();
    if (!TEXT_TOOL_NAMES.includes(cleanName)) return;
    if (
      !calls.some((c) => c.name === cleanName && JSON.stringify(c.args) === JSON.stringify(args))
    ) {
      calls.push({ name: cleanName, args });
    }
  };

  const text = stripThinkSegments(rawText);
  for (const { pattern, interpret } of BLOCK_EXTRACTORS) {
    for (const match of text.matchAll(pattern)) {
      interpret(match, addCall);
    }
  }
  extractActionLineCall(text, addCall);
  extractInlineNameCalls(text, addCall);
  return calls;
}
