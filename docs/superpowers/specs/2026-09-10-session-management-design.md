# Interactive Session Management & Switching Design Specification

**Date**: 2026-09-10  
**Feature**: Interactive Session Management & Switching (OpenCode-like Session Switcher)  
**Status**: Approved (Ready for Implementation Planning)  
**Scope**: FAY-CLI Core (`src/agent/session.js`, `src/ui/session-menu.js`, `src/cli/slash-commands.js`, `src/cli/repl.js`, `bin/faycli.js`)

---

## 1. Overview & Goals

FAY-CLI currently persists session turns to disk under `~/.faycli/sessions/<id>.json` and supports resuming past sessions via CLI flag `faycli resume <id>` or starting fresh via `/new`. However:
1. Session IDs are random alphanumeric strings (`sess_177328919_a8b9c`), making it difficult to identify conversation context without inspecting disk files.
2. Users cannot switch sessions from within an active REPL session; they must exit and restart the CLI.
3. Users cannot easily browse and pick from past sessions without manually running `faycli session list` and copy-pasting an ID.

This specification defines an **OpenCode-inspired interactive session management and switching system** with:
- **In-REPL interactive keyboard-driven picker** (`/session` or `/resume`) with arrow navigation, search/scope toggling, rename, and delete actions.
- **Automatic session titling** from the first user prompt, plus manual `/session rename <title>`.
- **Project/Workspace scoping by default**, keeping sessions organized per project while allowing global toggles (`a`).
- **Seamless REPL context switching with recent history replay**, auto-saving the previous session and rendering the last 2-3 turns of the newly activated session.
- **Shell-level interactive resume** (`faycli resume` without arguments opens the picker on startup).

---

## 2. User Experience & Workflows

### 2.1 In-REPL Interactive Session Picker
When a user enters `/session` or `/resume` in the interactive REPL:
1. If the terminal is an interactive TTY:
   FAY-CLI pauses normal prompt input and renders the interactive TUI session picker:
   ```text
   ⚡ Select a session  (↑/↓ navigate • Enter switch • a toggle all • r rename • d delete • Esc cancel)
   Scope: Current Project (/home/user/my-project) [3 sessions found]

     ▸ ● Fix login authentication bug (active)
         sess_177328919_a8b9c · 8 msgs · 14.2k tok · 5m ago
       ○ Refactor database connection pool
         sess_177327110_b4e2a · 18 msgs · 32.1k tok · 2h ago
       ○ Setup initial biome linter & CI
         sess_177321004_c1f9e · 4 msgs · 6.8k tok · yesterday
   ```
2. Keybindings inside the picker:
   - `↑` / `k` and `↓` / `j`: Move selection up/down.
   - `Enter`: Switch to the selected session immediately.
   - `Esc` / `q`: Exit picker and return to the REPL without changing session.
   - `a`: Toggle scope between "Current Project" and "All Projects".
   - `r`: Prompt inline to rename the selected session title.
   - `d`: Delete the selected session (prompts `Delete this session? (y/n)`).
   - `n`: Start a brand new session directly from the picker.
3. If not an interactive TTY (e.g. piped or automated):
   Fallback to rendering a structured text box listing recent sessions without raw mode.

### 2.2 History Replay on Session Switch
Once a session is selected:
1. Current active session state is saved to disk atomically (`oldSession.save()`).
2. The new session is loaded and attached to the active orchestrator.
3. Terminal displays a clear transition header card:
   ```text
   ✔ Switched to session: "Fix login authentication bug" (sess_177328919_a8b9c)
   Model: gemini-2.5-flash · Turns: 8 · Tokens: ~14,200
   ─────────────────────────────────────────────────────────────
   Recent conversation history:

   ❯ Can you inspect why login with OAuth fails on redirect?
   I found that the OAuth callback handler in src/auth/oauth.js was missing the state parameter check...
   ```
4. REPL turn counters (`turnCount`, `lastIterations`) and usage monitors are synchronized with the loaded session.

### 2.3 Automatic Session Titling & Renaming
- When the first user prompt is dispatched in a session without a custom title:
  - Extract the first user message text.
  - Sanitize whitespaces/newlines and strip leading system flags.
  - Truncate cleanly to 45-50 characters at word boundary.
  - Set as `session.title`.
- Users can manually rename anytime using:
  - `/session rename <New Title>` inside REPL.
  - Pressing `r` inside the interactive session picker.

### 2.4 Command Routing Summary
| Command / Input | Behavior |
| :--- | :--- |
| `/session` | Opens interactive session picker (TTY) or prints summary list (non-TTY) |
| `/resume` | Alias to `/session` (opens picker) |
| `/session info` or `/session stats` | Displays the detailed status card of the currently active session |
| `/session switch <id>` or `/resume <id>` | Immediately switches to the given session ID without opening the picker |
| `/session rename <title>` | Renames the currently active session title |
| `/session list` | Prints plain text list of saved sessions |
| `/session delete <id>` | Deletes the specified session from storage |
| `faycli resume` (CLI shell) | Opens the interactive session picker on startup if no session ID argument is passed |

---

## 3. Architecture & Technical Design

### 3.1 Session Data Model (`src/agent/session.js`)
#### Class `Session` Updates:
- Add property `this.title = data.title || null;`
- Update `toJSON()` to include `title: this.title`.
- Implement `setTitle(title)`:
  ```js
  setTitle(title) {
    this.title = typeof title === 'string' ? title.trim() : null;
    this.touch();
  }
  ```
- Implement `ensureTitle(firstPrompt)`:
  If `!this.title`, generates a clean title from `firstPrompt`:
  - Strips markdown formatting, newlines, and prompt prefixes.
  - Cuts at word boundary up to ~45 chars, appending `…` if truncated.

