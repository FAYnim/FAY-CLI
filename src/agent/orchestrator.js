/**
 * ReAct Agent Orchestrator
 * Coordinates reasoning-acting multi-turn loop between Gemini LLM,
 * Local Tools Actuator, Security Guard, and Session Persistence.
 */

import path from 'node:path';
import { parseTextToolCalls } from '../llm/openai.js';
import { createLlmClient } from '../llm/registry.js';
import { SecurityGuard } from '../security/guard.js';
import { dispatchToolCall, getToolDeclarations } from '../tools/registry.js';
import { logger as defaultLogger } from '../utils/logger.js';
import { findProjectRoot } from '../utils/project.js';
import { compactSession } from './compactor.js';
import { pruneMessages } from './pruner.js';
import { ReflectionChecker } from './reflection.js';
import { createSession, Session } from './session.js';
import { buildSystemPrompt } from './system-prompt.js';
import {
  accumulateUsage,
  contextBudgetLimit,
  getContextTokens,
  markRequestStart,
} from './usage.js';

export const DEFAULT_MAX_ITERATIONS = Infinity;

/**
 * Core ReAct Agent Orchestrator Class
 */
export class AgentOrchestrator {
  /**
   * @param {object} [options={}]
   * @param {object} [options.llmClient] - Generic LLM client instance
   * @param {string} [options.provider='gemini'] - Active provider ID
   * @param {SecurityGuard} [options.securityGuard] - Security guard engine
   * @param {Session} [options.session] - Conversation session
   * @param {string} [options.model] - Model name override
   * @param {string} [options.apiKey] - API key override
   * @param {string} [options.workingDir] - Active working directory
   * @param {number} [options.maxIterations=Infinity] - Maximum autonomous loop turns (default Infinity — the context window is the limit)
   * @param {Array<object>} [options.tools] - Tool declarations
   * @param {string} [options.systemInstruction] - Custom system prompt
   * @param {boolean} [options.autoApprove=false] - Auto-approve risky actions
   * @param {import('../utils/logger.js').Logger} [options.logger] - Logger instance
   * @param {number} [options.maxContextTokens] - Max context tokens before pruning
   * @param {number} [options.reflectionInterval=3] - Reflection check interval (0 = disabled)
   */
  constructor(options = {}) {
    this.workingDir = options.workingDir || findProjectRoot(process.cwd());
    this.maxIterations = options.maxIterations || DEFAULT_MAX_ITERATIONS;
    this.maxContextTokens = options.maxContextTokens;
    this.reflectionInterval = options.reflectionInterval != null ? options.reflectionInterval : 3;
    this.compactTimeoutMs = options.compactTimeoutMs ?? 30000;
    this.logger = options.logger || defaultLogger;
    this.locale = options.locale;
    this.mode = options.mode || 'build';
    this.activePlanPath = options.activePlanPath || null;

    // Security Guard
    this.securityGuard =
      options.securityGuard ||
      new SecurityGuard({
        autoApprove: options.autoApprove,
        baseDir: this.workingDir,
      });

    // LLM client: prefer explicit llmClient, then create from provider
    this.provider = options.provider || 'gemini';
    this.baseUrl = options.baseUrl;
    this.adapter = options.adapter;
    this.llmClient =
      options.llmClient ||
      createLlmClient({
        provider: this.provider,
        adapter: this.adapter,
        model: options.model,
        apiKey: options.apiKey,
        baseUrl: this.baseUrl,
        logger: this.logger,
        locale: this.locale,
      });
    // Session Management
    this.session =
      options.session ||
      createSession({
        model: this.llmClient.getModel(),
        provider: this.provider,
        workingDir: this.workingDir,
      });

    // Sync mode with security guard if available
    if (this.securityGuard && typeof this.securityGuard.setMode === 'function') {
      this.securityGuard.setMode(this.mode);
    }

    // Tools
    this.tools = options.tools || getToolDeclarations();

    // System prompt
    this.systemInstruction =
      options.systemInstruction ||
      buildSystemPrompt({
        workingDir: this.workingDir,
      });
  }

