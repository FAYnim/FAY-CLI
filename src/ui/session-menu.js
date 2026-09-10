/**
 * Interactive TUI Session Picker
 * Zero-dependency, lightweight keyboard-driven menu for managing and switching sessions.
 */

import readline from 'node:readline';
import { ansi } from '../utils/ansi.js';

export function formatRelativeTime(isoString) {
  if (!isoString) return 'unknown';
  const diffMs = Date.now() - new Date(isoString).getTime();
  if (diffMs < 0 || Number.isNaN(diffMs)) return 'just now';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(isoString).toLocaleDateString();
}

export function buildSessionMenuItems(sessions, activeSessionId) {
  return (sessions || []).map((s) => ({
    id: s.id,
    title: s.title || s.lastMessagePreview || s.preview || '(Untitled Session)',
    updatedAt: s.updatedAt,
    relativeTime: formatRelativeTime(s.updatedAt),
    messageCount: s.messageCount || 0,
    model: s.model || 'default',
    provider: s.provider || 'gemini',
    workingDir: s.workingDir || '',
    isActive: s.id === activeSessionId,
  }));
}

function renderFrame(items, selectedIndex, showAll, workingDir, output) {
  const scopeLabel = showAll
    ? `${ansi.yellow('All Projects')}`
    : `${ansi.cyan('Current Project')} ${ansi.dim(`(${workingDir || process.cwd()})`)}`;
  const countLabel = `[${items.length} session${items.length === 1 ? '' : 's'}]`;

  const header = `${ansi.bold(ansi.cyan('⚡ Select a session'))}  ${ansi.dim('(↑/↓ navigate • Enter switch • a toggle all • r rename • d delete • n new • Esc cancel)')}`;
  const lines = [header, `Scope: ${scopeLabel} ${ansi.dim(countLabel)}`, ''];

  if (items.length === 0) {
    lines.push(
      `  ${ansi.dim("(no sessions found in this scope — press 'a' for all projects or 'n' for new)")}`,
    );
  } else {
    items.forEach((it, idx) => {
      const isSelected = idx === selectedIndex;
      const cursor = isSelected ? ansi.green('▸') : ' ';
      const marker = it.isActive ? ansi.green('●') : ansi.dim('○');
      const title = isSelected ? ansi.bold(ansi.whiteBright(it.title)) : ansi.white(it.title);
      const activeTag = it.isActive ? ` ${ansi.green('(active)')}` : '';

      lines.push(`  ${cursor} ${marker} ${title}${activeTag}`);
      const meta = `${it.id} · ${it.messageCount} msgs · ${it.relativeTime} · ${it.model}`;
      lines.push(`      ${ansi.dim(meta)}`);
    });
  }

  lines.push('');
  output.write(`\x1B[2J\x1B[H${lines.join('\n')}\n`);
}

/**
 * Displays interactive session selection menu in TTY, or falls back in non-TTY.
 *
 * @param {object} options
 * @param {import('../agent/session.js').SessionManager} options.sessionManager
 * @param {string} [options.activeSessionId]
 * @param {string} [options.workingDir]
 * @param {NodeJS.ReadableStream} [options.input]
 * @param {NodeJS.WritableStream} [options.output]
 * @returns {Promise<{ cancelled: boolean, action?: 'switch'|'new', sessionId?: string, isNonTty?: boolean }>}
 */
