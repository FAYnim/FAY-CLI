# FAY CLI (`faycli`)

> **Autonomous AI Agent CLI — Optimized for Termux Android & Linux**

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.0-green)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue)](./LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Termux%20%7C%20Linux%20%7C%20macOS-informational)](https://termux.dev/)
[![PRD](https://img.shields.io/badge/Spec-PRD%20v1.0-orange)](./AI%20Termux.md)

---

## 📋 Overview

**FAY CLI (`faycli`)** is a lightweight, zero-native-dependency autonomous AI agent designed specifically for **Android Termux** environments. It uses Google's Gemini API as its reasoning engine while performing file I/O, directory exploration, and shell command execution directly on your local Termux filesystem.

### Key Highlights

- 🤖 **ReAct Agentic Loop** — multi-turn reasoning and acting with autonomous self-correction
- 🔒 **Security Guard** — human-in-the-loop confirmation, command blacklist, safe path jail
- ⚡ **Ultra-Lightweight** — startup `< 300 ms`, RAM `< 50 MB` idle
- 📱 **Termux-Native** — no `node-gyp`, no binary compilation, pure ESM Node.js
- 🔧 **12 Local Tools & Parallel Execution** — `read_file`, `write_file`, `patch_file`, `list_dir`, `execute_command`, `grep_file`, `search_files`, `git_status`, `git_diff`, `git_add_commit`, `web_fetch`, `web_search` with concurrent read execution (`Promise.all`)
- 🎨 **Rich Terminal UI** — ANSI Markdown renderer, live spinner, syntax highlighting
- 🌐 **Multi-Provider** — 2 native adapters (Gemini, OpenAI) + unlimited OpenAI-compatible endpoints (Groq, OpenRouter, DeepSeek, Ollama, custom)
- 🧩 **Multi-Model Catalog** — per-provider model lists with interactive TUI picker & CLI CRUD (`faycli model`)

> **Latest on `feat/multi-model-phase1`:** Phase 1–4 of the multi-model plan landed — per-provider
> `models[]` catalog, zero-dependency interactive `/model` picker, non-interactive `faycli model
> --list/--set` flags, and catalog CRUD (`--add` / `--remove` / `--clear`).
> **547/556 tests pass** (9 pre-existing failures), 0 regressions.

---

## 📦 Installation

### Android Termux (Recommended)

```bash
# Option 1: One-command installer
curl -fsSL https://raw.githubusercontent.com/FAYnim/FAY-CLI/main/install.sh | bash

# Option 2: Manual install from source
pkg update && pkg install nodejs git
git clone https://github.com/FAYnim/FAY-CLI
cd FAY-CLI
npm link
```

### Linux / macOS

```bash
git clone https://github.com/FAYnim/FAY-CLI
cd FAY-CLI
npm link
```

### Windows (for development)

```bash
git clone https://github.com/FAYnim/FAY-CLI
cd FAY-CLI
npm link
```

> **Requirements:** Node.js >= 20.0.0

---

## 🔑 Setup: Gemini API Key

Get a free Gemini API key at **[aistudio.google.com](https://aistudio.google.com/)**

**Option A: Store in config (recommended)**
```bash
faycli config set apiKey YOUR_GEMINI_API_KEY
```

**Option B: Environment variable**
```bash
# Add to ~/.bashrc or ~/.zshrc
export GEMINI_API_KEY="YOUR_GEMINI_API_KEY"
# Or use:
export FAYCLI_API_KEY="YOUR_GEMINI_API_KEY"
```

> **Security tip (SEC-01):** by default the Gemini key is sent as a `key=` query
> parameter (which can leak into proxy/DevTools logs). Send it via the
> `Authorization: Bearer` header instead:
> ```bash
> faycli config set gemini.useHeaderAuth true
> ```

---

## 🌐 Multi-Provider Support

`faycli` has **2 native LLM adapters** and supports unlimited **OpenAI-compatible** endpoints:

| Adapter | Provider(s) | Notes |
|---------|-------------|-------|
| `GeminiClient` | `gemini` | Native Google Generative Language API |
| `OpenAIClient` | `openai` + any OpenAI-compatible URL | Default adapter for custom providers |

> **Groq, OpenRouter, DeepSeek, Ollama** are **not** separate adapters — they reuse
> `OpenAIClient` with a different `--base-url`. This means `faycli` can speak to any
> OpenAI-compatible endpoint out of the box.

```bash
faycli provider list                         # Show configured providers
faycli provider use openai                   # Switch active provider (persists)
faycli provider add openai --api-key "$KEY"  # Configure OpenAI
faycli provider show gemini                  # Dump provider configuration as JSON
```

### Persistent vs One-Shot — Know the Difference

> 📖 Full concept guide below.

| Cara | Perintah | Simpan ke config? | Berlaku untuk |
|------|----------|:-----------------:|---------------|
| **One-shot CLI flag** | `faycli --model gpt-4o "prompt"` | ❌ Tidak | Hanya run ini |
| **One-shot provider** | `faycli --provider openai "prompt"` | ❌ Tidak | Hanya run ini |
| **Persistent model** | `faycli model --set gpt-4o` | ✅ Ya | Semua run berikutnya |
| **Persistent provider** | `faycli provider use openai` | ✅ Ya | Semua run berikutnya |

### Three "Model" Concepts (Don't Mix Them Up)

| Concept | Where | Meaning | Lifetime |
|---------|-------|---------|----------|
| `providers[id].model` | `config.json` | **Active model** used when sending requests | Persistent |
| `providers[id].models[]` | `config.json` | **Model catalog** — list of available models | Persistent |
| `--model <name>` CLI flag | CLI only | **One-shot override** — not saved anywhere | Transient |

### Popular Provider Setup Examples — OpenAI-Compatible

All of these reuse the `OpenAIClient` adapter with a custom `--base-url` (`--adapter openai` is applied by default):

#### 1. Groq (Ultra-Fast Inference)
```bash
faycli provider add groq \
  --adapter openai \
  --api-key "gsk_..." \
  --base-url "https://api.groq.com/openai/v1" \
  --model "llama-3.3-70b-versatile"

faycli provider use groq
```

#### 2. OpenRouter (Access Claude 3.5 Sonnet, GPT-4o, DeepSeek, etc.)
```bash
faycli provider add openrouter \
  --adapter openai \
  --api-key "sk-or-..." \
  --base-url "https://openrouter.ai/api/v1" \
  --model "anthropic/claude-3.5-sonnet"

faycli provider use openrouter
```

#### 3. DeepSeek
```bash
faycli provider add deepseek \
  --adapter openai \
  --api-key "sk-..." \
  --base-url "https://api.deepseek.com/v1" \
  --model "deepseek-chat"

faycli provider use deepseek
```

#### 4. Ollama (Local / Offline in Termux or PC)
```bash
faycli provider add ollama \
  --adapter openai \
  --base-url "http://localhost:11434/v1" \
  --model "llama3.2"

faycli provider use ollama
```

### One-Shot Provider/Model Override

Run a command with a different provider **without** altering your default configuration:

```bash
# One-shot: uses openai for this run only, your default stays unchanged
faycli --provider openai --model gpt-4o "translate this sentence"
faycli --provider groq "analisis file package.json"
```

### Environment Variables

| Provider | API Key | Base URL | Model |
|---|---|---|---|
| Gemini | `GEMINI_API_KEY`, `FAYCLI_API_KEY`, `T_AI_API_KEY` | — | — |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_BASE_URL` | `OPENAI_MODEL` |

### Developer Guide: Adding a Custom Native Adapter

To add a provider with a non-OpenAI protocol (e.g. Anthropic `/v1/messages`):

1. Create a client class extending `BaseLlmClient` in `src/llm/your-provider.js`.
2. Register your provider in `src/llm/registry.js` under `createLlmClient`.
3. Add built-in defaults in `src/config/constants.js` (`BUILTIN_PROVIDERS`).

---

## 🚀 Quick Start

```bash
# Start interactive REPL
faycli

# Single-shot task
faycli "Buat fungsi kalkulator dalam JavaScript dengan operasi dasar"

# Single-shot task using OpenAI
faycli --provider openai --model gpt-4o-mini "Buat REST API sederhana"

# UNIX pipe analysis
cat error.log | faycli "Analisis IP mencurigakan dan ringkas error utama"

# Git commit message
git diff | faycli "Buat pesan commit yang ringkas dan deskriptif"

# Use a specific model
faycli --model gemini-2.5-pro "Refaktor kode ini untuk performa optimal"

# Auto-approve all actions (skip confirmation prompts)
faycli -y "Instal dependensi dan jalankan tes"
```

---

## 📖 Usage Modes

### 1. Interactive REPL Mode

Start with `faycli` (no arguments) to enter the interactive multi-turn REPL:

```
$ faycli

  ┌─────────────────────────────────────────────────┐
  │  faycli — FAY CLI  (gemini-2.5-flash)   │
  │  Working Directory: /data/data/com.termux/...    │
  └─────────────────────────────────────────────────┘

  You › Buat REST API sederhana dengan Express.js
```

#### Session Status Line

After every agent turn, a one-line usage summary appears above the next prompt:

```
─ 23.4k tok │ ctx 12% │ loop 7/30 ─
```

- **tok** — cumulative API tokens billed this session (`~` prefix = estimate, shown when the provider does not report usage)
- **ctx** — context size vs the 85% budget where the ReAct loop force-stops
- **loop** — ReAct iterations used in the last turn vs the cap (default 30)

#### Slash Commands (inside REPL)

| Command | Description |
|---|---|
| `/help` | Display all available slash commands |
| `/model [name]` | View or switch active model (interactive TUI menu on TTY) |
| `/session` | Show current session info and ID |
| `/clear` | Clear conversation history |
| `/config` | View current configuration |
| `/exit` or `/quit` | Exit the REPL |

### 2. Single-Shot Mode

```bash
faycli "YOUR_TASK_HERE"
# Exits with code 0 on success, 1 on failure
```

### 3. UNIX Pipe Mode

```bash
# Analyze log files
cat access.log | faycli "Ekstrak top-10 IP dengan request terbanyak"

# Review code changes
git diff HEAD~1 | faycli "Review perubahan ini dan buat ringkasan"

# Analyze error output
npm test 2>&1 | faycli "Jelaskan error test dan saran perbaikan"

# Process any text data
cat data.json | faycli "Buat ringkasan dalam format Markdown"
```

### 4. Session Management

```bash
# List all saved sessions
faycli session list

# Resume a previous session
faycli resume sess_1700000000_abc123

# Delete a specific session
faycli session delete sess_1700000000_abc123

# Clear all sessions
faycli session clear

# Start with a specific session ID
faycli --session sess_1700000000_abc123
```

---

## ⚙️ Configuration

### All Config Commands

```bash
# View all configuration
faycli config list

# Get specific value
faycli config get model
faycli config get apiKey

# Set values
faycli config set apiKey YOUR_KEY
faycli config set model gemini-2.5-pro
faycli config set timeoutMs 60000
faycli config set autoConfirm true
faycli config set verbose true

# Reset a key to default
faycli config delete model

# Reset everything to defaults
faycli config reset
```

### Available Configuration Keys

| Key | Default | Description |
|---|---|---|
| `apiKey` | `""` | Gemini API key (env fallback: `GEMINI_API_KEY`, `FAYCLI_API_KEY`, or legacy `T_AI_API_KEY`) |
| `model` | `gemini-2.5-flash` | Default LLM model |
| `timeoutMs` | `30000` | Shell command timeout (ms) |
| `maxContextTokens` | `1000000` | Max tokens before context pruning |
| `autoConfirm` | `false` | Auto-approve all security prompts |
| `verbose` | `false` | Enable verbose debug logging |
| `gemini.useHeaderAuth` | `false` | Send Gemini API key via `Authorization: Bearer` header instead of `key=` query (SEC-01) |

### Supported Models — Per Provider Catalog

> Source of truth: `BUILTIN_PROVIDERS` in [`src/config/constants.js`](./src/config/constants.js).
> These models ship by default; use `faycli model --add` to extend any provider's catalog.

#### Gemini (native `GeminiClient`)

| Model | Description |
|-------|-------------|
| `gemini-2.5-flash` | **Default** — fast, efficient, high capability |
| `gemini-2.5-pro` | Most powerful, best for complex reasoning |
| `gemini-1.5-flash` | Lightweight, very fast |
| `gemini-1.5-pro` | High-capability v1.5 |
| `gemini-2.0-flash` | Latest v2.0 flash variant |

#### OpenAI (native `OpenAIClient` — also used by OpenAI-compatible providers)

| Model | Description |
|-------|-------------|
| `gpt-4o-mini` | **Default** — fast and cost-effective |
| `gpt-4o` | Most powerful GPT-4o |
| `gpt-4` | Classic GPT-4 |
| `gpt-3.5-turbo` | Legacy, fast and affordable |

> **OpenAI-compatible providers** (Groq, OpenRouter, DeepSeek, Ollama) use `OpenAIClient`
> but their models are **not** pre-loaded — manage them with `faycli model --add / --set`.

### Model Management (`faycli model`)

Manage models from the command line without entering the REPL:

```bash
# List models for the active provider (gemini by default)
faycli model --list

# List models for ALL configured providers
faycli model --list --all

# List models for a specific provider
faycli model --list --provider openai

# Set the active model and persist it
faycli model --set gemini-2.5-pro

# Set the model for a specific provider
faycli model --set gpt-4o --provider openai
```

The catalog is sourced from each provider's `models[]` array (Gemini ships 5 models,
OpenAI ships 4). Custom models not in the catalog are still saved (marked as
"custom" in the output).

#### Catalog CRUD — `add` / `remove` / `clear`

Manage each provider's model catalog itself (not just the active model). All three
operations are **script-friendly** and exit non-zero on failure.

```bash
# Add a single model to the active provider's catalog
faycli model --add gpt-4-turbo

# Add multiple models at once (comma-, semicolon-, or newline-separated)
faycli model --add gpt-4-turbo,gpt-4o,gpt-3.5-turbo --provider openai

# Top-level shortcut — equivalent to `faycli model --add`
faycli add gpt-4-turbo --provider openai

# Remove a model from the catalog
faycli model --remove gpt-3.5-turbo --provider openai
faycli remove gpt-3.5-turbo          # shortcut

# Reset a provider's catalog to the builtin defaults
faycli model --clear --provider openai
faycli clear --provider openai        # shortcut
```

**Rules enforced by the CLI:**

- `--add` dedupes against the existing catalog **and** the active model, and initializes
  the catalog from `BUILTIN_PROVIDERS[pid].models` on first use.
- `--remove` **refuses** to delete the currently active model (whether stored in config
  or the builtin `defaultModel`). Switch with `--set` first.
- `--clear` resets the catalog to the provider's builtin defaults but preserves any
  custom `model` you've previously set active.
- Unknown provider → exit `1` with a helpful error.

#### Interactive `/model` picker (REPL)

Inside the REPL, `/model` (no args) opens a **zero-dependency** interactive picker
(arrow keys / `j` `k` / `Enter` / `Esc`) when stdout is a TTY. Non-TTY sessions
(pipes, redirects) fall back to a static text box — the same one used by
`faycli model --list`.

```text
╔══════════════════════════════════════════════╗
║              Model (gemini)                  ║
╠══════════════════════════════════════════════╣
║   ▸ gemini-2.5-flash  (active)               ║
║      gemini-2.5-pro                          ║
║      gemini-1.5-flash                        ║
║      gemini-1.5-pro                          ║
║      gemini-2.0-flash                        ║
╚══════════════════════════════════════════════╝
```

---

## 🛡️ Security System

faycli includes a multi-layer security guard for safe file and command execution. The defense-in-depth logic lives in [`src/security/rules.js`](src/security/rules.js), [`src/security/guard.js`](src/security/guard.js), and [`src/security/path-validator.js`](src/security/path-validator.js); see [SECURITY.md](SECURITY.md) for the disclosure policy and full threat model.

### Protection Layers

1. **Safe Path Jail**: All file operations are constrained to the current working directory (CWD). Access outside CWD requires user confirmation.

2. **Command Blacklist**: Absolutely forbidden commands are rejected without prompting:
   - `rm -rf /`, `mkfs`, `dd if=/dev/zero`, `:(){ :|:& };:` (fork bomb), etc.

3. **Risky Command Confirmation**: Potentially destructive commands (e.g., `rm -rf`, `chmod 777`, `sudo`) trigger a `[y/N]` prompt before execution.

4. **Execution Timeout**: All shell commands have a configurable timeout (default: 30s) with `AbortController` enforcement.

5. **Human-in-the-Loop**: Every file write and command execution can be reviewed and approved/denied interactively.

### Confirmation Prompts

```
⚠ [SECURITY CHECK] AI wants to execute risky shell command:
  rm -rf ./dist
Proceed? [y/N]: y
```

### Auto-Approve Mode (`-y`)

```bash
# Skip all confirmation prompts (use in trusted environments only)
faycli -y "Bersihkan direktori dist dan build ulang"
faycli --yes "Deploy ke server staging"
```

### Termux Android Storage Access

On Termux, faycli automatically permits access to Android shared storage paths (`/sdcard/`, `~/storage/shared`) when `termux-setup-storage` has been configured:

```bash
# Enable Android storage access in Termux (one-time setup)
termux-setup-storage
```

### What Is NOT Protected

- **The command blacklist is bypassable.** It is a regex allowlist-of-denylist, not a sandbox boundary. Any novel or obfuscated command can slip past it.
- **No OS-level sandboxing.** faycli does not drop privileges, chroot/jail, or containerize. Treat it as capable of arbitrary code execution on your account.
- **`security.allowTermuxStorage` is opt-in** (`faycli config set security.allowTermuxStorage true`). Only enable it when you trust the model and the workspace contents.
- **Path validation restricts writes to the safe workspace only.** Reads and commands can still reach outside it when you approve them.

Run the CLI only in environments where you accept that the model has your privileges. For reporting vulnerabilities, see [SECURITY.md](SECURITY.md).

---

## 🔧 Local Tools (Actuators) & Concurrency

faycli equips the AI agent with 12 built-in tools. Tools marked **Read-Only / Idempotent** run in parallel via `Promise.all()` whenever the LLM emits multiple calls in a single turn, cutting latency dramatically. Mutating tools run sequentially to preserve filesystem integrity.

### ⚡ Parallel Execution (Read-Only)
- `read_file` — Read file content with line slicing (`filePath`, `startLine?`, `endLine?`, `encoding?`)
- `grep_file` — Substring or regex search across files (`query`, `dirPath?`, `pattern?`, `caseSensitive?`)
- `search_files` — Glob file matcher (`pattern`, `dirPath?`, `maxResults?`)
- `list_dir` — Explore directory structure with depth control (`dirPath?`, `depth?`, `showHidden?`)
- `git_status` — Check porcelain working-tree status (`workingDir?`)
- `git_diff` — Show unstaged/staged diff (`file?`, `staged?`, `workingDir?`)
- `web_fetch` — Fetch and extract URL web content (`url`, `raw?`)

### 🛡️ Sequential Execution (Mutating / Interactive)
- `write_file` — Write content atomically to disk (`filePath`, `content`, `encoding?`)
- `patch_file` — Exact string search-and-replace patch (`filePath`, `searchString`, `replaceString`)
- `execute_command` — Shell command execution with stdout/stderr capture (`command`, `workingDir?`)
- `git_add_commit` — Stage and commit git changes (`message`, `all?`, `workingDir?`)
- `web_search` — Web search via DuckDuckGo / SearXNG (`query`, `maxResults?`)

---

## 🤖 ReAct Agentic Loop

faycli implements the **ReAct (Reasoning + Acting)** pattern:

```
User Prompt
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│                    ReAct Agentic Loop                        │
│                                                             │
│  ┌──────────┐   Tool Call   ┌───────────────────────────┐   │
│  │  Gemini  │──────────────▶│  Security Guard           │   │
│  │   API    │               │  • Blacklist check        │   │
│  │  (LLM)   │               │  • Path validation        │   │
│  └──────────┘               │  • Risky cmd confirmation │   │
│       ▲                     └───────────┬───────────────┘   │
│       │                                 │ Authorized         │
│       │                                 ▼                   │
│  Function    ┌──────────────────────────────────────────┐   │
│  Response    │  Local Actuator (node:fs, child_process) │   │
│       └──────│  read_file │ write_file │ execute_command│   │
│              └──────────────────────────────────────────┘   │
│                                                             │
│  Loop ends when: text response (no tool calls) OR max steps  │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
Final Answer (streamed to terminal)
```

### Self-Healing Bug Fix Example

```bash
faycli "Buat file kalkulator calculator.js, tulis unit test, jalankan test, dan perbaiki bug sampai semua lulus"
```

faycli will autonomously:
1. 📝 Write `calculator.js` with the calculator functions
2. 📝 Write `test-calculator.js` with test cases
3. 🔧 Run `node test-calculator.js`
4. 🔍 Read error output (if tests fail)
5. 🩹 Apply `patch_file` to fix the bug
6. 🔄 Re-run tests until exit code 0
7. ✅ Report success

---

## 📊 Performance

faycli is engineered for the resource-constrained environment of Android phones:

| Metric | Target | Status |
|---|---|---|
| Startup Time | `< 300 ms` | ✅ Verified |
| Memory RSS (idle) | `< 50 MB` | ✅ Verified |
| Memory RSS (ReAct loop) | `< 50 MB` | ✅ Verified |
| Native Dependencies | Zero | ✅ Pure ESM |

### Run Benchmark Yourself

```bash
node scripts/benchmark.js
# Output:
#   Startup Time (avg)    142.35 ms     < 300 ms    ✔ PASS
#   Memory RSS            34.21 MB      < 50 MB     ✔ PASS
```

---

## 🧪 Testing

```bash
# Run all unit tests (Step 1–5)
npm test
# or
node --test tests/*.test.js

# Run E2E integration tests (Step 6)
node scripts/test-e2e.js
# or
node --test tests/e2e/*.test.js

# Run ALL tests (unit + E2E)
node --test tests/*.test.js tests/e2e/*.test.js

# Run benchmark
npm run benchmark
```

`npm test` runs the unit suite only. `npm test:e2e` exercises the real CLI against live
provider APIs and requires network + API credentials, so it is intentionally excluded
from `npm test` and CI; run it locally.

---

## 📁 Project Structure

```
FAY-CLI/
├── bin/
│   └── faycli.js                    # CLI executable entry point
├── src/
│   ├── cli/
│   │   ├── args.js               # Argument parser
│   │   ├── help.js               # --help output
│   │   ├── piping.js             # UNIX stdin pipe handler
│   │   ├── repl.js               # Interactive REPL
│   │   ├── single-shot.js        # Single-shot task runner
│   │   └── slash-commands.js     # /help, /model, /session, etc.
│   ├── config/
│   │   ├── constants.js          # App constants & defaults
│   │   └── manager.js            # Config load/save/get/set
│   ├── security/
│   │   ├── rules.js              # Blacklist & risky patterns
│   │   ├── path-validator.js     # Safe path boundary checker
│   │   └── guard.js              # SecurityGuard class
│   ├── tools/
│   │   ├── read_file.js          # Tool: read file content
│   │   ├── write_file.js         # Tool: write file atomically
│   │   ├── patch_file.js         # Tool: search-and-replace patch
│   │   ├── list_dir.js           # Tool: directory explorer
│   │   ├── execute_command.js    # Tool: shell command executor
│   │   └── registry.js           # Tool registry & Gemini schemas
│   ├── llm/
│   │   ├── gemini.js             # Gemini API client (pure fetch)
│   │   ├── stream-parser.js      # SSE stream parser
│   │   ├── retry.js              # Exponential backoff retry
│   │   └── types.js              # Message type factories
│   ├── agent/
│   │   ├── orchestrator.js       # ReAct loop orchestrator
│   │   ├── session.js            # Session manager & persistence
│   │   ├── pruner.js             # Context token pruning
│   │   └── system-prompt.js      # System instruction builder
│   ├── ui/
│   │   ├── markdown.js           # ANSI Markdown renderer
│   │   ├── spinner.js            # Live terminal spinner
│   │   └── box.js                # Terminal box & banner
│   └── utils/
│       ├── ansi.js               # ANSI color helpers
│       ├── logger.js             # Logger utility
│       └── termux.js             # Termux environment detection
├── tests/
│   ├── step1-*.test.js           # Unit tests: Foundation & Config
│   ├── step2-*.test.js           # Unit tests: Security & Tools
│   ├── step3-*.test.js           # Unit tests: LLM & Streaming
│   ├── step4-*.test.js           # Unit tests: ReAct & Session
│   ├── step5-*.test.js           # Unit tests: REPL & UI
│   └── e2e/
│       ├── e2e-self-healing.test.js  # E2E: Bug fix loop
│       ├── e2e-piping.test.js        # E2E: UNIX pipe workflow
│       └── e2e-session-resume.test.js # E2E: Session persistence
├── scripts/
│   ├── benchmark.js              # Performance benchmark
│   └── test-e2e.js               # E2E test runner
├── plans/                        # Development plan documents
├── install.sh                    # One-command installer
├── package.json
└── README.md
```

---

## 🔌 CLI Reference

```
Usage: faycli [OPTIONS] [PROMPT]

MODES:
  faycli                          Start interactive REPL
  faycli "PROMPT"                 Single-shot task execution
  cat file | faycli "INSTRUCTION" UNIX stdin pipe analysis
  faycli resume SESSION_ID        Resume saved session

PROVIDER COMMANDS:
  faycli provider list            List configured providers
  faycli provider use <id>        Set active provider (persist)
  faycli provider add <id>        Add or update provider settings
  faycli provider remove <id>     Remove a custom provider
  faycli provider show [id]       Show provider config as JSON

MODEL COMMANDS:
  faycli model --list             List models for the active provider
  faycli model --list --all       List models for ALL providers
  faycli model --list --provider <id>   List models for a specific provider
  faycli model --set <name>       Set the active model and persist
  faycli model --set <name> --provider <id>  Set model for a specific provider
  faycli model --add <name[,..]>  Add model(s) to a provider's catalog (no switch)
  faycli model --remove <name>    Remove a model from the catalog
  faycli model --clear            Reset a provider's catalog to builtin defaults
  faycli add <name>               Shortcut for `faycli model --add`
  faycli remove <name>            Shortcut for `faycli model --remove`
  faycli clear                    Shortcut for `faycli model --clear`
  (in REPL) /model                  Interactive picker (TTY) or static box (non-TTY)
  (in REPL) /model <name>           Set the active model from the REPL

CONFIG COMMANDS:
  faycli config list              List all configuration
  faycli config get KEY           Get config value
  faycli config set KEY VALUE     Set config value
  faycli config delete KEY        Reset key to default
  faycli config reset             Reset all to defaults
  faycli session list             List saved sessions
  faycli session delete SESS_ID   Delete a session
  faycli session clear            Delete all sessions

OPTIONS:
  -p, --provider ID                 One-shot provider override (does NOT persist — use `provider use` to persist)
  -m, --model MODEL                 One-shot model override (does NOT persist — use `model --set` to persist)
  -k, --api-key KEY                 Override API key for this run
  -s, --session SESSION_ID          Resume or attach session
  -y, --yes                         Auto-approve all security prompts
  --verbose                         Enable verbose debug output
  --config-dir PATH                 Custom config directory
  --help                            Show this help message
  --version                         Show version number

ENVIRONMENT VARIABLES:
  GEMINI_API_KEY                    Gemini API key
  OPENAI_API_KEY                    OpenAI API key
  OPENAI_BASE_URL                   Custom OpenAI endpoint base URL
  OPENAI_MODEL                      Default OpenAI model
  FAYCLI_API_KEY                  Fallback Gemini API key (legacy: T_AI_API_KEY)
  FAYCLI_CONFIG_DIR               Override config directory path (legacy: T_AI_CONFIG_DIR)
```

---

## 🔍 Troubleshooting

### "Gemini API key is not configured"

```bash
# Set via CLI
faycli config set apiKey YOUR_KEY

# Or export (add to ~/.bashrc)
export GEMINI_API_KEY="YOUR_KEY"
```

### "Permission denied" on bin/faycli.js

```bash
chmod +x bin/faycli.js
```

### "faycli command not found" after install

```bash
# Reload PATH
hash -r
# Or restart terminal

# Verify npm global bin is in PATH
echo $PATH | tr ':' '\n' | grep -i npm

# On Termux, check:
ls $PREFIX/bin/faycli
```

### Slow startup on Android

Termux Node.js startup can be slow on older devices. This is a system limitation. To improve:
```bash
# Use node with optimizations
node --jitless bin/faycli.js  # Reduces JIT warmup time on ARM
```

### Rate limit errors (HTTP 429)

The retry module automatically handles 429 responses with exponential backoff (up to 3 retries). If rate limiting persists:
```bash
faycli config set model gemini-1.5-flash  # Use a less-limited model
```

### Context too long / token limit exceeded

```bash
# Clear session and start fresh
faycli session clear

# Or use in REPL:
/clear
```

---

## 📄 License

MIT License — see [LICENSE](./LICENSE) for details.

---

## 🙏 Credits

Built with ❤️ for the Android Termux developer community.

- **Runtime**: [Node.js](https://nodejs.org/) (ESM, zero native deps)
- **AI**: [Google Gemini API](https://aistudio.google.com/)
- **Platform**: [Termux](https://termux.dev/)
- **Author**: FAYnim
