#!/usr/bin/env node

/**
 * FAY CLI (`faycli`)
 * Executable Entrypoint
 */

import { createAgentOrchestrator } from '../src/agent/orchestrator.js';
import { defaultSessionManager } from '../src/agent/session.js';
import { parseArgs } from '../src/cli/args.js';
import { showHelp, showVersion } from '../src/cli/help.js';
import { handleModelCommand } from '../src/cli/model-commands.js';
import { isPipedInput, mergePipedPrompt, readPipedStdin } from '../src/cli/piping.js';
import { startRepl } from '../src/cli/repl.js';
import { runSingleShot } from '../src/cli/single-shot.js';
import { ConfigManager } from '../src/config/manager.js';
import { showSessionMenu } from '../src/ui/session-menu.js';
import { ansi } from '../src/utils/ansi.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  // Initialize ConfigManager with custom directory if flag is present
  const configMgr = new ConfigManager(parsed.flags.configDir);

  // Configure logger verbosity
  if (parsed.flags.verbose) {
    logger.setVerbose(true);
  } else {
    const config = configMgr.loadConfig();
    if (config.verbose) logger.setVerbose(true);
  }

  // Handle Help & Version
  if (parsed.flags.help || parsed.command === 'help') {
    showHelp();
    process.exit(0);
  }

  if (parsed.flags.version || parsed.command === 'version') {
    showVersion();
    process.exit(0);
  }

  // Handle Config Subcommands
  if (parsed.command === 'config') {
    const sub = parsed.subcommand;
    const [key, val] = parsed.args;

    if (sub === 'list') {
      const cfg = configMgr.list({ maskApiKey: true });
      logger.info('Configuration properties:');
      console.log(JSON.stringify(cfg, null, 2));
      process.exit(0);
    }

    if (sub === 'get') {
      if (!key) {
        logger.error('Missing configuration key. Usage: faycli config get <key>');
        process.exit(1);
      }
      const val = configMgr.get(key);
      if (val === undefined) {
        logger.warn(`Key "${key}" is not set in configuration.`);
      } else {
        const displayVal = key === 'apiKey' ? configMgr.maskApiKey(val) : val;
        console.log(displayVal);
      }
      process.exit(0);
    }

    if (sub === 'set') {
      if (!key || val === undefined) {
        logger.error('Missing key or value. Usage: faycli config set <key> <val>');
        process.exit(1);
      }
      configMgr.set(key, val);
      logger.success(
        `Configuration updated: ${key} = ${key === 'apiKey' ? configMgr.maskApiKey(val) : val}`,
      );
      process.exit(0);
    }

    if (sub === 'delete') {
      if (!key) {
        logger.error('Missing configuration key. Usage: faycli config delete <key>');
        process.exit(1);
      }
      configMgr.delete(key);
      logger.success(`Configuration key "${key}" reset/deleted.`);
      process.exit(0);
    }

    if (sub === 'reset') {
      configMgr.reset();
      logger.success('Configuration reset to defaults.');
      process.exit(0);
    }

    logger.error(`Unknown config subcommand "${sub}". Available: get, set, list, reset, delete`);
    process.exit(1);
  }

  // Handle Session Subcommands
  if (parsed.command === 'session') {
    const sub = parsed.subcommand;
    const [sessId] = parsed.args;

    if (sub === 'list') {
      const sessions = defaultSessionManager.listSessions();
      if (sessions.length === 0) {
        logger.info('No saved sessions found.');
      } else {
        logger.info(`Found ${sessions.length} saved session(s):`);
        for (const s of sessions) {
          console.log(
            `  • ${ansi.yellow(s.id)} (${s.messageCount} msgs, updated: ${new Date(s.updatedAt).toLocaleString()})`,
          );
          if (s.lastMessagePreview) {
            console.log(`    ${ansi.dim(s.lastMessagePreview)}`);
          }
        }
      }
      process.exit(0);
    }

    if (sub === 'delete') {
      if (!sessId) {
        logger.error('Missing session ID. Usage: faycli session delete <session-id>');
        process.exit(1);
      }
      defaultSessionManager.deleteSession(sessId);
      logger.success(`Session "${sessId}" deleted.`);
      process.exit(0);
    }

    if (sub === 'clear') {
      defaultSessionManager.clearSessions();
      logger.success('All saved sessions cleared.');
      process.exit(0);
    }
  }

  // Handle Provider Subcommands
  if (parsed.command === 'provider') {
    const sub = parsed.subcommand;
    const [pid] = parsed.args;

    if (sub === 'list') {
      const config = configMgr.loadConfig();
      const providers = config.providers || {};
      const out = [];
      for (const [id, cfg] of Object.entries(providers)) {
        out.push({
          id,
          model: cfg.model || '(default)',
          baseUrl: cfg.baseUrl || '(default)',
          apiKey: configMgr.maskApiKey(cfg.apiKey || ''),
        });
      }
      console.log(JSON.stringify(out, null, 2));
      process.exit(0);
    }

    if (sub === 'use') {
      if (!pid) {
        logger.error('Missing provider id. Usage: faycli provider use <id>');
        process.exit(1);
      }
      configMgr.set('activeProvider', pid);
      logger.success(`Active provider set to: ${ansi.bold(pid)}`);
      process.exit(0);
    }

    if (sub === 'add') {
      const id = pid;
      if (!id) {
        logger.error('Missing provider id. Usage: faycli provider add <id>');
        process.exit(1);
      }
      const upsert = {};
      if (parsed.flags.apiKey !== null && parsed.flags.apiKey !== undefined) {
        upsert.apiKey = parsed.flags.apiKey;
      }
      if (parsed.flags.model) {
        upsert.model = parsed.flags.model;
      }
      if (parsed.flags.baseUrl) {
        upsert.baseUrl = parsed.flags.baseUrl;
      }
      if (parsed.flags.adapter) {
        upsert.adapter = parsed.flags.adapter;
      }
      // Clear empty strings
      for (const k of Object.keys(upsert)) {
        if (upsert[k] === '') delete upsert[k];
      }
      const cfg = configMgr.loadConfig();
      if (!cfg.providers) cfg.providers = {};
      cfg.providers[id] = { ...(cfg.providers[id] || {}), ...upsert };
      configMgr.saveConfig(cfg);
      logger.success(`Provider "${id}" added/updated.`);
      process.exit(0);
    }

    if (sub === 'remove') {
      if (!pid) {
        logger.error('Missing provider id. Usage: faycli provider remove <id>');
        process.exit(1);
      }
      try {
        configMgr.removeProvider(pid);
        logger.success(`Provider "${pid}" removed.`);
      } catch (err) {
        logger.error(err.message);
        process.exit(1);
      }
      process.exit(0);
    }

    if (sub === 'show') {
      const id = pid || configMgr.get('activeProvider') || 'gemini';
      try {
        const cfg = configMgr.getProviderConfig(id);
        console.log(JSON.stringify(cfg, null, 2));
      } catch (err) {
        logger.error(err.message);
        process.exit(1);
      }
      process.exit(0);
    }

    logger.error(`Unknown provider subcommand "${sub}". Available: list, use, add, remove, show`);
    process.exit(1);
  }

  // Handle Model Subcommands (Phase 3)
  if (parsed.command === 'model') {
    const result = handleModelCommand(parsed, configMgr);
    if (result.output) process.stdout.write(result.output);
    if (result.error) logger.error(result.error);
    process.exit(result.exitCode ?? 0);
  }

  // Determine effective provider (CLI flag > config)
  const effectiveProvider = parsed.flags.provider || configMgr.get('activeProvider') || 'gemini';

  // First-run auto-detect: no key for any builtin -> prompt
  if (!parsed.flags.provider && !configMgr.get('activeProvider')) {
    const hasGemini = Boolean(configMgr.getApiKey(null, 'gemini'));
    const hasOpenai = Boolean(configMgr.getApiKey(null, 'openai'));
    if (!hasGemini && !hasOpenai) {
      console.log(`
┌─ Setup ──────────────────────────────────┐
│ No API key configured.                   │
│ 1) Use Gemini  (set GEMINI_API_KEY)      │
│ 2) Use OpenAI  (set OPENAI_API_KEY)      │
│ 3) Configure now                         │
│ 4) Exit                                  │
└──────────────────────────────────────────┘
Select: `);
      if (!process.stdin.isTTY) {
        logger.error(
          "No API key configured. Set GEMINI_API_KEY or OPENAI_API_KEY, or run 'faycli provider add <id>'.",
        );
        process.exit(1);
      }
      const readline = await import('node:readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise((resolve) => rl.question('Select [1-4]: ', resolve));
      rl.close();
      if (answer.trim() === '1') {
        console.log('\nSet GEMINI_API_KEY and restart.\n');
        process.exit(0);
      }
      if (answer.trim() === '2') {
        console.log('\nSet OPENAI_API_KEY and restart.\n');
        process.exit(0);
      }
      if (answer.trim() === '3') {
        // Fall through
      }
      if (answer.trim() === '4') {
        process.exit(0);
      }
    }
  }

  const apiKey = configMgr.getApiKey(parsed.flags.apiKey, effectiveProvider);
  if (!apiKey) {
    const { BUILTIN_PROVIDERS } = await import('../src/config/constants.js');
    const builtin = BUILTIN_PROVIDERS[effectiveProvider];
    const envVars = builtin?.envVars?.join(', ') || 'none';
    logger.warn(
      `${effectiveProvider.charAt(0).toUpperCase() + effectiveProvider.slice(1)} API key is not configured!`,
    );
    console.log(`
${ansi.yellow('To set your API key, run:')}
  ${ansi.green(`faycli provider add ${effectiveProvider} --api-key <key>`)}

${ansi.yellow('Or export as environment variable:')}
  ${ansi.green(`export ${envVars.split(',')[0]}="<key>"`)}
`);
    process.exit(1);
  }

  const providerConfig = configMgr.getProviderConfig(effectiveProvider);
  const model =
    parsed.flags.model || providerConfig.model || providerConfig.defaultModel || 'gemini-2.5-flash';
  const autoApprove = Boolean(parsed.flags.yes || configMgr.get('autoApprove'));

  // Handle Resume Session
  let activeSession = null;
  let resumeId = parsed.command === 'resume' ? parsed.subcommand : parsed.flags.session;

  if (parsed.command === 'resume' && !resumeId) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const menuResult = await showSessionMenu({
        sessionManager: defaultSessionManager,
        workingDir: process.cwd(),
        input: process.stdin,
        output: process.stdout,
      });
      if (menuResult.cancelled) {
        process.exit(0);
      }
      if (menuResult.action === 'switch' && menuResult.sessionId) {
        resumeId = menuResult.sessionId;
      }
    }
  }

  if (resumeId) {
    if (defaultSessionManager.hasSession(resumeId)) {
      activeSession = defaultSessionManager.loadSession(resumeId);
      const titleDisplay = activeSession.title ? ` ("${activeSession.title}")` : '';
      logger.info(`Resumed existing session: ${ansi.yellow(resumeId)}${titleDisplay}`);
    } else {
      logger.error(`Session "${resumeId}" not found in storage.`);
      process.exit(1);
    }
  }

  const sessionProvider = activeSession?.provider || effectiveProvider;
  const sessionProviderConfig = configMgr.getProviderConfig(sessionProvider);
  const sessionApiKey = configMgr.getApiKey(parsed.flags.apiKey, sessionProvider);
  const sessionBaseUrl =
    parsed.flags.baseUrl || sessionProviderConfig.baseUrl || sessionProviderConfig.defaultBaseUrl;
  if (!sessionApiKey) {
    logger.error(`API key for session provider "${sessionProvider}" is not configured.`);
    process.exit(1);
  }

  const orchestrator = createAgentOrchestrator({
    provider: sessionProvider,
    adapter: parsed.flags.adapter || sessionProviderConfig.adapter,
    model: parsed.flags.model || activeSession?.model || model,
    apiKey: sessionApiKey,
    baseUrl: sessionBaseUrl,
    session: activeSession,
    autoApprove,
    maxIterations: parsed.flags.maxIterations || undefined,
    locale: configMgr.get('locale'),
    logger,
  });

  // Check for UNIX piped input (e.g. cat file | t-ai "analisis")
  if (isPipedInput(process.stdin)) {
    const pipedContent = await readPipedStdin({ stream: process.stdin });
    const finalPrompt = mergePipedPrompt(pipedContent, parsed.prompt);

    if (finalPrompt) {
      const outcome = await runSingleShot(finalPrompt, {
        orchestrator,
        model,
        apiKey: sessionApiKey,
        provider: sessionProvider,
        autoApprove,
        logger,
      });
      process.exit(outcome.success ? 0 : 1);
    }
  }

  // Single-shot direct prompt execution
  if (parsed.prompt) {
    const outcome = await runSingleShot(parsed.prompt, {
      orchestrator,
      model,
      apiKey: sessionApiKey,
      provider: sessionProvider,
      autoApprove,
      logger,
    });
    process.exit(outcome.success ? 0 : 1);
  }

  // Interactive REPL Mode
  await startRepl({
    orchestrator,
    configMgr,
    provider: sessionProvider,
    model,
    apiKey: sessionApiKey,
    autoApprove,
    logger,
  });
}

main().catch((err) => {
  logger.error(err.message || String(err));
  if (logger.isVerbose() && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
