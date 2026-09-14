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
});
