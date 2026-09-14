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
import { findPathsOutsideJail, tokenizeCommand } from '../src/security/command-paths.js';

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
        'type "C:\\Program Files\\x\\secret"',
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

  describe('tokenizeCommand()', () => {
    test('memecah token pada metachar luar-kutip, menghormati kutip', () => {
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
      assert.deepEqual(
        toks.map((t) => [t.value, t.quoted]),
        [
          ['echo', false],
          ['x > /etc/y', true],
          ['f.txt', false],
        ],
      );
    });
  });

  describe('findPathsOutsideJail()', () => {
    test('menangkap path relatif keluar dan absolut luar', () => {
      const r1 = findPathsOutsideJail('mv src ../outside', baseDir);
      assert.deepEqual(
        r1.map((p) => p.raw),
        ['../outside'],
      );

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
});
