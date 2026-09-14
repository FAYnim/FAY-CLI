# H-1 Command Path Jail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tutup bug audit H-1 (`docs/AUDIT-FINDINGS-2026-09-14.md`): `execute_command` tidak mengecek path yang muncul di *teks* command terhadap jail workspace, sehingga `sed -i ~/.bashrc`, `echo x >> /etc/crontab`, `mv src ../outside`, dan perintah Windows (`del /f`, `rd /s /q %USERPROFILE%\...`, `Remove-Item -Recurse -Force`) lolos tanpa prompt.

**Architecture:** Tiga lapis, semua di `src/security/`. (1) Perbaiki `PROTECTED_PATH_PATTERNS` — regex lama mewajibkan karakter setelah path harus spasi/`;`/`&`, sehingga `~/.bashrc` dan `/etc/crontab` lolos; ekspansi daftar + tambah shortcut home + direktori Windows. (2) Tambah `RISKY_COMMAND_PATTERNS` (sed -i, mv, ln, truncate, tee, rsync, redirect ke path absolut, verbs Windows) dan `BLACKLIST_PATTERNS` (format drive, wipe root drive). (3) File baru `command-paths.js`: tokenizer shell-lite quote-aware + `findPathsOutsideJail()` yang me-resolve tiap token mirip-path terhadap jail pakai `validateSafePath` yang sudah ada; `guard.authorize` mengubah hasil temuan jadi satu prompt HITL gabungan.

**Tech Stack:** Node.js ESM >=20, `node:test` + `node:assert/strict`, Biome. Tanpa dependency baru (zero-native rule).

**Luar scope (sengaja):** M-4 (`-y` tetap bypass prompt risky/luar-jail — protected path tetap hard-deny walau `-y`, karena blacklist dicek sebelum `autoApprove`), dan M-1 (symlink realpath).

---

## File Structure

| File | Aksi | Tanggung jawab |
|---|---|---|
| `src/security/rules.js` | Modify (:38-46 protected, :52-71 blacklist, :77-98 risky) | Definisi pattern regex murni |
| `src/security/command-paths.js` | Create | Tokenisasi command + ekstraksi path di luar jail |
| `src/security/guard.js` | Modify (case `execute_command` :237-284) | Merangkai hasil ekstraksi ke prompt HITL |
| `tests/h1-command-jail.test.js` | Create | Semua test unit + integrasi H-1 |
| `SECURITY.md` | Modify (:22) | Update dokumentasi pattern |
| `docs/ROADMAP.md` | Modify | Tandai H-1 selesai |

Semua baris referensi akurat per HEAD `397b7a8`; kalau bergeser, cari pola teks yang sama.

---

### Task 1: Perbaiki & ekspansi `PROTECTED_PATH_PATTERNS`

Bug inti: karakter setelah path **wajib** `[\s;&|><]`, jadi `~/.bashrc` (disusul `/`) dan `/etc/crontab` tidak match. Fix: tail path diizinkan lewat `(?:\/[^\s;&|><"']*)?`, plus kelas prekursor diperluas (`"'(`) supaya `">>/etc/...` dan `"${HOME}/..."` ikut kena. `/home` sengaja TIDAK masuk protected (jail user Windows/Linux sering di bawahnya) — itu ditangani Task 3 (prompt, bukan deny).

- [ ] **Step 1: Tulis test gagal**

Buat `tests/h1-command-jail.test.js`:

