/**
 * Interactive REPL Session Engine
 * Multi-turn terminal interface with slash commands and SIGINT handling.
 */

import { AgentOrchestrator, createAgentOrchestrator } from '../agent/orchestrator.js';
import { contextBudgetLimit, getContextTokens, getUsage } from '../agent/usage.js';
import { APP_NAME } from '../config/constants.js';
import { ConfigManager } from '../config/manager.js';
import { loadLocale, t } from '../i18n/index.js';
import { renderBanner, renderStatusLine } from '../ui/box.js';
import { renderMarkdown } from '../ui/markdown.js';
import { closePromptLine, pausePrompt, promptLine, resumePrompt } from '../ui/prompt-editor.js';
import { createSpinner } from '../ui/spinner.js';
import { createThoughtDisplay } from '../ui/thought-display.js';
import { buildShortcutOverlay } from '../ui/shortcut-overlay.js';
import { deriveQuickFixes, renderQuickFixBar } from '../ui/quick-fix.js';
import { buildPrompt } from '../ui/history-indicator.js';
import { ansi } from '../utils/ansi.js';
import { logger as defaultLogger } from '../utils/logger.js';
import { findProjectRoot } from '../utils/project.js';
import { SecurityGuard } from '../security/guard.js';
import { getSuggestions } from './autocomplete.js';
import { executeSlashCommand, isSlashCommand } from './slash-commands.js';

export const REPL_PROMPT = `${ansi.cyan(APP_NAME)} ${ansi.bold('❯')} `;

export function buildReplPrompt(mode = 'build', turn = 0) {
  return buildPrompt({ appName: APP_NAME, turn, mode });
}

/**
 * Starts the Interactive REPL Session Loop
 *
 * @param {object} [options={}]
 * @param {AgentOrchestrator} [options.orchestrator]
 * @param {ConfigManager} [options.configMgr]
 * @param {string} [options.model]
 * @param {string} [options.apiKey]
 * @param {string} [options.workingDir]
 * @param {boolean} [options.autoApprove=false]
 * @param {NodeJS.ReadableStream} [options.input=process.stdin]
 * @param {NodeJS.WritableStream} [options.output=process.stdout]
 * @param {import('../utils/logger.js').Logger} [options.logger]
 * @returns {Promise<void>}
 */
