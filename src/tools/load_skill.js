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
