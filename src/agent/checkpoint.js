/**
 * Checkpoint & Rollback Management
 * Provides automated file modification snapshots and /undo capability.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logger as defaultLogger } from '../utils/logger.js';

export class CheckpointManager {
  /**
   * @param {object} options
   * @param {string} options.checkpointsDir - Root directory for checkpoints (~/.faycli/checkpoints)
   * @param {string} [options.baseDir] - Default workspace baseDir
   * @param {boolean} [options.enabled=true] - Whether checkpointing is active
   * @param {number} [options.keep=10] - Number of session checkpoint folders to retain
   * @param {number} [options.maxFileSize=1048576] - Maximum file size to backup (default 1 MB)
   * @param {object} [options.logger] - Logger instance
   */
  constructor(options = {}) {
    this.checkpointsDir = options.checkpointsDir;
    this.baseDir = options.baseDir || process.cwd();
    this.enabled = options.enabled !== false;
    this.keep = typeof options.keep === 'number' ? options.keep : 10;
    this.maxFileSize = typeof options.maxFileSize === 'number' ? options.maxFileSize : 1048576;
    this.logger = options.logger || defaultLogger;
  }

  /**
   * Get storage directory for a specific session
   * @param {string} sessionId
   * @returns {string}
   */
  getSessionDir(sessionId) {
    const safeId = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.checkpointsDir, safeId);
  }

  /**
   * Ensure session directory exists
   * @param {string} sessionId
   * @returns {string}
   */
  ensureSessionDir(sessionId) {
    const dir = this.getSessionDir(sessionId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    return dir;
  }

  /**
   * Prepare snapshot before file mutation.
   *
   * @param {object} params
   * @param {string} params.sessionId
   * @param {string} params.toolName
   * @param {string} params.filePath
   * @param {string} [params.baseDir]
   * @returns {Promise<object>} Token to commit or discard
   */
  async createSnapshot({ sessionId, toolName, filePath, baseDir }) {
    if (!this.enabled || !sessionId || !filePath) {
      return { skipped: true, reason: 'disabled_or_missing_params' };
    }

    const effectiveBase = baseDir || this.baseDir;
    const resolvedPath = path.resolve(effectiveBase, filePath);
    const relPath = path.relative(effectiveBase, resolvedPath).replace(/\\/g, '/');

    const sessionDir = this.ensureSessionDir(sessionId);
    const id = Date.now() + Math.floor(Math.random() * 1000);

    if (!fs.existsSync(resolvedPath)) {
      return {
        id,
        sessionId,
        tool: toolName,
        relPath,
        resolvedPath,
        existedBefore: false,
        backupFile: null,
        tooLarge: false,
        size: 0,
      };
    }

    let stats;
    try {
      stats = fs.statSync(resolvedPath);
    } catch (err) {
      this.logger.debug('checkpoint.createSnapshot stat error', err);
      return { skipped: true, reason: 'stat_failed' };
    }

    if (stats.size > this.maxFileSize) {
      return {
        id,
        sessionId,
        tool: toolName,
        relPath,
        resolvedPath,
        existedBefore: true,
        backupFile: null,
        tooLarge: true,
        size: stats.size,
      };
    }

    const hashSlug = crypto.createHash('sha256').update(relPath).digest('hex').slice(0, 8);
    const backupFileName = `${id}-${hashSlug}.bak`;
    const backupFullPath = path.join(sessionDir, backupFileName);

    try {
      fs.copyFileSync(resolvedPath, backupFullPath);
    } catch (copyErr) {
      this.logger.warn(`Failed to create checkpoint snapshot for "${relPath}": ${copyErr.message}`);
      return { skipped: true, reason: 'copy_failed' };
    }

    return {
      id,
      sessionId,
      tool: toolName,
      relPath,
      resolvedPath,
      existedBefore: true,
      backupFile: backupFileName,
      backupFullPath,
      tooLarge: false,
      size: stats.size,
    };
  }

  /**
   * Commits snapshot into session index.jsonl
   *
   * @param {string} sessionId
   * @param {object} token
   */
  async commitSnapshot(sessionId, token) {
    if (!token || token.skipped) return;

    const sessionDir = this.ensureSessionDir(sessionId);
    const indexPath = path.join(sessionDir, 'index.jsonl');

    const record = {
      id: token.id,
      timestamp: new Date().toISOString(),
      tool: token.tool,
      relPath: token.relPath,
      existedBefore: token.existedBefore,
      backupFile: token.backupFile,
      tooLarge: token.tooLarge,
      size: token.size,
    };

    fs.appendFileSync(indexPath, `${JSON.stringify(record)}\n`, 'utf8');
  }

  /**
   * Discards snapshot if tool execution fails
   *
   * @param {string} sessionId
   * @param {object} token
   */
  async discardSnapshot(sessionId, token) {
    if (!token || token.skipped) return;

    if (token.backupFullPath && fs.existsSync(token.backupFullPath)) {
      try {
        fs.unlinkSync(token.backupFullPath);
      } catch (_e) {
        /* silent-ok: discard cleanup is best-effort */
      }
    }
  }

  /**
   * Get all checkpoints for a session
   *
   * @param {string} sessionId
   * @returns {Array<object>}
   */
  getCheckpoints(sessionId) {
    const sessionDir = this.getSessionDir(sessionId);
    const indexPath = path.join(sessionDir, 'index.jsonl');

    if (!fs.existsSync(indexPath)) return [];

    try {
      const content = fs.readFileSync(indexPath, 'utf8');
      return content
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch (err) {
      this.logger.debug('checkpoint.getCheckpoints read error', err);
      return [];
    }
  }

  /**
   * Revert file edits by n steps
   *
   * @param {object} params
   * @param {string} params.sessionId
   * @param {number} [params.steps=1]
   * @param {string} [params.baseDir]
   * @returns {Promise<{ success: boolean, restored?: Array<object>, reason?: string }>}
   */
  async undo({ sessionId, steps = 1, baseDir }) {
    if (!sessionId) {
      return { success: false, reason: 'No active session' };
    }

    const checkpoints = this.getCheckpoints(sessionId);
    if (!checkpoints.length) {
      return { success: false, reason: 'No file checkpoints found for this session.' };
    }

    const effectiveBase = baseDir || this.baseDir;
    const sessionDir = this.getSessionDir(sessionId);
    const countToUndo = Math.min(Math.max(1, steps), checkpoints.length);

    const entriesToUndo = checkpoints.slice(-countToUndo).reverse();
    const restored = [];

    for (const entry of entriesToUndo) {
      if (entry.tooLarge) {
        return {
          success: false,
          reason: `Cannot undo edit on "${entry.relPath}": file exceeded maximum checkpoint size (1 MB).`,
        };
      }

      const targetPath = path.resolve(effectiveBase, entry.relPath);

      if (entry.existedBefore && entry.backupFile) {
        const backupPath = path.join(sessionDir, entry.backupFile);
        if (!fs.existsSync(backupPath)) {
          return {
            success: false,
            reason: `Backup file "${entry.backupFile}" missing for "${entry.relPath}".`,
          };
        }

        const parentDir = path.dirname(targetPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        fs.copyFileSync(backupPath, targetPath);
        try {
          fs.unlinkSync(backupPath);
        } catch (_e) {
          /* silent-ok: cleanup is best-effort */
        }

        restored.push({ relPath: entry.relPath, action: 'restored', tool: entry.tool });
      } else if (!entry.existedBefore) {
        if (fs.existsSync(targetPath)) {
          fs.unlinkSync(targetPath);
        }
        restored.push({ relPath: entry.relPath, action: 'unlinked', tool: entry.tool });
      }
    }

    // Rewrite remaining index.jsonl entries
    const remaining = checkpoints.slice(0, checkpoints.length - countToUndo);
    const indexPath = path.join(sessionDir, 'index.jsonl');
    if (remaining.length === 0) {
      try {
        fs.unlinkSync(indexPath);
      } catch (_e) {
        /* silent-ok */
      }
    } else {
      const newContent = remaining.map((r) => JSON.stringify(r)).join('\n') + '\n';
      fs.writeFileSync(indexPath, newContent, 'utf8');
    }

    return { success: true, restored };
  }

  /**
   * Prune old session checkpoints keeping only the most recent N sessions.
   *
   * @param {number} [keepLimit]
   */
  pruneSessions(keepLimit) {
    const keep = typeof keepLimit === 'number' ? keepLimit : this.keep;
    if (!this.checkpointsDir || !fs.existsSync(this.checkpointsDir)) return;

    try {
      const entries = fs
        .readdirSync(this.checkpointsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const fullPath = path.join(this.checkpointsDir, d.name);
          try {
            const stat = fs.statSync(fullPath);
            return { name: d.name, fullPath, mtimeMs: stat.mtimeMs };
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      if (entries.length <= keep) return;

      entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const toDelete = entries.slice(keep);

      for (const item of toDelete) {
        try {
          fs.rmSync(item.fullPath, { recursive: true, force: true });
        } catch (err) {
          this.logger.debug(`checkpoint.pruneSessions: failed to remove ${item.fullPath}`, err);
        }
      }
    } catch (err) {
      this.logger.debug('checkpoint.pruneSessions error', err);
    }
  }
}
