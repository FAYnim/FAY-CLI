/**
 * Session State Manager & Atomic Disk Persistence
 * Manages conversation history, session lifecycle, and disk storage at ~/.faycli/sessions/
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_MODEL } from '../config/constants.js';
import { configManager } from '../config/manager.js';
import {
  createFunctionCallPart,
  createFunctionResponseMessage,
  createModelMessage,
  createUserMessage,
  normalizeContent,
} from '../llm/types.js';

/**
 * Generates a unique, timestamped session ID
 * @returns {string}
 */
export function generateSessionId() {
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  return `sess_${timestamp}_${randomSuffix}`;
}

/**
 * Session Class representing an active or restored conversation
 */
export class Session {
  /**
   * @param {object} [data={}]
   * @param {string} [data.id] - Session ID
   * @param {string} [data.createdAt] - Creation ISO timestamp
   * @param {string} [data.updatedAt] - Last update ISO timestamp
   * @param {string} [data.model] - Model name
   * @param {string} [data.workingDir] - Workspace directory
   * @param {Array<object>} [data.messages=[]] - History of messages
   * @param {object} [data.metadata={}] - Additional session metadata
   * @param {string} [data.sessionsDir] - Storage directory override
   */
  constructor(data = {}) {
    const now = new Date().toISOString();
    this.id = data.id || generateSessionId();
    this.createdAt = data.createdAt || now;
    this.updatedAt = data.updatedAt || now;
    this.model = data.model || DEFAULT_MODEL;
    this.provider = data.provider || 'gemini';
    this.workingDir = data.workingDir || process.cwd();
    this.metadata = data.metadata || {};
    this.sessionsDir = data.sessionsDir || null;

    this.title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : null;
    this.messages = [];
    if (Array.isArray(data.messages)) {
      this.messages = data.messages.map(normalizeContent);
    }
  }

  /**
   * Sets or updates session title
   * @param {string} title
   * @returns {string|null}
   */
  setTitle(title) {
    this.title = typeof title === 'string' && title.trim() ? title.trim() : null;
    this.touch();
    return this.title;
  }

