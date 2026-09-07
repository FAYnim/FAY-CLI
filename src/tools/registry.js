/**
 * Tool Registry & Gemini Function Declarations Generator
 */

import { executeCommandTool } from './execute_command.js';
import { gitAddCommitTool, gitDiffTool, gitStatusTool } from './git.js';
import { grepFileTool } from './grep_file.js';
import { listDirTool } from './list_dir.js';
import { patchFileTool } from './patch_file.js';
import { readFileTool } from './read_file.js';
import { searchFilesTool } from './search_files.js';
import { webFetchTool } from './web_fetch.js';
import { webSearchTool } from './web_search.js';
import { writeFileTool } from './write_file.js';

/**
 * Mapping of all registered actuator tools
 */
export const TOOLS_MAP = {
  read_file: readFileTool,
  write_file: writeFileTool,
  patch_file: patchFileTool,
  list_dir: listDirTool,
  execute_command: executeCommandTool,
  grep_file: grepFileTool,
  search_files: searchFilesTool,
  git_status: gitStatusTool,
  git_diff: gitDiffTool,
  git_add_commit: gitAddCommitTool,
  web_fetch: webFetchTool,
  web_search: webSearchTool,
};

/**
 * Set of tools that are idempotent and safe for concurrent execution
 */
export const READ_ONLY_TOOLS = new Set([
  'read_file',
  'grep_file',
  'search_files',
  'list_dir',
  'git_status',
  'git_diff',
  'web_fetch',
]);

/**
 * Gemini Function Declaration Schemas for all available tools
 */
