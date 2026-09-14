/**
 * Reflection Checker — Self-Evaluation Loop
 * Periodically asks the LLM to assess whether the current task is complete
 * based on recent tool calls, preventing unnecessary iterations.
 */

/**
 * Default reflection check interval (every N iterations)
 */
const DEFAULT_REFLECTION_INTERVAL = 3;

/**
 * System prompt for reflection evaluator — instructs the LLM to output JSON only
 */
export const REFLECTION_SYSTEM_INSTRUCTION = `You are an AI agent progress evaluator. Given a task and a list of recent tool calls, decide whether the task has been completed.

Respond with ONLY a valid JSON object, nothing else:
{
  "finish": true,
  "reason": "Brief explanation"
}
or
{
  "finish": false,
  "reason": "Brief explanation of what remains"
}

Rules:
- Set "finish": true when the task goal appears achieved or no further meaningful progress is possible.
- Set "finish": false when the agent is still actively working toward the goal.
- Be conservative: when uncertain, prefer "finish": false to avoid premature termination.`;

/**
 * Builds the reflection user prompt from original task and recent tool calls
 */
export function buildReflectionPrompt(originalPrompt, iterationCount, recentToolCalls) {
  const callsDetail =
    recentToolCalls.length > 0
      ? recentToolCalls.map((c) => `  - ${c.name}(${JSON.stringify(c.args)})`).join('\n')
      : '  (none yet)';

  return `TASK: ${originalPrompt}

PROGRESS:
- Current iteration: ${iterationCount}
- Recent tool calls made:
${callsDetail}

EVALUATE: Has the task been completed?
Respond ONLY with a JSON object in this exact format:
{
  "finish": true or false,
  "reason": "Brief explanation"
}`;
}

/**
 * Helper to normalize raw parsed object into { finish: boolean, reason: string }
 * @param {any} parsed
 * @returns {{finish: boolean, reason: string}|null}
 */
function normalizeReflectionObject(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  // Resolve finish status
  let finish = undefined;
  const rawFinish =
    parsed.finish ??
    parsed.completed ??
    parsed.done ??
    parsed.is_finished ??
    parsed.isComplete;

  if (typeof rawFinish === 'boolean') {
    finish = rawFinish;
  } else if (typeof rawFinish === 'string') {
    const lower = rawFinish.trim().toLowerCase();
    if (lower === 'true' || lower === 'yes' || lower === '1') finish = true;
    else if (lower === 'false' || lower === 'no' || lower === '0') finish = false;
  }

  if (typeof finish !== 'boolean') {
    return null;
  }

  // Resolve reason
  const rawReason =
    parsed.reason ??
    parsed.explanation ??
    parsed.message ??
    parsed.details ??
    parsed.summary;

  let reason = '';
  if (typeof rawReason === 'string') {
    reason = rawReason.trim();
  } else if (rawReason != null) {
    reason = String(rawReason).trim();
  }

  if (!reason) {
    reason = finish ? 'Task goal achieved' : 'Task in progress';
  }

  return { finish, reason };
}

/**
 * Parses a reflection response string into { finish, reason }
 * Handles markdown fences, preamble/postamble text, nested braces, and field aliases.
 *
 * @param {string} text
 * @returns {{finish: boolean, reason: string}|null}
 */
export function parseReflectionResponse(text) {
  if (!text || typeof text !== 'string') return null;

  const trimmed = text.trim();

  // 1. Direct JSON parse (if already clean JSON)
  try {
    const parsed = JSON.parse(trimmed);
    const normalized = normalizeReflectionObject(parsed);
    if (normalized) return normalized;
  } catch {
    /* silent-ok: staged JSON.parse cascade; next candidate tried below */
  }

  // 2. Extract content from markdown code fence block if present: ```json ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1]) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      const normalized = normalizeReflectionObject(parsed);
      if (normalized) return normalized;
    } catch {
      /* silent-ok: staged JSON.parse cascade; next candidate tried below */
    }
  }

  // 3. Robust substring extraction: between outermost curly braces
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(candidate);
      const normalized = normalizeReflectionObject(parsed);
      if (normalized) return normalized;
    } catch {
      /* silent-ok: staged JSON.parse cascade; next candidate tried below */
    }
  }

  return null;
}