```js
/**
 * Audit H-1 (docs/AUDIT-FINDINGS-2026-09-14.md): command text must not
 * silently touch paths outside the workspace jail.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SecurityGuard } from '../src/security/guard.js';
// import { findPathsOutsideJail, tokenizeCommand } from '../src/security/command-paths.js';
// ^ aktifkan mulai Task 3 (modul belum ada saat Task 1–2 dijalankan)

describe('H-1: command path jail', () => {
  let baseDir;
  let guard;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faycli-h1-'));
    guard = new SecurityGuard({ baseDir });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  describe('PROTECTED_PATH_PATTERNS (hard-deny, juga saat -y)', () => {
    test('home shortcut dengan tail path diblok', () => {
      for (const cmd of [
        "sed -i 's/.*/EVIL/' ~/.bashrc",
        'echo x >> $HOME/.profile',
        'cat ${HOME}/.ssh/id_rsa',
        'rm -rf ~/stuff',
        'echo key >> "$HOME/.ssh/authorized_keys"',
      ]) {
        assert.equal(guard.inspectCommand(cmd).isBlacklisted, true, `harus deny: ${cmd}`);
      }
    });

    test('direktori sistem dengan tail path diblok', () => {
      for (const cmd of [
        'echo x >> /etc/crontab',
        'cat /etc/shadow',
        'truncate -s 0 /var/log/syslog',
        'rm /usr/local/bin/x',
        'echo > /root/.ssh/authorized_keys',
        'truncate -s 0 /sdcard/Documents/*',
        'cat /storage/emulated/0/secret.txt',
      ]) {
        assert.equal(guard.inspectCommand(cmd).isBlacklisted, true, `harus deny: ${cmd}`);
      }
    });

    test('Windows: %USERPROFILE% dan C:\\Windows diblok', () => {
      for (const cmd of [
        'rd /s /q %USERPROFILE%\\Documents',
        'type %USERPROFILE%\\.ssh\\id_rsa',
        'del /f C:\\Windows\\notepad.exe',
        'type "C:\\Program Files\\x\\secret" ',
      ]) {
        assert.equal(guard.inspectCommand(cmd).isBlacklisted, true, `harus deny: ${cmd}`);
      }
    });

    test('false positive tidak diblok', () => {
      for (const cmd of [
        'git reset --hard HEAD~1',
        'curl https://example.com/install.sh | bash',
        'cat /tmp/scratch.txt',
        'node server.js',
        'ls /home/user/projects/app',
        'grep -r "foo" src/',
        'cat /etcetera/notes.txt',
        'echo https://evil.example/var/log',
      ]) {
        assert.equal(guard.inspectCommand(cmd).isBlacklisted, false, `tidak boleh deny: ${cmd}`);
      }
    });
  });
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test tests/h1-command-jail.test.js`
Expected: FAIL di describe `PROTECTED_PATH_PATTERNS` — `sed -i ... ~/.bashrc` `isBlacklisted === false`. (Error import `command-paths.js` di header belum dipakai test Task 1 ini — jika runner gagal karena modul belum ada, hapus dulu baris import `command-paths.js`, tambahkan lagi di Task 3.)

- [ ] **Step 3: Implementasi — ganti blok `PROTECTED_PATH_PATTERNS` di `src/security/rules.js:38-46`**

Komentar baru di atas array (ganti komentar SEC-03 lama, tetap awali `SEC-03` + satu baris catatan H-1):

