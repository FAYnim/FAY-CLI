/**
 * Interactive Security Confirmation Dialog (Human-In-The-Loop)
 *
 * Renders a lightweight, borderless keyboard-navigable confirmation prompt
 * when the SecurityGuard intercepts a risky action.
 *
 * Format:
 *   AI ingin menjalankan perintah shell yang mungkin berisiko:
 *
 *   <command>
 *
 *   Apakah anda mengizinkannya?
 *
 *     1. Iya - Izinkan dan jalankan
 *   ▸ 2. Tolak - Batalkan tindakan
 *
 *   [↑/↓]: Navigasi  [Enter]: Pilih  [1/2]: Cepat  [Esc]: Tolak
 *
 * Navigation:
 *   ↑ / k           — move cursor up
 *   ↓ / j           — move cursor down
 *   1 / y / Y       — shortcut: select "Allow"
 *   2 / n / N       — shortcut: select "Deny"
 *   Enter           — confirm highlighted selection
 *   Esc / Ctrl+C    — abort (treated as Deny)
 *
 * Non-TTY fallback: resolves false (Deny) automatically so unattended
 * pipelines and test runners never hang waiting for keyboard input.
 */

import readline from 'node:readline';
import { ansi } from '../utils/ansi.js';

export const MENU_OPTIONS = [
  {
    index: 0,
    shortLabel: '1. Iya',
    label: '1. Iya - Izinkan dan jalankan',
    value: true,
    color: (s) => ansi.green(s),
  },
  {
    index: 1,
    shortLabel: '2. Tolak',
    label: '2. Tolak - Batalkan tindakan',
    value: false,
    color: (s) => ansi.red(s),
  },
];

export const DEFAULT_SELECTED = 1; // Default: cursor di "Tolak" (aman)

/**
 * Bangun baris-baris teks dialog tanpa border.
 *
 * @param {object} params
 * @param {string} params.description
 * @param {string} [params.target]
 * @param {string} params.question
 * @param {number} params.selected
 * @returns {string[]}
 */
export function buildDialogLines({ description, target, question, selected }) {
  const lines = [];

  // Baris baru / enter sebelum deskripsi agar tipografi lega dan tidak menempel pada baris sebelumnya
  lines.push('');
  lines.push(ansi.bold(ansi.yellow(description)));

  // Baris target / perintah (jika ada)
  if (target && target.trim()) {
    lines.push('');
    const targetLines = target.split('\n');
    for (const tl of targetLines) {
      lines.push(`  ${ansi.cyan(tl)}`);
    }
  }

  // Baris pertanyaan
  lines.push('');
  lines.push(ansi.bold(ansi.white(question)));
  lines.push('');

  // Baris opsi pilihan
  for (const opt of MENU_OPTIONS) {
    const isSelected = opt.index === selected;
    const cursor = isSelected ? ansi.bold(ansi.yellow('▸ ')) : '  ';
    const label = isSelected
      ? ansi.bold(opt.color(opt.label))
      : ansi.dim(opt.label);
    lines.push(`${cursor}${label}`);
  }

  // Baris petunjuk navigasi
  lines.push('');
  lines.push(ansi.dim('[↑/↓]: Navigasi  [Enter]: Pilih  [1/2]: Cepat  [Esc]: Tolak'));

  return lines;
}

/**
 * Tampilkan dialog konfirmasi keamanan interaktif tanpa border.
 *
 * @param {object} options
 * @param {string} [options.title='']           - Sub-judul konteks tindakan (opsional)
 * @param {string} options.description          - Penjelasan singkat tindakan AI
 * @param {string} [options.target]             - Perintah / path / URL yang akan dieksekusi
 * @param {string} [options.question]           - Pertanyaan ke pengguna
 * @param {NodeJS.ReadableStream} [options.input=process.stdin]
 * @param {NodeJS.WritableStream} [options.output=process.stdout]
 * @param {boolean} [options.enabled]           - Override TTY detection
 * @returns {Promise<boolean>}                  true = Iya, false = Tolak
 */
