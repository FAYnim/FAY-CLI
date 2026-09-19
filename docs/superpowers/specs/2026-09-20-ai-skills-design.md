# Design Specification: AI Skills System (skills.sh compatible)

- **Date:** 2026-09-20
- **Status:** Approved
- **Topic:** Open Agent Skills Specification, Discovery, Installation, and Dual-Activation in FAY-CLI

## 1. Overview & Motivation

AI agents often require specialized, domain-specific procedural guidelines to produce high-quality work (e.g., UI/UX styling rules, test-driven development workflows, customer research methodologies, API integrations). While general-purpose prompts provide basic assistance, agent skills package expert workflows into structured, reusable capabilities.

The open agent skills ecosystem (popularized by [skills.sh](https://skills.sh/), `vercel-labs/skills`, and compatible tools across Antigravity, Claude Code, Cursor, and Codex) standardizes skills as directories containing a `SKILL.md` file with YAML frontmatter metadata and Markdown instructions.

This specification integrates **AI Skills** into FAY-CLI:
1. **Open Standard Compatibility**: Full support for the `SKILL.md` format, enabling FAY-CLI to consume public and custom skill packs from [skills.sh](https://skills.sh/) and GitHub.
2. **Dual-Tier Scope & Priority**: Support for project-level skills (`.agents/skills/` or `.fay/skills/`) and user global skills (`~/.agents/skills/` or `~/.fay/skills/`), with project-level precedence.
3. **Token-Efficient Discovery & Injection**: Injects only a concise `<available_skills>` catalog into the system prompt. Instructions are loaded on-demand to conserve context window.
4. **Dual Activation**:
   - **Autonomous (Agentic)**: The agent calls a built-in `load_skill` tool when task requirements match a skill's description.
   - **Explicit (User)**: Users can trigger skills directly via `@skill:<name>` mentions or `/skill use <name>`.
5. **Hybrid Installation & Management**: Built-in CLI commands (`/skill add`, `/skill list`, `/skill remove`, `/skill info`) that can fetch skills directly via lightweight HTTPS (Termux-friendly) or delegate to `npx skills add`.

---

## 2. Architecture & Component Workflow

```
               ┌────────────────────────────────────────┐
               │         Skill Sources & Repos          │
               │  (skills.sh / GitHub / Local Folders)  │
               └───────────────────┬────────────────────┘
                                   │
                           /skill add <source>
                                   ▼
               ┌────────────────────────────────────────┐
               │       src/skills/installer.js          │
               │   (HTTPS Tarball / Raw / npx fallback) │
               └───────────────────┬────────────────────┘
                                   │
             ┌─────────────────────┴─────────────────────┐
             ▼                                           ▼
  Project: ./.agents/skills/                   Global: ~/.agents/skills/
  (or ./.fay/skills/)                         (or ~/.fay/skills/)
             │                                           │
             └─────────────────────┬─────────────────────┘
                                   │
                                   ▼
               ┌────────────────────────────────────────┐
               │      src/skills/skill-manager.js       │
               │  (Scan directories, parse YAML header, │
               │   deduplicate with project precedence) │
               └───────────────────┬────────────────────┘
                                   │
         ┌─────────────────────────┼─────────────────────────┐
         ▼                         ▼                         ▼
[src/agent/system-prompt.js] [src/tools/load_skill.js] [src/agent/mention-parser.js]
Injects concise catalog:     Tool for agent to load    Resolves @skill:<name>
<available_skills>           full SKILL.md on-demand   in user prompt directly
```

---

## 3. Detailed Specifications

### 3.1 Skill Folder Format (`SKILL.md`)

Each skill resides in its own directory named after the skill:
```text
<skill-name>/
├── SKILL.md          # Required: YAML frontmatter + procedural markdown
├── scripts/          # Optional: Helper executable scripts
├── references/       # Optional: Detailed guides, cheat sheets, or manuals
└── assets/           # Optional: Static templates, examples, diagrams
```

#### Frontmatter Structure:
```markdown
---
name: frontend-design
description: "Create distinctive, production-grade frontend interfaces with high design quality. Use when user asks to build UI components, landing pages, or styling web apps."
version: 1.0.0
author: anthropics
---

# Frontend Design Guidelines
[Detailed procedural rules and best practices...]
```

### 3.2 Storage Hierarchy & Resolution

FAY-CLI checks for skills in the following order:
1. **Project Directory**:
   - `<projectRoot>/.agents/skills/<skill-name>/`
   - `<projectRoot>/.fay/skills/<skill-name>/`
2. **Global Directory**:
   - `<userHome>/.agents/skills/<skill-name>/`
   - `<userHome>/.fay/skills/<skill-name>/`

**Precedence Rule:** If a skill with the same `name` exists in both Project and Global locations, the **Project** version overrides the Global version.

### 3.3 Skill Discovery (`src/skills/skill-manager.js`)

The `SkillManager` module provides:
- `discoverSkills({ projectRoot, homeDir })`: Scans both scopes, parses YAML frontmatter using a zero-dependency parser, and returns an array of skill metadata objects:
  ```js
  {
    name: string,
    description: string,
    version?: string,
    author?: string,
    scope: 'project' | 'global',
    dirPath: string,
    skillFilePath: string
  }
  ```
- `getSkill(name, { projectRoot, homeDir })`: Retrieves a specific skill by name, adhering to the precedence rule.
- `loadSkillContent(name, { projectRoot, homeDir })`: Reads the full markdown content of the skill (excluding frontmatter) and enumerates any helper files in `scripts/` or `references/`.

### 3.4 System Prompt Injection (`src/agent/system-prompt.js`)

When skills are detected, FAY-CLI appends a lightweight `<available_skills>` block to the system prompt:

```markdown
### AVAILABLE SKILLS:
The following skills are installed and provide specialized procedures.
When the user request matches a skill's description, invoke the `load_skill` tool with the skill's name to retrieve its full instructions before taking action.

- **frontend-design** (project): Create distinctive, production-grade frontend interfaces with high design quality. Use when user asks to build UI components, landing pages, or styling web apps.
- **brainstorming** (global): Explores user intent, requirements, and design before implementation. Use before any creative work.
```

### 3.5 Runtime Execution & Dual-Activation

1. **Autonomous Activation via `load_skill` Tool (`src/tools/load_skill.js`)**:
   - **Tool Name**: `load_skill`
   - **Parameters**: `{ skill_name: string }`
   - **Behavior**: Retrieves the skill via `SkillManager.loadSkillContent(skill_name)`. Returns the formatted procedural instructions, plus references to any bundled scripts or assets.
2. **Explicit User Activation via `@skill:<name>` Mention**:
   - In `src/agent/mention-parser.js`, tokens matching `@skill:([a-zA-Z0-9_-]+)` are extracted.
   - The parser loads the corresponding `SKILL.md` and appends a `[Skill Context: <name>]` block directly into the user message payload before sending to the LLM.
   - The clean prompt in terminal UI displays the user input without the large injected block.
3. **REPL Autocomplete (`src/cli/autocomplete.js`)**:
   - When the user types `@skill:`, the REPL autocompletes available skill names with Tab completion.

### 3.6 Skill Installer & Management (`src/skills/installer.js` & `src/cli/slash-commands.js`)

#### Installer Capabilities:
- **GitHub Shorthand**: `owner/repo` (e.g. `anthropics/skills` or `mattpocock/skills`).
- **Sub-skill Selection**: `owner/repo --skill <name>`.
- **Download Strategy**:
  - Primary: Pure Node.js HTTPS fetch of repository tarball or raw GitHub content (fast, minimal RAM, ideal for Termux).
  - Optional flag `--via-npx`: Delegates to `npx skills add <source>`.
- **Target Flag**:
  - Default: Installs to `./.agents/skills/<name>`.
  - `--global` / `-g`: Installs to `~/.agents/skills/<name>`.

#### Commands:
- REPL Slash Command:
  - `/skill` / `/skill help`: Shows available subcommands.
  - `/skill list`: Lists installed skills (name, scope, author, description).
  - `/skill add <source> [--global] [--skill <name>]`: Installs a skill.
  - `/skill remove <name> [--global]`: Deletes a skill.
  - `/skill info <name>`: Displays skill frontmatter and preview.
  - `/skill use <name>`: Manually activates a skill for the next turn.
- Standalone CLI:
  - `faycli skill list`
  - `faycli skill add <source> [-g]`
  - `faycli skill remove <name>`

---

## 4. Error Handling & Safety

1. **Malicious / Corrupt Skills**:
   - Frontmatter parsing uses safe string/regex splitting without `eval()` or dangerous YAML deserializers.
   - Skill names are validated against path traversal (`../` or invalid characters).
2. **Missing or Incomplete Skills**:
   - If a skill folder lacks `SKILL.md`, it is gracefully ignored with an optional debug warning.
   - If `load_skill` is called with an unknown skill name, it returns a helpful error list of currently installed skills.
3. **Network / Offline Failures**:
   - Installer validates HTTP status codes and reports clear user messages if the repository or network is unreachable.

---

## 5. Testing & Verification Strategy

1. **Unit Tests**:
   - `tests/skills-manager.test.js`: Test discovery, frontmatter parsing, project-vs-global resolution, and content loading.
   - `tests/skills-installer.test.js`: Test source parsing (GitHub shorthand, sub-skill flags), directory creation, and mock download.
   - `tests/tool-load-skill.test.js`: Test `load_skill` tool execution, parameter validation, and missing skill fallback.
   - `tests/mention-skill.test.js`: Test `@skill:<name>` parsing and context injection into user prompts.
2. **Integration Tests**:
   - Verify prompt construction in `system-prompt.js` with installed skills.
   - Test REPL autocomplete for `@skill:`.
   - Verify `/skill list`, `/skill info`, and `/skill remove` lifecycle.
