/**
 * Interactive TUI Model Picker
 * Zero-dependency, lightweight keyboard-driven menu for switching models.
 *
 * Phase 2 of MULTI_MODEL_PLAN. Renders a vertical list of providers + their
 * available models and lets the user navigate with arrow keys, Enter to
 * select, and Esc / Ctrl+C to abort.
 *
 * Falls back to non-TTY rendering when stdin/stdout is not a TTY (caller
 * is expected to detect that and use the phase-1.3 text box instead).
 */

import readline from 'node:readline';
import { ansi } from '../utils/ansi.js';

/**
 * @typedef {Object} ModelMenuItem
 * @property {string} providerId   Provider identifier (e.g. "gemini")
 * @property {string} model        Model name (e.g. "gemini-2.5-flash")
 * @property {boolean} isActive    Whether this model is the current active one
 * @property {boolean} isCurrentProvider Whether this is the active provider
 */

/**
 * @typedef {Object} ModelMenuOptions
 * @property {string} [activeProvider='gemini'] - The currently active provider
 * @property {string} [activeModel='gemini-2.5-flash'] - The currently active model
 * @property {NodeJS.ReadableStream} [input=process.stdin] - Input stream
 * @property {NodeJS.WritableStream} [output=process.stdout] - Output stream
 * @property {boolean} [enabled] - Force enable/disable (default: detect TTY)
 */

/**
 * Build a flat list of selectable items from a provider+models map.
 * Sections are emitted as non-selectable headers in the rendering layer;
 * here we return only selectable entries.
 *
 * @param {Object<string, string[]>} providerModels
 * @param {string} activeProvider
 * @param {string} activeModel
 * @returns {Array<{providerId: string, model: string, isActive: boolean, isCurrentProvider: boolean}>}
 */
export function buildModelMenuItems(providerModels, activeProvider, activeModel) {
  const items = [];
  const ids = Object.keys(providerModels || {});
  for (const pid of ids) {
    const models = Array.isArray(providerModels[pid]) ? providerModels[pid] : [];
    for (const m of models) {
      if (typeof m !== 'string' || !m.trim()) continue;
      items.push({
        providerId: pid,
        model: m,
        isActive: pid === activeProvider && m === activeModel,
        isCurrentProvider: pid === activeProvider,
      });
    }
  }
  return items;
}

/**
 * Render a single frame of the menu to the given output stream.
 * Pure function — no side effects beyond writing to `output`.
 *
 * @param {Array<ModelMenuItem>} items
 * @param {number} selectedIndex
 * @param {string} activeProvider
 * @param {string} activeModel
 * @param {NodeJS.WritableStream} output
 */
function renderFrame(items, selectedIndex, activeProvider, activeModel, output) {
  // Header
  const header = `${ansi.bold(ansi.cyan('⚡ Select a model'))}  ${ansi.dim('(↑/↓ navigate • Enter select • Esc cancel)')}`;
  // Build lines grouped by provider, with section headers
  const lines = [header, ''];
  let lastProvider = null;
  items.forEach((it, idx) => {
    if (it.providerId !== lastProvider) {
      if (lastProvider !== null) lines.push('');
      const providerLabel = it.isCurrentProvider
        ? `${ansi.bold(ansi.yellow(it.providerId))} ${ansi.dim('(active provider)')}`
        : `${ansi.bold(ansi.cyan(it.providerId))}`;
      lines.push(`  ${providerLabel}`);
      lastProvider = it.providerId;
    }
    const isSelected = idx === selectedIndex;
    const cursor = isSelected ? ansi.green('▸') : ' ';
    const marker = it.isActive ? ansi.green('●') : ansi.dim('○');
    const name = isSelected ? ansi.bold(ansi.whiteBright(it.model)) : ansi.white(it.model);
    const tag = it.isActive ? ` ${ansi.dim('(active)')}` : '';
    lines.push(`  ${cursor} ${marker} ${name}${tag}`);
  });

  if (items.length === 0) {
    lines.push(`  ${ansi.dim('(no models available)')}`);
  }

  // Footer status
  lines.push('');
  lines.push(
    `  ${ansi.dim('Current:')} ${ansi.bold(ansi.yellow(activeProvider))} ${ansi.dim('/')} ${ansi.bold(ansi.yellow(activeModel))}`,
  );

  const frame = lines.join('\n');

  // Move cursor to top-left and clear frame
  output.write('\x1b[?25l'); // hide cursor
  output.write('\x1b[H\x1b[2J'); // clear screen
  output.write(`${frame}\n`);
}

/**
 * Clear the rendered menu frame from the terminal by emitting ANSI clear
 * sequences. Used when the user makes a selection or aborts.
 *
 * @param {NodeJS.WritableStream} output
 * @param {number} lineCount
 */
function clearFrame(output, lineCount) {
  output.write('\x1b[?25h'); // show cursor
  output.write('\x1b[H\x1b[2J');
  if (lineCount > 0) {
    // best-effort: we don't track exact line count, so re-clear is enough
  }
}

/**
 * Show the interactive model picker and resolve with the user's choice.
 *
 * @param {Array<ModelMenuItem>} items
 * @param {ModelMenuOptions} [options]
 * @returns {Promise<{cancelled: true} | {cancelled: false, providerId: string, model: string}>}
 */
