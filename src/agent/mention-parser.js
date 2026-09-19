/**
 * Prompt File Mention Parser & Context Injector
 * Extracts @file references and safely embeds file content in LLM messages.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadSkillContent } from '../skills/skill-manager.js';

export const DEFAULT_MAX_FILE_SIZE = 50 * 1024; // 50 KB
export const DEFAULT_MAX_FILES = 5;

// Regex matching @path/file or @skill:name preceded by start of string or whitespace
const MENTION_REGEX = /(?:^|\s)@([a-zA-Z0-9_\-./:]+)/g;

/**
 * Check if a buffer contains binary data (contains null bytes)
 *
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function isBinaryBuffer(buffer) {
  const checkLen = Math.min(buffer.length, 1024);
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Extract all unique valid mention tokens from user text
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseMentions(text) {
  if (typeof text !== 'string') return [];
  const matches = new Set();
  MENTION_REGEX.lastIndex = 0;
  let m = MENTION_REGEX.exec(text);
  while (m !== null) {
    const token = m[1].replace(/^\/+|\/+$/g, '');
    if (token && !token.endsWith('@')) {
      matches.add(token);
    }
    m = MENTION_REGEX.exec(text);
  }
  return [...matches];
}

/**
 * Expand @file and @skill: mentions by reading target files/skills and appending context blocks
 *
 * @param {string} text - Original user prompt
 * @param {object} [options={}]
 * @param {string} [options.workingDir=process.cwd()]
 * @param {string} [options.projectRoot]
 * @param {string} [options.homeDir]
 * @param {number} [options.maxFileSizeBytes=DEFAULT_MAX_FILE_SIZE]
 * @param {number} [options.maxFiles=DEFAULT_MAX_FILES]
 * @returns {{ cleanPrompt: string, injectedPrompt: string, attachedFiles: string[], attachedSkills: string[] }}
 */
export function expandMentions(text, options = {}) {
  const cleanPrompt = text || '';
  if (!cleanPrompt.trim()) {
    return { cleanPrompt, injectedPrompt: cleanPrompt, attachedFiles: [], attachedSkills: [] };
  }

  const workingDir = options.workingDir || process.cwd();
  const projectRoot = options.projectRoot || workingDir;
  const homeDir = options.homeDir;
  const maxSizeBytes = options.maxFileSizeBytes || DEFAULT_MAX_FILE_SIZE;
  const maxFiles = options.maxFiles || DEFAULT_MAX_FILES;

  const rawMentions = parseMentions(cleanPrompt);
  if (rawMentions.length === 0) {
    return { cleanPrompt, injectedPrompt: cleanPrompt, attachedFiles: [], attachedSkills: [] };
  }

  const attachedFiles = [];
  const attachedSkills = [];
  const contextBlocks = [];

  for (const relPath of rawMentions) {
    // Handle @skill:<name>
    if (relPath.startsWith('skill:')) {
      const skillName = relPath.slice(6).trim();
      if (skillName) {
        const skillObj = loadSkillContent(skillName, { projectRoot, homeDir });
        if (skillObj && skillObj.content) {
          contextBlocks.push(
            `<context_skill name="${skillName}">\n${skillObj.content}\n</context_skill>`,
          );
          attachedSkills.push(skillName);
        }
      }
      continue;
    }

    if (attachedFiles.length >= maxFiles) continue;

    const fullPath = path.resolve(workingDir, relPath);

    // Ensure within workingDir jail
    if (!fullPath.startsWith(path.resolve(workingDir))) {
      continue;
    }

    let stats;
    try {
      stats = fs.statSync(fullPath);
    } catch {
      continue; // File does not exist
    }

    if (!stats.isFile()) continue;

    try {
      const buffer = fs.readFileSync(fullPath);
      const posixPath = relPath.split(path.sep).join('/');

      if (isBinaryBuffer(buffer)) {
        contextBlocks.push(
          `<context_file path="${posixPath}">\n[Binary file omitted]\n</context_file>`,
        );
        attachedFiles.push(posixPath);
        continue;
      }

      if (buffer.length > maxSizeBytes) {
        const truncated = buffer.subarray(0, maxSizeBytes).toString('utf-8');
        contextBlocks.push(
          `<context_file path="${posixPath}">\n${truncated}\n\n[... content truncated: exceeds 50KB limit]\n</context_file>`,
        );
      } else {
        contextBlocks.push(
          `<context_file path="${posixPath}">\n${buffer.toString('utf-8')}\n</context_file>`,
        );
      }
      attachedFiles.push(posixPath);
    } catch {
      // Ignore read errors
    }
  }

  if (contextBlocks.length === 0) {
    return { cleanPrompt, injectedPrompt: cleanPrompt, attachedFiles: [], attachedSkills: [] };
  }

  const injectedPrompt = `${cleanPrompt}\n\n${contextBlocks.join('\n\n')}`;
  return { cleanPrompt, injectedPrompt, attachedFiles, attachedSkills };
}
