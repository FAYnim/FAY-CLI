# FAY CLI — Roadmap Fitur

> Dihasilkan dari explore kode per 2026-09-13 (~13.9k LOC, v1.0.0).
> Prioritas = urutan kerja disarankan (ROI tertinggi & paling kecil dulu).
> Semua kandidat dip-filter constraint proyek: zero native dependency, harus jalan di Termux.

## Ringkasan Prioritas

| # | Fitur | Prioritas | Kesulitan | Estimasi |
|---|-------|-----------|-----------|----------|
| 1 | Auto-load project instructions (`FAY.md`/`AGENTS.md`) | 1 — tertinggi | Mudah | ~50 LOC |
| 2 | Cost & token usage di status line | 2 | Mudah | ~80 LOC |
| 3 | Checkpoint & `/undo` file edit | 3 | Sedang | ~200 LOC (done) |
| 4 | Bersihkan silent `catch {}` | 4 | Mudah | ~40 titik |
| 5 | Hooks lifecycle (`preToolUse`/`postToolUse`) | 5 | Sedang | ~150 LOC |
| 6 | Image / multimodal input | 6 | Sedang–Sulit | ~250 LOC |
| 7 | Sub-agent `task` tool | 7 — terendah | Sulit | ~400 LOC |

---

## 1. Auto-load Project Instructions — Prioritas 1 · Mudah (done)

**Status saat ini.** `buildSystemPrompt()` (`src/agent/system-prompt.js:266`) sudah punya
hook `options.customInstructions` yang meng-inject blok `### CUSTOM USER INSTRUCTIONS:`
ke system prompt — tapi **tidak pernah diisi dari file mana pun**. Plumbing lengkap,
sumber datanya belum ada.

**Gap.** Agent tidak tahu konvensi repo: nama branch, style, larangan tertentu,
arsitektur. User harus ketik ulang konteks tiap sesi.

**Desain.**
- Fungsi baru `loadProjectInstructions(cwd)` di `src/utils/project.js` (sudah ada
  helper detect project root): cari `FAY.md`, lalu fallback `AGENTS.md`, di cwd
  dan naik sampai project root. Ambil file pertama yang ketemu.
- Trim ke batas aman (mis. 8 KB) — context budget Termux kecil.
- Wire di `src/cli/repl.js` + `single-shot.js`: hasilnya dilewatkan sebagai
  `customInstructions` saat memanggil `buildSystemPrompt()`.
- Config override: `instructionsFile` (string | false untuk matikan).
- Slash `/instructions` opsional untuk preview isi yang ter-load.

**Kenapa prioritas 1.** Dampak terbesar per baris kode. Satu file berubah,
semua sesi langsung lebih pintar. Tidak menyentuh loop, security, atau LLM adapter.

**Risiko.** Prompt injection dari repo orang lain — mitigasi: tampilkan path file
yang di-load ke UI sekali di awal sesi.

---

## 2. Cost & Token Usage di Status Line — Prioritas 2 · Mudah (tidak perlu)

**Status saat ini.** `src/agent/usage.js` sudah lengkap:
`createUsage`, `accumulateUsage`, `getContextTokens`, `contextBudgetLimit`.
Sesi resume (`session.js`) menyimpan metadata. Tapi angka-angka ini tidak pernah
dijumlahkan jadi tampilan permanen — hanya dipakai internal compactor.

**Gap.** User tidak tahu berapa token/money terbakar per turn dan per sesi.
Di provider berbayar (Groq/OpenRouter) ini penting; di Termux kuota juga penting.

**Desain.**
- `formatUsageSummary(usage)` di `usage.js`: input/output token, % context budget,
  estimasi biaya.
- Tabel harga per model di `src/config/constants.js` (`BUILTIN_PROVIDERS` sudah
  jadi single source of truth — tinggal tambah field `pricing` per model, opsional;
  model tanpa harga → tampilkan token saja).
