# Design Specification: File Mention (@) Autocomplete & Context Injection

- **Date:** 2026-09-20
- **Status:** Approved
- **Topic:** Interactive File Mention Autocomplete and Prompt Context Injection

## 1. Overview & Motivation

When interacting with AI coding CLIs (e.g. Cursor, Claude Code, Aider), users frequently refer to specific project files in their prompts. Manually typing full relative paths is error-prone, and waiting for the agent to make a tool call round-trip (`read_file`) consumes unnecessary API tokens, round-trip latency, and ReAct iterations.

This feature provides:
1. **Interactive File Mention Autocomplete:** Typing `@` in the interactive REPL displays a matching file popup that can be navigated with Up/Down arrow keys and inserted with Tab or Enter.
2. **Hybrid Search Matching:** Typing `@<filename>` executes a fast fuzzy/substring search across the entire project workspace, while typing `@<dir>/` provides hierarchical directory-by-directory drilldown.
3. **Prompt Context Injection:** When a prompt containing `@path/to/file` is submitted, FAY-CLI safely reads the file contents and injects them as structured XML context blocks (`<context_file path="...">`) into the user message payload sent to the LLM. The terminal UI displays the original clean prompt so the session view remains uncluttered.

---

## 2. Architecture & Component Boundaries

The implementation adheres to FAY-CLI's zero-dependency philosophy, running purely on Node.js standard libraries (`node:fs`, `node:path`, `node:readline`).

```
[REPL Keypress] ───────> [src/cli/autocomplete.js]
                               │
                        (Query candidates)
                               ▼
                    [src/utils/file-index.js] (In-memory cached workspace walk)
                               │
                               ▼
                    [src/ui/prompt-editor.js] (Terminal popup rendering: Up/Down/Tab)
                               │
[User Hits ENTER] ─────────────┘
         │
         ▼
[src/agent/mention-parser.js] (Extract @file tokens, read safely with guardrails)
         │
         ├──> cleanPrompt: Recorded for terminal display & session history
         └──> injectedPrompt: Sent to LLM with <context_file path="..."> blocks
                  │
                  ▼
[src/agent/orchestrator.js] (ReAct loop with pre-loaded file context)
```

### Component Roles

1. **`src/utils/file-index.js`**
   - **Responsibility:** Discovers and maintains a cached list of workspace files for fast matching.
   - **Performance & Constraints:**
     - Uses `src/utils/fs-walk.js` to traverse the workspace.
     - Respects ignore lists: `.git`, `node_modules`, `.faycli`, `.env*`, and binary extensions (`.png`, `.jpg`, `.zip`, `.bin`, `.exe`, `.tar`, `.gz`, etc.).
     - Caches file paths in memory with a 30-second TTL (Time-To-Live).
     - Caps index at 5,000 files to preserve low memory overhead on Android Termux.
   - **API:**
     - `getWorkspaceFiles(workingDir, options)`: Returns array of relative file paths.
     - `searchWorkspaceFiles(prefix, workingDir, options)`: Performs case-insensitive substring and boundary scoring, returning top matches.
     - `clearFileIndexCache()`: Clears the in-memory cache.

2. **`src/cli/autocomplete.js`**
   - **Responsibility:** Pure suggestion calculation based on prompt buffer and cursor index.
   - **Hybrid Routing:**
     - Checks if token starts with `@` preceded by space or start-of-line.
     - If the token contains `/` (e.g. `@src/cli/`), delegates to direct hierarchical directory listing.
     - If the token does not contain `/` (e.g. `@repl`), calls `searchWorkspaceFiles` from `file-index.js` to return matching relative file paths across the repo.
   - **API:**
     - `getSuggestions(text, cursor, ctx)`: Returns `{ kind: 'file', items, replaceStart, replaceEnd, dir }`.

3. **`src/ui/prompt-editor.js`**
   - **Responsibility:** Interactive terminal popup rendering and key handling.
   - **Behavior:**
     - Displays up to 8 items in the dropdown.
     - Displays `@workspace` header for global fuzzy search, or `@dir/` for hierarchical mode.
     - `up` / `down`: Cycles through active suggestions.
     - `tab`: Inserts selected file path with a trailing space (or trailing slash if directory).
     - `enter`: If suggestion is active and partial, completes the selection; if already full match or no popup, submits the prompt.
     - `escape`: Dismisses popup without altering text.

