/**
 * REPL Slash Commands Handler
 * Handles in-session commands (/help, /model, /session, /clear, /config, /exit)
 */

import fs from 'node:fs';
import path from 'node:path';
import { compactSession } from '../agent/compactor.js';
import { estimateSessionTokens } from '../agent/pruner.js';
import { getUsage } from '../agent/usage.js';
import { renderBox, renderStatusCard } from '../ui/box.js';
import { showModelMenuFromConfig } from '../ui/model-menu.js';
import { ansi } from '../utils/ansi.js';
import { logger as defaultLogger } from '../utils/logger.js';
import { addModelsCli, clearModelsCli, removeModelCli } from './model-commands.js';
import { runProviderAddWizard } from './provider-wizard.js';

export const SLASH_COMMANDS_HELP = [
  { cmd: '/help', desc: 'Show this slash commands help menu' },
  {
    cmd: '/plan [title]',
    desc: 'Enter Plan Mode (read-only research & plan drafting in .fay/plans/)',
  },
  { cmd: '/build', desc: 'Exit Plan Mode and switch to Build Mode to execute code changes' },
  { cmd: '/provider [id]', desc: 'Show active provider or switch provider + persist' },
  { cmd: '/provider list', desc: 'List configured providers' },
  { cmd: '/provider add [id]', desc: 'Add a new provider via interactive wizard' },
  { cmd: '/provider remove <id>', desc: 'Remove a configured provider' },
  { cmd: '/provider show [id]', desc: 'Show provider config details' },
  {
    cmd: '/model [name]',
    desc: 'Show available models (interactive TTY menu) or switch to a new model',
  },
  { cmd: '/model add <name[,...]>', desc: 'Add model(s) to provider catalog' },
  { cmd: '/model remove <name>', desc: 'Remove a model from provider catalog' },
  { cmd: '/model clear', desc: 'Reset provider catalog to builtin defaults' },
  { cmd: '/session', desc: 'Display current session ID, token usage & stats' },
  {
    cmd: '/compact',
    desc: 'Summarize older context now to free space (agent loop does it automatically at 92%)',
  },
  { cmd: '/thoughts', desc: 'Toggle display of LLM reasoning/thought steps (hidden by default)' },
  { cmd: '/clear', desc: 'Clear the terminal screen' },
  { cmd: '/config', desc: 'Display active CLI configuration settings' },
  { cmd: '/exit, /quit', desc: 'Exit interactive REPL session' },
];

/**
 * Parse --provider flag from an args array.
 * e.g. ['add', 'gpt-4', '--provider', 'openai'] → 'openai'
 * @param {string[]} args
 * @returns {string|null}
 */
function parseProviderFlag(args) {
  const idx = args.indexOf('--provider');
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return null;
}

/**
 * Determines if user input is a slash command
 * @param {string} input
 * @returns {boolean}
 */
export function isSlashCommand(input) {
  if (!input || typeof input !== 'string') return false;
  return input.trim().startsWith('/');
}

/**
 * Parses and executes a slash command
 *
 * @param {string} input - Raw command line starting with '/'
 * @param {object} context - Execution context
 * @param {import('../agent/orchestrator.js').AgentOrchestrator} [context.orchestrator]
 * @param {import('../config/manager.js').ConfigManager} [context.configMgr]
 * @param {import('../utils/logger.js').logger} [context.logger]
 * @param {NodeJS.WriteStream} [context.stream=process.stdout]
 * @param {NodeJS.ReadableStream} [context.input=process.stdin]
 * @returns {Promise<{ handled: boolean, action?: string, message?: string, error?: boolean }>}
 */
