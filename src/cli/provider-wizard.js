/**
 * Interactive wizard for /provider add REPL command.
 * Zero new dependencies — uses node:readline (built-in).
 */
import readline from 'node:readline';
import { ansi } from '../utils/ansi.js';

/**
 * Returns true when a base URL points to a local endpoint
 * (Ollama / self-hosted use case — API key is optional).
 * @param {string} url
 * @returns {boolean}
 */
export function isLocalUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.toLowerCase();
  return u.includes('localhost') || u.includes('127.0.0.1');
}

/**
 * Determines whether an API key is required given the adapter and base URL.
 * @param {'openai'|'gemini'} adapter
 * @param {string} baseUrl  empty string means "use adapter default"
 * @returns {boolean}
 */
export function isApiKeyRequired(adapter, baseUrl) {
  if (adapter === 'gemini') return true;
  // openai: local endpoints (Ollama) don't need a key
  if (isLocalUrl(baseUrl)) return false;
  // openai: everything else (default OpenAI, cloud endpoints) needs a key
  return true;
}

/**
 * Runs the interactive /provider add wizard.
 *
 * Does NOT write to config — returns the result for the caller to persist.
 *
 * @param {object} ctx
 * @param {import('../config/manager.js').ConfigManager} ctx.configMgr
 * @param {NodeJS.WritableStream}  [ctx.stream=process.stdout]
 * @param {NodeJS.ReadableStream}  [ctx.input=process.stdin]
 * @param {string} [ctx.prefilledId]  provider ID already provided via /provider add <id>
 * @returns {Promise<
 *   { cancelled: true } |
 *   { cancelled: false, providerId: string, config: object, switchNow: boolean }
 * >}
 */
export async function runProviderAddWizard(ctx = {}) {
  const stream = ctx.stream || process.stdout;
  const inputStream = ctx.input || process.stdin;
  const configMgr = ctx.configMgr;
  const prefilledId = ctx.prefilledId || null;

  const rl = readline.createInterface({ input: inputStream, output: stream, terminal: false });

  // Promise-based question helper. Rejects on SIGINT or stream close.
  function ask(prompt) {
    return new Promise((resolve, reject) => {
      const onClose = () => reject(new Error('cancelled'));
      rl.once('close', onClose);
      rl.question(prompt, (answer) => {
        rl.removeListener('close', onClose);
        resolve(answer || '');
      });
    });
  }

  // ESC key cancels wizard. Listen on raw input stream (non‑terminal mode).
  // We close the wizard's readline interface when ESC arrives; the ask()
  // promise rejects via the 'close' listener registered above. The REPL
  // also pauses its own readline on the same input stream around this
  // call, so the ESC byte does not flow back to the REPL and is not
  // misread as SIGINT.
  rl.input.on('data', (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buf.length > 0 && buf[0] === 0x1b) {
      rl.close();
    }
  });

  function write(msg) {
    stream.write(msg);
  }

  try {
    write(
      `${ansi.dim('  Press Esc anytime to cancel — nothing will be saved until you confirm at the end.')}\n\n`,
    );

    // ── Step 1: Provider ID ───────────────────────────────────────────
    let providerId;
    if (prefilledId) {
      providerId = prefilledId.trim();
    } else {
      while (true) {
        const raw = await ask(
          `${ansi.cyan('  Provider ID')} (e.g. groq, deepseek, ollama) [Esc to cancel]: `,
        );
        const id = raw.trim();
        if (!id) {
          write(`${ansi.yellow('  ⚠')} Provider ID cannot be empty.\n`);
          continue;
        }
        // Check for duplicate
        const existingCfg = configMgr ? configMgr.loadConfig() : {};
        const existing = existingCfg.providers || {};
        if (existing[id]) {
          const overwrite = await ask(
            `${ansi.yellow('  ⚠')} Provider "${ansi.bold(id)}" already exists. Overwrite? [y/N, Esc to cancel]: `,
          );
          if (overwrite.trim().toLowerCase() !== 'y') {
            write(`  Asking for a new ID...\n`);
            continue;
          }
        }
        providerId = id;
        break;
      }
    }

    // ── Step 2: Adapter ───────────────────────────────────────────────
    let adapter;
    while (true) {
      const raw = await ask(
        `${ansi.cyan('  Adapter')} [openai/gemini] (default: openai) [Esc to cancel]: `,
      );
      const val = raw.trim().toLowerCase();
      if (val === '' || val === 'openai') {
        adapter = 'openai';
        break;
      }
      if (val === 'gemini') {
        adapter = 'gemini';
        break;
      }
      write(`${ansi.yellow('  ⚠')} Invalid adapter. Must be "openai" or "gemini".\n`);
    }

    // ── Step 3: Base URL (skip for gemini) ────────────────────────────
    let baseUrl;
    if (adapter !== 'gemini') {
      const raw = await ask(
        ansi.cyan('  Base URL') +
          ' (e.g. https://api.groq.com/openai/v1, Enter for OpenAI default) [Esc to cancel]: ',
      );
      baseUrl = raw.trim() || '';
    }
    // gemini: baseUrl stays undefined (not stored)

    // ── Step 4: API Key (smart validation) ────────────────────────────
    let apiKey;
    const keyRequired = isApiKeyRequired(adapter, baseUrl || '');
    while (true) {
      const suffix = keyRequired ? '' : ' (optional, Enter to skip)';
      const raw = await ask(`${ansi.cyan('  API Key') + suffix} [Esc to cancel]: `);
      const val = raw.trim();
      if (!val && keyRequired) {
        const ctx_label = adapter === 'gemini' ? 'gemini' : 'cloud openai providers';
        write(`${ansi.yellow('  ⚠')} API key is required for ${ctx_label}.\n`);
        continue;
      }
      apiKey = val || undefined; // undefined = not stored
      break;
    }

    // ── Step 5: Default Model (always optional) ───────────────────────
    const rawModel = await ask(
      `${ansi.cyan('  Default model')} (optional, Enter to skip) [Esc to cancel]: `,
    );
    const model = rawModel.trim() || undefined;

    // ── Post-save: switch now? ────────────────────────────────────────
    write(`\n${ansi.green('  ✔')} Provider ${ansi.bold(ansi.yellow(providerId))} ready to save.\n`);
    const rawSwitch = await ask(
      `  Switch to ${ansi.bold(providerId)} now? [Y/n, Esc to cancel without switching]: `,
    );
    const switchNow = rawSwitch.trim().toLowerCase() !== 'n';

    rl.close();

    // Build config object — omit undefined fields
    const config = { adapter };
    if (typeof baseUrl === 'string') config.baseUrl = baseUrl;
    if (apiKey) config.apiKey = apiKey;
    if (model) config.model = model;

    return { cancelled: false, providerId, config, switchNow };
  } catch (_err) {
    // SIGINT or stream closed mid-wizard
    try {
      rl.close();
    } catch {
      /* silent-ok: rl may already be closed when wizard is interrupted */
    }
    write(`\n${ansi.yellow('  ⚠')} Provider add cancelled.\n\n`);
    return { cancelled: true };
  }
}