export async function startRepl(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const logger = options.logger || defaultLogger;
  const configMgr = options.configMgr || new ConfigManager();
  await loadLocale(configMgr.get('locale'));

  // Active spinner reference — shared so SecurityGuard callbacks can stop it
  // before showing the confirmation dialog and resume afterwards.
  let activeSpinner = null;
  const thoughtDisplay = createThoughtDisplay({ stream: output });

  const orchestrator =
    options.orchestrator ||
    createAgentOrchestrator({
      model: options.model || configMgr.get('model'),
      apiKey: options.apiKey || configMgr.getApiKey(),
      workingDir: options.workingDir || findProjectRoot(process.cwd()),
      autoApprove: options.autoApprove,
      securityGuard: options.securityGuard,
      logger,
    });

  // Attach spinner coordination callbacks into the active SecurityGuard
  // (guarantees spinner stops cleanly when confirmation dialog appears, even if orchestrator was pre-created)
  const securityGuard = orchestrator.securityGuard;
  if (securityGuard) {
    securityGuard.onBeforeConfirm = () => {
      if (activeSpinner && activeSpinner.isSpinning()) {
        activeSpinner.stop();
      }
    };
    securityGuard.onAfterConfirm = (allowed) => {
      const badge = allowed
        ? `\n${ansi.green('✔')} ${ansi.bold(ansi.green(t('securityAllowed')))}`
        : `\n${ansi.red('✖')} ${ansi.bold(ansi.red(t('securityDenied')))}\n`;
      output.write(badge + '\n');
    };
  }

  const session = orchestrator.getSession();
  const activeModel = orchestrator.llmClient
    ? orchestrator.llmClient.getModel()
    : 'gemini-2.5-flash';
  const activeProvider = orchestrator.provider || 'gemini';

  // Display Welcome Banner
  const banner = renderBanner({
    title: '⚡ fay-cli',
    version: 'v1.0.0',
    subtitle: 'Autonomous AI Agent CLI for Termux Android',
    details: [
      `Provider: ${ansi.bold(ansi.green(activeProvider))}`,
      `Model   : ${ansi.bold(ansi.cyan(activeModel))}`,
      `Session : ${ansi.bold(ansi.yellow(session.id))}`,
      `WorkDir : ${ansi.dim(orchestrator.workingDir)}`,
      `Commands: Type ${ansi.cyan('/help')} for menu or ${ansi.cyan('/exit')} to quit`,
    ],
  });

  output.write(`\n${banner}\n\n`);

  let isBusy = false;
  let activeAbortController = null;
  let lastSigintTime = 0;
  let isClosing = false;
  let _wizardActive = false; // true while a sub-readline wizard owns stdin
  let lastIterations = 0;
  let turnCount = 0;

  // Ctrl+C while a turn is running aborts it. While idle, the prompt editor
  // owns raw mode and routes Ctrl+C to handleCtrlC below instead.
  const onProcessSigint = () => {
    if (isBusy && activeAbortController) {
      output.write(`\n${ansi.yellow(t('cancelled'))}\n`);
      activeAbortController.abort();
    }
  };
  process.on('SIGINT', onProcessSigint);

  // Double Ctrl+C within 1s exits; mirrors the old rl.on('SIGINT') idle path.
  const handleCtrlC = () => {
    const now = Date.now();
    if (now - lastSigintTime < 1000) {
      output.write(`\n${ansi.cyan(t('goodbye'))}\n\n`);
      isClosing = true;
      return 'exit';
    }
    lastSigintTime = now;
    output.write(`\n${ansi.dim(t('ctrlCExitHint'))}\n`);
    return 'continue';
  };

  const promptSuggestions = (text, cursor) =>
    getSuggestions(text, cursor, { workingDir: orchestrator.workingDir });

  // Prints the one-line session status (tokens · context · loops) that the
  // user sees above every new prompt. Reads fresh session state so it is
  // correct on success, error, and abort paths alike.
  const printStatusLine = () => {
    const sess = orchestrator.getSession();
    output.write(
      `\n${renderStatusLine({
        usage: getUsage(sess),
        contextTokens: getContextTokens(sess),
        contextBudget: contextBudgetLimit(orchestrator.maxContextTokens),
        iterations: lastIterations,
        maxIterations: orchestrator.maxIterations,
      })}\n`,
    );
  };

  // Main REPL Event Loop
  while (!isClosing) {
    const rawInput = await promptLine({
      input,
      output,
      prompt: buildReplPrompt(orchestrator.getMode?.() || 'build', turnCount),
      getSuggestions: promptSuggestions,
      onCtrlC: handleCtrlC,
    });
    if (rawInput === null || isClosing) {
      break;
    }

    const line = (rawInput || '').trim();
    if (!line) {
      continue;
    }

    if (line === '?') {
      output.write(`\n${buildShortcutOverlay()}\n\n`);
      continue;
    }

    // Intercept Slash Commands
    if (isSlashCommand(line)) {
      // Pause the fallback readline so the wizard (a child readline on
      // the same input stream) can read raw ESC bytes without them leaking
      // back to the REPL and being interpreted as SIGINT/exit.
      // No-op in TTY mode, where the prompt editor owns stdin.
      pausePrompt(input);
      let slashResult = { handled: false };
      try {
        slashResult = await executeSlashCommand(line, {
          orchestrator,
          configMgr,
          logger,
          stream: output,
          input,
          thoughtDisplay,
          onWizardActive: (active) => {
            _wizardActive = active;
          },
        });
      } catch (err) {
        logger.error(`Slash command failed: ${err.message}`);
        output.write(`\n${ansi.red('✖')} Command failed: ${err.message}\n\n`);
      } finally {
        resumePrompt(input);
      }

      if (slashResult?.action === 'exit') {
        isClosing = true;
        break;
      }
      continue;
    }

    // Process Agent Turn
    isBusy = true;
    activeAbortController = new AbortController();
    const spinner = createSpinner({ stream: output });
    activeSpinner = spinner; // expose to SecurityGuard callbacks
    let hasStreamedToken = false;

    try {
      const providerName = orchestrator.provider ? orchestrator.provider.toUpperCase() : 'LLM';
      spinner.start(t('contactingApi', { provider: providerName }));

      const result = await orchestrator.runTurn(line, {
        signal: activeAbortController.signal,
        onIterationStart: (iter) => {
          lastIterations = iter;
          if (iter > 1) {
            hasStreamedToken = false;
            spinner.start(t('thinkingTurn', { turn: iter }));
          }
        },
        onCompactStart: () => spinner.start('Compacting context…'),
        onCompactEnd: (r) => {
          if (r.compacted) {
            spinner.stop();
            output.write(
              `${ansi.dim(`[context compacted: ${r.method}, ${r.tokensBefore.toLocaleString()}→${r.tokensAfter.toLocaleString()} tok]`)}\n`,
            );
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
          if (!hasStreamedToken) {
            hasStreamedToken = true;
            output.write('\n');
          }
          output.write(clean);
        },
        onToolCall: (call) => {
          if (spinner.isSpinning()) {
            spinner.stop();
          }
          const argsStr = JSON.stringify(call.args || {}).slice(0, 50);
          output.write(
            `\n${ansi.magenta('⚡ [TOOL]')} ${ansi.bold(call.name)} ${ansi.dim(argsStr)}\n`,
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

      if (!hasStreamedToken && result.text) {
        output.write(`\n${renderMarkdown(result.text)}\n\n`);
      } else {
        output.write('\n\n');
      }

      const fixes = deriveQuickFixes({ toolCalls: result.toolCalls, text: result.text });
      const fixBar = renderQuickFixBar(fixes);
      if (fixBar) output.write(fixBar);
    } catch (err) {
      if (spinner.isSpinning()) {
        spinner.stop();
      }

      if (activeAbortController?.signal.aborted) {
        // Handled in SIGINT handler
      } else {
        logger.error(`Turn execution failed: ${err.message}`);
        output.write('\n');
      }
    } finally {
      isBusy = false;
      activeAbortController = null;
      activeSpinner = null;
    }
    printStatusLine();
    turnCount++;
  }

  process.removeListener('SIGINT', onProcessSigint);
  closePromptLine(input);
}
