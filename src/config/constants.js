/**
 * @typedef {Object} BuiltinProviderDef
 * @property {'gemini'|'openai'} adapter  - LLM client adapter type ('gemini' | 'openai').
 * @property {string} defaultBaseUrl  - Default base URL adapter.
 * @property {string} defaultModel    - Model AKTIF default (satu nilai, persisten).
 * @property {string[]} models        - KATALOG model yang tersedia (banyak nilai, persisten).
 * @property {string[]} envVars       - Env var untuk API key (urut = prioritas).
 * @property {string[]} [envBaseUrlVars] - Env var override base URL.
 * @property {string[]} [envModelVars]   - Env var override model.
 */

/**
 * Application Constants & Default Configuration Values
 * FAY CLI (`faycli`)
 */

export const APP_NAME = 'faycli';
export const APP_FULL_NAME = 'fay-cli';
export const APP_VERSION = '1.0.0';
export const APP_DESCRIPTION = 'Autonomous AI Agent CLI optimized for Termux Android environment';

// Configuration Paths
export const DEFAULT_CONFIG_DIR_NAME = '.faycli';
export const DEFAULT_CONFIG_FILE_NAME = 'config.json';
export const DEFAULT_SESSIONS_DIR_NAME = 'sessions';
export const DEFAULT_CHECKPOINTS_DIR_NAME = 'checkpoints';

// Fallback Termux home directory if os.homedir() returns empty or unusual root
export const TERMUX_HOME_FALLBACK = '/data/data/com.termux/files/home';

// Default Model (backward-compat bridge — tetap di-export agar import lama
// di session.js, help.js, manager.js, gemini.js, dan tests tidak terputus).
// Sumber kebenaran model Gemini resmi ada di `BUILTIN_PROVIDERS.gemini.models`
// dan model aktif per provider ada di `BUILTIN_PROVIDERS[provider].defaultModel`.
export const DEFAULT_MODEL = 'gemini-2.5-flash';

// Execution Defaults
export const DEFAULT_TIMEOUT_MS = 30000; // 30 seconds
export const DEFAULT_MAX_CONTEXT_TOKENS = 1000000;
export const DEFAULT_TEMPERATURE = 0.7;

// Built-in Providers & Defaults
// ---------------------------------------------------------------------------
// Single Source of Truth untuk model per provider.
//
// Setiap entry di BUILTIN_PROVIDERS[id] adalah blueprint dari sebuah provider:
//   - adapter        : jenis adapter LLM ('gemini' | 'openai'). Provider custom
//                      secara default menggunakan adapter OpenAI-compatible ('openai').
//   - defaultBaseUrl : base URL default adapter (dipakai bila user tidak override)
//   - defaultModel   : **model AKTIF default** — dipakai saat request, satu nilai
//   - models[]       : **katalog model** yang tersedia — daftar resmi, banyak nilai
//   - envVars[]      : daftar env var yang dibaca untuk api key (urut = prioritas)
//   - envBaseUrlVars : daftar env var override base URL
//   - envModelVars   : daftar env var override model
//
// Invariant: `defaultModel` WAJIB ada di `models[]` untuk setiap builtin provider.
// Kalau invarian ini dilanggar, config/manager.js akan melempar error jelas.
//
// Catatan: `DEFAULT_MODEL` di atas adalah alias backward-compat yang nilainya
// SELALU sama dengan `BUILTIN_PROVIDERS.gemini.defaultModel` (sumber kebenaran).
// ---------------------------------------------------------------------------
/** @type {Record<string, import('./constants.js').BuiltinProviderDef>} */
export const BUILTIN_PROVIDERS = {
  gemini: {
    adapter: 'gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-2.5-flash',
    models: [
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-1.5-flash',
      'gemini-1.5-pro',
      'gemini-2.0-flash',
    ],
    envVars: ['GEMINI_API_KEY', 'FAYCLI_API_KEY', 'T_AI_API_KEY'],
    envBaseUrlVars: [],
    envModelVars: [],
  },
  openai: {
    adapter: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4', 'gpt-3.5-turbo'],
    envVars: ['OPENAI_API_KEY'],
    envBaseUrlVars: ['OPENAI_BASE_URL'],
    envModelVars: ['OPENAI_MODEL'],
  },
};

export const DEFAULT_ACTIVE_PROVIDER = 'gemini';

// Default Config Object
export const DEFAULT_CONFIG = {
  activeProvider: DEFAULT_ACTIVE_PROVIDER,
  providers: {},
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
  autoConfirm: false,
  verbose: false,
  locale: 'en',
  instructionsFile: 'AGENTS.md',
  // MCP servers keyed by id. Each entry is
  // { enabled, command, args[], env{}, cwd?, timeoutMs? }.
  // Empty by default: no server is ever spawned unless the user adds one.
  mcpServers: {},
  checkpoint: {
    enabled: true,
    keep: 10,
    maxFileSize: 1048576, // 1 MB cap
  },
};
