import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Parses YAML frontmatter from raw markdown string safely without external dependencies.
 *
 * @param {string} raw
 * @returns {{ metadata: Record<string, string>, content: string }}
 */
export function parseSkillFrontmatter(raw) {
  if (!raw || typeof raw !== 'string') {
    return { metadata: {}, content: '' };
  }

  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { metadata: {}, content: normalized };
  }

  const endIndex = normalized.indexOf('\n---\n', 4);
  if (endIndex === -1) {
    return { metadata: {}, content: normalized };
  }

  const frontmatterStr = normalized.slice(4, endIndex);
  const content = normalized.slice(endIndex + 5);
  const metadata = {};

  for (const line of frontmatterStr.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    let val = trimmed.slice(colonIndex + 1).trim();

    // Strip surrounding single/double quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    metadata[key] = val;
  }

  return { metadata, content };
}

/**
 * Scans a folder for skills containing SKILL.md.
 *
 * @param {string} baseDir
 * @param {'project'|'global'} scope
 * @returns {Array<object>}
 */
function scanSkillsDirectory(baseDir, scope) {
  if (!fs.existsSync(baseDir)) return [];

  const found = [];
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(baseDir, entry.name);
      const skillFile = path.join(skillDir, 'SKILL.md');

      if (!fs.existsSync(skillFile)) continue;

      try {
        const raw = fs.readFileSync(skillFile, 'utf8');
        const { metadata } = parseSkillFrontmatter(raw);
        const name = metadata.name || entry.name;
        const description = metadata.description || 'No description provided.';

        found.push({
          name,
          description,
          version: metadata.version || '1.0.0',
          author: metadata.author || 'unknown',
          dirPath: skillDir,
          skillFilePath: skillFile,
          scope,
        });
      } catch {
        // Skip malformed individual skill files
      }
    }
  } catch {
    // Skip unreadable directories
  }

  return found;
}

/**
 * Discovers all installed skills across Project and Global directories.
 * Project-level skills override global-level skills when name collision occurs.
 *
 * @param {object} [options={}]
 * @param {string} [options.projectRoot]
 * @param {string} [options.homeDir]
 * @returns {Array<object>}
 */
export function discoverSkills(options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const homeDir = options.homeDir || os.homedir();

  const projectPaths = [
    path.join(projectRoot, '.agents', 'skills'),
    path.join(projectRoot, '.fay', 'skills'),
  ];

  const globalPaths = [
    path.join(homeDir, '.agents', 'skills'),
    path.join(homeDir, '.fay', 'skills'),
  ];

  const skillsMap = new Map();

  // Scan global first
  for (const p of globalPaths) {
    const globalSkills = scanSkillsDirectory(p, 'global');
    for (const s of globalSkills) {
      if (!skillsMap.has(s.name)) {
        skillsMap.set(s.name, s);
      }
    }
  }

  // Scan project second (overwrites global)
  for (const p of projectPaths) {
    const projectSkills = scanSkillsDirectory(p, 'project');
    for (const s of projectSkills) {
      skillsMap.set(s.name, s);
    }
  }

  return Array.from(skillsMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Retrieves a single skill by name.
 *
 * @param {string} name
 * @param {object} [options={}]
 * @returns {object|null}
 */
export function getSkill(name, options = {}) {
  const skills = discoverSkills(options);
  return skills.find((s) => s.name === name) || null;
}

/**
 * Reads the instructions of a skill and lists available scripts/references.
 *
 * @param {string} name
 * @param {object} [options={}]
 * @returns {{ skill: object, content: string, scripts: string[], references: string[] }|null}
 */
export function loadSkillContent(name, options = {}) {
  const skill = getSkill(name, options);
  if (!skill) return null;

  try {
    const raw = fs.readFileSync(skill.skillFilePath, 'utf8');
    const { content } = parseSkillFrontmatter(raw);

    const scripts = [];
    const scriptsDir = path.join(skill.dirPath, 'scripts');
    if (fs.existsSync(scriptsDir)) {
      for (const file of fs.readdirSync(scriptsDir)) {
        scripts.push(path.join('scripts', file).replace(/\\/g, '/'));
      }
    }

    const references = [];
    const refsDir = path.join(skill.dirPath, 'references');
    if (fs.existsSync(refsDir)) {
      for (const file of fs.readdirSync(refsDir)) {
        references.push(path.join('references', file).replace(/\\/g, '/'));
      }
    }

    return {
      skill,
      content: content.trim(),
      scripts,
      references,
    };
  } catch {
    return null;
  }
}