#### Class `SessionManager` Updates:
- Enhance `listSessions({ workingDir, all = false })`:
  - Scans files in `this.getSessionsDir()`.
  - Parses each session safely. Corrupted files are caught and logged at debug level, not crashing the list.
  - Reads metadata: `id`, `title`, `createdAt`, `updatedAt`, `model`, `provider`, `workingDir`, `messageCount`, `lastMessagePreview`, `totalTokens`.
  - If `all === false` and `workingDir` is specified, filters sessions where `session.workingDir === workingDir` or normalized paths match.
  - Sorts sessions descending by `updatedAt`.
- Implement `renameSession(sessionId, newTitle)`:
  - Loads session, sets title, saves atomically to disk.

### 3.2 Interactive TUI Session Picker (`src/ui/session-menu.js`)
- Modelled after `src/ui/model-menu.js`:
  - Pure Node.js standard libraries (`readline`, `process.stdin`, `process.stdout`), zero native dependencies.
  - ANSI colors and unicode glyphs (`▸`, `●`, `○`).
  - Supports Termux, Linux, macOS, and Windows terminal emulators.
- Manages local menu state:
  - `items`: List of session summary objects.
  - `selectedIndex`: Currently highlighted session index.
  - `showAll`: Boolean toggle for project-scoped vs all projects.
  - `mode`: Normal navigation vs inline renaming vs inline deletion confirmation.
- Output: Returns `{ cancelled: boolean, action: 'switch' | 'new' | 'none', sessionId?: string }`.

### 3.3 Slash Commands Integration (`src/cli/slash-commands.js`)
- Update `case 'session':` and add `case 'resume':`:
  - Subcommands: `info`, `stats`, `list`, `rename`, `switch`, `delete`.
  - When invoked with no args or when action is `switch`:
    - Check TTY. If interactive TTY, call `showSessionMenu({ sessionManager, activeSession, workingDir, input, stream })`.
    - If user selected a session:
      - Emit action `switch_session` with `targetSessionId`.
- Handle session transition in REPL context:
  - Auto-save old session.
  - Load target session.
  - Call `orchestrator.setSession(targetSession)`.
  - Synchronize orchestrator model & provider if session was bound to a specific model.
  - Return `{ handled: true, action: 'switch_session', session: targetSession }`.

### 3.4 REPL Transition & History Replay (`src/cli/repl.js`)
- In `repl.js`, handle `slashResult.action === 'switch_session'`:
  - Update `turnCount = newSession.messages.length`.
  - Reset `lastIterations = 0`.
  - Render session switch banner with `renderBox` / `ansi`.
  - Extract the last 2-3 message turns from `newSession.messages`:
    - Render user prompts with cyan bold prompt styling.
    - Render assistant model responses using `renderMarkdown`.
  - Resume REPL prompt cleanly.

### 3.5 Shell CLI Entrypoint (`bin/faycli.js`)
- When `parsed.command === 'resume'`:
  - If `parsed.subcommand` is present: load session directly as before.
  - If `parsed.subcommand` is omitted (i.e. `faycli resume` called directly):
    - Check TTY. If interactive TTY, display `showSessionMenu`.
    - If user picks a session, resume it.
    - If user cancels, exit cleanly (0).
    - If no saved sessions exist, log helpful message and start new session.

---

## 4. Error Handling & Edge Cases

1. **Corrupted Session Files**:
   - `SessionManager.listSessions` wraps JSON parsing in try/catch. Damaged files are skipped with a debug warning and never crash the menu.
2. **Session Provider Mismatch**:
   - If a resumed session was recorded with a provider (e.g. `openai`) that has no API key configured in current environment, warn user and offer fallback to active configured provider.
3. **Switching to Current Active Session**:
   - Picker highlights `(active)`. If selected, picker closes and indicates the session is already active without redundant disk reload.
4. **Empty / Fresh Sessions**:
   - Fresh sessions without messages display `(New Untitled Session)` as placeholder title.
5. **Terminal Resize & Raw Mode Cleanup**:
   - Menu registers clean exit handlers for SIGINT, ensuring `input.setRawMode(false)` is always executed on exit or crash.

---

## 5. Verification & Testing Strategy

### 5.1 Unit Tests (`tests/session-management.test.js`)
- **Title Extraction**:
  - Test `ensureTitle()` on multiline input, long text (>100 chars), markdown backticks, and single-word prompts.
  - Test `setTitle()` persists across `save()` and `load()`.
- **Session Scoping & Listing**:
  - Create multiple dummy sessions across different `workingDir` paths.
  - Verify `listSessions({ workingDir, all: false })` only returns sessions matching the current directory.
  - Verify `listSessions({ all: true })` returns all sessions sorted by `updatedAt` descending.
- **Slash Commands**:
  - Test `/session rename <title>` updates `orchestrator.session.title`.
  - Test `/session info` outputs stats card.
  - Test `/session switch <id>` handles nonexistent ID gracefully.
- **TUI Picker Non-TTY Fallback**:
  - Test that `showSessionMenu` returns gracefully when non-TTY stream is supplied.

### 5.2 Manual End-to-End Verification
1. Start `node bin/faycli.js`.
2. Ask a question: "Analyze package.json and summarize dependencies".
3. Check that the session is automatically titled (e.g. "Analyze package.json and summarize dependencies").
4. Run `/session` -> verify interactive picker shows the session marked as `(active)`.
5. Start `/new` session -> ask a different question: "Write a hello world script".
6. Run `/session` -> navigate to the first session using arrow keys -> press `Enter`.
7. Verify:
   - Header shows switch confirmation.
   - 2-3 previous turns are replayed in terminal.
   - New prompt continues from the resumed session context.
8. Exit CLI, run `node bin/faycli.js resume` without arguments -> verify interactive picker appears on CLI launch.
