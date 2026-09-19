/**
 * Lightweight, zero-dependency CLI Argument Parser
 * Optimized for minimal latency (< 1ms)
 */

/**
 * Parse CLI arguments array (typically process.argv.slice(2))
 * @param {string[]} rawArgs
 * @returns {object}
 */
export function parseArgs(rawArgs = []) {
  const flags = {
    provider: null,
    adapter: null,
    model: null,
    apiKey: null,
    baseUrl: null,
    session: null,
    yes: false,
    help: false,
    version: false,
    verbose: false,
    configDir: null,
    timeout: null,
    // Phase 3 — `tai model` non-interactive subcommand flags
    modelList: false, // --list    : list available models
    modelAll: false, // --all     : when combined with --list, include all providers
    modelSet: null, // --set <m> : set active model (alternative to `--model`)
    // Phase 4 — `tai model add/remove/clear` (catalog CRUD)
    modelAdd: null, // --add <m[,m2,...]>  : add model(s) to a provider's catalog
    modelRemove: null, // --remove <m[,m2,...]> : remove model(s) from a provider's catalog
    modelClear: false, // --clear             : reset catalog to builtin defaults
    maxIterations: null, // --max-iterations <n> : cap ReAct loop (default unlimited)
    global: false, // --global, -g           : apply operation globally
  };

  const positional = [];
  const args = [...rawArgs];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--version' || arg === '-v') {
      flags.version = true;
    } else if (arg === '--verbose') {
      flags.verbose = true;
    } else if (arg === '--yes' || arg === '-y') {
      flags.yes = true;
    } else if (arg === '--global' || arg === '-g') {
      flags.global = true;
    } else if (arg.startsWith('--provider=')) {
      flags.provider = arg.slice(11).trim();
    } else if (arg === '--provider' || arg === '-p') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags.provider = args[++i].trim();
      }
    } else if (arg.startsWith('--adapter=')) {
      flags.adapter = arg.slice(10).trim();
    } else if (arg === '--adapter') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags.adapter = args[++i].trim();
      }
    } else if (arg.startsWith('--base-url=')) {
      flags.baseUrl = arg.slice(11).trim();
    } else if (arg === '--base-url') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags.baseUrl = args[++i].trim();
      }
    } else if (arg.startsWith('--model=')) {
      flags.model = arg.slice(8).trim();
    } else if (arg === '--model' || arg === '-m') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags.model = args[++i].trim();
      }
    } else if (arg.startsWith('--api-key=')) {
      flags.apiKey = arg.slice(10).trim();
    } else if (arg === '--api-key' || arg === '-k') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags.apiKey = args[++i].trim();
      }
    } else if (arg.startsWith('--session=')) {
      flags.session = arg.slice(10).trim();
    } else if (arg === '--session' || arg === '-s') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags.session = args[++i].trim();
      }
    } else if (arg.startsWith('--config-dir=')) {
      flags.configDir = arg.slice(13).trim();
    } else if (arg === '--config-dir') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags.configDir = args[++i].trim();
      }
    } else if (arg.startsWith('--timeout=')) {
      const num = Number(arg.slice(10));
      if (!Number.isNaN(num)) flags.timeout = num;
    } else if (arg === '--timeout') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        const num = Number(args[++i]);
        if (!Number.isNaN(num)) flags.timeout = num;
      }
    } else if (arg.startsWith('--max-iterations=')) {
      const num = Number(arg.slice(17));
      if (Number.isInteger(num) && num > 0) flags.maxIterations = num;
    } else if (arg === '--max-iterations') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        const num = Number(args[++i]);
        if (Number.isInteger(num) && num > 0) flags.maxIterations = num;
      }
    } else if (arg === '--list') {
      // Phase 3: used by `tai model --list`
      flags.modelList = true;
    } else if (arg === '--all') {
      // Phase 3: used by `tai model --list --all` (all providers)
      flags.modelAll = true;
    } else if (arg.startsWith('--set=')) {
      // Phase 3: `tai model --set=<model>`
      const v = arg.slice(6).trim();
      if (v) flags.modelSet = v;
    } else if (arg === '--set') {
      // Phase 3: `tai model --set <model>`
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        const v = args[++i].trim();
        if (v) flags.modelSet = v;
      }
    } else if (arg.startsWith('--add=')) {
      // Phase 4: `tai model --add=<model[,m2,...]>`
      const v = arg.slice(6).trim();
      if (v) flags.modelAdd = v;
    } else if (arg === '--add') {
      // Phase 4: `tai model --add <model[,m2,...]>`
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        const v = args[++i].trim();
        if (v) flags.modelAdd = v;
      }
    } else if (arg.startsWith('--remove=')) {
      // Phase 4: `tai model --remove=<model[,m2,...]>`
      const v = arg.slice(9).trim();
      if (v) flags.modelRemove = v;
    } else if (arg === '--remove') {
      // Phase 4: `tai model --remove <model[,m2,...]>`
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        const v = args[++i].trim();
        if (v) flags.modelRemove = v;
      }
    } else if (arg === '--clear') {
      // Phase 4: `tai model --clear` (reset catalog to builtin defaults)
      flags.modelClear = true;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  let command = null;
  let subcommand = null;
  let subArgs = [];
  let prompt = null;

  if (flags.help) {
    command = 'help';
  } else if (flags.version) {
    command = 'version';
  } else if (positional.length > 0) {
    const firstWord = positional[0].toLowerCase();

    if (firstWord === 'config') {
      command = 'config';
      subcommand = positional[1]?.toLowerCase() || 'list';
      subArgs = positional.slice(2);
    } else if (firstWord === 'provider' || firstWord === 'providers') {
      command = 'provider';
      subcommand = positional[1]?.toLowerCase() || 'list';
      subArgs = positional.slice(2);
    } else if (firstWord === 'session' || firstWord === 'sessions') {
      command = 'session';
      subcommand = positional[1]?.toLowerCase() || 'list';
      subArgs = positional.slice(2);
    } else if (firstWord === 'model' || firstWord === 'models') {
      // Phase 3: `tai model ...` non-interactive model management
      // Subcommands inferred from flags:
      //   --list               → list
      //   --set <m>            → set
      //   --add <m[,m2,...]>   → add (Phase 4)
      //   --remove <m>         → remove (Phase 4)
      //   --clear              → clear (Phase 4)
      //   (no flags)           → list (back-compat: default to listing)
      if (flags.modelSet) {
        command = 'model';
        subcommand = 'set';
      } else if (flags.modelAdd) {
        command = 'model';
        subcommand = 'add';
      } else if (flags.modelRemove) {
        command = 'model';
        subcommand = 'remove';
      } else if (flags.modelClear) {
        command = 'model';
        subcommand = 'clear';
      } else {
        command = 'model';
        subcommand = 'list';
      }
      subArgs = positional.slice(2);
    } else if (firstWord === 'model-add' || firstWord === 'add') {
      // Phase 4: shortcut `tai add <model> --provider <id>`
      command = 'model';
      subcommand = 'add';
      if (positional[1]) flags.modelAdd = positional[1].trim();
    } else if (firstWord === 'model-remove' || firstWord === 'remove') {
      // Phase 4: shortcut `tai remove <model> --provider <id>`
      command = 'model';
      subcommand = 'remove';
      if (positional[1]) flags.modelRemove = positional[1].trim();
    } else if (firstWord === 'model-clear' || firstWord === 'clear') {
      // Phase 4: shortcut `tai clear --provider <id>`
      command = 'model';
      subcommand = 'clear';
    } else if (firstWord === 'resume') {
      command = 'resume';
      subcommand = positional[1] || null;
      subArgs = positional.slice(2);
    } else if (firstWord === 'skill') {
      command = 'skill';
      subcommand = positional[1] || 'list';
      subArgs = positional.slice(2);
    } else if (firstWord === 'help') {
      command = 'help';
    } else if (firstWord === 'version') {
      command = 'version';
    } else {
      command = 'chat';
      prompt = positional.join(' ').trim();
    }
  }

  return {
    command,
    subcommand,
    args: subArgs,
    positional,
    flags,
    prompt,
    rawArgs,
  };
}