export function showConfirmDialog(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const description =
    options.description || 'AI ingin menjalankan tindakan yang memerlukan konfirmasi:';
  const target = options.target || '';
  const question = options.question || 'Apakah anda mengizinkannya?';

  // Deteksi TTY; non-TTY langsung auto-deny (aman)
  const isTTY = Boolean(input?.isTTY && output?.isTTY);
  const enabled = options.enabled !== undefined ? Boolean(options.enabled) : isTTY;

  return new Promise((resolve) => {
    if (!enabled) {
      // Non-TTY fallback: tolak secara otomatis agar aman di pipeline/test
      resolve(false);
      return;
    }

    let selected = DEFAULT_SELECTED;
    let renderedLineCount = 0;

    function render() {
      const lines = buildDialogLines({ description, target, question, selected });
      const frame = lines.join('\n');

      output.write('\x1b[?25l'); // Sembunyikan kursor saat menu aktif

      if (renderedLineCount > 0) {
        readline.cursorTo(output, 0);
        readline.moveCursor(output, 0, -renderedLineCount);
        output.write('\x1b[J'); // Hapus dari kursor ke bawah
      } else {
        // Render pertama kali: bersihkan sisa baris terminal aktif (misal spinner)
        output.write('\r\x1b[K');
      }

      output.write(frame + '\n');
      renderedLineCount = lines.length;
    }

    function clear() {
      output.write('\x1b[?25h'); // Kembalikan kursor
      if (renderedLineCount > 0) {
        readline.cursorTo(output, 0);
        readline.moveCursor(output, 0, -renderedLineCount);
        output.write('\x1b[J');
        renderedLineCount = 0;
      }
    }

    if (typeof input.setRawMode === 'function') {
      try { input.setRawMode(true); } catch (_) { /* ignore */ }
    }
    readline.emitKeypressEvents(input);
    if (typeof input.resume === 'function') input.resume();

    const keypressHandler = (_chunk, key) => {
      if (!key) return;

      // Ctrl+C → tolak
      if (key.ctrl && key.name === 'c') {
        done(false);
        return;
      }

      // Esc → tolak
      if (key.name === 'escape') {
        done(false);
        return;
      }

      // Enter → konfirmasi pilihan
      if (key.name === 'return' || key.name === 'enter') {
        done(MENU_OPTIONS[selected].value);
        return;
      }

      // Navigasi atas
      if (key.name === 'up' || key.name === 'k') {
        selected = (selected - 1 + MENU_OPTIONS.length) % MENU_OPTIONS.length;
        render();
        return;
      }

      // Navigasi bawah
      if (key.name === 'down' || key.name === 'j') {
        selected = (selected + 1) % MENU_OPTIONS.length;
        render();
        return;
      }

      // Shortcut angka: 1 = Iya, 2 = Tolak
      if (key.name === '1') { done(true); return; }
      if (key.name === '2') { done(false); return; }

      // Shortcut huruf: y = Iya, n = Tolak
      if (key.sequence === 'y' || key.sequence === 'Y') { done(true); return; }
      if (key.sequence === 'n' || key.sequence === 'N') { done(false); return; }
    };

    const onClose = () => done(false);

    function done(value) {
      try {
        input.removeListener('keypress', keypressHandler);
      } catch {
        /* silent-ok: readline teardown best-effort */
      }
      try {
        input.removeListener('close', onClose);
      } catch {
        /* silent-ok: readline teardown best-effort */
      }
      try {
        if (typeof input.setRawMode === 'function' && input.isTTY) {
          input.setRawMode(false);
        }
      } catch {
        /* silent-ok: readline teardown best-effort */
      }
      try {
        if (typeof input.pause === 'function') input.pause();
      } catch {
        /* silent-ok: readline teardown best-effort */
      }
      clear();
      resolve(value);
    }

    input.on('keypress', keypressHandler);
    input.on('close', onClose);

    render();
  });
}