- Render di status line (`src/ui/history-indicator.js` / status-line yang sudah
  ada test-nya) + slash `/cost` untuk breakdown detail.

**Kenapa prioritas 2.** Data sudah ada semua; murni layer display. Zero risiko
ke agent loop.

**Risiko.** Harga per-model cepat usang — treat sebagai estimasi, label "±".

---

## 3. Checkpoint & `/undo` File Edit — Prioritas 3 · Sedang (done)

**Status saat ini.** `write_file` dan `patch_file` langsung overwrite. Guard
(`src/security/guard.js:312`) sudah membaca `beforeContent` untuk diff preview —
informasi yang sama persis yang dibutuhkan checkpoint, tapi dibuang setelah confirm.

**Gap.** Tidak ada jalan kembali kalau agent merusak file. Diff preview membantu,
tapi setelah 20 turn, user sering baru sadar file rusak terlambat.

**Desain.**
- Sebelum eksekusi `write_file`/`patch_file` sukses: tulis snapshot konten
  sebelum ke `~/.faycli/checkpoints/<sessionId>/<n>-<relpath>.bak` + index JSONL
  (turn, tool, path, hash).
- Retention: prune checkpoint sesi lama saat `/new` atau sesuai config
  `checkpoint.keep` (default mis. 10 sesi).
- `/undo` — restore file terakhir (pilih via `confirm-menu.js` kalau banyak).
  `/undo <n>` — n langkah ke belakang.
- Gate config `security.checkpoint: true|false` (default on; off di Termux storage
  kalau user hemat storage).
- Jangan checkpoint file >1 MB — simpan marker "too large", skip restore dengan warning.

**Kenapa prioritas 3.** Safety net yang paling diminta di CLI agent lain
(Claude Code punya pola sama). Butuh sedikit desain lifecycle (prune, naming,
path relativization) — makanya di atas hooks.

**Risiko.** Disk membengkak — wajib prune. Path dengan karakter aneh — pakai
slug hash, bukan nama asli.

---

## 4. Bersihkan Silent `catch {}` — Prioritas 4 · Mudah (done)

**Status saat ini.** Ditemukan ~10+ empty catch: `src/llm/openai.js`
(baris 402, 406, 509, 603, 613, 626, 638, 659), `src/agent/reflection.js:71`,
`src/agent/session.js:483`.

**Gap.** Error LLM/streaming/session gagal hilang tanpa jejak. Debug bug user
(remote, Termux) jadi tebak-tebakan.

**Desain.**
- `src/utils/logger.js` sudah ada. Ganti `catch {}` →
  `catch (err) { logger.debug('openai.parse', err); }` — level debug supaya
  default tidak berisik, `--debug` mengungkap.
- Tambah test kecil: spy logger, pastikan tidak ada lagi `catch {}` kosong via
  grep-test di CI (`node --test`).

**Kenapa di sini.** Bukan fitur, tapi prasyarat semua fitur di atas bisa
di-debug. Kerjakan bersamaan dengan poin 3–6 per file yang disentuh; tidak
perlu milestone sendiri. Urutan 4 hanya karena boleh disisipkan kapan saja.

---

## 5. Hooks Lifecycle `preToolUse` / `postToolUse` — Prioritas 5 · Sedang

**Status saat ini.** Nol grep match untuk "hooks". `dispatchToolCall()` di
`src/tools/registry.js` jalur tunggal semua tool — titik sisip sempurna.

**Gap.** Tidak ada cara user menyisipkan aksi own: auto-format setelah
`write_file`, lint gate sebelum `execute_command`, notifikasi Termux
(`termux-notification`) saat turn selesai.

**Desain.**
- Config `hooks: { preToolUse: [{ matcher: "write_file|patch_file", command: "..." }], postToolUse: [...] }`.
- Eksekusi via `child_process.spawn` (sudah dipakai `execute_command.js` —
  zero-dep, Termux-safe).
