/**
 * Security Guard & Human-In-The-Loop Confirmation Engine
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { configManager } from '../config/manager.js';
import { showConfirmDialog } from '../ui/confirm-menu.js';
import { renderDiffPreview } from '../ui/diff-preview.js';
import { ansi } from '../utils/ansi.js';
import { validateSafePath } from './path-validator.js';
import {
  BLACKLIST_PATTERNS,
  DEFAULT_SECURITY_CONFIG,
  HARD_LIMITS,
  OBFUSCATION_PATTERNS,
  PROTECTED_PATH_PATTERNS,
  RISKY_COMMAND_PATTERNS,
} from './rules.js';

export class SecurityGuard {
  /**
   * @param {object} [options={}]
   * @param {boolean} [options.autoApprove=false] - Auto-approve risky actions (-y / --yes)
   * @param {string} [options.baseDir=process.cwd()] - Safe workspace base directory
   * @param {string[]} [options.allowedDirs=[]] - Additional explicitly allowed directories
   * @param {Function} [options.confirmationHandler=null] - Custom confirmation hook for tests/UI
   * @param {number} [options.defaultTimeoutMs=30000] - Default timeout for commands
   * @param {Function} [options.onBeforeConfirm=null] - Called just before showing the confirmation dialog
   * @param {Function} [options.onAfterConfirm=null]  - Called after the user makes a choice (receives boolean)
   */
  constructor(options = {}) {
    this.autoApprove = Boolean(options.autoApprove);
    this.baseDir = options.baseDir || process.cwd();
    this.allowedDirs = Array.isArray(options.allowedDirs) ? options.allowedDirs : [];
    this.confirmationHandler = options.confirmationHandler || null;
    this.defaultTimeoutMs =
      options.defaultTimeoutMs || DEFAULT_SECURITY_CONFIG.defaultCommandTimeoutMs;
    this.onBeforeConfirm = typeof options.onBeforeConfirm === 'function' ? options.onBeforeConfirm : null;
    this.onAfterConfirm = typeof options.onAfterConfirm === 'function' ? options.onAfterConfirm : null;
    this._stream = options.stream || null;
    this.mode = options.mode || 'build';
  }

  /**
   * Sets current execution mode ('build' | 'plan')
   * @param {'build'|'plan'} mode
   */
  setMode(mode) {
    this.mode = mode === 'plan' ? 'plan' : 'build';
  }

  /**
   * Evaluates command safety against blacklist and risky rules
   *
   * @param {string} command
   * @returns {{ isBlacklisted: boolean, isRisky: boolean, matchedPattern?: string, rejectReason?: string }}
   */
  inspectCommand(command) {
    if (!command || typeof command !== 'string') {
      return { isBlacklisted: false, isRisky: false };
    }

    const trimmed = command.trim();

    // SEC-03: hard limits — length cap and null-byte guard.
    if (trimmed.length > HARD_LIMITS.maxCommandLength) {
      return {
        isBlacklisted: true,
        isRisky: true,
        rejectReason: `Command exceeds maximum length (${HARD_LIMITS.maxCommandLength} chars)`,
      };
    }
    if (trimmed.includes('\0')) {
      return {
        isBlacklisted: true,
        isRisky: true,
        rejectReason: 'Command contains null byte (possible truncation attack)',
      };
    }

    // SEC-03: obfuscation detection (hex escapes, base64-to-shell, eval).
    for (const pattern of OBFUSCATION_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          isBlacklisted: true,
          isRisky: true,
          matchedPattern: pattern.toString(),
          rejectReason: 'Command uses obfuscation (hex escapes / base64 / eval)',
        };
      }
    }

    // SEC-03: protected paths — any command targeting `/`, `~`, `/etc`,
    // `/boot`, `/var/lib` is rejected regardless of verb.
    for (const pattern of PROTECTED_PATH_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          isBlacklisted: true,
          isRisky: true,
          matchedPattern: pattern.toString(),
          rejectReason: 'Command targets a protected system path',
        };
      }
    }

    // Check absolute blacklist
    for (const pattern of BLACKLIST_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          isBlacklisted: true,
          isRisky: true,
          matchedPattern: pattern.toString(),
        };
      }
    }

    // Check risky patterns
    for (const pattern of RISKY_COMMAND_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          isBlacklisted: false,
          isRisky: true,
          matchedPattern: pattern.toString(),
        };
      }
    }

    return { isBlacklisted: false, isRisky: false };
  }

  /**
   * SEC-04: build path validation options, threading the opt-in flag
   * from config (`security.allowTermuxStorage`).
   */
  _pathOptions() {
    let allowTermuxStorage = false;
    try {
      allowTermuxStorage = configManager.get('security.allowTermuxStorage') === true;
    } catch {
      // config unavailable (tests) — keep default false
    }
    return {
      allowedDirs: this.allowedDirs,
      allowTermuxStorage,
    };
  }

  /**
   * Interactively prompts user for confirmation using a rich TUI dialog.
   *
   * Accepts either:
   *   - A plain string `message` (backward-compatible with existing call sites)
   *   - A structured object with `{ title, description, target, question }`
   *     for richer, more informative dialogs.
   *
   * @param {string|{title?: string, description: string, target?: string, question?: string}} messageOrOptions
   * @returns {Promise<boolean>}
   */
  async promptConfirmation(messageOrOptions) {
    if (this.autoApprove) {
      return true;
    }

    // Backward-compat: support legacy string messages passed from tests or
    // custom call sites (confirmationHandler receives the string as-is).
    const legacyMessage =
      typeof messageOrOptions === 'string'
        ? messageOrOptions
        : messageOrOptions?.description || 'AI ingin melakukan tindakan yang memerlukan konfirmasi.';

    if (typeof this.confirmationHandler === 'function') {
      return await this.confirmationHandler(legacyMessage);
    }

    // Build structured options for the interactive TUI dialog.
    // If caller passed a plain string, wrap it into a minimal description.
    const dialogOpts =
      typeof messageOrOptions === 'object' && messageOrOptions !== null
        ? {
            title: messageOrOptions.title || '',
            description: messageOrOptions.description || legacyMessage,
            target: messageOrOptions.target || '',
            question: messageOrOptions.question || 'Apakah Anda mengizinkan tindakan ini?',
          }
        : {
            title: '',
            description: legacyMessage,
            target: '',
            question: 'Apakah Anda mengizinkan tindakan ini?',
          };

    // Notify REPL/caller that a dialog is about to appear (e.g. stop spinner)
    if (this.onBeforeConfirm) this.onBeforeConfirm();

    // Use the interactive arrow-key TUI dialog on TTY terminals.
    // Falls back to safe deny on non-TTY (pipes, CI, tests without handler).
    const result = await showConfirmDialog(dialogOpts);

    // Notify REPL/caller with the user's decision
    if (this.onAfterConfirm) this.onAfterConfirm(result);

    return result;
  }

  /**
   * Pre-execution validation for tool invocations
   *
   * @param {string} toolName
   * @param {object} args
   * @returns {Promise<{ allowed: boolean, reason?: string, resolvedPath?: string }>}
   */
  async authorize(toolName, args = {}) {
    if (this.mode === 'plan') {
      if (toolName === 'execute_command' || toolName === 'patch_file') {
        return {
          allowed: false,
          reason: `Tool "${toolName}" is not permitted in Plan Mode. Use /build to switch mode.`,
        };
      }
      if (toolName === 'write_file') {
        const rawPath = args.filePath || '';
        const normalized = path.normalize(rawPath).replace(/\\/g, '/');
        const isPlanFolder = normalized.includes('/.fay/plans/') || normalized.startsWith('.fay/plans/');
        if (!isPlanFolder) {
          return {
            allowed: false,
            reason: 'File mutation is restricted to .fay/plans/ in Plan Mode. Use /build to execute.',
          };
        }
      }
    }

    switch (toolName) {
      case 'execute_command': {
        const { command, workingDir } = args;
        if (!command || typeof command !== 'string') {
          return { allowed: false, reason: 'Command must be a non-empty string.' };
        }

        const inspection = this.inspectCommand(command);

        if (inspection.isBlacklisted) {
          return {
            allowed: false,
            reason: `Forbidden command detected by security guard: "${command}" (matches blacklist pattern)`,
          };
        }

        if (workingDir) {
          const pathValidation = validateSafePath(workingDir, this.baseDir, this._pathOptions());
          if (!pathValidation.isAllowed) {
            const confirmed = await this.promptConfirmation({
              description: 'AI ingin menjalankan perintah shell di luar workspace:',
              target: `Direktori: ${pathValidation.resolvedPath}\nPerintah : ${command}`,
              question: 'Apakah anda mengizinkannya?',
            });
            if (!confirmed) {
              return {
                allowed: false,
                reason: `User rejected command execution in external path "${workingDir}".`,
              };
            }
          }
        }

        if (inspection.isRisky && !this.autoApprove) {
          const confirmed = await this.promptConfirmation({
            description: 'AI ingin menjalankan perintah shell yang mungkin berisiko:',
            target: command,
            question: 'Apakah anda mengizinkannya?',
          });
          if (!confirmed) {
            return {
              allowed: false,
              reason: `User denied execution of risky command: "${command}".`,
            };
          }
        }

        return { allowed: true };
      }

      case 'patch_file': {
        const filePath = args.filePath;
        if (!filePath || typeof filePath !== 'string') {
          return { allowed: false, reason: 'File path must be a non-empty string.' };
        }
        const pathValidation = validateSafePath(filePath, this.baseDir, this._pathOptions());
        if (!pathValidation.isAllowed && !this.autoApprove) {
          const confirmed = await this.promptConfirmation({
            description: 'AI ingin menulis/mengubah file di luar workspace:',
            target: pathValidation.resolvedPath,
            question: 'Apakah anda mengizinkannya?',
          });
          if (!confirmed) {
            return { allowed: false, reason: `User rejected file access outside workspace for "${filePath}".` };
          }
        }
        let beforeContent = args._beforeContent;
        let afterContent = args._afterContent;
        if (beforeContent === undefined && typeof args.searchString === 'string' && typeof args.replaceString === 'string') {
          try {
            const abs = pathValidation.resolvedPath || path.resolve(this.baseDir, filePath);
            if (fs.existsSync(abs)) {
              beforeContent = fs.readFileSync(abs, 'utf-8');
              afterContent = beforeContent.replace(args.searchString, args.replaceString);
            }
          } catch {}
        }
        if (!this.autoApprove && beforeContent !== undefined && afterContent !== undefined) {
          const preview = renderDiffPreview({
            filePath: pathValidation.resolvedPath || filePath,
            before: beforeContent,
            after: afterContent,
          });
          if (this.onBeforeConfirm) this.onBeforeConfirm();
          (this._stream || process.stdout).write(preview);
          const confirmed = await this.promptConfirmation({
            description: 'AI ingin menerapkan patch pada file:',
            target: pathValidation.resolvedPath || filePath,
            question: 'Apakah anda mengizinkan perubahan ini?',
          });
          if (this.onAfterConfirm) this.onAfterConfirm(confirmed);
          if (!confirmed) return { allowed: false, reason: `User rejected patch on "${filePath}".` };
        }
        return { allowed: true, resolvedPath: pathValidation.resolvedPath };
      }

      case 'read_file':
      case 'write_file': {
        const filePath = args.filePath;
        if (!filePath || typeof filePath !== 'string') {
          return { allowed: false, reason: 'File path must be a non-empty string.' };
        }

        const pathValidation = validateSafePath(filePath, this.baseDir, this._pathOptions());

        if (!pathValidation.isAllowed && !this.autoApprove) {
          const isRead = toolName === 'read_file';
          const confirmed = await this.promptConfirmation({
            description: isRead
              ? 'AI ingin membaca file di luar workspace:'
              : 'AI ingin menulis/mengubah file di luar workspace:',
            target: pathValidation.resolvedPath,
            question: 'Apakah anda mengizinkannya?',
          });
          if (!confirmed) {
            return {
              allowed: false,
              reason: `User rejected file access outside workspace for "${filePath}".`,
            };
          }
        }

        return { allowed: true, resolvedPath: pathValidation.resolvedPath };
      }

      case 'list_dir':
      case 'grep_file':
      case 'search_files': {
        const dirPath = args.dirPath || '.';
        const pathValidation = validateSafePath(dirPath, this.baseDir, this._pathOptions());

        if (!pathValidation.isAllowed && !this.autoApprove) {
          const confirmed = await this.promptConfirmation({
            description: 'AI ingin membaca direktori di luar workspace:',
            target: pathValidation.resolvedPath,
            question: 'Apakah anda mengizinkannya?',
          });
          if (!confirmed) {
            return {
              allowed: false,
              reason: `User rejected directory scan outside workspace for "${dirPath}".`,
            };
          }
        }

        return { allowed: true, resolvedPath: pathValidation.resolvedPath };
      }

      case 'git_status':
      case 'git_diff': {
        if (args.workingDir && args.workingDir !== '.') {
          const pathValidation = validateSafePath(
            args.workingDir,
            this.baseDir,
            this._pathOptions(),
          );
          if (!pathValidation.isAllowed && !this.autoApprove) {
            const gitOp = toolName === 'git_status' ? 'status' : 'diff';
            const confirmed = await this.promptConfirmation({
              description: `AI ingin menjalankan git ${gitOp} di luar workspace:`,
              target: pathValidation.resolvedPath,
              question: 'Apakah anda mengizinkannya?',
            });
            if (!confirmed) {
              return {
                allowed: false,
                reason: `User rejected git operation in "${args.workingDir}".`,
              };
            }
          }
        }
        return { allowed: true };
      }

      case 'git_add_commit': {
        if (args.workingDir && args.workingDir !== '.') {
          const pathValidation = validateSafePath(
            args.workingDir,
            this.baseDir,
            this._pathOptions(),
          );
          if (!pathValidation.isAllowed && !this.autoApprove) {
            const confirmed = await this.promptConfirmation({
              description: 'AI ingin melakukan git commit di luar workspace:',
              target: pathValidation.resolvedPath,
              question: 'Apakah anda mengizinkannya?',
            });
            if (!confirmed) {
              return { allowed: false, reason: `User rejected git commit in "${args.workingDir}".` };
            }
          }
        }
        if (!this.autoApprove) {
          const files = (args.files || ['.']).join(', ');
          const confirmed = await this.promptConfirmation({
            description: 'AI ingin melakukan commit perubahan ke Git:',
            target: `File : ${files}\nPesan: ${args.message}`,
            question: 'Apakah anda mengizinkannya?',
          });
          if (!confirmed) {
            return { allowed: false, reason: 'User denied git commit.' };
          }
        }
        return { allowed: true };
      }

      case 'web_fetch': {
        const url = args.url;
        if (!url || typeof url !== 'string') {
          return { allowed: false, reason: 'URL must be a non-empty string.' };
        }
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          return { allowed: false, reason: `Invalid URL: "${url}"` };
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return { allowed: false, reason: `Only http(s) URLs allowed, got "${parsed.protocol}"` };
        }
        if (!this.autoApprove) {
          const confirmed = await this.promptConfirmation({
            description: 'AI ingin mengakses URL eksternal:',
            target: url,
            question: 'Apakah anda mengizinkannya?',
          });
          if (!confirmed) {
            return { allowed: false, reason: `User rejected fetching "${url}".` };
          }
        }
        return { allowed: true };
      }

      case 'web_search': {
        if (!args.query || typeof args.query !== 'string') {
          return { allowed: false, reason: 'Search query must be a non-empty string.' };
        }
        if (!this.autoApprove) {
          const confirmed = await this.promptConfirmation({
            description: 'AI ingin melakukan pencarian web:',
            target: args.query,
            question: 'Apakah anda mengizinkannya?',
          });
          if (!confirmed) {
            return { allowed: false, reason: `User rejected web search for "${args.query}".` };
          }
        }
        return { allowed: true };
      }

      default:
        return { allowed: true };
    }
  }
}
