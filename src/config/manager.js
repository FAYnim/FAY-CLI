/**
 * Configuration Manager for FAY CLI
 * Manages configuration loading, atomic persistence, and API key resolution
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUILTIN_PROVIDERS,
  DEFAULT_ACTIVE_PROVIDER,
  DEFAULT_CHECKPOINTS_DIR_NAME,
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_DIR_NAME,
  DEFAULT_CONFIG_FILE_NAME,
  DEFAULT_SESSIONS_DIR_NAME,
  TERMUX_HOME_FALLBACK,
} from './constants.js';

// ---------------------------------------------------------------------------
// Single Source of Truth invariant validation.
//
// For every builtin provider, `defaultModel` (the active model) MUST be a
// member of `models[]` (the catalog). If a developer ever edits
// `BUILTIN_PROVIDERS` in constants.js and accidentally drifts one entry,
// downstream code (`getProviderModels`, slash `/model`, etc.) would silently
// hide the active model from listings — a confusing bug. Failing fast at
// module load catches the mistake before any test or runtime can be affected.
// ---------------------------------------------------------------------------
(function validateBuiltinProviderInvariants() {
  for (const [id, def] of Object.entries(BUILTIN_PROVIDERS)) {
    if (!def || typeof def !== 'object') {
      throw new Error(`[config] BUILTIN_PROVIDERS[${JSON.stringify(id)}] is not an object`);
    }
    if (typeof def.defaultModel !== 'string' || !def.defaultModel.trim()) {
      throw new Error(
        `[config] BUILTIN_PROVIDERS[${JSON.stringify(id)}].defaultModel must be a non-empty string`,
      );
    }
    if (!Array.isArray(def.models) || def.models.length === 0) {
      throw new Error(
        `[config] BUILTIN_PROVIDERS[${JSON.stringify(id)}].models must be a non-empty array`,
      );
    }
    if (!def.models.includes(def.defaultModel)) {
      throw new Error(
        `[config] Invariant violation: BUILTIN_PROVIDERS[${JSON.stringify(id)}].defaultModel ` +
          `(${JSON.stringify(def.defaultModel)}) must be a member of ` +
          `BUILTIN_PROVIDERS[${JSON.stringify(id)}].models ${JSON.stringify(def.models)}. ` +
          'See the provider-model clarity refactor (Phase 1.3).',
      );
    }
    // Catalog entries must be non-empty strings (no blanks, no nulls).
    for (const m of def.models) {
      if (typeof m !== 'string' || !m.trim()) {
        throw new Error(
          `[config] BUILTIN_PROVIDERS[${JSON.stringify(id)}].models contains a non-string or blank entry`,
        );
      }
    }
  }
})();

export class ConfigManager {
  constructor(customConfigDir = null) {
    this.customConfigDir = customConfigDir;
    // BUG-03: in-memory cache of loaded config keyed by configPath so
    // multiple ConfigManager instances (e.g. tests with customConfigDir)
    // don't collide. Invalidated by saveConfig().
    this._cache = new Map(); // configPath -> config object
  }

  /**
   * Resolve root configuration directory
   * Priority: customConfigDir > process.env.FAYCLI_CONFIG_DIR > process.env.T_AI_CONFIG_DIR > os.homedir()/.faycli (auto-migrate from ~/.termuxai) > ~/.t-ai > fallback
   * @returns {string}
   */
  getConfigDir() {
    if (this.customConfigDir) {
      return path.resolve(this.customConfigDir);
    }
    if (process.env.FAYCLI_CONFIG_DIR) {
      return path.resolve(process.env.FAYCLI_CONFIG_DIR);
    }
    // Legacy env-var fallback for users upgrading from t-ai
    if (process.env.T_AI_CONFIG_DIR) {
      return path.resolve(process.env.T_AI_CONFIG_DIR);
    }

    const homeDir =
      process.env.HOME || process.env.USERPROFILE || os.homedir() || TERMUX_HOME_FALLBACK;
    const primaryDir = path.join(homeDir, DEFAULT_CONFIG_DIR_NAME);
    // One-time migration: if ~/.faycli doesn't exist but ~/.termuxai does,
    // copy old data in (implicit backup — old dir left intact).
    const legacyTermuxaiDir = path.join(homeDir, '.termuxai');
    if (!fs.existsSync(primaryDir) && fs.existsSync(legacyTermuxaiDir)) {
      try {
        fs.cpSync(legacyTermuxaiDir, primaryDir, { recursive: true });
        fs.chmodSync(primaryDir, 0o700);
      } catch (_err) {
        if (!fs.existsSync(primaryDir)) {
          return legacyTermuxaiDir;
        }
      }
    }
    // Legacy t-ai fallback: only when neither new nor migrated dir exists
    const legacyTaiDir = path.join(homeDir, '.t-ai');
    if (!fs.existsSync(primaryDir) && fs.existsSync(legacyTaiDir)) {
      return legacyTaiDir;
    }
    return primaryDir;
  }

  /**
   * Get path to config.json
   * @returns {string}
   */
  getConfigPath() {
    return path.join(this.getConfigDir(), DEFAULT_CONFIG_FILE_NAME);
  }

  /**
   * Get path to sessions directory
   * @returns {string}
   */
  getSessionsDir() {
    return path.join(this.getConfigDir(), DEFAULT_SESSIONS_DIR_NAME);
  }

  /**
   * Get path to checkpoints directory
   * @returns {string}
   */
  getCheckpointsDir() {
    return path.join(this.getConfigDir(), DEFAULT_CHECKPOINTS_DIR_NAME);
  }

  /**
   * Ensure directory structure exists
   */
  ensureDirs() {
    const configDir = this.getConfigDir();
    const sessionsDir = this.getSessionsDir();
    const checkpointsDir = this.getCheckpointsDir();

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(checkpointsDir)) {
      fs.mkdirSync(checkpointsDir, { recursive: true, mode: 0o700 });
    }
  }

  /**
   * Load configuration from file, initializing with defaults if missing.
   *
   * BUG-03: in-memory cache invalidated on `saveConfig()`. External file
   * writes (tests calling `fs.writeFileSync(config.json)`) bypass the
   * cache, but those tests create fresh `ConfigManager` instances per
   * case, so the per-instance Map gives them an empty cache and they
   * re-read from disk. If a test mutates the file without going through
   * saveConfig, instantiate a new ConfigManager.
   *
   * @returns {object}
   */
  loadConfig() {
    this.ensureDirs();
    const configPath = this.getConfigPath();

    // BUG-03: cache hit when no writes have happened on this instance
    if (this._cache.has(configPath)) {
      return this._cache.get(configPath);
    }

    if (!fs.existsSync(configPath)) {
      const fresh = structuredClone(DEFAULT_CONFIG);
      this.saveConfig(fresh);
      return fresh;
    }

    let parsed;
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      parsed = JSON.parse(raw);
    } catch (_err) {
      // In case of corrupt file, fallback to defaults
      return structuredClone(DEFAULT_CONFIG);
    }
    const config = {
      ...structuredClone(DEFAULT_CONFIG),
      ...parsed,
      providers: { ...(parsed.providers || {}) },
    };

    // Auto-promote legacy apiKey into providers[activeProvider] if providers missing
    if (!config.providers || Object.keys(config.providers).length === 0) {
      const act = config.activeProvider || DEFAULT_ACTIVE_PROVIDER;
      if (!config.providers) config.providers = {};
      if (!config.providers[act]) {
        const provCfg = {};
        // Carry over legacy apiKey if present
        if (config.apiKey && typeof config.apiKey === 'string' && config.apiKey.trim()) {
          provCfg.apiKey = config.apiKey.trim();
        }
        if (config.model && typeof config.model === 'string' && config.model.trim()) {
          provCfg.model = config.model.trim();
        }
        // Check env match
        const builtin = BUILTIN_PROVIDERS[act];
        if (builtin && !provCfg.apiKey) {
          for (const envVar of builtin.envVars) {
            if (process.env[envVar]?.trim()) {
              provCfg.apiKey = process.env[envVar].trim();
              break;
            }
          }
        }
        if (Object.keys(provCfg).length > 0) {
          config.providers[act] = provCfg;
          config.activeProvider = act;
          this._cache.delete(configPath);
          this.saveConfig(config);
        }
      }
    }

    this._cache.set(configPath, config);
    return config;
  }

  /**
   * Save configuration atomically to disk
   * @param {object} configData
   * @returns {object}
   */
  saveConfig(configData) {
    this.ensureDirs();
    const configPath = this.getConfigPath();
    const tmpPath = `${configPath}.tmp.${process.pid}.${Date.now()}`;
    const payload = JSON.stringify(configData, null, 2);

    fs.writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(tmpPath, configPath);
    } catch (_err) {
      // Fallback for filesystems that don't support atomic rename across mounts
      fs.copyFileSync(tmpPath, configPath);
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* silent-ok: leftover tmp file after copy fallback is cosmetic */
      }
    }

    // BUG-03: refresh cache eagerly so the next loadConfig() returns
    // from cache without re-reading. Invalidate first so any concurrent
    // reader doesn't see a stale entry during the write window.
    this._cache.set(configPath, configData);

    return configData;
  }

  /**
   * Get specific configuration value
   * @param {string} key
   * @returns {any}
   */
  get(key) {
    const config = this.loadConfig();
    if (key.includes('.')) {
      const parts = key.split('.');
      let curr = config;
      for (const p of parts) {
        if (curr == null) return undefined;
        curr = curr[p];
      }
      return curr;
    }
    return config[key];
  }

  /**
   * Set configuration value
   * @param {string} key
   * @param {any} value
   * @returns {any}
   */
  set(key, value) {
    const config = this.loadConfig();

    let castedValue = value;
    if (key === 'timeoutMs' || key === 'maxContextTokens') {
      const parsedNum = Number(value);
      if (!Number.isNaN(parsedNum)) castedValue = parsedNum;
    } else if (key === 'autoConfirm' || key === 'verbose') {
      if (typeof value === 'string') {
        castedValue = value.toLowerCase() === 'true' || value === '1';
      } else {
        castedValue = Boolean(value);
      }
    }

    if (key.includes('.')) {
      const parts = key.split('.');
      let curr = config;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (!curr[p] || typeof curr[p] !== 'object') {
          curr[p] = {};
        }
        curr = curr[p];
      }
      curr[parts[parts.length - 1]] = castedValue;
    } else {
      config[key] = castedValue;
    }
    this.saveConfig(config);
    return castedValue;
  }

  /**
   * Delete or reset key to default
   * @param {string} key
   * @returns {boolean}
   */
  delete(key) {
    const config = this.loadConfig();
    const defaults = structuredClone(DEFAULT_CONFIG);
    if (Object.hasOwn(defaults, key)) {
      config[key] = defaults[key];
    } else {
      delete config[key];
    }
    this.saveConfig(config);
    return true;
  }

  /**
   * Reset entire configuration to default
   * @returns {object}
   */
  reset() {
    const fresh = structuredClone(DEFAULT_CONFIG);
    this.saveConfig(fresh);
    return fresh;
  }

  /**
   * List all configuration keys (optionally masking API key)
   * @param {object} [options]
   * @param {boolean} [options.maskApiKey=true]
   * @returns {object}
   */
  list(options = { maskApiKey: true }) {
    const config = this.loadConfig();
    const result = { ...config };

    if (options.maskApiKey && result.apiKey) {
      result.apiKey = this.maskApiKey(result.apiKey);
    }
    if (options.maskApiKey && result.providers) {
      const maskedProviders = {};
      for (const [k, v] of Object.entries(result.providers)) {
        maskedProviders[k] = { ...v };
        if (maskedProviders[k].apiKey) {
          maskedProviders[k].apiKey = this.maskApiKey(maskedProviders[k].apiKey);
        }
      }
      result.providers = maskedProviders;
    }

    return result;
  }

  /**
   * Helper to mask API key for safe terminal display
   * @param {string} key
   * @returns {string}
   */
  maskApiKey(key) {
    if (!key || typeof key !== 'string') return '';
    if (key.length <= 8) return '****';
    return `${key.slice(0, 4)}...${key.slice(-4)}`;
  }

  /**
   * Get merged provider configuration
   * @param {string} providerId
   * @returns {object}
   */
  getProviderConfig(providerId) {
    const builtin = BUILTIN_PROVIDERS[providerId];
    const config = this.loadConfig();
    const stored = config.providers?.[providerId] || {};
    if (!builtin && !config.providers?.[providerId]) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    const merged = { ...(builtin || {}), ...stored };

    // Env vars override defaults if stored value is not present
    if (!stored.apiKey && builtin?.envVars) {
      for (const envVar of builtin.envVars) {
        const v = process.env[envVar];
        if (v?.trim()) {
          merged.apiKey = v.trim();
          break;
        }
      }
    }

    if (!stored.baseUrl && builtin?.envBaseUrlVars) {
      for (const envVar of builtin.envBaseUrlVars) {
        const v = process.env[envVar];
        if (v?.trim()) {
          merged.baseUrl = v.trim();
          break;
        }
      }
    }

    if (!stored.model && builtin?.envModelVars) {
      for (const envVar of builtin.envModelVars) {
        const v = process.env[envVar];
        if (v?.trim()) {
          merged.model = v.trim();
          break;
        }
      }
    }

    return merged;
  }

  /**
   * Resolve API Key following precedence:
   * 1. overrideKey (CLI flag)
   * 2. process.env per provider
   * 3. config.json providers[providerId].apiKey
   * @param {string} [overrideKey]
   * @param {string} [providerId]
   * @returns {string|null}
   */
  getApiKey(overrideKey = null, providerId = null) {
    if (overrideKey && typeof overrideKey === 'string' && overrideKey.trim().length > 0) {
      return overrideKey.trim();
    }
    const resolvedProvider =
      providerId || this.loadConfig().activeProvider || DEFAULT_ACTIVE_PROVIDER;
    const builtin = BUILTIN_PROVIDERS[resolvedProvider];
    // 1. Env vars lookup
    if (builtin?.envVars) {
      for (const envVar of builtin.envVars) {
        const v = process.env[envVar];
        if (v && typeof v === 'string' && v.trim().length > 0) {
          return v.trim();
        }
      }
    }
    // 2. Config lookup (providers[providerId].apiKey or legacy config.apiKey)
    const config = this.loadConfig();
    const storedKey =
      config.providers?.[resolvedProvider]?.apiKey ||
      (resolvedProvider === 'gemini' ? config.apiKey : null);
    if (storedKey && typeof storedKey === 'string' && storedKey.trim().length > 0) {
      return storedKey.trim();
    }
    return null;
  }

  /**
   * Set a specific provider field and persist
   *
   * Fallback auto-include: when `field === 'model'`, we always make
   * sure the value is reflected in `providers[providerId].models[]`
   * so listings (`tai model --list`, `/model`, etc.) can never lose
   * the active selection — even for **custom (non-builtin) providers**
   * and even when the `models[]` array is missing entirely.
   *
   * @param {string} providerId
   * @param {string} field
   * @param {any} value
   */
  setProviderField(providerId, field, value) {
    const config = this.loadConfig();
    if (!config.providers) config.providers = {};
    if (!config.providers[providerId]) config.providers[providerId] = {};
    if (value === '' || value === null || value === undefined) {
      delete config.providers[providerId][field];
    } else {
      config.providers[providerId][field] = value;
    }
    // Auto-populate `models` from builtin when first configuring a builtin provider
    if (BUILTIN_PROVIDERS[providerId] && !config.providers[providerId].models) {
      const builtinModels = BUILTIN_PROVIDERS[providerId].models;
      if (Array.isArray(builtinModels) && builtinModels.length > 0) {
        config.providers[providerId].models = [...builtinModels];
      }
    }
    // Fallback: when the user picks a `model`, make sure it lives in
    // `models[]` too (create the array if missing). This covers:
    //   - custom providers that have no builtin catalog
    //   - legacy configs where `models[]` was wiped or never written
    //   - builtin providers whose `models[]` was cleared by the user
    if (field === 'model') {
      const prov = config.providers[providerId];
      if (!Array.isArray(prov.models)) prov.models = [];
      const v = typeof value === 'string' ? value.trim() : '';
      if (v && !prov.models.includes(v)) {
        prov.models.push(v);
      }
    }
    this.saveConfig(config);
  }

  /**
   * Add one or more models to a provider's catalog.
   *
   * - Accepts a single name or a comma-/semicolon-separated list (e.g.
   *   `"gpt-4,gpt-4o,gpt-3.5-turbo"`).
   * - Trims whitespace, drops empty entries, dedupes against existing
   *   `models[]` (and the active `model` if set).
   * - Does NOT change the active model. Use `tai model --set <name>` to
   *   switch after adding.
   * - For builtin providers, the stored `models[]` is initialized from
   *   the builtin catalog on first add (matches `setProviderField` behavior).
   *
   * @param {string} providerId
   * @param {string|string[]} input
   * @returns {{ added: string[], skipped: string[], catalog: string[] }}
   */
  addProviderModels(providerId, input) {
    const config = this.loadConfig();
    if (!config.providers) config.providers = {};
    if (!config.providers[providerId]) config.providers[providerId] = {};
    const prov = config.providers[providerId];

    // Initialize `models[]` from builtin catalog for builtin providers on first add
    if (BUILTIN_PROVIDERS[providerId] && !Array.isArray(prov.models)) {
      const builtinModels = BUILTIN_PROVIDERS[providerId].models;
      if (Array.isArray(builtinModels) && builtinModels.length > 0) {
        prov.models = [...builtinModels];
      } else {
        prov.models = [];
      }
    } else if (!Array.isArray(prov.models)) {
      prov.models = [];
    }

    // Normalize input → string[]
    const raw = Array.isArray(input) ? input : String(input || '').split(/[,;\n]+/g);
    const candidates = raw.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);

    // Dedupe against the live catalog (so re-adding the same name is a no-op)
    const existing = new Set(prov.models);
    if (typeof prov.model === 'string' && prov.model.trim()) {
      existing.add(prov.model.trim());
    }

    const added = [];
    const skipped = [];
    for (const name of candidates) {
      if (existing.has(name)) {
        skipped.push(name);
        continue;
      }
      prov.models.push(name);
      existing.add(name);
      added.push(name);
    }

    if (added.length > 0) {
      this.saveConfig(config);
    }

    return {
      added,
      skipped,
      catalog: config.providers[providerId].models,
    };
  }

  /**
   * Remove one or more models from a provider's catalog.
   *
   * - Accepts a single name or a comma-/semicolon-separated list.
   * - Never removes the *effective* active model. The "effective" active
   *   model is the stored `prov.model` if set, otherwise the builtin
   *   `defaultModel` (since that's what the LLM client will actually use
   *   if the user never explicitly picked one).
   * - Empty result is allowed — returns `{ removed: [], skipped: [] }`.
   *
   * @param {string} providerId
   * @param {string|string[]} input
   * @returns {{ removed: string[], skipped: string[], catalog: string[] }}
   */
  removeProviderModels(providerId, input) {
    const config = this.loadConfig();
    const prov = config.providers?.[providerId];
    if (!prov) {
      return { removed: [], skipped: [], catalog: [] };
    }
    if (!Array.isArray(prov.models)) prov.models = [];

    const raw = Array.isArray(input) ? input : String(input || '').split(/[,;\n]+/g);
    const candidates = new Set(
      raw.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean),
    );

    // Effective active = stored model, falling back to builtin default
    const builtin = BUILTIN_PROVIDERS[providerId];
    const storedActive =
      typeof prov.model === 'string' && prov.model.trim() ? prov.model.trim() : null;
    const effectiveActive = storedActive || builtin?.defaultModel || null;

    const removed = [];
    const skipped = [];
    const next = [];
    for (const m of prov.models) {
      if (candidates.has(m) && m !== effectiveActive) {
        removed.push(m);
      } else if (candidates.has(m) && m === effectiveActive) {
        skipped.push(m);
        next.push(m);
      } else {
        next.push(m);
      }
    }

    if (removed.length > 0) {
      prov.models = next;
      this.saveConfig(config);
    }

    return {
      removed,
      skipped,
      catalog: config.providers[providerId].models,
    };
  }

  /**
   * Reset a provider's catalog back to its builtin defaults.
   *
   * - For builtin providers: `models[]` is restored from `BUILTIN_PROVIDERS`
   *   and the active `model` is preserved (if still in the restored list).
   * - For custom (non-builtin) providers: `models[]` is set to `[]`.
   * - Safe to call on an unknown provider (returns empty catalog).
   *
   * @param {string} providerId
   * @returns {{ catalog: string[] }}
   */
  clearProviderModels(providerId) {
    const config = this.loadConfig();
    if (!config.providers) config.providers = {};
    if (!config.providers[providerId]) config.providers[providerId] = {};
    const prov = config.providers[providerId];

    const builtin = BUILTIN_PROVIDERS[providerId];
    const builtinModels = Array.isArray(builtin?.models) ? [...builtin.models] : [];

    // Preserve the active model even if it was a custom finetune (per the
    // ⭐ "auto-include stored model" guarantee in getProviderModels).
    if (
      typeof prov.model === 'string' &&
      prov.model.trim() &&
      !builtinModels.includes(prov.model.trim())
    ) {
      builtinModels.push(prov.model.trim());
    }

    prov.models = builtinModels;
    this.saveConfig(config);
    return { catalog: config.providers[providerId].models };
  }

  /**
   * Get available models for a provider.
   *
   * Backward-compatible alias of `getModelCatalog(providerId)`. Kept as a
   * plain delegation (no deprecation warning — the migration is complete;
   * see BUG-02 in IMPROVEMENTS.md). New call sites should use
   * `getModelCatalog()`.
   *
   * @param {string} providerId
   * @returns {string[]}
   */
  getProviderModels(providerId) {
    return this.getModelCatalog(providerId);
  }

  /**
   * Get the effective ACTIVE model for a provider.
   *
   * This is the **read-side alias** introduced in Phase 2.1 of the
   * provider-model clarity refactor. The goal is to disambiguate the three
   * near-identical names (`model`, `models[]`, `--model`) by giving the
   * "active" concept an explicit getter name, while keeping the on-disk
   * format (`providers[id].model`) untouched for backward compatibility.
   *
   * Resolution precedence (first non-empty wins, mirroring the legacy
   * inline logic in `getProviderConfig()`):
   *   1. `providers[id].model` (user's persisted choice — could be a
   *      custom finetune not in the builtin catalog)
   *   2. env var override (`builtin.envModelVars`, first non-empty)
   *   3. `BUILTIN_PROVIDERS[id].defaultModel` (the builtin default)
   *
   * @param {string} providerId
   * @returns {string|null} the effective active model, or `null` if the
   *   provider is unknown AND no stored value exists
   */
  getActiveModel(providerId) {
    const builtin = BUILTIN_PROVIDERS[providerId];
    const config = this.loadConfig();
    const stored = config.providers?.[providerId] || {};

    // 1. Stored user choice (highest priority)
    if (typeof stored.model === 'string' && stored.model.trim()) {
      return stored.model.trim();
    }
    // 2. Env var override (only meaningful for builtin providers with envModelVars)
    if (builtin?.envModelVars) {
      for (const envVar of builtin.envModelVars) {
        const v = process.env[envVar];
        if (typeof v === 'string' && v.trim()) {
          return v.trim();
        }
      }
    }
    // 3. Builtin default
    if (
      builtin?.defaultModel &&
      typeof builtin.defaultModel === 'string' &&
      builtin.defaultModel.trim()
    ) {
      return builtin.defaultModel.trim();
    }
    return null;
  }

  /**
   * Get the MODEL CATALOG for a provider (the list of available models).
   *
   * This is the **canonical** read-side getter introduced in Phase 2.1 to
   * disambiguate `model` (active, single value) from `models[]` (catalog,
   * many values). `getProviderModels()` is a backward-compatible alias that
   * delegates here — all new call sites should use `getModelCatalog()`.
   *
   * Precedence (all deduplicated, first occurrence wins):
   *   1. builtin.defaultModel
   *   2. stored `model`           ← the user's active/selected model
   *   3. stored `models[]`        ← user-customized catalog
   *   4. builtin `models[]`       ← builtin catalog
   *
   * The returned list always includes the currently active model (if any),
   * even when it is a custom finetune outside the builtin catalog.
   *
   * @param {string} providerId
   * @returns {string[]} deduplicated list of model names (may be empty for
   *   unknown providers with no stored catalog)
   */
  getModelCatalog(providerId) {
    const builtin = BUILTIN_PROVIDERS[providerId];
    const config = this.loadConfig();
    const stored = config.providers?.[providerId] || {};

    const builtinModels = builtin?.models || [];
    const storedModels = Array.isArray(stored.models) ? stored.models : [];
    // The currently-active model the user picked (may be a custom finetune
    // or a model not present in the catalog). We always surface it.
    const activeModel =
      typeof stored.model === 'string' && stored.model.trim() ? stored.model.trim() : null;

    // Combine: builtin default model first, then active model, then
    // stored catalog, then builtin catalog. Deduplicate while preserving
    // first-occurrence order so `(active)` markers stay consistent.
    const merged = [];
    const seen = new Set();
    const push = (m) => {
      if (typeof m !== 'string') return;
      const v = m.trim();
      if (!v || seen.has(v)) return;
      seen.add(v);
      merged.push(v);
    };

    push(builtin?.defaultModel);
    push(activeModel);
    for (const m of storedModels) push(m);
    for (const m of builtinModels) push(m);
    return merged;
  }

  /**
   * List all known provider IDs.
   *
   * Returns the union of builtin providers (from `BUILTIN_PROVIDERS`) and
   * any custom providers the user has stored in `config.json.providers`.
   * Order is stable: builtin IDs first (in declaration order), then
   * custom IDs sorted alphabetically.
   *
   * This is the single source of truth for "what providers exist" so that
   * CLI code (`tai provider list`, `tai model --list`, the `/model` picker)
   * never has to call `Object.keys(BUILTIN_PROVIDERS)` directly and miss
   * user-added custom providers.
   *
   * @returns {string[]}
   */
  getProviderNames() {
    const builtinNames = Object.keys(BUILTIN_PROVIDERS);
    const config = this.loadConfig();
    const storedNames = Object.keys(config.providers || {});
    const builtinSet = new Set(builtinNames);
    const customNames = storedNames
      .filter((n) => !builtinSet.has(n))
      .sort((a, b) => a.localeCompare(b));
    return [...builtinNames, ...customNames];
  }

  /**
   * Remove custom provider (refuses built-in providers)
   * @param {string} providerId
   */
  removeProvider(providerId) {
    if (BUILTIN_PROVIDERS[providerId]) {
      throw new Error(`Cannot remove builtin provider "${providerId}"`);
    }
    const config = this.loadConfig();
    delete config.providers?.[providerId];
    this.saveConfig(config);
  }
}

// Singleton default export instance
export const configManager = new ConfigManager();