export async function executeSlashCommand(input, context = {}) {
  if (!isSlashCommand(input)) {
    return { handled: false };
  }

  const parts = input.trim().slice(1).split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);
  const stream = context.stream || process.stdout;
  const configMgr = context.configMgr;
  const orchestrator = context.orchestrator;
  const inputStream = context.input || process.stdin;
  const logger = context.logger || defaultLogger;

  switch (command) {
    case 'help': {
      const lines = SLASH_COMMANDS_HELP.map(
        (c) => `${ansi.cyanBright(c.cmd.padEnd(16))} ${ansi.dim('─')} ${ansi.white(c.desc)}`,
      );
      const box = renderBox(lines.join('\n'), {
        title: 'REPL Slash Commands',
        borderColor: 'cyan',
        borderStyle: 'round',
        minWidth: 48,
      });
      stream.write(`\n${box}\n\n`);
      return { handled: true, action: 'help' };
    }

    case 'plan': {
      if (!orchestrator) return { handled: true, error: true, message: 'No active orchestrator' };
      if (orchestrator.getMode?.() === 'plan') {
        stream.write(`\n${ansi.yellow('⚠')} Already in Plan Mode.\n\n`);
        return { handled: true, action: 'plan', planPath: orchestrator.getActivePlanPath?.() };
      }
      const plansDir = path.join(orchestrator.workingDir, '.fay', 'plans');
      fs.mkdirSync(plansDir, { recursive: true });
      const titleSlug = args.join('-').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'task';
      const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
      const planFile = path.join(plansDir, `plan-${timestamp}-${titleSlug}.md`);
      const initialContent = `# Plan: ${args.join(' ') || 'Untitled Plan'}\n\n- Created: ${new Date().toISOString()}\n- Status: Draft\n\n## Context & Findings\n\n## Action Checklist\n- [ ] 1. Initial investigation\n\n## Verification & Tests\n`;
      fs.writeFileSync(planFile, initialContent, 'utf-8');
      orchestrator.setMode?.('plan', planFile);

      stream.write(
        `\n${ansi.green('✔')} Switched to ${ansi.bold(ansi.yellow('Plan Mode'))}.\n\n`,
      );
      return { handled: true, action: 'plan', planPath: planFile };
    }

    case 'build': {
      if (!orchestrator) return { handled: true, error: true, message: 'No active orchestrator' };
      if (orchestrator.getMode?.() === 'build') {
        stream.write(`\n${ansi.cyan('ℹ')} Already in Build Mode.\n\n`);
        return { handled: true, action: 'build' };
      }
      const activePlan = orchestrator.getActivePlanPath?.();
      orchestrator.setMode?.('build', null);
      stream.write(
        `\n${ansi.green('✔')} Switched to ${ansi.bold(ansi.green('Build Mode'))}.\n\n`,
      );
      return { handled: true, action: 'build', planPath: activePlan };
    }

    case 'provider': {
      const action = args[0];
      if (action === 'list') {
        const config = configMgr ? configMgr.loadConfig() : {};
        const providers = config.providers || {};
        const lines = Object.entries(providers).map(
          ([id, cfg]) =>
            `  ${ansi.cyan(id.padEnd(12))} ${ansi.dim('|')} ${ansi.white(cfg.model || '(default)')} ${ansi.dim('|')} ${ansi.white(cfg.baseUrl || '(default)')}`,
        );
        if (!lines.length) lines.push(ansi.dim('  (no providers configured)'));
        const box = renderBox(lines.join('\n'), {
          title: 'Providers',
          borderColor: 'cyan',
          borderStyle: 'round',
          minWidth: 48,
        });
        stream.write(`\n${box}\n\n`);
        return { handled: true, action: 'provider_list' };
      }

      // ── /provider add ──────────────────────────────────────────────
      if (action === 'add') {
        const prefilledId = args[1] || null; // /provider add <id> pre-fills step 1
        // Tell REPL a wizard is running so its SIGINT handler doesn't print
        // the "press Ctrl+C again to exit" hint or re-prompt while the wizard
        // owns stdin. See repl.js rl.on('SIGINT').
        if (typeof context.onWizardActive === 'function') context.onWizardActive(true);
        const wizardResult = await runProviderAddWizard({
          configMgr,
          stream,
          input: inputStream,
          prefilledId,
        });
        if (typeof context.onWizardActive === 'function') context.onWizardActive(false);

        if (wizardResult.cancelled) {
          return { handled: true, action: 'provider_add_cancelled' };
        }

        // Persist to config
        const cfg = configMgr ? configMgr.loadConfig() : {};
        if (!cfg.providers) cfg.providers = {};
        cfg.providers[wizardResult.providerId] = wizardResult.config;
        if (configMgr) configMgr.saveConfig(cfg);

        // Optionally switch active provider
        if (wizardResult.switchNow) {
          if (configMgr) configMgr.set('activeProvider', wizardResult.providerId);
          if (orchestrator && typeof orchestrator.setProvider === 'function') {
            try {
              orchestrator.setProvider(wizardResult.providerId, {
                apiKey: wizardResult.config.apiKey,
                model: wizardResult.config.model,
                baseUrl: wizardResult.config.baseUrl,
              });
            } catch (_) {
              // setProvider may fail if adapter not loaded — config already saved
              stream.write(
                `${ansi.yellow('ℹ')} Could not switch live session. Restart REPL to apply.\n\n`,
              );
            }
          } else if (!orchestrator) {
            stream.write(
              `${ansi.yellow('ℹ')} No active session. Restart REPL to apply provider switch.\n\n`,
            );
          }
          stream.write(
            `\n${ansi.green('✔')} Provider "${ansi.bold(ansi.yellow(wizardResult.providerId))}" saved and activated.\n\n`,
          );
        } else {
          stream.write(
            `\n${ansi.green('✔')} Provider "${ansi.bold(ansi.yellow(wizardResult.providerId))}" saved.\n  To use it: ${ansi.cyan(`/provider ${wizardResult.providerId}`)}\n\n`,
          );
        }

        return { handled: true, action: 'provider_added', providerId: wizardResult.providerId };
      }

      // ── /provider remove <id> ──────────────────────────────────────
      if (action === 'remove') {
        const removeId = args[1];
        if (!removeId) {
          stream.write(`\n${ansi.yellow('⚠')} Usage: /provider remove <id>\n\n`);
          return { handled: true, action: 'provider_remove_error', error: true };
        }

        // Guard: refuse to remove builtin providers
        const { BUILTIN_PROVIDERS } = await import('../config/constants.js');
        if (BUILTIN_PROVIDERS[removeId]) {
          stream.write(
            `\n${ansi.red('✖')} Cannot remove builtin provider "${ansi.bold(removeId)}". Only custom providers can be removed.\n\n`,
          );
          return { handled: true, action: 'provider_remove_error', error: true };
        }

        // Confirm if removing active provider
        const activeP = orchestrator?.provider || configMgr?.get('activeProvider') || 'gemini';
        if (removeId === activeP) {
          stream.write(
            `\n${ansi.yellow('⚠')} "${ansi.bold(removeId)}" is the active provider. Remove anyway? [y/N]: `,
          );
          const confirm = await new Promise((resolve) => {
            const onData = (chunk) => {
              inputStream.removeListener('data', onData);
              resolve(chunk.toString().trim());
            };
            inputStream.once('data', onData);
          });
          if (confirm.toLowerCase() !== 'y') {
            stream.write(`${ansi.dim('Removal cancelled.')}\n\n`);
            return { handled: true, action: 'provider_remove_cancelled' };
          }
        }

        try {
          if (configMgr) configMgr.removeProvider(removeId);
          stream.write(
            `\n${ansi.green('✔')} Provider "${ansi.bold(ansi.yellow(removeId))}" removed.\n\n`,
          );
          return { handled: true, action: 'provider_removed' };
        } catch (err) {
          stream.write(`\n${ansi.red('✖')} ${err.message}\n\n`);
          return { handled: true, action: 'provider_remove_error', error: true };
        }
      }

      // ── /provider show [id] ────────────────────────────────────────
      if (action === 'show') {
        const showId =
          args[1] || orchestrator?.provider || configMgr?.get('activeProvider') || 'gemini';
        try {
          const provCfg = configMgr ? configMgr.getProviderConfig(showId) : {};
          // Mask API key for display
          const display = { ...provCfg };
          if (display.apiKey && typeof display.apiKey === 'string' && display.apiKey.length > 8) {
            display.apiKey = `${display.apiKey.slice(0, 4)}...${display.apiKey.slice(-4)}`;
          }
          const lines = Object.entries(display)
            .filter(([, v]) => v !== undefined && v !== null && (!Array.isArray(v) || v.length > 0))
            .map(([k, v]) => {
              const val = Array.isArray(v) ? v.join(', ') : String(v);
              return `  ${ansi.cyan(k.padEnd(14))} ${ansi.dim('│')} ${ansi.white(val)}`;
            });
          const box = renderBox(lines.join('\n'), {
            title: `Provider: ${showId}`,
            borderColor: 'cyan',
            borderStyle: 'round',
            minWidth: 48,
          });
          stream.write(`\n${box}\n\n`);
          return { handled: true, action: 'provider_show' };
        } catch (err) {
          stream.write(`\n${ansi.yellow('⚠')} ${err.message}\n\n`);
          return { handled: true, action: 'provider_show_error', error: true };
        }
      }

      const providerId = action;
      if (!providerId) {
        const active = orchestrator?.provider || configMgr?.get('activeProvider') || 'gemini';
        stream.write(`\n${ansi.cyan('ℹ')} Active provider: ${ansi.bold(ansi.yellow(active))}\n\n`);
        return { handled: true, action: 'provider_info' };
      }

      if (orchestrator && typeof orchestrator.setProvider === 'function') {
        try {
          const providerConfig = configMgr ? configMgr.getProviderConfig(providerId) : {};
          const apiKey = configMgr ? configMgr.getApiKey(null, providerId) : null;
          orchestrator.setProvider(providerId, {
            apiKey,
            model: providerConfig.model || providerConfig.defaultModel,
            baseUrl: providerConfig.baseUrl || providerConfig.defaultBaseUrl,
          });
          if (configMgr) configMgr.set('activeProvider', providerId);
          stream.write(
            `\n${ansi.green('✔')} Switched provider to: ${ansi.bold(ansi.yellow(providerId))}\n\n`,
          );
          return { handled: true, action: 'provider_changed' };
        } catch (err) {
          stream.write(`\n${ansi.yellow('⚠')} ${err.message}\n\n`);
          return { handled: true, action: 'provider_error', error: true };
        }
      }

      stream.write(`\n${ansi.yellow('⚠')} No orchestrator context for /provider.\n\n`);
      return { handled: true, action: 'provider_error', error: true };
    }

    case 'model': {
      const modelSubCmd = args[0];
      const providerOverride = parseProviderFlag(args);

      // Sub-command routing: add / remove / clear
      if (modelSubCmd === 'add') {
        // Collect everything between 'add' and any '--provider' flag as model names
        const modelArgs = args.slice(1).filter((a) => a !== '--provider' && a !== providerOverride);
        const models = modelArgs.join(',') || '';
        const result = addModelsCli({ configMgr, models, providerOverride });
        if (result.output) stream.write(result.output);
        return { handled: true, action: 'model_add', error: result.exitCode !== 0 };
      }

      if (modelSubCmd === 'remove') {
        const modelArgs = args.slice(1).filter((a) => a !== '--provider' && a !== providerOverride);
        const models = modelArgs.join(',') || '';
        const result = removeModelCli({ configMgr, models, providerOverride });
        if (result.output) stream.write(result.output);
        return { handled: true, action: 'model_remove', error: result.exitCode !== 0 };
      }

      if (modelSubCmd === 'clear') {
        const result = clearModelsCli({ configMgr, providerOverride });
        if (result.output) stream.write(result.output);
        return { handled: true, action: 'model_clear', error: result.exitCode !== 0 };
      }

      // Not a sub-command — fall through to existing model switch/info behavior
      const newModel = modelSubCmd;
      if (!newModel) {
        let currentModel = 'unknown';
        const client = orchestrator?.llmClient;
        if (client && typeof client.getModel === 'function') {
          currentModel = client.getModel();
        } else if (configMgr) {
          const act = configMgr.get('activeProvider') || 'gemini';
          try {
            // Phase 2.2: use getActiveModel() instead of getProviderConfig().model
            currentModel = configMgr.getActiveModel?.(act) || 'gemini-2.5-flash';
          } catch {
            currentModel = 'gemini-2.5-flash';
          }
        }

        // Phase 2: If we're attached to a TTY, show interactive menu first.
        // The text box (Phase 1.3) is still rendered afterwards as a reference
        // for any TTY fallbacks (e.g. menu with no items).
        const isInteractiveTty = Boolean(
          stream?.isTTY && typeof stream === 'object' && inputStream?.isTTY,
        );

        // Phase 2.2: prefer getModelCatalog() (canonical getter) — guard updated accordingly
        if (isInteractiveTty && configMgr && typeof configMgr.getModelCatalog === 'function') {
          const menuResult = await showModelMenuFromConfig({
            configMgr,
            orchestrator,
            input: inputStream,
            output: stream,
          });

          if (!menuResult.cancelled) {
            // Apply the selection through the same code path as `/model <name>`
            const chosen = menuResult.model;
            if (orchestrator) {
              if (orchestrator.llmClient) {
                if (typeof orchestrator.llmClient.setModel === 'function') {
                  orchestrator.llmClient.setModel(chosen);
                } else {
                  orchestrator.llmClient.model = chosen;
                }
              }
              if (orchestrator.session) {
                orchestrator.session.model = chosen;
              }
            }
            if (configMgr) {
              const act = orchestrator?.provider || configMgr.get('activeProvider') || 'gemini';
              configMgr.setProviderField(act, 'model', chosen);
            }
            const providerLabel =
              menuResult.providerId !== (orchestrator?.provider || configMgr.get('activeProvider'))
                ? ` (provider: ${ansi.bold(ansi.yellow(menuResult.providerId))})`
                : '';
            stream.write(
              `\n${ansi.green('✔')} Switched active model to: ${ansi.bold(ansi.yellow(chosen))}${providerLabel}\n\n`,
            );
            return { handled: true, action: 'model_changed', message: chosen };
          }

          // User cancelled the interactive menu → fall through to the static box
        }

        // Phase 1.3: Render box with available models for active provider
        let modelLines = [];
        // Phase 2.2: prefer getModelCatalog() over deprecated getProviderModels()
        if (configMgr && typeof configMgr.getModelCatalog === 'function') {
          const act = orchestrator?.provider || configMgr.get('activeProvider') || 'gemini';
          const allModels = configMgr.getModelCatalog(act);
          if (allModels.length > 0) {
            modelLines = allModels.map((m) =>
              m === currentModel
                ? `  ${ansi.green('▸')} ${ansi.bold(ansi.yellow(m))} ${ansi.dim('(active)')}`
                : `    ${ansi.white(m)}`,
            );

            // Show other providers' models in a second section
            const stored = configMgr.loadConfig().providers || {};
            const otherIds = Object.keys(stored).filter((pid) => pid !== act);
            if (otherIds.length > 0) {
              const otherLines = [];
              for (const pid of otherIds) {
                // Phase 2.2: prefer getModelCatalog() over deprecated getProviderModels()
                const pm = configMgr.getModelCatalog(pid);
                if (pm.length > 0) {
                  otherLines.push(`  ${ansi.cyan(`${pid}:`)} ${pm.join(', ')}`);
                }
              }
              if (otherLines.length > 0) {
                modelLines.push('');
                modelLines.push(ansi.dim('  Other providers:'));
                modelLines.push(...otherLines);
              }
            }

            const box = renderBox(modelLines.join('\n'), {
              title: `Model (${act})`,
              borderColor: 'cyan',
              borderStyle: 'round',
              minWidth: 48,
            });
            stream.write(`\n${box}\n\n`);
            return { handled: true, action: 'model_info', message: currentModel };
          }
        }

        // Fallback: original single-line output (no getModelCatalog or empty list)
        stream.write(
          `\n${ansi.cyan('ℹ')} Active model: ${ansi.bold(ansi.yellow(currentModel))}\n\n`,
        );
        return { handled: true, action: 'model_info', message: currentModel };
      }

      if (orchestrator) {
        if (orchestrator.llmClient) {
          if (typeof orchestrator.llmClient.setModel === 'function') {
            orchestrator.llmClient.setModel(newModel);
          } else {
            orchestrator.llmClient.model = newModel;
          }
        }
        if (orchestrator.session) {
          orchestrator.session.model = newModel;
        }
      }
      if (configMgr) {
        const act = orchestrator?.provider || configMgr.get('activeProvider') || 'gemini';
        configMgr.setProviderField(act, 'model', newModel);
      }
      stream.write(
        `\n${ansi.green('✔')} Switched active model to: ${ansi.bold(ansi.yellow(newModel))}\n\n`,
      );
      return { handled: true, action: 'model_changed', message: newModel };
    }

    case 'session': {
      if (!orchestrator?.session) {
        stream.write(`\n${ansi.yellow('⚠')} No active session context found.\n\n`);
        return { handled: true, action: 'session_info', error: true };
      }

      const sess = orchestrator.session;
      const msgs = sess.getMessages ? sess.getMessages() : [];
      const tokenEst = estimateSessionTokens ? estimateSessionTokens(sess) : 0;
      const usage = getUsage(sess);

      const card = renderStatusCard('Active Session Details', {
        'Session ID': sess.id || 'N/A',
        Model: orchestrator.llmClient?.getModel() || sess.model || 'N/A',
        'Working Dir': sess.workingDir || process.cwd(),
        'Message Turns': msgs.length,
        'Est. Tokens': `${tokenEst.toLocaleString()} tokens`,
        'API Requests': usage.llmRequests,
        'API Prompt Tokens': usage.promptTokens.toLocaleString(),
        'API Completion Tokens': usage.completionTokens.toLocaleString(),
        'API Total Tokens': usage.totalTokens.toLocaleString(),
        'Created At': sess.createdAt ? new Date(sess.createdAt).toLocaleString() : 'N/A',
      });

      stream.write(`\n${card}\n\n`);
      return { handled: true, action: 'session_info' };
    }

    case 'compact': {
      if (!orchestrator?.session) {
        stream.write(`\n${ansi.yellow('⚠')} No active session context found.\n\n`);
        return { handled: true, action: 'compact', error: true };
      }
      const sess = orchestrator.session;
      const result = await compactSession(sess, orchestrator.llmClient, {
        archivePath: sess.sessionsDir
          ? `${path.join(sess.sessionsDir, String(sess.id).replace(/[^a-zA-Z0-9_-]/g, ''))}.archive.jsonl`
          : null,
        logger,
      });
      if (!result.compacted) {
        stream.write(
          `\n${ansi.dim('Nothing to compact — recent window already fits. Context: ')}${ansi.white(result.tokensBefore.toLocaleString())} ${ansi.dim('tokens')}\n\n`,
        );
        return { handled: true, action: 'compact', method: 'noop' };
      }
      try {
        sess.save();
      } catch (e) {
        logger.warn(`Failed to persist session after manual compact: ${e.message}`);
      }
      stream.write(
        `\n${ansi.green('✔')} Context compacted (${ansi.cyan(result.method)}): ` +
          `${ansi.white(result.tokensBefore.toLocaleString())} → ${ansi.white(result.tokensAfter.toLocaleString())} tokens\n\n`,
      );
      return { handled: true, action: 'compact', method: result.method };
    }

    case 'thoughts': {
      if (!context.thoughtDisplay) {
        stream.write(`\n${ansi.yellow('\u26A0')} Thought display not available in this context.\n\n`);
        return { handled: true, action: 'thoughts_error', error: true };
      }
      const nowEnabled = context.thoughtDisplay.toggle();
      stream.write(`\n${ansi.cyan('\u2139')} Thought display: ${nowEnabled ? ansi.green('ON') : ansi.dim('OFF')}\n\n`);
      return { handled: true, action: 'thoughts_toggle', enabled: nowEnabled };
    }

    case 'clear': {
      if (typeof console.clear === 'function') {
        console.clear();
      } else {
        stream.write('\x1b[2J\x1b[0f');
      }
      return { handled: true, action: 'clear' };
    }

    case 'config': {
      const cfg = configMgr ? configMgr.list({ maskApiKey: true }) : {};
      const card = renderStatusCard('Configuration Settings', cfg);
      stream.write(`\n${card}\n\n`);
      return { handled: true, action: 'config_info' };
    }

    case 'exit':
    case 'quit': {
      stream.write(`\n${ansi.cyan('👋 Goodbye! Session saved.')}\n\n`);
      return { handled: true, action: 'exit' };
    }

    default: {
      const errMsg = `Unknown slash command: "/${command}". Type ${ansi.cyan('/help')} for a list of available commands.`;
      stream.write(`\n${ansi.yellow('⚠')} ${errMsg}\n\n`);
      return { handled: true, action: 'unknown', error: true, message: errMsg };
    }
  }
}