  /**
   * Gets current active session
   * @returns {Session}
   */
  getSession() {
    return this.session;
  }

  /**
   * Gets current execution mode ('build' | 'plan')
   * @returns {string}
   */
  getMode() {
    return this.mode;
  }

  /**
   * Gets active plan file path if in plan mode
   * @returns {string|null}
   */
  getActivePlanPath() {
    return this.activePlanPath;
  }

  /**
   * Sets current execution mode and optional active plan path
   * @param {'build'|'plan'} mode
   * @param {string|null} [planPath=null]
   */
  setMode(mode, planPath = null) {
    this.mode = mode === 'plan' ? 'plan' : 'build';
    this.activePlanPath = planPath ?? (this.mode === 'build' ? null : this.activePlanPath);
    if (this.securityGuard && typeof this.securityGuard.setMode === 'function') {
      this.securityGuard.setMode(this.mode);
    }
  }

  /**
   * Returns effective tools allowed for the current mode
   * @returns {Array<object>}
   */
  getEffectiveTools() {
    if (this.mode !== 'plan') {
      return this.tools;
    }
    const disallowedInPlan = new Set(['patch_file', 'execute_command', 'git_add_commit']);
    return this.tools.filter((t) => !disallowedInPlan.has(t.name));
  }

  /**
   * Archive file for replaced raw turns: <sessionsDir>/<id>.archive.jsonl.
   * Null when the session has no storage dir (in-memory test sessions).
   * @returns {string|null}
   */
  _archivePath() {
    const dir = this.session?.sessionsDir;
    const id = this.session?.id;
    if (!dir || !id) return null;
    return path.join(dir, `${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}.archive.jsonl`);
  }

  /**
   * Sets or attaches a new session
   * @param {Session} session
   */
  setSession(session) {
    if (!session || typeof session.getMessages !== 'function') {
      throw new TypeError('Invalid session instance');
    }
    this.session = session;
  }

