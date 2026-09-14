/**
 * Security Rules & Pattern Definitions for FAY CLI (`faycli`)
 */

/**
 * SEC-03: Hard limits applied to every command before pattern checks.
 * Length cap blocks obfuscation-via-padding; null-byte check blocks
 * truncation attacks where `\0` makes the shell see a different command
 * than what the security guard inspected.
 */
export const HARD_LIMITS = {
  maxCommandLength: 2000,
  maxTokenLength: 256,
};

/**
 * SEC-03: Obfuscation patterns. Matched commands are rejected even if
 * they slip past the blacklist. Covers hex escapes, base64-piped-to-shell,
 * reversed-string tricks, and eval.
 */
export const OBFUSCATION_PATTERNS = [
  // ANSI-C hex/octal escapes: $'\x72m' or $'\101'
  /\$\\['"][xX][0-9a-fA-F]{2}/,
  /\$\\['"][0-7]{1,3}['"]/,
  // printf with hex/octal escapes piped to a shell
  /\bprintf\s+.*\\x[0-9a-fA-F]{2}.*\|/i,
  // Base64 decoded to shell
  /\bbase64\s+(?:-d|--decode)\b.*\|\s*(bash|sh|zsh|dash|ksh)\b/i,
  // Eval of any string
  /\beval\s+/i,
];

/**
 * SEC-03 / H-1: Path-based destructive guards. Any command that targets
 * these paths is rejected regardless of verb (`find / -delete`, etc.).
 * H-1 fix: the old patterns required the char AFTER the path to be a
 * space/`;`/`&`, so `~/.bashrc` and `/etc/crontab` slipped through — the
 * tail group `(?:\/[^\s;&|><"']*)?` now allows a path suffix. Prefix class
 * includes shell separators AND quotes so `">>/etc/x` matches too.
 * `/home` is intentionally NOT listed (user jails live there); out-of-jail
 * absolute paths are handled by command-paths.js instead.
 */
export const PROTECTED_PATH_PATTERNS = [
  // bare `/` atau `/*`
  /(^|[\s;&|><"'(])\/\*(?=$|[\s;&|><"'])/i,
  /(^|[\s;&|><"'(])\/(?=$|[\s;&|><"'])/i,
  // home shortcut: `~` atau `~/...` (tidak kena `HEAD~1`, tidak kena `~user`)
  /(^|[\s;&|><"'(])~(?![\w-])(?:[/\\][^\s;&|><"']*)?/i,
  // $HOME / ${HOME} (+ tail)
  /(^|[\s;&|><"'(])\$\{?(?:HOME|USERPROFILE)\}?(?![\w])(?:[/\\][^\s;&|><"']*)?/i,
  // %USERPROFILE% / %HOME% Windows (+ tail)
  /(^|[\s;&|><"'(])%(?:USERPROFILE|HOME)%(?![\w])(?:[/\\][^\s;&|><"']*)?/i,
  // $env:USERPROFILE PowerShell (+ tail)
  /(^|[\s;&|><"'(])\$env:(?:HOME|USERPROFILE)(?![\w])(?:[/\\][^\s;&|><"']*)?/i,
  // direktori sistem POSIX — bare atau + tail
  /(^|[\s;&|><"'(])\/(?:etc|boot|var|root|usr|bin|sbin|lib|sdcard|storage)(?![\w-])(?:\/[^\s;&|><"']*)?/i,
  // direktori sistem Windows
  /(^|[\s;&|><"'(])[A-Za-z]:[\\/](?:Windows|Program Files(?: \(x86\))?)(?![\w])(?:[\\/][^\s;&|><"']*)?/i,
];

/**
 * Commands that are strictly forbidden under any circumstances.
 * Attempting to execute any matching command will result in an immediate security error.
 */
export const BLACKLIST_PATTERNS = [
  // rm -rf / or root/home directory wipes
  /\brm\s+-[a-zA-Z0-9]*r[a-zA-Z0-9]*f[a-zA-Z0-9]*\s+((\/|\/\*|~|~\/\*|\$HOME\/?|\$\{HOME\}\/?)\s*($|[;&|><]))/i,
  /\brm\s+--no-preserve-root/i,

  // Disk formatting and block device overwrites
  /\bmkfs(\.[a-z0-9]+)?\s+/i,
  /\bdd\s+.*of=\/(dev|system)\//i,
  />\s*\/dev\/(sd[a-z]|hd[a-z]|nvme[0-9]n[0-9]|block|kmem|mem)/i,

  // Classic fork bombs
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,

  // System-wide permission breaks
  /\bchmod\s+-[a-zA-Z0-9]*R[a-zA-Z0-9]*\s+(777|000)\s+((\/|\/\*|~|\$HOME)\s*($|[;&|><]))/i,
  /\bchown\s+-[a-zA-Z0-9]*R[a-zA-Z0-9]*\s+.*\s+((\/|\/\*|~|\$HOME)\s*($|[;&|><]))/i,

  // System partition remounts in Android/Linux
  /\bmount\s+.*-o\s+.*remount,rw\s+\/(system|vendor|product)?/i,

  // H-1: Windows root-drive wipes and formatters. `format` + drive letter
  // always deny (volume label is `label`, not `format`).
  /\bformat(?:\.com)?\s+[a-z]:/i,
  /\b(rd|rmdir)\s+\/[a-z]\s*(?:\/[a-z]\s*)*[a-z]:\\(?:\*)?(?=$|[\s;&|])/i,
  /\b(del|erase)\s+\/[a-z]\s*(?:\/[a-z]\s*)*[a-z]:\\(?:\*)?(?=$|[\s;&|])/i,
  /\bRemove-Item\b.*-Recurse.*-Force.*(?:[a-z]:\\(?:\*)?(?=$|[\s;&|])|%USERPROFILE%)/i,
];

/**
 * Commands that modify the system or filesystem and require human confirmation [y/N]
 * unless auto-approved via `--yes` / `-y`.
 */
export const RISKY_COMMAND_PATTERNS = [
  // Deletion operations
  /\b(rm|unlink|rmdir)\b/i,

  // Dangerous Git operations
  /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z0-9]*f|push\s+-[a-zA-Z0-9]*f|push\s+.*--force|branch\s+-D)/i,

  // Permission modifications
  /\b(chmod|chown|chgrp)\b/i,

  // Process terminations
  /\b(kill|pkill|killall)\b/i,

  // Pipe remote scripts to shell
  /\b(curl|wget|fetch)\b.*\|\s*(bash|sh|zsh|dash|ksh|python|perl|ruby)/i,

  // System package operations
  /\b(apt|pkg|apt-get|pacman|apk)\s+(remove|purge|autoremove|clean)/i,

  // Global installations
  /\b(npm|yarn|pnpm)\s+install\s+-g\b/i,

  // H-1: in-place file rewriting (`sed -i` / `sed -i.bak`).
  /\bsed\s+-i(\.\S*)?\b/i,

  // H-1: file-mutation verbs — `git mv` dikecualikan via negative lookbehind
  // (harus TEPAT di depan verb; kalau di depan separator, spasi "git " ikut
  // terkonsumsi dan lookbehind tidak melihatnya).
  /(?:^|[;&|()\s])(?<!git\s)(mv|rename|ln|truncate|tee|rsync)(?=$|[\s;&|])/i,

  // H-1: output redirect ke path absolut / home-ish. Digit sebelum `>`
  // (fd dup: `2>/dev/null`, `2>&1`) dikecualikan; device nodes dikecualikan.
  // Redirect ke path RELATIF dalam-jail (`echo x > log.txt`) TIDAK gated —
  // hanya target absolut/home-ish (`~`, `$`, `%`, `X:\`, `/`).
  /(^|[^0-9])>{1,2}\s*["']?(?:~|\$|%|[A-Za-z]:[\\/]|\/(?!dev\/(?:null|stdout|stderr|zero)))/i,

  // H-1: Windows deletion verbs (cmd + PowerShell). Root-drive variant
  // ditangani BLACKLIST (deny); `Remove-Item` plain hanya risky di sini.
  /\b(rd|rmdir|del|erase)\s+\/[a-z]/i,
  /\bRemove-Item\b/i,
];

/**
 * Default directory names and files to ignore during scans and directory listings
 */
export const DEFAULT_IGNORE_PATTERNS = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.cache',
  '.faycli',
  '.next',
  '.nuxt',
  '__pycache__',
  '.venv',
  'venv',
  'coverage',
  '.DS_Store',
  'Thumbs.db',
];

/**
 * Known binary file extensions
 */
export const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.svgz',
  '.mp3',
  '.mp4',
  '.wav',
  '.ogg',
  '.flac',
  '.avi',
  '.mov',
  '.mkv',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.exe',
  '.bin',
  '.dll',
  '.so',
  '.dylib',
  '.elf',
  '.apk',
  '.dex',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.iso',
  '.img',
  '.dmg',
  '.sqlite',
  '.db',
]);

/**
 * Default security thresholds & execution limits
 */
export const DEFAULT_SECURITY_CONFIG = {
  // Max bytes for reading a file to prevent token exhaustion (500 KB)
  maxReadSizeBytes: 500 * 1024,

  // Max lines returned per read
  maxReadLines: 1000,

  // Default timeout for shell command execution (30 seconds)
  defaultCommandTimeoutMs: 30000,

  // Max bytes for command output capture (50 KB)
  maxOutputSizeBytes: 50 * 1024,

  // Max lines for command output capture
  maxOutputLines: 500,
};
