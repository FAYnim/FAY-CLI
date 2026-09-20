import { discoverSkills, loadSkillContent } from '../skills/skill-manager.js';

/**
 * Actuator tool that loads the complete procedural instructions of an installed skill.
 *
 * @param {object} args
 * @param {string} args.skill_name - Name of the skill to load
 * @param {object} [context={}]
 * @returns {Promise<{ success: boolean, data?: object, error?: string }>}
 */
export async function loadSkillTool(args, context = {}) {
  const skillName = args?.skill_name?.trim();
  if (!skillName) {
    return {
      success: false,
      error: "Missing required parameter 'skill_name'.",
    };
  }

  // Guard against repetitive loading in the same session
  const sessionMetadata = context.session?.metadata;
  const loadedSkills =
    context.loadedSkills ||
    (sessionMetadata?.loadedSkills ? new Set(sessionMetadata.loadedSkills) : null);
  const isAlreadyLoaded = loadedSkills
    ? Array.isArray(loadedSkills)
      ? loadedSkills.includes(skillName)
      : loadedSkills.has?.(skillName)
    : false;

  if (isAlreadyLoaded) {
    return {
      success: true,
      data: {
        name: skillName,
        already_loaded: true,
        message: `Skill '${skillName}' is already loaded and active in the current session. Do not re-load this skill; proceed directly with your task.`,
      },
    };
  }

  const projectRoot = context.projectRoot || context.workingDir || process.cwd();
  const homeDir = context.homeDir;

  const contentObj = loadSkillContent(skillName, { projectRoot, homeDir });
  if (!contentObj) {
    const available = discoverSkills({ projectRoot, homeDir }).map((s) => s.name);
    return {
      success: false,
      error: `Skill '${skillName}' not found. Available skills: ${available.length > 0 ? available.join(', ') : 'none'}.`,
    };
  }

  // Record skill as loaded in context and session metadata
  if (context.loadedSkills?.add) {
    context.loadedSkills.add(skillName);
  }
  if (sessionMetadata) {
    if (!Array.isArray(sessionMetadata.loadedSkills)) {
      sessionMetadata.loadedSkills = [];
    }
    if (!sessionMetadata.loadedSkills.includes(skillName)) {
      sessionMetadata.loadedSkills.push(skillName);
    }
  }

  return {
    success: true,
    data: {
      name: contentObj.skill.name,
      description: contentObj.skill.description,
      scope: contentObj.skill.scope,
      instructions: contentObj.content,
      scripts: contentObj.scripts,
      references: contentObj.references,
    },
  };
}
