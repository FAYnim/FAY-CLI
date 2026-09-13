# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Run CLI locally**: `node bin/faycli.js` or `npm link` then `faycli`
- **Run all unit tests**: `npm test` (`node --test tests/*.test.js`)
- **Run a single test file**: `node --test tests/<filename>.test.js`
- **Run tests matching a pattern**: `node --test --test-name-pattern="<pattern>" tests/<filename>.test.js`
- **Run all tests (unit + E2E)**: `npm run test:all`
- **Run E2E tests (requires live API credentials)**: `npm run test:e2e`
- **Run benchmarks**: `npm run benchmark`
- **Lint**: `npm run lint` (`biome check .`)
- **Lint & auto-fix**: `npm run lint:fix` (`biome check --write .`)
- **Format code**: `npm run format` (`biome format --write .`)
- **Commit message check**: `npm run commitlint` (`commitlint --from origin/main`)

## Architecture & System Design

`faycli` is a zero-native-dependency autonomous AI agent CLI optimized for Android Termux and Linux/macOS/Windows, built on pure Node.js ESM (>=20.0.0).

### Core Pipeline & Agent Loop (`src/agent/`)
- **`AgentOrchestrator` (`src/agent/orchestrator.js`)**: Coordinates the ReAct (Reasoning + Acting) loop. Default iteration limit is `Infinity`. Monitors context limits (`usage.js`), triggers LLM auto-compaction (`compactor.js`) when context approaches 92% of budget, and runs periodic self-reflection checks (`reflection.js`) to prevent loops.
- **Operating Modes**:
  - `build` mode (default): Full read/write/patch tools and shell execution.
  - `plan` mode (`/plan`): Read-only exploration and architecture analysis; file modifications restricted to `.fay/plans/`. Return to build mode via `/build`.
- **Session State (`src/agent/session.js`)**: Persists chat turns and metadata into `~/.faycli/sessions/<id>.json`. Archives compacted turns to `<id>.archive.jsonl`.
- **System Prompt (`src/agent/system-prompt.js`)**: Dynamically detects host/Termux environment and injects mode-aware system instructions.

### LLM Adapters (`src/llm/`)
- **Multi-Provider Factory (`src/llm/registry.js`)**: Instantiates LLM clients using `createLlmClient()`.
  - `GeminiClient` (`src/llm/gemini.js`): Native Google Generative Language API adapter with SSE streaming and Gemini 3+ thought signature preservation.
  - `OpenAIClient` (`src/llm/openai.js`): Adapter for OpenAI and OpenAI-compatible APIs (Groq, OpenRouter, DeepSeek, Ollama). Contains `parseTextToolCalls` pipeline for extracting tool calls emitted as text or XML blocks.
- **HTTP Connection Pool (`src/llm/http-pool.js`)**: Pooled connections across ReAct iterations via Undici `Agent` with transparent fallback to standard `fetch`.

### Actuator Tools (`src/tools/`)
- 12 local tools mapped in `src/tools/registry.js`: `read_file`, `write_file`, `patch_file`, `list_dir`, `execute_command`, `grep_file`, `search_files`, `git_status`, `git_diff`, `git_add_commit`, `web_fetch`, `web_search`.
- **Argument Normalization**: `TOOL_ARG_ALIASES` normalizes common model hallucinations/aliases (e.g. `path`/`file` -> `filePath`) before tool execution.
- **Dispatch**: `dispatchToolCall()` validates arguments, routes through `SecurityGuard`, and executes the tool.

### Security Layers (`src/security/`)
- **`SecurityGuard` (`src/security/guard.js`)**: Defense-in-depth gatekeeper for tool calls.
- **Path Validation (`src/security/path-validator.js`)**: Constrains write operations to the active workspace jail. Termux shared storage (`/sdcard/`, `~/storage/shared`) requires explicit `security.allowTermuxStorage` opt-in.
- **Command Rules (`src/security/rules.js`)**: Hard-blocks destructive commands (blacklist/patterns) and prompts for confirmation on risky commands (`rm -rf`, `chmod`, `sudo`).

### CLI & UI (`src/cli/`, `src/ui/`)
- **Entry point (`bin/faycli.js`)**: Dispatches between CLI subcommands (`config`, `session`, `provider`, `model`), stdin piping (`piping.js`), single-shot prompt execution (`single-shot.js`), and interactive REPL (`repl.js`).
- **Configuration (`src/config/`)**: `ConfigManager` (`manager.js`) handles persistent configuration in `~/.faycli/config.json`. Single source of truth for providers and model catalogs is `BUILTIN_PROVIDERS` in `constants.js`.
- **Terminal UI (`src/ui/`)**: Lightweight ANSI rendering without heavy dependencies: custom Markdown renderer (`markdown.js`), interactive TTY picker menus (`model-menu.js`, `confirm-menu.js`), diff preview (`diff-preview.js`), and spinners (`spinner.js`).
- **i18n (`src/i18n/`)**: Zero-dependency localization layer supporting `en` (default) and `id` (`locales/`).

## Key Conventions & Constraints

- **Pure ESM**: Use `import`/`export` and include `.js` file extensions in import specifiers.
- **Zero Native Dependencies**: Do not introduce packages requiring native binary compilation or `node-gyp` (must run on Termux).
- **Code Style**: Formatted and linted with Biome (2 spaces, single quotes, semicolons, line width 100).
- **Commit Format**: Conventional commits enforced via commitlint (`feat:`, `fix:`, `chore:`, etc.).