  /**
   * Runs an autonomous ReAct loop for a user instruction/prompt
   *
   * @param {string} prompt - User input task
   * @param {object} [options={}]
   * @param {(token: string) => void} [options.onToken] - Real-time token streaming callback
   * @param {(call: { name: string, args: object }) => void} [options.onToolCall] - Hook when tool is called
   * @param {(name: string, result: any) => void} [options.onToolResult] - Hook when tool finishes
   * @param {(iteration: number) => void} [options.onIterationStart] - Turn hook
   * @param {AbortSignal} [options.signal] - Abort controller signal
   * @param {number} [options.maxIterations] - Override max iterations
   * @param {number} [options.reflectionInterval] - Override reflection check interval (0 = disabled)
   * @returns {Promise<{
   *   success: boolean,
   *   text: string,
   *   iterations: number,
   *   toolCalls: Array<object>,
   *   loopLimitReached: boolean,
   *   session: Session
   * }>}
   */
  async runTurn(prompt, options = {}) {
    const maxIters = options.maxIterations || this.maxIterations;
    const signal = options.signal;
    const executedToolCalls = [];
    let finalText = '';
    let loopLimitReached = false;
    let noopCompacts = 0;
    let currentIteration = 0;

    // Reflection checker (0 means disabled)
    const reflectionEnabled = (options.reflectionInterval ?? this.reflectionInterval) > 0;
    const reflectionInterval = reflectionEnabled
      ? (options.reflectionInterval ?? this.reflectionInterval)
      : 0;
    const reflectionChecker = reflectionEnabled
      ? new ReflectionChecker(this.llmClient, {
          interval: reflectionInterval,
          logger: this.logger,
        })
      : null;

    // Add user prompt to session history if provided
    if (prompt && typeof prompt === 'string' && prompt.trim() !== '') {
      this.session.addUserMessage(prompt.trim());
    }

    while (currentIteration < maxIters) {
      if (signal?.aborted) {
        throw signal.reason || new Error('ReAct loop was aborted');
      }

      currentIteration++;
      if (typeof options.onIterationStart === 'function') {
        options.onIterationStart(currentIteration);
      }

      // Step 0: Context pressure check — compact and keep going. The only
      // hard stops left are: final text answer, abort, API error,
      // reflection, an explicit cap, or the double-noop guard below.
      // Real API usage anchors the estimate when available (see usage.js).
      const currentTokens = getContextTokens(this.session);
      const budgetLimit = contextBudgetLimit(this.maxContextTokens);
      if (currentTokens > budgetLimit) {
        if (typeof options.onCompactStart === 'function') options.onCompactStart();
        let compactResult;
        try {
          compactResult = await compactSession(this.session, this.llmClient, {
            archivePath: this._archivePath(),
            logger: this.logger,
            signal,
            timeoutMs: this.compactTimeoutMs,
          });
        } catch (compactErr) {
          // Abort during compaction propagates like any other abort.
          throw compactErr;
        }
        if (typeof options.onCompactEnd === 'function') options.onCompactEnd(compactResult);

        if (compactResult.compacted) {
          noopCompacts = 0;
          try {
            this.session.save();
          } catch (saveErr) {
            this.logger.warn(`Failed to persist session after compaction: ${saveErr.message}`);
          }
        } else {
          noopCompacts++;
          if (noopCompacts >= 2) {
            this.logger.warn(
              `Context over budget (${currentTokens.toLocaleString()} / ${budgetLimit.toLocaleString()}) ` +
                `but compaction could not reduce it (nothing left to compact). Stopping ReAct loop.`,
            );
            loopLimitReached = false;
            break;
          }
        }
        // Re-check budget next iteration; the real request for this
        // iteration has not been sent yet, so nothing is wasted.
        continue;
      }

      // Step 1: Context Pruning
      const rawMessages = this.session.getMessages();
      const prunedContents = pruneMessages(rawMessages, {
        maxTokens: this.maxContextTokens,
      });

      // Step 1.5: Snapshot the estimator baseline for real-usage anchoring
      markRequestStart(this.session);

      // Step 2: Stream generation via LLM API
      let streamResult;
      try {
        streamResult = await this.llmClient.generateStream({
          contents: prunedContents,
          tools: this.getEffectiveTools(),
          systemInstruction: this.systemInstruction,
          onToken: (token) => {
            if (typeof options.onToken === 'function') {
              options.onToken(token);
            }
          },
          signal,
        });
      } catch (genErr) {
        // If stream error occurs, log and rethrow
        this.logger.error(`Generation error at turn ${currentIteration}: ${genErr.message}`);
        throw genErr;
      }

      // Step 2.5: Accumulate real API usage into session metadata
      accumulateUsage(this.session, streamResult.usage);

      let { text, functionCalls } = streamResult;

      // Fallback: If no structured function calls returned, detect embedded tool calls in text
      if (!functionCalls || functionCalls.length === 0) {
        const textCalls = parseTextToolCalls(text);
        if (textCalls.length > 0) {
          functionCalls = textCalls;
        }
      }

      // Step 3: Handle Pure Text Response (No tool calls)
      if (!functionCalls || functionCalls.length === 0) {
        finalText = text;
        this.session.addModelMessage(text);
        break; // Successfully concluded the ReAct loop
      }

      // Step 4: Handle Function Call(s)
      // Record model message containing function call(s) and any accompanying thinking text
      const modelParts = [];
      if (text?.trim()) {
        modelParts.push({ text });
      }
      for (const fc of functionCalls) {
        const part = {
          functionCall: {
            name: fc.name,
            args: fc.args || {},
          },
        };
        // Echo the thought signature back or Gemini 3+ rejects the next
        // request with 400: "missing a thought_signature in functionCall parts".
        if (fc.thoughtSignature) {
          part.thoughtSignature = fc.thoughtSignature;
        }
        modelParts.push(part);
      }
      this.session.addMessage({ role: 'model', parts: modelParts });

      // Step 5: Execute each tool call through Security Guard and Actuators
      for (const fc of functionCalls) {
        const { name, args } = fc;

        if (typeof options.onToolCall === 'function') {
          options.onToolCall(fc);
        }

        // Dispatch actuator tool with security authorization
        const toolExecution = await dispatchToolCall(name, args, {
          securityGuard: this.securityGuard,
          baseDir: this.workingDir,
          logger: this.logger,
        });

        let responsePayload;

        if (toolExecution.error) {
          // Self-correction error feedback payload
          responsePayload = {
            error: true,
            status: 'error',
            message: toolExecution.message || 'Tool execution failed',
          };
          this.logger.warn(`Tool "${name}" failed: ${toolExecution.message}`);
        } else {
          // Successful tool output
          responsePayload =
            toolExecution.result !== undefined ? toolExecution.result : { status: 'ok' };
        }

        executedToolCalls.push({
          name,
          args,
          response: responsePayload,
          iteration: currentIteration,
        });

        if (typeof options.onToolResult === 'function') {
          options.onToolResult(name, responsePayload);
        }

        // Add function response to session history
        this.session.addFunctionResponseMessage(name, responsePayload);
      }

      // Step 5.5: Record for reflection and run periodic check
      if (reflectionChecker) {
        reflectionChecker.record(currentIteration, executedToolCalls);

        // Run reflection check at interval, but skip on the very last iteration
        const isLastIteration = currentIteration >= maxIters - 1;
        if (!isLastIteration && currentIteration % reflectionInterval === 0) {
          try {
            const verdict = await reflectionChecker.check(prompt || '', currentIteration);
            if (verdict.finish) {
              this.logger.info(`[Reflection] Stopping early — ${verdict.reason}`);
              break;
            }
          } catch (refErr) {
            this.logger.warn(
              `[Reflection] Check failed at iter ${currentIteration}: ${refErr.message}`,
            );
          }
        }
      }

      // Check if we hit the iteration ceiling
      if (currentIteration >= maxIters) {
        loopLimitReached = true;
        this.logger.warn(`ReAct loop reached maximum iteration limit (${maxIters}).`);
        break;
      }
    }

    // Step 6: Atomic session save
    try {
      this.session.save();
    } catch (saveErr) {
      this.logger.warn(`Failed to persist session to disk: ${saveErr.message}`);
    }

    return {
      success: !loopLimitReached,
      text: finalText,
      iterations: currentIteration,
      toolCalls: executedToolCalls,
      loopLimitReached,
      session: this.session,
    };
  }