/**
 * Reflection Checker class.
 * Stores a sliding window of recent tool calls and periodically queries the LLM
 * to assess whether the original task has been completed.
 */
export class ReflectionChecker {
  /**
   * @param {object} llmClient - LLM client instance with .generate() method
   * @param {object} [options={}]
   * @param {number} [options.interval=3] - Run reflection check every N iterations
   * @param {number} [options.windowSize=6] - Keep this many past iterations in history
   * @param {import('../utils/logger.js').Logger} [options.logger] - Logger instance
   */
  constructor(llmClient, options = {}) {
    this.llmClient = llmClient;
    this.interval = options.interval ?? DEFAULT_REFLECTION_INTERVAL;
    this.windowSize = options.windowSize || 6;
    this.logger = options.logger;
    this._history = []; // [{ iteration, calls: [{name, args}] }]
  }

  /**
   * Record tool calls from the current iteration into the sliding window
   * @param {number} iteration
   * @param {Array<object>} toolCalls
   */
  record(iteration, toolCalls) {
    const calls = Array.isArray(toolCalls)
      ? toolCalls.map((c) => ({ name: c.name, args: c.args || {} }))
      : [];

    this._history.push({ iteration, calls });

    if (this._history.length > this.windowSize) {
      this._history.shift();
    }
  }

  /**
   * Perform a reflection check against the LLM.
   * Returns { finish: boolean, reason: string }.
   * On failure (parse error, network error), returns { finish: false, reason: '...' }.
   *
   * @param {string} originalPrompt - The user's original task
   * @param {number} currentIteration - Current loop iteration (1-based)
   * @returns {Promise<{finish: boolean, reason: string}>}
   */
  async check(originalPrompt, currentIteration) {
    if (!this.llmClient) {
      return { finish: false, reason: 'no_llm_client' };
    }

    const recentCalls = this._history.flatMap((h) => h.calls);
    if (recentCalls.length === 0) {
      return { finish: false, reason: 'no_actions_yet' };
    }

    const userPrompt = buildReflectionPrompt(originalPrompt, currentIteration, recentCalls);

    try {
      const result = await this.llmClient.generate({
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        systemInstruction: REFLECTION_SYSTEM_INSTRUCTION,
        generationConfig: { responseMimeType: 'application/json' },
        timeoutMs: 15000,
      });

      const text = result?.text?.trim() || '';
      const parsed = parseReflectionResponse(text);

      if (parsed) {
        (this.logger?.info || (() => {}))(
          `[Reflection] iter ${currentIteration}: ${parsed.reason}`,
        );
        return parsed;
      }

      (this.logger?.warn || (() => {}))(
        `[Reflection] iter ${currentIteration}: response not parseable as JSON, continuing`,
      );
      return { finish: false, reason: 'parse_failed' };
    } catch (err) {
      (this.logger?.warn || (() => {}))(
        `[Reflection] iter ${currentIteration}: check failed (${err.message}), continuing`,
      );
      return { finish: false, reason: `error: ${err.message}` };
    }
  }

  /**
   * Reset internal history (call between separate runTurn invocations if needed)
   */
  reset() {
    this._history = [];
  }

  /**
   * Expose history for testing
   * @returns {Array<{iteration: number, calls: Array<{name:string, args:object}>}>}
   */
  getHistory() {
    return [...this._history];
  }
}

/**
 * Factory function to create a ReflectionChecker
 */
export function createReflectionChecker(llmClient, options = {}) {
  return new ReflectionChecker(llmClient, options);
}