export async function showSessionMenu({
  sessionManager,
  activeSessionId = null,
  workingDir = process.cwd(),
  input = process.stdin,
  output = process.stdout,
}) {
  const isInteractiveTty = Boolean(output?.isTTY && input?.isTTY);
  if (!isInteractiveTty) {
    return { cancelled: true, isNonTty: true };
  }

  return new Promise((resolve) => {
    let showAll = false;
    let items = buildSessionMenuItems(
      sessionManager.listSessions({ workingDir, all: showAll }),
      activeSessionId,
    );

    let selectedIndex = 0;
    const activeIdx = items.findIndex((it) => it.isActive);
    if (activeIdx >= 0) selectedIndex = activeIdx;

    if (typeof input.resume === 'function') input.resume();
    if (typeof input.setRawMode === 'function') {
      try {
        input.setRawMode(true);
      } catch (_) {}
    }
    readline.emitKeypressEvents(input);

    let isPrompting = false;

    renderFrame(items, selectedIndex, showAll, workingDir, output);

    const cleanup = (result) => {
      try {
        input.removeListener('keypress', onKeypress);
      } catch (_) {}
      try {
        if (typeof input.setRawMode === 'function' && input.isTTY) {
          input.setRawMode(false);
        }
      } catch (_) {}
      output.write('\x1B[2J\x1B[H');
      resolve(result);
    };

    const onKeypress = async (_chunk, key) => {
      if (isPrompting || !key) return;

      if ((key.ctrl && key.name === 'c') || key.name === 'escape' || key.name === 'q') {
        cleanup({ cancelled: true });
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        const chosen = items[selectedIndex];
        if (!chosen) {
          cleanup({ cancelled: true });
          return;
        }
        cleanup({ cancelled: false, action: 'switch', sessionId: chosen.id });
        return;
      }

      if (key.name === 'up' || key.name === 'k') {
        if (items.length > 0) {
          selectedIndex = (selectedIndex - 1 + items.length) % items.length;
          renderFrame(items, selectedIndex, showAll, workingDir, output);
        }
        return;
      }

      if (key.name === 'down' || key.name === 'j') {
        if (items.length > 0) {
          selectedIndex = (selectedIndex + 1) % items.length;
          renderFrame(items, selectedIndex, showAll, workingDir, output);
        }
        return;
      }

      // 'a' -> toggle all / project scoped
      if (key.name === 'a') {
        showAll = !showAll;
        items = buildSessionMenuItems(
          sessionManager.listSessions({ workingDir, all: showAll }),
          activeSessionId,
        );
        selectedIndex = Math.min(selectedIndex, Math.max(0, items.length - 1));
        renderFrame(items, selectedIndex, showAll, workingDir, output);
        return;
      }

      // 'n' -> new session
      if (key.name === 'n') {
        cleanup({ cancelled: false, action: 'new' });
        return;
      }

      // 'd' -> delete selected session
      if (key.name === 'd' && items.length > 0) {
        const target = items[selectedIndex];
        if (target.isActive) {
          output.write(`\n${ansi.yellow('⚠ Cannot delete currently active session.')}\n`);
          setTimeout(() => renderFrame(items, selectedIndex, showAll, workingDir, output), 1500);
          return;
        }

        isPrompting = true;
        input.setRawMode(false);
        const rl = readline.createInterface({ input, output });
        rl.question(`\nDelete session "${target.title}" (${target.id})? [y/N]: `, (ans) => {
          rl.close();
          input.setRawMode(true);
          isPrompting = false;
          if (ans.trim().toLowerCase() === 'y') {
            sessionManager.deleteSession(target.id);
            items = buildSessionMenuItems(
              sessionManager.listSessions({ workingDir, all: showAll }),
              activeSessionId,
            );
            selectedIndex = Math.min(selectedIndex, Math.max(0, items.length - 1));
          }
          renderFrame(items, selectedIndex, showAll, workingDir, output);
        });
        return;
      }

      // 'r' -> rename selected session
      if (key.name === 'r' && items.length > 0) {
        const target = items[selectedIndex];
        isPrompting = true;
        input.setRawMode(false);
        const rl = readline.createInterface({ input, output });
        rl.question(`\nNew title for session "${target.title}": `, (ans) => {
          rl.close();
          input.setRawMode(true);
          isPrompting = false;
          const newTitle = ans.trim();
          if (newTitle) {
            sessionManager.renameSession(target.id, newTitle);
            items = buildSessionMenuItems(
              sessionManager.listSessions({ workingDir, all: showAll }),
              activeSessionId,
            );
          }
          renderFrame(items, selectedIndex, showAll, workingDir, output);
        });
        return;
      }
    };

    input.on('keypress', onKeypress);
  });
}
