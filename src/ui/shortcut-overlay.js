/**
 * Keyboard Shortcut Reference Overlay
 * Shown when user types '?' at idle REPL prompt.
 */
import { renderBox } from './box.js';
import { ansi } from '../utils/ansi.js';

export const SHORTCUT_ENTRIES = [
  { key: '?',          desc: 'Show this keyboard shortcut reference' },
  { key: 'Ctrl+C',    desc: 'Cancel running agent turn' },
  { key: 'Ctrl+C x2', desc: 'Exit REPL (press twice within 1s)' },
  { key: 'Tab',        desc: 'Autocomplete slash command or @file path' },
  { key: 'Up / Down',  desc: 'Navigate autocomplete suggestions' },
  { key: 'Esc',        desc: 'Dismiss autocomplete popup' },
  { key: 'Left/Right', desc: 'Move cursor in input line' },
  { key: 'Home / End', desc: 'Jump to start / end of input' },
  { key: '/help',      desc: 'Show all slash commands' },
  { key: '/model',     desc: 'Interactive model picker' },
  { key: '/session',   desc: 'Show session token usage stats' },
  { key: '/new',       desc: 'Start a fresh session (saves current one)' },
  { key: '/compact',   desc: 'Manually compact context window' },
  { key: '/thoughts',  desc: 'Toggle LLM reasoning display' },
  { key: '/clear',     desc: 'Clear terminal screen' },
  { key: '/exit',      desc: 'Exit the REPL session' },
];

export function buildShortcutOverlay() {
  const maxKeyLen = SHORTCUT_ENTRIES.reduce((m, e) => Math.max(m, e.key.length), 0);
  const lines = SHORTCUT_ENTRIES.map(({ key, desc }) => {
    const pad = ' '.repeat(Math.max(0, maxKeyLen - key.length));
    return `  ${ansi.cyanBright(key)}${pad}  ${ansi.dim('\u2500')}  ${ansi.white(desc)}`;
  });
  return renderBox(lines.join('\n'), {
    title: 'Keyboard Shortcuts',
    borderStyle: 'round',
    borderColor: 'cyan',
    minWidth: 50,
  });
}