  /**
   * Switch active provider, recreate llmClient, update session.
   * @param {string} providerId
   * @param {object} [overrides] - optional { model, apiKey, baseUrl }
   */
  setProvider(providerId, overrides = {}) {
    if (!providerId || typeof providerId !== 'string') {
      throw new TypeError('providerId must be a non-empty string');
    }
    this.provider = providerId;
    this.adapter = overrides.adapter;
    this.llmClient = createLlmClient({
      provider: providerId,
      adapter: overrides.adapter,
      model: overrides.model || (this.llmClient ? this.llmClient.getModel() : undefined),
      apiKey: overrides.apiKey || (this.llmClient ? this.llmClient.getApiKey() : undefined),
      baseUrl: overrides.baseUrl,
      logger: this.logger,
      locale: this.locale,
    });
    if (this.session) {
      this.session.provider = providerId;
      this.session.model = this.llmClient.getModel();
    }
  }

  /**
   * Alias for runTurn
   * @param {string} prompt
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async execute(prompt, options = {}) {
    return this.runTurn(prompt, options);
  }
}

/**
 * Factory to create an AgentOrchestrator instance
 *
 * @param {object} [options={}]
 * @returns {AgentOrchestrator}
 */
export function createAgentOrchestrator(options = {}) {
  return new AgentOrchestrator(options);
}
