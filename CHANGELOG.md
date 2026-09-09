# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Biome linter/formatter (`npm run lint`, `npm run lint:fix`, `npm run format`) with a pre-commit hook under `.githooks/` (MAINT-01).
- GitHub Actions CI running lint and unit tests on Node 20 and 22 (MAINT-02).
- `CHANGELOG.md` (this file), maintained manually per PR (MAINT-03).
- Commit message linting via `@commitlint/cli` + `@commitlint/config-conventional`, enforced by a `.githooks/commit-msg` hook and `npm run commitlint` / `npm run commitlint:check` (CONFIG-02).
- `Logger` JSDoc typedef in `src/utils/logger.js`; `options.logger` annotations across 7 modules now reference it instead of `object` (DOC-04).
- i18n layer: `locales/en.json` + `locales/id.json` with a zero-dep loader in `src/i18n/index.js`; new `locale` config key (MAINT-04).
- Data-driven `TOOL_ARG_ALIASES` map in `src/tools/registry.js` backing a branch-free `normalizeToolArgs`; adding a tool-argument alias is now a one-line map edit (MAINT-06).
- `tests/registry-args.test.js` covering alias mapping, precedence, fallbacks, and nullish-vs-falsy semantics (MAINT-06).
- 49 snapshot tests in `tests/parse-text-tool-calls.test.js` locking `parseTextToolCalls` extraction behavior for every known model output format: tagged `<tool_calls>`/`<tool_call>` containers and JSON, `<tool_call><_action>`/`<_function_call>` XML blocks, `<function=name>` parameter blocks, fenced JSON, ReAct `Action:` lines, bare `tool_name {…}` pairs, `<think>` stripping, classification fallback, ordering, and dedup (MAINT-07).

- Session status line above each REPL prompt (`─ 23.4k tok │ ctx 12% │ loop 7/30 ─`): real API usage accumulated into `session.metadata.usage` via the new pure module `src/agent/usage.js` (estimator fallback with `~` prefix), OpenAI-compatible streaming usage parsing (`stream_options.include_usage` with one 400-fallback retry), and the ReAct budget check switched to the real-usage-anchored `getContextTokens()` (FEATURE-01).
- Shared HTTP connection pool for LLM clients via `src/llm/http-pool.js`: `pooledFetch` lazily constructs a single undici `Agent` (256 connections, 60s keep-alive, pipelining 1) and threads it as the fetch `dispatcher`. Both `BaseLlmClient` and `GeminiClient` now default `this.fetch` to `pooledFetch` instead of `globalThis.fetch`. When the `undici` package is not installed, the wrapper transparently falls back to `globalThis.fetch` — Node's bundled undici-based fetch already pools internally, so ReAct loops still avoid per-iteration TCP+TLS handshakes without adding a runtime dependency. 7 new tests lock fallback, dispatcher cache identity, idempotent `closePool`, init-passthrough, and that both adapters wire the wrapper (PERF-01).

- Unlimited ReAct loop with LLM auto-compact: the 30-iteration cap is gone (`DEFAULT_MAX_ITERATIONS = Infinity`) — the only stops are a final answer, user abort, API error, reflection stop, or an explicit `--max-iterations <n>`. When context crosses 92% of the budget, the new `src/agent/compactor.js` summarizes old turns via the LLM (mechanical `[Context digest]` fallback when the summary call fails), keeps the last 10 messages verbatim, and the loop continues. Replaced raw turns are archived to `<sessionsDir>/<id>.archive.jsonl` before the session is rewritten, so nothing is lost. Manual `/compact` slash command, `onCompactStart`/`onCompactEnd` REPL hooks, `loop N/∞` status rendering, and oversized single tool results truncated at 25% of the context budget as the per-request safety net (FEATURE-02).
- `/new` slash command inside REPL to start a fresh conversation session (new ID, reset prompt turn badge, zeroed usage counters) without restarting the CLI process. The previous session is automatically saved to disk and can be resumed with `faycli resume <id>` (FEATURE-03).

### Changed

- Context pruning now compresses instead of discarding: when `pruneMessages` drains older turns to fit the context window, they are folded into a bounded `[Context digest]` summary message placed ahead of the retained window (per-message one-liners, body capped at 4000 chars). Tool call/response pairs are never split across the drain boundary, and `compress: false` restores the previous hard cutoff (PERF-02).
- Session token estimation is now incremental: per-message estimates are cached in a `WeakMap` keyed by message identity (`src/agent/pruner.js`), so `estimateSessionTokens` at the top of every ReAct iteration and `pruneMessages`' internal re-estimation only pay for newly appended messages instead of rescanning the full history (PERF-03).
- `parseTextToolCalls` in `src/llm/openai.js` consolidated from seven ad-hoc regex passes into a structured pipeline: a declarative table of block constructs scanned in order, shared JSON-shape and parameter-tag helpers, and a single validation/dedup point. Extraction behavior is unchanged — the snapshot suite passes identically before and after the rewrite (MAINT-07).

- Codebase formatted and lint-cleaned with Biome across `src/`, `tests/`, `scripts/`, and `bin/`.
- **MAINT-04**: User-facing strings are now localized, default **English**. Indonesian REPL/spinner/retry messages are opt-in via `faycli config set locale id`. Existing users who relied on the Indonesian defaults will see English after upgrading.
- **MAINT-05 (breaking for embedders)**: Removed the legacy `geminiClient` alias. Pass `llmClient` instead of `geminiClient` when constructing `AgentOrchestrator`, and read `orchestrator.llmClient` instead of `orchestrator.geminiClient`. The CLI-facing behavior is unchanged.

### Fixed

- **Gemini thought signatures**: Gemini 3+ models (e.g. `gemini-3.5-flash`) attach a `thoughtSignature` to function call parts and reject the next request with 400 when replayed history omits it. The signature is now captured during stream/non-stream extraction, stored in session history, and echoed back on subsequent turns. Tool-calling loops on Gemini 3 models no longer fail at turn 2.

## [1.0.0] - 2026-08-30

### Security

- **SEC-01**: Added `gemini.useHeaderAuth` config flag so the Gemini API key can be sent via `Authorization: Bearer` header instead of the `key=` URL query param (`src/llm/gemini.js`).
- **SEC-02**: Windows `spawn` no longer silently falls back to `shell: true`; the shell is now always explicit (`src/tools/execute_command.js`).
- **SEC-03** (partial): Defense-in-depth hardening in `src/security/rules.js` and `src/security/guard.js` — `HARD_LIMITS`, obfuscation patterns, and protected-path blocks. Regex blacklist kept as last line.
- **SEC-04**: `allowTermuxStorage` now defaults to `false`; full SD-card access requires explicit opt-in (`src/security/path-validator.js`).

### Fixed

- **BUG-01**: Per-pull `AnswerStream` replaces the timing-coupled answer feeder; the 10 previously cancelled provider-wizard tests now pass deterministically.
- **BUG-02**: Removed the `TAI_DEPRECATED_GET_PROVIDER_MODELS` warning; `getProviderModels()` is a plain delegation to `getModelCatalog()`.
- **BUG-03**: `ConfigManager` now caches `loadConfig()` per config path with invalidate-on-write instead of re-reading the file on every access.
- **BUG-04**: `read_file`, `list_dir`, and `patch_file` migrated to `node:fs/promises`, unblocking the event loop on the tool hot path.

[Unreleased]: https://github.com/FAYnim/FAY-CLI/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/FAYnim/FAY-CLI/releases/tag/v1.0.0
