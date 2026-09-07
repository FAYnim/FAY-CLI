/**
 * REPL Prompt History Indicator
 * Format (turn 0):  fay ❯
 * Format (turn 3):  fay [3] ❯
 */
import { ansi } from '../utils/ansi.js';

export function formatTurnBadge(turn) {
  if (!turn || turn <= 0) return '';
  return ansi.dim(ansi.yellow(`[${turn}]`));
}

export function buildPrompt({ appName, turn = 0, mode = 'build' }) {
  const badge = formatTurnBadge(turn);
  const planBadge = mode === 'plan' ? ansi.bold(ansi.yellow('[PLAN]')) : '';
  const nameStr = ansi.cyan(appName);
  const arrow = ansi.bold('\u276F');

  const parts = [nameStr];
  if (planBadge) parts.push(planBadge);
  if (badge) parts.push(badge);
  parts.push(arrow);

  return `${parts.join(' ')} `;
}
