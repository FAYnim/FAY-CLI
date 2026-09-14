# Security Policy

## Reporting a Vulnerability

faycli grants an LLM shell access. If you find a security vulnerability, report it
privately — do not open a public issue. Open a private security advisory on GitHub or
contact the maintainers directly.

Please include:
- Steps to reproduce
- Affected version
- Impact description

## Security Model

Protection lives in `src/security/rules.js`, `src/security/guard.js`, and
`src/security/path-validator.js`:

- Regex blacklist of dangerous commands — bypassable, treated as last line, not a boundary
- `HARD_LIMITS`: 2000-char command cap, null-byte guard
- `OBFUSCATION_PATTERNS`: hex escapes, base64-to-shell, eval
- `PROTECTED_PATH_PATTERNS`: hard-blocks `/`, `/*`, `~`/`~/...`, `$HOME`, `%USERPROFILE%`, `$env:USERPROFILE`, and system dirs (`/etc`, `/boot`, `/var`, `/root`, `/usr`, `/bin`, `/sbin`, `/lib`, `/sdcard`, `/storage`, `C:\Windows`, `C:\Program Files`) — with path tails (`/etc/crontab` now caught), regardless of verb or `-y`.
- `command-paths.js`: tokenizes command text (quote-aware) and prompts HITL before any unquoted path token resolves outside the jail.
- Path validation restricts writes to the safe workspace; `security.allowTermuxStorage`
  is opt-in (`faycli config set security.allowTermuxStorage true`)

OS-level sandboxing (privilege drop, chroot/jail) is **not** implemented. Treat the agent
as capable of arbitrary code execution on your account.