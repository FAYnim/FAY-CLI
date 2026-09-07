/**
 * Single-Shot Command Runner
 * Executes a single prompt or piped task through the ReAct Agent Orchestrator to completion.
 */

import { AgentOrchestrator, createAgentOrchestrator } from '../agent/orchestrator.js';
import { ConfigManager } from '../config/manager.js';
import { loadLocale, t } from '../i18n/index.js';
import { renderMarkdown } from '../ui/markdown.js';
import { createSpinner } from '../ui/spinner.js';
import { createThoughtDisplay } from '../ui/thought-display.js';
import { ansi } from '../utils/ansi.js';
import { logger as defaultLogger } from '../utils/logger.js';
import { SecurityGuard } from '../security/guard.js';

/**
 * Runs a single-shot autonomous task
 *
 * @param {string} prompt - User task or prompt
 * @param {object} [options={}]
 * @param {AgentOrchestrator} [options.orchestrator] - Preconfigured orchestrator instance
 * @param {string} [options.model] - Model override
 * @param {string} [options.apiKey] - API key override
 * @param {string} [options.workingDir] - Working directory
 * @param {boolean} [options.autoApprove=false] - Auto-approve risky actions
 * @param {AbortSignal} [options.signal] - Abort controller signal
 * @param {NodeJS.WriteStream} [options.stream=process.stdout] - Output stream
 * @param {import('../utils/logger.js').Logger} [options.logger] - Custom logger
 * @param {ConfigManager} [options.configMgr] - Config source for the locale
 * @param {boolean} [options.streamTokens=true] - Stream tokens in real-time
 * @returns {Promise<{
 *   success: boolean,
 *   text: string,
 *   iterations: number,
 *   toolCalls: Array<object>,
 *   session?: object,
 *   error?: Error
 * }>}
 */
export async function runSingleShot(prompt, options = {}) {
  const stream = options.stream || process.stdout;
  const logger = options.logger || defaultLogger;
  const streamTokens = options.streamTokens !== false;
  const configMgr = options.configMgr || new ConfigManager();
  await loadLocale(configMgr.get('locale'));



  const spinner = createSpinner({ stream });
  const thoughtDisplay = createThoughtDisplay({ stream });
  let hasStreamedToken = false;
  let streamedText = '';
  const orchestrator =
    options.orchestrator ||
    createAgentOrchestrator({
      model: options.model,
      apiKey: options.apiKey,
      workingDir: options.workingDir,
      autoApprove: options.autoApprove,
      securityGuard: options.securityGuard,
      logger,
    });

  // Attach spinner coordination callbacks into the active SecurityGuard
  if (orchestrator.securityGuard) {
    orchestrator.securityGuard.onBeforeConfirm = () => {
      if (spinner.isSpinning()) {
        spinner.stop();
      }
    };
    orchestrator.securityGuard.onAfterConfirm = (allowed) => {
      const badge = allowed
        ? `\n${ansi.green('✔')} ${ansi.bold(ansi.green(t('securityAllowed')))}`
        : `\n${ansi.red('✖')} ${ansi.bold(ansi.red(t('securityDenied')))}\n`;
      stream.write(badge + '\n');
    };
  }

  try {
    spinner.start(t('thinkingTurn', { turn: 1 }));

    const result = await orchestrator.runTurn(prompt, {
      signal: options.signal,
      onIterationStart: (iter) => {
        if (iter > 1) {
          hasStreamedToken = false;
          spinner.start(t('thinkingTurn', { turn: iter }));
        }
      },
      onToken: (token) => {
        const clean = thoughtDisplay.processToken(
          token.replace(
            /<\/?(?:tool_calls?|function_call|tool_sep)[^>]*>/gi,
            '',
          ),
        );
        if (!clean) return;

        if (spinner.isSpinning()) {
          spinner.stop();
        }
        if (streamTokens) {
          if (!hasStreamedToken) {
            hasStreamedToken = true;
            // Strip any leading newlines that the LLM emits as the first
            // token after tool calls; we add exactly one separator here.
            const stripped = clean.replace(/^\n+/, '');
            stream.write('\n');
            if (stripped) {
              stream.write(stripped);
              streamedText += stripped;
            }
          } else {
            stream.write(clean);
            streamedText += clean;
          }
        }
      },
      onToolCall: (call) => {
        if (spinner.isSpinning()) {
          spinner.stop();
        }
        const toolDetails = call.args ? JSON.stringify(call.args).slice(0, 60) : '';
        const preview = toolDetails.length >= 60 ? `${toolDetails}...` : toolDetails;
        stream.write(
          `\n${ansi.magenta('⚡ [TOOL]')} ${ansi.bold(call.name)} ${ansi.dim(preview)}\n`,
        );
        spinner.start(t('runningTool', { tool: call.name }));
      },
      onToolResult: (name, toolRes) => {
        if (toolRes?.error) {
          spinner.warn(t('toolError', { tool: name, message: toolRes.message || t('failed') }));
        } else {
          spinner.succeed(t('toolDone', { tool: name }));
        }
        spinner.start(t('analyzingResult'));
      },
    });

    if (spinner.isSpinning()) {
      spinner.stop();
    }

    // If tokens weren't streamed in real time, render Markdown now
    if (!streamTokens && result.text) {
      const formatted = renderMarkdown(result.text);
      stream.write(`\n${formatted}\n`);
    } else if (hasStreamedToken) {
      // Last streamed token already ends with \n; no extra newline needed
      // to avoid double blank line after the response.
    }

    return {
      success: result.success,
      text: result.text,
      iterations: result.iterations,
      toolCalls: result.toolCalls,
      session: result.session,
    };
  } catch (err) {
    if (spinner.isSpinning()) {
      spinner.stop();
    }

    if (options.signal?.aborted) {
      stream.write(`\n${ansi.yellow(t('cancelled'))}\n\n`);
      return {
        success: false,
        text: streamedText,
        iterations: 0,
        toolCalls: [],
        error: err,
      };
    }

    logger.error(`Single-shot task failed: ${err.message}`);
    return {
      success: false,
      text: streamedText,
      iterations: 0,
      toolCalls: [],
      error: err,
    };
  }
}
