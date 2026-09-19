import fs from 'node:fs';
import path from 'node:path';

/**
 * Parses user installation source string into components.
 *
 * @param {string} sourceStr
 * @returns {{ owner: string, repo: string, skillName: string|null }}
 */
export function parseInstallSource(sourceStr) {
  let clean = sourceStr.trim();
  let explicitSkill = null;

  const skillMatch = clean.match(/(?:--skill|-s)\s+([a-zA-Z0-9_-]+)/);
  if (skillMatch) {
    explicitSkill = skillMatch[1];
    clean = clean.replace(/(?:--skill|-s)\s+([a-zA-Z0-9_-]+)/, '').trim();
  }

  // Handle URL format: https://github.com/owner/repo/tree/main/...
  if (clean.startsWith('http://') || clean.startsWith('https://')) {
    const url = new URL(clean);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const owner = parts[0];
      const repo = parts[1];
      const skillName = explicitSkill || (parts.length >= 5 ? parts[parts.length - 1] : null);
      return { owner, repo, skillName };
    }
  }

  // Handle owner/repo format
  const parts = clean.split('/');
  if (parts.length >= 2) {
    return {
      owner: parts[0],
      repo: parts[1],
      skillName: explicitSkill,
    };
  }

  return {
    owner: clean,
    repo: 'skills',
    skillName: explicitSkill || clean,
  };
}

/**
 * Downloads and installs a skill from GitHub raw content.
 *
 * @param {string} source
 * @param {object} [options={}]
 * @returns {Promise<{ success: boolean, skillDir?: string, error?: string }>}
 */
export async function installSkillFromGitHub(source, options = {}) {
  const parsed = parseInstallSource(source);
  const skillName = options.skillName || parsed.skillName || parsed.repo;
  const targetDir = options.targetDir || path.join(process.cwd(), '.agents', 'skills');
  const fetcher = options.fetcher || globalThis.fetch;

  if (!skillName) {
    return { success: false, error: 'Could not determine skill name from source.' };
  }

  const destinationFolder = path.join(targetDir, skillName);
  fs.mkdirSync(destinationFolder, { recursive: true });

  // Candidate branches and file paths
  const branches = ['main', 'master'];
  const possiblePaths = [`skills/${skillName}/SKILL.md`, `${skillName}/SKILL.md`, 'SKILL.md'];

  let rawContent = null;

  for (const branch of branches) {
    if (rawContent) break;
    for (const relPath of possiblePaths) {
      const rawUrl = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${branch}/${relPath}`;
      try {
        const res = await fetcher(rawUrl);
        if (res?.ok && res.status === 200) {
          rawContent = await res.text();
          break;
        }
      } catch {
        // Try next candidate path
      }
    }
  }

  if (!rawContent) {
    fs.rmSync(destinationFolder, { recursive: true, force: true });
    return {
      success: false,
      error: `Could not locate SKILL.md in repository ${parsed.owner}/${parsed.repo}.`,
    };
  }

  fs.writeFileSync(path.join(destinationFolder, 'SKILL.md'), rawContent, 'utf8');
  return { success: true, skillDir: destinationFolder };
}

/**
 * Removes an installed skill directory.
 *
 * @param {string} skillName
 * @param {object} [options={}]
 * @returns {{ success: boolean, error?: string }}
 */
export function removeSkill(skillName, options = {}) {
  const targetDir = options.targetDir || path.join(process.cwd(), '.agents', 'skills');
  const skillPath = path.join(targetDir, skillName);

  if (!fs.existsSync(skillPath)) {
    return { success: false, error: `Skill folder not found at ${skillPath}` };
  }

  try {
    fs.rmSync(skillPath, { recursive: true, force: true });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