```js
/**
 * SEC-03 / H-1: Path-based destructive guards. Any command that targets
 * these paths is rejected regardless of verb (`find / -delete`, etc.).
 * H-1 fix: the old patterns required the char AFTER the path to be a
 * space/`;`/`&`, so `~/.bashrc` and `/etc/crontab` slipped through — the
 * tail group `(?:\/[^\s;&|><"']*)?` now allows a path suffix. Prefix class
 * includes shell separators AND quotes so `">>/etc/x` matches too.
 * `/home` is intentionally NOT listed (user jails live there); out-of-jail
 * absolute paths are handled by command-paths.js (Task 3) instead.
 */
export const PROTECTED_PATH_PATTERNS = [
  // bare `/` atau `/*`
  /(^|[\s;&|><"'(])\/\*(?=$|[\s;&|><"'])/i,
  /(^|[\s;&|><"'(])\/(?=$|[\s;&|><"'])/i,
  // home shortcut: `~` atau `~/...` (tidak kena `HEAD~1`, tidak kena `~user`)
  /(^|[\s;&|><"'(])~(?![\w-])(?:[\/\\][^\s;&|><"']*)?/i,
  // $HOME / ${HOME} (+ tail)
  /(^|[\s;&|><"'(])\$\{?(?:HOME|USERPROFILE)\}?(?![\w])(?:[\/\\][^\s;&|><"']*)?/i,
  // %USERPROFILE% / %HOME% Windows (+ tail)
  /(^|[\s;&|><"'(])%(?:USERPROFILE|HOME)%(?![\w])(?:[\/\\][^\s;&|><"']*)?/i,
  // $env:USERPROFILE PowerShell (+ tail)
  /(^|[\s;&|><"'(])\$env:(?:HOME|USERPROFILE)(?![\w])(?:[\/\\][^\s;&|><"']*)?/i,
  // direktori sistem POSIX — bare atau + tail
  /(^|[\s;&|><"'(])\/(?:etc|boot|var|root|usr|bin|sbin|lib|sdcard|storage)(?![\w-])(?:\/[^\s;&|><"']*)?/i,
  // direktori sistem Windows
  /(^|[\s;&|><"'(])[A-Za-z]:[\\/](?:Windows|Program Files(?: \(x86\))?)(?![\w])(?:[\\/][^\s;&|><"']*)?/i,
];
```

Keep comment `SEC-03` lama di atasnya, tambah satu baris penjelasan fix H-1.

- [ ] **Step 4: Jalankan test baru + test lama**

Run: `node --test tests/h1-command-jail.test.js tests/step2-security.test.js`
Expected: PASS semua. Khususnya `dangerousCommands` lama (`rm -rf ~`, `rm -rf /*`, `rm -rf $HOME`, `chmod -R 777 /`) masih blacklisted, dan `git reset --hard HEAD~1` masih `isBlacklisted: false, isRisky: true`.

- [ ] **Step 5: Commit**

```bash
git add src/security/rules.js tests/h1-command-jail.test.js
git commit -m "fix(security): close protected-path regex gaps and add Windows/home shortcuts (H-1)"
```

---

### Task 2: Pattern risky & blacklist baru (POSIX + Windows)

Menutup celah: `sed`/`mv`/`ln`/`truncate`/`tee`/redirect ke path absolut tidak pernah berstatus risky; verbs Windows (`rd /s`, `del /f`, `Remove-Item`) tidak match apa pun.

- [ ] **Step 1: Tulis test gagal**

Tambah di dalam `describe('H-1: command path jail', ...)` (sebelum closing `});` terakhir file test):

```js
  describe('RISKY/BLACKLIST tambahan', () => {
    test('file-mutation verbs jadi risky', () => {
      // Catatan: `echo x >> ./log.txt` TIDAK di sini — redirect ke path
      // dalam-jail tidak perlu prompt; yang gated hanya redirect absolut/home-ish.
      for (const cmd of [
        'sed -i s/a/b/ notes.txt',
        'mv src ../outside',
        'ln -s ../secret ./notes.txt',
        'truncate -s 0 file.txt',
        'echo x | tee out.txt',
        'rsync -a src/ dst/',
        'echo secret > /tmp/x.txt',
      ]) {
        const insp = guard.inspectCommand(cmd);
        assert.equal(insp.isRisky, true, `harus risky: ${cmd}`);
        assert.equal(insp.isBlacklisted, false, `tidak boleh deny: ${cmd}`);
      }
    });

    test('verbs Windows jadi risky', () => {
      for (const cmd of [
        'del /f notes.txt',
        'rd /s /q build',
        'Remove-Item -Recurse -Force dir',
        'powershell -c "Remove-Item x"',
      ]) {
        const insp = guard.inspectCommand(cmd);
        assert.equal(insp.isRisky, true, `harus risky: ${cmd}`);
        assert.equal(insp.isBlacklisted, false, `tidak boleh deny: ${cmd}`);
      }
    });

    test('wipe root drive diblok total', () => {
      for (const cmd of [
        'rd /s /q C:\\',
        'format C:',
        'Remove-Item -Recurse -Force C:\\',
      ]) {
        assert.equal(guard.inspectCommand(cmd).isBlacklisted, true, `harus deny: ${cmd}`);
      }
    });

    test('perintah jail biasa tetap tidak risky', () => {
      for (const cmd of [
        'git status',
        'ls -la',
        'npm test',
        'cat package.json',
        'node index.js',
        'echo hi',
        'npm run build 2>&1',
        'make clean 2>/dev/null',
        'git mv a.txt b.txt',
        'node -e "console.log(1)"',
      ]) {
        const insp = guard.inspectCommand(cmd);
        assert.equal(insp.isRisky, false, `tidak boleh risky: ${cmd}`);
        assert.equal(insp.isBlacklisted, false, `tidak boleh deny: ${cmd}`);
      }
    });
  });
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test tests/h1-command-jail.test.js`
Expected: FAIL — `sed -i s/a/b/ notes.txt` `isRisky === false`, `del /f notes.txt` tidak risky, `rd /s /q C:\` tidak blacklisted.

- [ ] **Step 3: Implementasi — `src/security/rules.js`**

a. Append di akhir array `BLACKLIST_PATTERNS` (setelah pola `mount`, sebelum `];`):

```js
  // H-1: Windows root-drive wipes and formatters. `format C: Label` (tanpa
  // switch) TIDAK di-blok — volume label, bukan destructive wipe.
  /\bformat(?:\.com)?\s+[a-z]:\s*[\/\\]/i,
  /\b(rd|rmdir)\s+\/[a-z]\s*(?:\/[a-z]\s*)*[a-z]:\\(?:\*)?(?=$|[\s;&|])/i,
  /\b(del|erase)\s+\/[a-z]\s*(?:\/[a-z]\s*)*[a-z]:\\(?:\*)?(?=$|[\s;&|])/i,
  /\bRemove-Item\b.*-Recurse.*-Force.*(?:[a-z]:\\(?:\*)?(?=$|[\s;&|])|%USERPROFILE%)/i,
```

b. Append di akhir array `RISKY_COMMAND_PATTERNS` (`rules.js:77-98`, setelah pola `npm install -g` — jangan hapus pola lama):

```js
  // H-1: in-place file rewriting (`sed -i` / `sed -i.bak`).
  /\bsed\s+-i(\.\S*)?\b/i,

  // H-1: file-mutation verbs — `git mv` dikecualikan via negative lookbehind.
  // (?<!...) harus di depan GROUP, bukan di dalam alternation.
  /(?<!git\s)(?:^|[;&|()\s])(mv|rename|ln|truncate|tee|rsync)(?=$|[\s;&|])/i,

  // H-1: output redirect ke path absolut / home-ish. Digit sebelum `>`
  // (fd dup: `2>/dev/null`, `2>&1`) dikecualikan; device nodes dikecualikan.
  // Redirect ke path RELATIF dalam-jail (`echo x > log.txt`) TIDAK gated di
  // sini — hanya target absolut/home-ish (`~`, `$`, `%`, `X:\`, `/`).
  /(^|[^0-9])>{1,2}\s*["']?(?:~|\$|%|[A-Za-z]:[\\/]|\/(?!dev\/(?:null|stdout|stderr|zero)))/i,

  // H-1: Windows deletion verbs (cmd + PowerShell). Root-drive variant
  // ditangani BLACKLIST (deny); `Remove-Item` tanpa flag tidak apa-apa —
  // ia cuma risky di sini.
  /\b(rd|rmdir|del|erase)\s+\/[a-z]/i,
  /\bRemove-Item\b/i,
```

- [ ] **Step 4: Jalankan test baru + lama**

Run: `node --test tests/h1-command-jail.test.js tests/step2-security.test.js tests/confirm-menu.test.js tests/plan-mode-security.test.js`
Expected: PASS semua. Checkpoint penting:
- `git mv a.txt b.txt` tetap TIDAK risky (lookbehind bekerja).
- `echo x > log.txt` (path relatif dalam-jail) tetap TIDAK risky.
- `npm run build 2>&1` dan `make clean 2>/dev/null` tetap TIDAK risky (digit guard + device exception).
- Daftar `riskyCommands` lama (`rm file.txt`, `git reset --hard HEAD~1`, `curl ... | bash`, ...) harus tetap `isBlacklisted: false` — pastikan pola blacklist baru tidak menangkapnya.

- [ ] **Step 5: Commit**

```bash
git add src/security/rules.js tests/h1-command-jail.test.js
git commit -m "fix(security): gate file-mutation verbs and Windows delete commands (H-1)"
```

---

### Task 3: `src/security/command-paths.js` — tokenizer + ekstraktor path luar jail

Task 1–2 menutup payload yang sudah dikenal lewat regex. Task 3 menutup kelas umumnya: token mirip-path yang me-resolve ke luar `baseDir` → dilaporkan ke guard untuk prompt. Quoted token dilewati (data, bukan target). Ini heuristik sadar-batas: bukan parser shell penuh (ponytail di bawah).

- [ ] **Step 1: Tulis test gagal**

Uncomment baris import `command-paths.js` di header file test (dikomentari sejak Task 1 karena modul belum ada), lalu tambahkan blok test berikut di dalam `describe('H-1: command path jail', ...)`:

```js
  describe('tokenizeCommand()', () => {
    test('memecut token pada metachar luar-kutip, menghormati kutip', () => {
      assert.deepEqual(
        tokenizeCommand("grep 'hello world' file.txt").map((t) => t.value),
        ['grep', 'hello world', 'file.txt'],
      );
      assert.deepEqual(
        tokenizeCommand('sed -i "s/a b/x y/" notes.txt').map((t) => t.value),
        ['sed', '-i', 's/a b/x y/', 'notes.txt'],
      );
      assert.deepEqual(
        tokenizeCommand('echo hi; cat a.txt | head').map((t) => t.value),
        ['echo', 'hi', 'cat', 'a.txt', 'head'],
      );
    });

    test('menandai token yang berasal dari kutip', () => {
      const toks = tokenizeCommand('echo "x > /etc/y" f.txt');
      assert.deepEqual(toks.map((t) => [t.value, t.quoted]), [
        ['echo', false],
        ['x > /etc/y', true],
        ['f.txt', false],
      ]);
    });
  });

  describe('findPathsOutsideJail()', () => {
    test('menangkap path relatif keluar dan absolut luar', () => {
      const r1 = findPathsOutsideJail('mv src ../outside', baseDir);
      assert.deepEqual(r1.map((p) => p.raw), ['../outside']);

      const outsideAbs = path.join(path.dirname(baseDir), 'secret.env');
      const r2 = findPathsOutsideJail(`cat ${outsideAbs}`, baseDir);
      assert.equal(r2.length, 1);
      assert.equal(r2[0].resolved, path.resolve(outsideAbs));
    });

    test('path di dalam jail tidak dilaporkan', () => {
      fs.mkdirSync(path.join(baseDir, 'src'), { recursive: true });
      const insideAbs = path.join(baseDir, 'src', 'a.js');
      for (const cmd of ['mv a.js b.js', `cat ${insideAbs}`, 'grep foo src/a.js']) {
        assert.deepEqual(findPathsOutsideJail(cmd, baseDir), [], `tidak boleh lapor: ${cmd}`);
      }
    });

    test('token quoted, flag, dan URL dilewati', () => {
      for (const cmd of [
        'curl -s https://example.com/a/b',
        'git commit -m "touch ../outside" --author=x@y',
        'node -e "require(\'../outside\')"',
        'echo "see ../outside for docs"',
      ]) {
        assert.deepEqual(findPathsOutsideJail(cmd, baseDir), [], `tidak boleh lapor: ${cmd}`);
      }
    });

    test('tilde di-resolve ke home user (luar jail)', () => {
      const r = findPathsOutsideJail('echo hi >> ~/notes.txt', baseDir);
      assert.equal(r.length, 1);
      assert.equal(r[0].resolved, path.join(os.homedir(), 'notes.txt'));
    });

    test('$VAR yang tidak ter-resolve dianggap keluar (fail-closed)', () => {
      delete process.env.FAYCLI_H1_UNSET_VAR;
      const r = findPathsOutsideJail('cat $FAYCLI_H1_UNSET_VAR/data.bin', baseDir);
      assert.equal(r.length, 1);
      assert.equal(r[0].resolved, null);
    });

    test('allowedDirs dihormati', () => {
      const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'faycli-h1-extra-'));
      try {
        assert.deepEqual(
          findPathsOutsideJail(`cat ${path.join(extra, 'f.txt')}`, baseDir, {
            allowedDirs: [extra],
          }),
          [],
        );
      } finally {
        fs.rmSync(extra, { recursive: true, force: true });
      }
    });
  });
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test tests/h1-command-jail.test.js`
Expected: FAIL — `Cannot find module '../src/security/command-paths.js'`.

- [ ] **Step 3: Implementasi — buat `src/security/command-paths.js`**

```js
/**
 * H-1: Command-text path auditing.
 *
 * `SecurityGuard.inspectCommand` only pattern-matches the raw command string.
 * This module tokenizes a command shell-lite (quote-aware) and resolves every
 * *unquoted* path-looking token against the workspace jail, so the guard can
 * prompt before `mv notes.txt ../outside` runs silently.
 *
 * ponytail: heuristic, not a full shell parser. Ceiling — quoted tokens are
 * skipped (`bash -c 'cat ../outside'` is not caught here, only by the
 * pattern layer), `$(...)`/backtick substitutions are opaque, cmd.exe and
 * POSIX quoting differ slightly on backslash handling. Upgrade path: swap
 * `tokenizeCommand` for a real shlex port if false positives ever demand it.
 */

import os from 'node:os';
import path from 'node:path';
import { validateSafePath } from './path-validator.js';

const SPLIT_CHARS = /[\s;&|<>()]/;
const TRAILING_PUNCT = /[*?:,"']+$/;
const DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const IS_WINDOWS = path.sep === '\\';

/**
 * Quote-aware tokenizer. Mirrors POSIX-ish splitting; returns
 * `{ value, quoted }` so callers can skip quoted payloads (data, not target).
 *
 * @param {string} command
 * @returns {Array<{ value: string, quoted: boolean }>}
 */
export function tokenizeCommand(command) {
  const out = [];
  let current = '';
  let hasToken = false;
  let sawQuote = false;
  let quote = null; // "'" | '"' | null

  const flush = () => {
    if (hasToken) out.push({ value: current, quoted: sawQuote });
    current = '';
    hasToken = false;
    sawQuote = false;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && !IS_WINDOWS && '"$`\\'.includes(command[i + 1])) current += command[++i];
      else current += ch;
      continue;
    }
    if (ch === "'") { quote = "'"; hasToken = true; sawQuote = true; continue; }
    if (ch === '"') { quote = '"'; hasToken = true; sawQuote = true; continue; }
    if (ch === '\\' && !IS_WINDOWS && i + 1 < command.length) {
      current += command[++i];
      hasToken = true;
      continue;
    }
    if (SPLIT_CHARS.test(ch)) { flush(); continue; }
    current += ch;
    hasToken = true;
  }
  flush();
  return out;
}

Lalu lanjutkan file dengan:

```js
/**
 * Heuristic: does this unquoted token *look* like a path reference?
 * Flags (`-i`), URLs (`https://`), and plain words never do.
 *
 * @param {string} bare
 * @returns {boolean}
 */
function looksLikePath(bare) {
  if (!bare || bare.startsWith('-')) return false;
  if (bare.includes('://')) return false;
  if (DRIVE_RE.test(bare)) return true;
  if (bare === '~' || /^~[\\/]/.test(bare)) return true;
  if (/^\.\.?[\\/]/.test(bare)) return true;
  if (bare.startsWith('/')) return true;
  // $VAR/path, ${VAR}/path, %VAR%\path, $env:VAR\path
  if (/[\/\\]/.test(bare) && /[$%]\{?[\w:]+\}?(?:%|:)?[\/\\]/.test(bare)) return true;
  return false;
}

/**
 * Expands `~`, `$VAR`/`${VAR}` (HOME falls back to os.homedir()), and
 * `%VAR%` / `$env:VAR`, then resolves against the jail. Returns `null`
 * when the token still contains an unresolvable variable reference —
 * callers must treat unknown as outside (fail-closed).
 *
 * @param {string} raw
 * @param {string} baseDir
 * @returns {string | null}
 */
function expandAndResolve(raw, baseDir) {
  let s = raw;
  if (IS_WINDOWS) {
    s = s.replace(/"/g, '');
  }
  s = s.replace(/^~/, () => os.homedir());
  s = s.replace(/\$\{?(\w+)\}?/g, (m, name) => {
    const val = name === 'HOME' ? os.homedir() : process.env[name];
    return val !== undefined ? val : m;
  });
  s = s.replace(/%(\w+)%/g, (m, name) => {
    const val = name === 'USERPROFILE' ? os.homedir() : process.env[name];
    return val !== undefined ? val : m;
  });
  s = s.replace(/\$env:(\w+)/gi, (m, name) => {
    const val = name.toLowerCase() === 'userprofile' ? os.homedir() : process.env[name];
    return val !== undefined ? val : m;
  });
  // Unresolvable variable left ⇒ fail-closed.
  if (/\$\{?\w/.test(s) || /%\w+%/.test(s) || /\$env:\w/i.test(s)) return null;
  // Drive-letter reference on POSIX is suspicious regardless of resolution.
  if (!IS_WINDOWS && DRIVE_RE.test(s)) return null;
  // Backslash-separated path on POSIX cannot be resolved meaningfully.
  if (!IS_WINDOWS && s.includes('\\')) return null;
  return path.resolve(baseDir, s);
}

/**
 * Find unquoted path-like tokens that resolve OUTSIDE the workspace jail.
 *
 * @param {string} command - raw command text
 * @param {string} baseDir - workspace jail root
 * @param {object} [options={}] - passed through to validateSafePath
 * @param {string[]} [options.allowedDirs]
 * @param {boolean} [options.allowTermuxStorage]
 * @returns {Array<{ raw: string, resolved: string | null }>} deduped by `raw`;
 *   `resolved === null` means unresolvable variable ⇒ treat as outside.
 */
export function findPathsOutsideJail(command, baseDir, options = {}) {
  const out = [];
  const seen = new Set();
  if (!command || typeof command !== 'string' || !baseDir) return out;

  for (const token of tokenizeCommand(command)) {
    if (token.quoted) continue;
    const bare = token.value.replace(TRAILING_PUNCT, '');
    if (!looksLikePath(bare)) continue;
    if (seen.has(bare)) continue;
    const resolved = expandAndResolve(bare, baseDir);
    if (resolved === null) {
      seen.add(bare);
      out.push({ raw: token.value, resolved: null });
      continue;
    }
    const validation = validateSafePath(resolved, baseDir, options);
    if (!validation.isAllowed) {
      seen.add(bare);
      out.push({ raw: token.value, resolved: validation.resolvedPath });
    }
  }
  return out;
}
```

- [ ] **Step 4: Jalankan test**

Run: `node --test tests/h1-command-jail.test.js`
Expected: PASS semua (blok Task 1–2 dan Task 3). Test Windows-drive di platform POSIX tetap lolos karena `expandAndResolve` mengembalikan `null` (fail-closed) yang di-assert sebagai luar.

- [ ] **Step 5: Commit**

```bash
git add src/security/command-paths.js tests/h1-command-jail.test.js
git commit -m "feat(security): add quote-aware command tokenizer and jail path extractor (H-1)"
```

---

### Task 4: Wire ke `guard.authorize('execute_command')`

Satu prompt gabungan: command yang berisiko ATAU menyentuh path luar jail → dialog, dengan daftar path-nya di `target`. `autoApprove` (-y) tetap bypass prompt (semantik M-4, sengaja di luar scope) — protected path sudah hard-deny dari Task 1 walau `-y`.

- [ ] **Step 1: Tulis test gagal**

Tambah blok berikut di dalam `describe('H-1: command path jail', ...)`:

```js
  describe('authorize(execute_command) — prompt untuk path luar jail', () => {
    test('menolak command yang menyentuh path luar saat user deny', async () => {
      let description = '';
      const g = new SecurityGuard({
        baseDir,
        confirmationHandler: async (msg) => {
          description = msg;
          return false;
        },
      });
      const outside = path.join(path.dirname(baseDir), 'secret.env');
      const res = await g.authorize('execute_command', { command: `cat ${outside}` });
      assert.equal(res.allowed, false);
      assert.match(res.reason, /outside workspace/i);
      assert.match(description, /luar workspace/i);
    });

    test('mengizinkan setelah user approve', async () => {
      const g = new SecurityGuard({
        baseDir,
        confirmationHandler: async () => true,
      });
      const outside = path.join(path.dirname(baseDir), 'secret.env');
      const res = await g.authorize('execute_command', { command: `cat ${outside}` });
      assert.equal(res.allowed, true);
    });

    test('command in-jail tidak memicu prompt', async () => {
      let prompted = false;
      const g = new SecurityGuard({
        baseDir,
        confirmationHandler: async () => {
          prompted = true;
          return false;
        },
      });
      fs.writeFileSync(path.join(baseDir, 'a.txt'), 'x');
      const res = await g.authorize('execute_command', { command: 'cat a.txt' });
      assert.equal(res.allowed, true);
      assert.equal(prompted, false);
    });

    test('deskripsi prompt menyebut path luar saat command menyentuhnya, approve tetap lolos', async () => {
      // `confirmationHandler` dipanggil dengan `legacyMessage` = field
      // `description` dari dialog terstruktur (guard.js:169-175) — jadi
      // yang di-assert deskripsinya, bukan `target`.
      let description = '';
      const g = new SecurityGuard({
        baseDir,
        confirmationHandler: async (msg) => {
          description = msg;
          return true;
        },
      });
      const outside = path.join(path.dirname(baseDir), 'outside.txt');
      const res = await g.authorize('execute_command', { command: `touch ${outside}` });
      assert.equal(res.allowed, true);
      assert.match(description, /luar workspace/i);
    });
  });
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test tests/h1-command-jail.test.js`
Expected: FAIL — `cat <abs-luar>` saat ini `allowed: true` tanpa prompt (hanya `workingDir` yang dicek).

- [ ] **Step 3: Implementasi — `src/security/guard.js`**

a. Tambah import (blok import `src/security/guard.js:13`):

```js
import { findPathsOutsideJail } from './command-paths.js';
```

b. Di `authorize` case `execute_command`: setelah blok `if (workingDir) {...}` (`guard.js:252-267`) dan SEBELUM blok `if (inspection.isRisky && !this.autoApprove)` — ganti blok isRisky lama (`guard.js:269-281`) dengan blok gabungan ini:

```js
        // H-1: paths appearing inside the command text must respect the jail
        // too — validateSafePath was only ever applied to `workingDir`.
        const outsidePaths = findPathsOutsideJail(command, this.baseDir, this._pathOptions());
        const needsPrompt = inspection.isRisky || outsidePaths.length > 0;

        if (needsPrompt && !this.autoApprove) {
          const outsideList = outsidePaths.map((p) => `- ${p.raw}`).join('\n');
          const description = outsidePaths.length
            ? 'AI ingin menjalankan perintah shell yang menyentuh path di luar workspace:'
            : 'AI ingin menjalankan perintah shell yang mungkin berisiko:';
          const target = outsidePaths.length
            ? `${command}\n\nPath di luar workspace:\n${outsideList}`
            : command;
          const confirmed = await this.promptConfirmation({
            description,
            target,
            question: 'Apakah anda mengizinkannya?',
          });
          if (!confirmed) {
            return {
              allowed: false,
              reason: outsidePaths.length
                ? `User denied execution: command touches paths outside workspace ("${outsidePaths[0].raw}").`
                : `User denied execution of risky command: "${command}".`,
            };
          }
        }
```

Perhatikan: test lama di `step2-security.test.js` meng-assert reason `/User denied execution/i` untuk risky — kedua cabang reason tetap cocok pola itu.

- [ ] **Step 4: Jalankan seluruh test security + related**

Run: `node --test tests/h1-command-jail.test.js tests/step2-security.test.js tests/confirm-menu.test.js tests/plan-mode-security.test.js tests/step4-orchestrator.test.js`
Expected: PASS semua.

- [ ] **Step 5: Commit**

```bash
git add src/security/guard.js tests/h1-command-jail.test.js
git commit -m "fix(security): validate command-text paths against workspace jail before exec (H-1)"
```

---

### Task 5: Green sweep + dokumentasi

- [ ] **Step 1: Full suite + lint**

Run: `npm test` lalu `npm run lint`
Expected: PASS semua, 0 error Biome (warning formatting beres via `npm run lint:fix` bila perlu).

- [ ] **Step 2: Update `SECURITY.md:22`**

Ganti baris:

```
- `PROTECTED_PATH_PATTERNS`: blocks `/`, `~`, `/etc`, `/boot`, `/var/lib`
```

menjadi:

```
- `PROTECTED_PATH_PATTERNS`: hard-blocks `/`, `/*`, `~`/`~/...`, `$HOME`, `%USERPROFILE%`, `$env:USERPROFILE`, and system dirs (`/etc`, `/boot`, `/var`, `/root`, `/usr`, `/bin`, `/sbin`, `/lib`, `/sdcard`, `/storage`, `C:\Windows`, `C:\Program Files`) — with path tails (`/etc/crontab` now caught), regardless of verb or `-y`.
- `command-paths.js`: tokenizes command text (quote-aware) and prompts HITL before any unquoted path token resolves outside the jail.
```

- [ ] **Step 3: Update `docs/ROADMAP.md`**

Di bagian remediasi audit, tandai H-1 selesai: `H-1 ✅ (fix: 3 lapis — protected regex, risky verbs + Windows, command-text jail check)`. Kalau belum ada entri remediasi H-1 di ROADMAP, tambahkan satu baris di bawah bagian prioritas perbaikan audit.

- [ ] **Step 4: Commit**

```bash
git add SECURITY.md docs/ROADMAP.md
git commit -m "docs(security): document H-1 command path jail fix"
```

---

## Catatan verifikasi manual (opsional, setelah Task 4)

Coba di Termux/Linux dengan project bukan-jail untuk payload audit:

```
faycli            # build mode, tanpa -y
> jalankan: sed -i 's/.*/EVIL/' ~/.bashrc      → DITOLAK hard (protected)
> jalankan: mv notes.txt ../outside            → prompt daftar path
> jalankan: del /f C:\Windows\notepad.exe      → DITOLAK hard (protected Windows)
> jalankan: ls -la && git status               → jalan tanpa prompt (false-positive check)
```