export const TOOL_DECLARATIONS = [
  {
    name: 'read_file',
    description: 'Read content from a file with optional line range slicing and token protection.',
    parameters: {
      type: 'OBJECT',
      properties: {
        filePath: {
          type: 'STRING',
          description: 'Relative or absolute path to the file to read',
        },
        startLine: {
          type: 'INTEGER',
          description: '1-indexed starting line number for slicing (optional)',
        },
        endLine: {
          type: 'INTEGER',
          description: '1-indexed ending line number for slicing (optional)',
        },
        encoding: {
          type: 'STRING',
          description: 'File character encoding, defaults to utf-8',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'write_file',
    description:
      'Write text content to a destination file. Automatically creates parent directories and uses atomic write.',
    parameters: {
      type: 'OBJECT',
      properties: {
        filePath: {
          type: 'STRING',
          description: 'Destination file path',
        },
        content: {
          type: 'STRING',
          description: 'Full text content to write into the file',
        },
        encoding: {
          type: 'STRING',
          description: 'File character encoding, defaults to utf-8',
        },
      },
      required: ['filePath', 'content'],
    },
  },
  {
    name: 'patch_file',
    description:
      'Perform token-efficient exact search-and-replace on an existing file. The searchString must be unique.',
    parameters: {
      type: 'OBJECT',
      properties: {
        filePath: {
          type: 'STRING',
          description: 'Target file path to modify',
        },
        searchString: {
          type: 'STRING',
          description: 'Exact string to be replaced (must occur exactly once in the file)',
        },
        replaceString: {
          type: 'STRING',
          description: 'New string to replace the searchString with',
        },
      },
      required: ['filePath', 'searchString', 'replaceString'],
    },
  },
  {
    name: 'list_dir',
    description:
      'Inspect directory contents recursively with tree formatting, depth control, and ignore filtering (.git, node_modules).',
    parameters: {
      type: 'OBJECT',
      properties: {
        dirPath: {
          type: 'STRING',
          description: 'Directory path to inspect (defaults to current working directory .)',
        },
        depth: {
          type: 'INTEGER',
          description: 'Maximum depth level for recursive inspection (default 2)',
        },
        ignorePatterns: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'Optional custom list of directory/file names to ignore',
        },
      },
    },
  },
  {
    name: 'execute_command',
    description:
      'Execute a shell command locally in Termux or host environment with timeout protection.',
    parameters: {
      type: 'OBJECT',
      properties: {
        command: {
          type: 'STRING',
          description: 'Shell command line to execute',
        },
        workingDir: {
          type: 'STRING',
          description: 'Working directory for execution (defaults to workspace base directory)',
        },
        timeoutMs: {
          type: 'INTEGER',
          description: 'Execution timeout limit in milliseconds (defaults to 30000)',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'grep_file',
    description:
      'Search file contents with a JavaScript regex across the workspace. Skips .git, node_modules and binary files. Returns file, line number and line text per match.',
    parameters: {
      type: 'OBJECT',
      properties: {
        pattern: {
          type: 'STRING',
          description: 'JavaScript regex source, e.g. "function\\s+\\w+"',
        },
        dirPath: {
          type: 'STRING',
          description: 'Directory to search (default "." = workspace root)',
        },
        glob: { type: 'STRING', description: 'Optional file filter glob, e.g. "src/*.js"' },
        caseSensitive: { type: 'BOOLEAN', description: 'Case-sensitive matching (default false)' },
        maxResults: {
          type: 'INTEGER',
          description: 'Maximum matches to return (default 100, max 1000)',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'search_files',
    description:
      'Find files by glob pattern. Patterns without "/" match file names at any depth (e.g. "*.test.js"); patterns with "/" match relative paths (e.g. "src/*.js"). Skips .git and node_modules.',
    parameters: {
      type: 'OBJECT',
      properties: {
        pattern: { type: 'STRING', description: 'Glob pattern to match file names or paths' },
        dirPath: { type: 'STRING', description: 'Search root directory (default ".")' },
        maxResults: { type: 'INTEGER', description: 'Maximum files to return (default 200)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'git_status',
    description: 'Show current git branch and working-tree changes (porcelain format).',
    parameters: {
      type: 'OBJECT',
      properties: {
        workingDir: { type: 'STRING', description: 'Repo directory (default workspace root)' },
      },
    },
  },
  {
    name: 'git_diff',
    description: 'Show unstaged (or staged) git diff, optionally limited to one file.',
    parameters: {
      type: 'OBJECT',
      properties: {
        file: { type: 'STRING', description: 'Only diff this path (optional)' },
        staged: {
          type: 'BOOLEAN',
          description: 'Diff the index instead of the working tree (default false)',
        },
        workingDir: { type: 'STRING', description: 'Repo directory (default workspace root)' },
      },
    },
  },
  {
    name: 'git_add_commit',
    description:
      'Stage the given paths and create a commit with a message. Requires user confirmation unless auto-approve is on.',
    parameters: {
      type: 'OBJECT',
      properties: {
        message: { type: 'STRING', description: 'Commit message' },
        files: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'Paths to stage (default ["."])',
        },
        workingDir: { type: 'STRING', description: 'Repo directory (default workspace root)' },
      },
      required: ['message'],
    },
  },
  {
    name: 'web_fetch',
    description:
      'Fetch a URL and return its content as readable text (HTML is stripped). Only public http(s) URLs; local/private hosts are blocked.',
    parameters: {
      type: 'OBJECT',
      properties: {
        url: { type: 'STRING', description: 'http(s) URL to fetch' },
        timeoutMs: { type: 'INTEGER', description: 'Request timeout in ms (default 15000)' },
        maxBytes: {
          type: 'INTEGER',
          description: 'Max content bytes returned (default 102400)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'web_search',
    description:
      'Search the web (DuckDuckGo Lite by default; SearXNG if configured). Returns ranked titles, URLs and snippets. Requires user confirmation.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'Search query' },
        maxResults: { type: 'INTEGER', description: 'Max results (default 8, max 20)' },
        engine: { type: 'STRING', description: '"duckduckgo" (default) or "searxng"' },
      },
      required: ['query'],
    },
  },
];

/**
 * Returns Gemini API function declarations array
 *
 * @returns {Array<object>}
 */
export function getToolDeclarations() {
  return JSON.parse(JSON.stringify(TOOL_DECLARATIONS));
}

/**
 * Retrieves a tool function by its registered name
 *
 * @param {string} name
 * @returns {Function|undefined}
 */
export function getTool(name) {
  return TOOLS_MAP[name];
}

/**
 * Data-driven alias map used by normalizeToolArgs. Each tool lists rules that
 * copy a model-emitted alias into the canonical argument name. Aliases are
 * tried in order. By default a rule fires when the canonical value is falsy
 * and picks the first truthy alias; rules with `nullish: true` fire when the
 * canonical value is strictly undefined and pick the first non-nullish alias
 * (so empty strings still count as provided content). `fallback` fills the
 * canonical argument when no alias matches.
 */
export const TOOL_ARG_ALIASES = {
  read_file: [
    {
      target: 'filePath',
      aliases: [
        'path',
        'file',
        'filepath',
        'file_path',
        'filename',
        'fileName',
        'target_file',
        'destination',
      ],
    },
  ],
  write_file: [
    {
      target: 'filePath',
      aliases: [
        'path',
        'file',
        'filepath',
        'file_path',
        'filename',
        'fileName',
        'target_file',
        'destination',
      ],
    },
    { target: 'content', aliases: ['text', 'data', 'contents', 'body', 'code'], nullish: true },
  ],
  patch_file: [
    {
      target: 'filePath',
      aliases: [
        'path',
        'file',
        'filepath',
        'file_path',
        'filename',
        'fileName',
        'target_file',
        'destination',
      ],
    },
    { target: 'searchString', aliases: ['search', 'find', 'pattern', 'old_string', 'oldString'] },
    { target: 'replaceString', aliases: ['replace', 'new_string', 'newString'] },
  ],
  list_dir: [{ target: 'dirPath', aliases: ['path', 'dir', 'directory', 'folder'], fallback: '.' }],
  execute_command: [{ target: 'command', aliases: ['cmd', 'script', 'exec'] }],
  grep_file: [
    { target: 'pattern', aliases: ['query', 'regex', 'search', 'searchString', 'text'] },
    { target: 'dirPath', aliases: ['path', 'dir', 'directory', 'folder'], fallback: '.' },
  ],
  search_files: [
    { target: 'pattern', aliases: ['query', 'glob', 'name', 'filename', 'find'] },
    { target: 'dirPath', aliases: ['path', 'dir', 'directory', 'folder'], fallback: '.' },
  ],
  git_status: [{ target: 'workingDir', aliases: ['path', 'dir', 'cwd'], fallback: '.' }],
  git_diff: [
    { target: 'file', aliases: ['filePath', 'path', 'target_file'] },
    { target: 'workingDir', aliases: ['dir', 'cwd'], fallback: '.' },
  ],
  git_add_commit: [
    { target: 'message', aliases: ['msg', 'commitMessage', 'commit_message'] },
    { target: 'files', aliases: ['paths', 'filePaths'] },
    { target: 'workingDir', aliases: ['path', 'dir', 'cwd'], fallback: '.' },
  ],
  web_fetch: [{ target: 'url', aliases: ['href', 'link', 'uri', 'target'] }],
  web_search: [{ target: 'query', aliases: ['q', 'search', 'searchQuery', 'keywords'] }],
};

/**
 * Normalizes tool arguments to support model variations and aliases.
 * @param {string} name - Tool name
 * @param {object} rawArgs - Raw tool arguments
 * @returns {object}
 */
export function normalizeToolArgs(name, rawArgs = {}) {
  const args = { ...(rawArgs || {}) };
  const rules = TOOL_ARG_ALIASES[name];
  if (!rules) {
    return args;
  }

  for (const { target, aliases, fallback, nullish } of rules) {
    const missing = nullish ? args[target] === undefined : !args[target];
    if (!missing) {
      continue;
    }
    const value = aliases
      .map((alias) => args[alias])
      .find((v) => (nullish ? v !== undefined && v !== null : Boolean(v)));
    args[target] = value !== undefined ? value : fallback;
  }

  return args;
}

/**
 * Safely dispatches a tool call with security authorization check and error handling.
 *
 * @param {string} name - Tool name
 * @param {object} rawArgs - Tool arguments
 * @param {object} [context={}] - Execution context (e.g. securityGuard, baseDir, logger)
 * @returns {Promise<{ success?: boolean, error?: boolean, result?: any, message?: string }>}
 */
export async function dispatchToolCall(name, rawArgs = {}, context = {}) {
  const tool = getTool(name);

  if (!tool) {
    return {
      error: true,
      message: `Tool "${name}" is not recognized. Available tools: ${Object.keys(TOOLS_MAP).join(', ')}`,
    };
  }

  const args = normalizeToolArgs(name, rawArgs);

  // Authorize via SecurityGuard if present in context
  if (context.securityGuard && typeof context.securityGuard.authorize === 'function') {
    try {
      const auth = await context.securityGuard.authorize(name, args);
      if (!auth.allowed) {
        return {
          error: true,
          message: auth.reason || `Security guard blocked execution of tool "${name}".`,
        };
      }
    } catch (authErr) {
      return {
        error: true,
        message: `Security check failed: ${authErr.message || String(authErr)}`,
      };
    }
  }

  try {
    const result = await tool(args, context);
    return {
      success: true,
      result,
    };
  } catch (err) {
    return {
      error: true,
      message: err.message || String(err),
    };
  }
}