  /**
   * Automatically sets a title from prompt text if not already titled
   * @param {string|Array|object} textOrParts
   * @returns {string|null}
   */
  ensureTitle(textOrParts) {
    if (this.title) return this.title;
    let raw = '';
    if (typeof textOrParts === 'string') {
      raw = textOrParts;
    } else if (Array.isArray(textOrParts)) {
      raw = textOrParts.map((p) => (typeof p === 'string' ? p : p?.text || '')).join(' ');
    } else if (textOrParts && typeof textOrParts.text === 'string') {
      raw = textOrParts.text;
    }

    const cleaned = raw
      .replace(/```[\s\S]*?```/g, '') // remove code blocks
      .replace(/`([^`]+)`/g, '$1') // unwrap inline code
      .replace(/[\r\n\t]+/g, ' ') // replace whitespace/newlines with space
      .replace(/\s+/g, ' ') // collapse multiple spaces
      .trim();

    if (!cleaned) return null;

    const maxLen = 45;
    if (cleaned.length <= maxLen) {
      this.title = cleaned;
    } else {
      const sliced = cleaned.slice(0, maxLen);
      const lastSpace = sliced.lastIndexOf(' ');
      this.title = `${(lastSpace > 20 ? sliced.slice(0, lastSpace) : sliced).trim()}…`;
    }

    this.touch();
    return this.title;
  }

  /**
   * Appends a raw or normalized message to the session
   * @param {object|string} messageOrRole
   * @param {Array|string} [parts]
   * @returns {object} Normalized message added
   */
  addMessage(messageOrRole, parts) {
    let normalized;
    if (typeof messageOrRole === 'string' && parts !== undefined) {
      normalized = normalizeContent({ role: messageOrRole, parts });
    } else {
      normalized = normalizeContent(messageOrRole);
    }

    this.messages.push(normalized);
    this.touch();
    return normalized;
  }

  /**
   * Appends a user message
   * @param {string|Array} textOrParts
   * @returns {object}
   */
  addUserMessage(textOrParts) {
    this.ensureTitle(textOrParts);
    const msg = createUserMessage(textOrParts);
    this.messages.push(msg);
    this.touch();
    return msg;
  }

  /**
   * Appends a model response message
   * @param {string|Array} textOrParts
   * @returns {object}
   */
  addModelMessage(textOrParts) {
    const msg = createModelMessage(textOrParts);
    this.messages.push(msg);
    this.touch();
    return msg;
  }

  /**
   * Appends a model message containing function call(s)
   * @param {string} name - Function name
   * @param {object} [args={}] - Function arguments
   * @returns {object}
   */
  addFunctionCallMessage(name, args = {}) {
    const part = createFunctionCallPart(name, args);
    const msg = {
      role: 'model',
      parts: [part],
    };
    this.messages.push(msg);
    this.touch();
    return msg;
  }

  /**
   * Appends a tool execution response message
   * @param {string} name - Tool name
   * @param {any} response - Execution result or error object
   * @returns {object}
   */
  addFunctionResponseMessage(name, response) {
    const msg = createFunctionResponseMessage(name, response);
    this.messages.push(msg);
    this.touch();
    return msg;
  }

  /**
   * Updates last modified timestamp
   */
  touch() {
    this.updatedAt = new Date().toISOString();
  }

  /**
   * Returns conversation messages array
   * @returns {Array<object>}
   */
  getMessages() {
    return this.messages;
  }

  /**
   * Sets messages array
   * @param {Array<object>} messages
   */
  setMessages(messages) {
    this.messages = Array.isArray(messages) ? messages.map(normalizeContent) : [];
    this.touch();
  }

  /**
   * Clears conversation history
   */
  clear() {
    this.messages = [];
    this.touch();
  }

  /**
   * Converts session to serializable plain object
   * @returns {object}
   */
  toJSON() {
    return {
      id: this.id,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      model: this.model,
      provider: this.provider,
      workingDir: this.workingDir,
      messages: this.messages,
      metadata: this.metadata,
    };
  }

  /**
   * Saves session atomically to disk
   * @param {string} [sessionsDir]
   * @returns {Session}
   */
  save(sessionsDir) {
    const dir = sessionsDir || this.sessionsDir;
    saveSession(this, { sessionsDir: dir });
    return this;
  }
}

/**
 * Session Manager handles storage, loading, and listing of session files
 */
export class SessionManager {
  /**
   * @param {object} [options={}]
   * @param {string} [options.sessionsDir] - Storage directory path
   * @param {string} [options.configDir] - Base config directory
   */
  constructor(options = {}) {
    if (options.sessionsDir) {
      this.sessionsDir = path.resolve(options.sessionsDir);
    } else if (options.configDir) {
      this.sessionsDir = path.join(path.resolve(options.configDir), 'sessions');
    } else {
      this.sessionsDir = configManager.getSessionsDir();
    }
  }

  /**
   * Ensures sessions directory exists
   * @returns {string}
   */
  getSessionsDir() {
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
    }
    return this.sessionsDir;
  }

  /**
   * Resolves filepath for a session ID
   * @param {string} sessionId
   * @returns {string}
   */
  getSessionPath(sessionId) {
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(this.getSessionsDir(), `${safeId}.json`);
  }

  /**
   * Creates a new Session instance
   * @param {object} [options={}]
   * @returns {Session}
   */
  createSession(options = {}) {
    return new Session({
      ...options,
      sessionsDir: this.sessionsDir,
    });
  }

  /**
   * Saves session data to disk atomically
   * @param {Session|object} session
   * @returns {boolean}
   */
  saveSession(session) {
    const _dir = this.getSessionsDir();
    const data = typeof session.toJSON === 'function' ? session.toJSON() : session;

    if (!data.id) {
      throw new Error('Cannot save session without an id');
    }

    const targetPath = this.getSessionPath(data.id);
    const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
    const payload = JSON.stringify(data, null, 2);

    fs.writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(tmpPath, targetPath);
    } catch (_err) {
      fs.copyFileSync(tmpPath, targetPath);
      try {
        fs.unlinkSync(tmpPath);
      } catch (_) {}
    }

    return true;
  }

  /**
   * Checks if session file exists
   * @param {string} sessionId
   * @returns {boolean}
   */
  hasSession(sessionId) {
    if (!sessionId) return false;
    const sessionPath = this.getSessionPath(sessionId);
    return fs.existsSync(sessionPath);
  }

  /**
   * Loads session from disk
   * @param {string} sessionId
   * @returns {Session}
   */
  loadSession(sessionId) {
    if (!sessionId) {
      throw new Error('Session ID is required');
    }

    const sessionPath = this.getSessionPath(sessionId);
    if (!fs.existsSync(sessionPath)) {
      throw new Error(`Session "${sessionId}" not found at ${sessionPath}`);
    }

    try {
      const raw = fs.readFileSync(sessionPath, 'utf8');
      const data = JSON.parse(raw);
      return new Session({
        ...data,
        sessionsDir: this.sessionsDir,
      });
    } catch (err) {
      throw new Error(`Failed to load session "${sessionId}": ${err.message}`);
    }
  }

  /**
   * Lists all saved sessions with summary metadata, sorted by updatedAt descending
   * @param {object} [options={}]
   * @param {string} [options.workingDir] - Filter sessions by workspace path
   * @param {boolean} [options.all=false] - Return all sessions regardless of workingDir
   * @returns {Array<object>}
   */
  listSessions(options = {}) {
    const { workingDir = null, all = false } = options;
    const dir = this.getSessionsDir();
    if (!fs.existsSync(dir)) {
      return [];
    }

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.includes('.tmp.'));
    const sessions = [];

    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);

        let lastMessageText = '';
        if (Array.isArray(data.messages) && data.messages.length > 0) {
          const lastMsg = data.messages[data.messages.length - 1];
          if (lastMsg?.parts?.[0]?.text) {
            lastMessageText = lastMsg.parts[0].text.slice(0, 80);
          } else if (lastMsg?.parts?.[0]?.functionCall) {
            lastMessageText = `[Tool Call: ${lastMsg.parts[0].functionCall.name}]`;
          }
        }

        const sessionWorkDir = data.workingDir || '';
        if (!all && workingDir && sessionWorkDir) {
          const normTarget = path.resolve(workingDir);
          const normSess = path.resolve(sessionWorkDir);
          if (normTarget !== normSess) {
            continue;
          }
        }

        sessions.push({
          id: data.id || path.basename(file, '.json'),
          title: data.title || null,
          createdAt: data.createdAt || null,
          updatedAt: data.updatedAt || null,
          model: data.model || DEFAULT_MODEL,
          provider: data.provider || 'gemini',
          workingDir: sessionWorkDir,
          messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
          preview: lastMessageText,
          lastMessagePreview: lastMessageText,
          filePath,
          metadata: data.metadata || {},
        });
      } catch {
        // Skip corrupted files
      }
    }

    // Sort by updatedAt descending
    return sessions.sort((a, b) => {
      const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return timeB - timeA;
    });
  }

  /**
   * Renames a saved session's title
   * @param {string} sessionId
   * @param {string} newTitle
   * @returns {boolean}
   */
  renameSession(sessionId, newTitle) {
    if (!this.hasSession(sessionId)) return false;
    const session = this.loadSession(sessionId);
    session.setTitle(newTitle);
    return this.saveSession(session);
  }

  /**
   * Deletes a session file
   * @param {string} sessionId
   * @returns {boolean}
   */
  deleteSession(sessionId) {
    if (!sessionId) return false;
    const sessionPath = this.getSessionPath(sessionId);
    if (fs.existsSync(sessionPath)) {
      fs.unlinkSync(sessionPath);
      return true;
    }
    return false;
  }

  /**
   * Deletes all sessions
   * @returns {number} Count of deleted sessions
   */
  clearSessions() {
    const dir = this.getSessionsDir();
    if (!fs.existsSync(dir)) return 0;

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    let count = 0;
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(dir, file));
        count++;
      } catch {}
    }
    return count;
  }
}

/**
 * Singleton default session manager
 */
export const defaultSessionManager = new SessionManager();

/**
 * Helper to create a new session
 * @param {object} [options={}]
 * @returns {Session}
 */
export function createSession(options = {}) {
  const manager =
    options.sessionsDir || options.configDir ? new SessionManager(options) : defaultSessionManager;
  return manager.createSession(options);
}

/**
 * Helper to save a session
 * @param {Session|object} session
 * @param {object} [options={}]
 * @returns {boolean}
 */
export function saveSession(session, options = {}) {
  const manager =
    options.sessionsDir || options.configDir ? new SessionManager(options) : defaultSessionManager;
  return manager.saveSession(session);
}

/**
 * Helper to load a session
 * @param {string} sessionId
 * @param {object} [options={}]
 * @returns {Session}
 */
export function loadSession(sessionId, options = {}) {
  const manager =
    options.sessionsDir || options.configDir ? new SessionManager(options) : defaultSessionManager;
  return manager.loadSession(sessionId);
}

/**
 * Helper to list sessions
 * @param {object} [options={}]
 * @returns {Array<object>}
 */
export function listSessions(options = {}) {
  const manager =
    options.sessionsDir || options.configDir ? new SessionManager(options) : defaultSessionManager;
  return manager.listSessions();
}

/**
 * Helper to delete a session
 * @param {string} sessionId
 * @param {object} [options={}]
 * @returns {boolean}
 */
export function deleteSession(sessionId, options = {}) {
  const manager =
    options.sessionsDir || options.configDir ? new SessionManager(options) : defaultSessionManager;
  return manager.deleteSession(sessionId);
}