export function showModelMenu(items, options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const activeProvider = options.activeProvider || 'gemini';
  const activeModel = options.activeModel || 'gemini-2.5-flash';

  const isTTY = Boolean(input?.isTTY && output?.isTTY);
  const enabled = options.enabled !== undefined ? Boolean(options.enabled) : isTTY;

  return new Promise((resolve) => {
    if (!enabled || !items || items.length === 0) {
      resolve({ cancelled: true });
      return;
    }

    let selectedIndex = 0;
    // Pre-select the active model if found
    const activeIdx = items.findIndex((it) => it.isActive);
    if (activeIdx >= 0) selectedIndex = activeIdx;

    // Ensure input is resumed so event loop does not exit while waiting for menu interaction
    if (typeof input.resume === 'function') {
      input.resume();
    }

    // Ensure keypress events are emitted on the input stream
    if (typeof input.setRawMode === 'function') {
      try {
        input.setRawMode(true);
      } catch (_) {
        // ignore — some streams (e.g. piped) don't support raw mode
      }
    }
    readline.emitKeypressEvents(input);

    const keypressHandler = (_chunk, key) => {
      if (!key) return;

      if (key.ctrl && key.name === 'c') {
        cleanup({ cancelled: true });
        return;
      }

      if (key.name === 'escape' || key.name === 'q') {
        cleanup({ cancelled: true });
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        const chosen = items[selectedIndex];
        if (!chosen) {
          cleanup({ cancelled: true });
          return;
        }
        cleanup({ cancelled: false, providerId: chosen.providerId, model: chosen.model });
        return;
      }

      if (key.name === 'up' || key.name === 'k') {
        selectedIndex = (selectedIndex - 1 + items.length) % items.length;
        renderFrame(items, selectedIndex, activeProvider, activeModel, output);
        return;
      }

      if (key.name === 'down' || key.name === 'j') {
        selectedIndex = (selectedIndex + 1) % items.length;
        renderFrame(items, selectedIndex, activeProvider, activeModel, output);
        return;
      }

      if (key.name === 'home') {
        selectedIndex = 0;
        renderFrame(items, selectedIndex, activeProvider, activeModel, output);
        return;
      }

      if (key.name === 'end') {
        selectedIndex = items.length - 1;
        renderFrame(items, selectedIndex, activeProvider, activeModel, output);
        return;
      }
    };

    const onClose = () => {
      cleanup({ cancelled: true });
    };

    function cleanup(result) {
      try {
        input.removeListener('keypress', keypressHandler);
      } catch (_) {}
      try {
        if (typeof input.setRawMode === 'function' && input.isTTY) {
          input.setRawMode(false);
        }
      } catch (_) {}
      try {
        input.removeListener('close', onClose);
      } catch (_) {}
      // Clear the menu from the screen
      clearFrame(output, 0);
      // Drain any pending keypresses that may have piled up
      if (input.readable && typeof input.read === 'function' && !input.isTTY) {
        // best-effort; not strictly needed for TTY
      }
      resolve(result);
    }

    input.on('keypress', keypressHandler);
    input.on('close', onClose);

    renderFrame(items, selectedIndex, activeProvider, activeModel, output);
  });
}

/**
 * Build the provider-models map and current model/provider from a
 * ConfigManager + orchestrator pair, then show the interactive menu.
 * Convenience wrapper used by slash-commands.
 *
 * @param {Object} ctx
 * @param {import('../config/manager.js').ConfigManager} ctx.configMgr
 * @param {import('../agent/orchestrator.js').AgentOrchestrator} [ctx.orchestrator]
 * @param {NodeJS.ReadableStream} [ctx.input]
 * @param {NodeJS.WritableStream} [ctx.output]
 * @returns {Promise<{cancelled: true} | {cancelled: false, providerId: string, model: string}>}
 */
export async function showModelMenuFromConfig(ctx = {}) {
  const { configMgr, orchestrator, input, output } = ctx;

  // Phase 2.2: prefer getModelCatalog() (canonical getter); fall back to provCfg for unknown providers
  if (!configMgr || typeof configMgr.getModelCatalog !== 'function') {
    return { cancelled: true };
  }

  const activeProvider = orchestrator?.provider || configMgr.get('activeProvider') || 'gemini';
  const client = orchestrator?.llmClient;
  let activeModel = 'gemini-2.5-flash';
  if (client && typeof client.getModel === 'function') {
    activeModel = client.getModel();
  } else {
    try {
      // Phase 2.2: use getActiveModel() instead of getProviderConfig().model
      activeModel = configMgr.getActiveModel?.(activeProvider) || activeModel;
    } catch (_) {}
  }

  // Build provider -> models map
  const stored = configMgr.loadConfig();
  const providerIds = new Set();
  providerIds.add(activeProvider);
  for (const pid of Object.keys(stored.providers || {})) providerIds.add(pid);

  // Include known builtin providers that have models (for discoverability)
  const { BUILTIN_PROVIDERS } = await import('../config/constants.js');
  for (const pid of Object.keys(BUILTIN_PROVIDERS || {})) providerIds.add(pid);

  const providerModels = {};
  for (const pid of providerIds) {
    // Phase 2.2: prefer getModelCatalog() over deprecated getProviderModels()
    const models = configMgr.getModelCatalog(pid);
    if (models && models.length > 0) {
      providerModels[pid] = models;
    }
  }

  const items = buildModelMenuItems(providerModels, activeProvider, activeModel);
  return showModelMenu(items, { activeProvider, activeModel, input, output });
}