- Kontrak: JSON payload ke stdin hook `{tool, args, result}`, exit code ≠0 dari
  `preToolUse` = blok tool dengan stderr sebagai alasan; stdout `postToolUse`
  di-inject sebagai message tambahan ke percakapan (pola Claude Code).
- Timeout default 30 dtk, log via logger (butuh poin 4).

**Kenapa prioritas 5.** Daya ungkit automation besar, core tidak berubah —
tapi kontrak exit-code/blocking perlu desain matang supaya security guard
tidak bisa di-bypass hook. Setelah checkpoint (#3) supaya kegagalan hook
masih bisa di-undo.

**Risiko.** Hook arbitrary code = perlu dokumentasi jelas; jangan auto-run
hook dari repo untrusted tanpa konfirmasi pertama kali.

---

## 6. Image / Multimodal Input — Prioritas 6 · Sedang–Sulit

**Status saat ini.** Nol support: tidak ada `inlineData`/`base64` di
`src/llm/`. Request builder Gemini dan OpenAI keduanya text-only.

**Gap.** User mobile (audiens utama Termux) punya kamera: screenshot error,
foto whiteboard, mockup. Agent tidak bisa melihat apa pun.

**Desain.**
- Slash `/image <path>` (+ autocomplete) attach file ke turn berikutnya;
  atau deteksi ekstensi gambar di argumen prompt single-shot.
- `readImage(path)` di `src/utils/fs-walk.js`/terpisah: validasi MIME
  (png/jpeg/webp/gif), cap ~4 MB, return `{mimeType, data(base64)}`.
- Gemini: `contents[].parts` dapat `{ inlineData: { mimeType, data } }` —
  sudah native di API payload yang dibangun `gemini.js`.
- OpenAI-compat: part `{ type: "image_url", image_url: { url: "data:<mime>;base64,..." } }`.
  Provider non-vision (DeepSeek text) → 400; tangkap & tampilkan pesan jelas.
- Simpan di session JSON sebagai path + hash, bukan base64 (file sesi membengkak).

**Kenapa kesulitan lebih tinggi.** Menyentuh kedua adapter, stream-parser types,
session storage, dan kebijakan per-provider. Perlu uji manual per provider.

---

## 7. Sub-agent `task` Tool — Prioritas 7 · Sulit

**Status saat ini.** `tool-partitioner.js` + test `parallel_tools.test.js`
menunjukkan tool sudah bisa jalan paralel dalam satu agent. Tidak ada konsep
agent-of-agents.

**Gap.** Task besar (audit seluruh repo, riset multi-file) menumpuk di satu
context window — compactor akan memangkas hasil tengah. Sub-agent dengan
window sendiri = konteks induk tetap bersih.

**Desain.**
- Tool ke-13 `task`: argumen `{ description, prompt }`.
- Implementasi: instantiate `AgentOrchestrator` child — reuse penuh — dengan:
  session terpisah (tidak persist ke daftar user), max iterations kecil
  (mis. 20), **tanpa** tool `task` rekursif (cegah runaway), warisan
  SecurityGuard + workspace jail yang sama.
- Return: hanya final text child ke parent sebagai tool result, bukan riwayat
  turn-nya.
- UI: spinner `task: <description>` + indikator child aktif (thought-display.js
  sudah ada pola render bertingkat).
- Config: `subagents.enabled` (default off dulu — fitur paling spekulatif).

**Kenapa prioritas 7.** Paling mahal, paling banyak edge case (biaya berlipat,
recursion, UX parallelism), dan nilainya baru terasa setelah compaction (#
sudah ada) dirasa kurang oleh user nyata. Validasi demand dulu lewat #1–5.

---

## Remediasi Audit Keamanan (2026-09-14)

Prioritas perbaikan audit (`docs/AUDIT-FINDINGS-2026-09-14.md`):
- H-1 ✅ (fix: 3 lapis — protected regex, risky verbs + Windows, command-text jail check)