4. **`src/agent/mention-parser.js`**
   - **Responsibility:** Extracts mentioned files, validates existence, enforces security guardrails, and attaches file contents.
   - **Guardrails:**
     - Ignores email-like tokens (e.g., `test@example.com`).
     - Normalizes Windows backslashes `\` to POSIX `/`.
     - Validates file exists and is within `workingDir` (using path boundary validator).
     - Skips directories and binary files.
     - Max file size: 50 KB (or ~1,000 lines). Files exceeding this limit are truncated with an informative note `[... content truncated: exceeds 50KB limit]`.
     - Multi-file limit: Maximum 5 files per turn (or 150 KB aggregate) to protect context token budget.
   - **API:**
     - `parseMentions(text)`: Returns list of mentioned file paths.
     - `expandMentions(text, { workingDir })`: Returns `{ cleanPrompt: string, injectedPrompt: string, attachedFiles: string[] }`.

5. **`src/cli/repl.js` & `src/agent/orchestrator.js`**
   - **Integration:**
     - When prompt is submitted in `repl.js`, calls `expandMentions`.
     - If files are attached, outputs a subtle terminal indicator: `📎 Attached 1 file: src/cli/repl.js`.
     - Passes `injectedPrompt` into `orchestrator.runTurn(injectedPrompt, { displayPrompt: cleanPrompt })`.
     - Orchestrator records `cleanPrompt` in session user message view, but feeds `injectedPrompt` to the LLM turn contents.

---

## 3. Data Formats & Protocols

### Injected XML Format
```xml
User prompt text here...

<context_file path="src/cli/repl.js">
// Actual file content goes here
</context_file>
```

When multiple files are mentioned:
```xml
Compare these two files:

<context_file path="src/cli/repl.js">
...
</context_file>

<context_file path="src/cli/autocomplete.js">
...
</context_file>
```

---

## 4. Error Handling & Edge Cases

1. **Non-existent file:**
   - If user types `@nonexistent.js` and submits, `mention-parser.js` leaves the token unchanged and does not attach a `<context_file>` block. No error is thrown.
2. **Binary files:**
   - If user mentions `@image.png`, the system skips the raw binary content and inserts:
     `<context_file path="image.png">[Binary file omitted]</context_file>`.
3. **Disk I/O latency in Android Termux:**
   - In-memory cache with 30-second TTL prevents repeated filesystem scans during fast typing.
   - Recursive walk caps entries at 5,000 to prevent event loop blocking.
4. **Non-TTY fallback:**
   - When running in non-TTY mode (piped input, CI test suites), `prompt-editor.js` continues to use standard readline fallback without crashing.

---

## 5. Testing & Verification Plan

### Automated Unit Tests (`npm test`)
- `tests/file-index.test.js`:
  - Verify workspace traversal and ignore filters (`node_modules`, `.git`, binary files).
  - Verify cache hit behavior within TTL and cache expiration after TTL.
  - Verify cap limit (5,000 entries).
  - Verify `searchWorkspaceFiles` ranking (exact basename match scored higher than deep nested match).
- `tests/autocomplete.test.js`:
  - Test `@` prefix triggers global search when no slash present.
  - Test `@dir/` triggers hierarchical folder completion.
  - Test that email addresses (`name@domain.com`) do not trigger file autocomplete.
- `tests/mention-parser.test.js`:
  - Test token extraction and path normalization.
  - Test safe file reading, size capping (>50KB truncation), and binary detection.
  - Test XML wrapping format and preservation of clean prompt.
- `tests/repl-mention.test.js`:
  - Integration test verifying that a prompt containing `@file` passes injected context to the orchestrator turn.

### Manual Verification
1. Launch CLI: `node bin/faycli.js`.
2. Type `@` — verify popup appears with project files.
3. Type `@repl` — verify selection highlights `src/cli/repl.js`.
4. Press `Tab` — verify path is inserted with trailing space.
5. Send message: `"Ringkas fungsi startRepl di @src/cli/repl.js"` — verify model answers immediately with knowledge of `startRepl` without calling `read_file` tool.
