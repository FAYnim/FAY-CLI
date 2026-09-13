# Desain: Auto-load Project Instructions (`AGENTS.md`)

**Tanggal:** 2026-09-13
**Sumber:** `docs/ROADMAP.md` item #1 (Prioritas 1 · Mudah · ~50 LOC)
**Status:** Disetujui user

## Tujuan

Agent `faycli` otomatis memuat instruksi proyek (konvensi repo, larangan, style,
arsitektur) dari file `AGENTS.md`, sehingga user tidak perlu ketik ulang konteks
tiap sesi. Tidak ada dukungan `FAY.md` — hanya `AGENTS.md` (format general yang
semakin jadi standar lintas tool).

## Latar Belakang (kondisi kode saat ini)

- `buildSystemPrompt()` (`src/agent/system-prompt.js:233`) sudah punya hook
  `options.customInstructions` yang meng-inject blok `### CUSTOM USER INSTRUCTIONS:`
  (`:267-277`) — tapi tidak pernah diisi dari file mana pun. Plumbing lengkap,
  sumber data belum ada.
- Satu-satunya pemanggil `buildSystemPrompt()` adalah
  `getEffectiveSystemInstruction()` (`src/agent/orchestrator.js:112`), dipanggil
  dari constructor orchestrator (`:105`).
- Entry point (`src/cli/repl.js:60`, `src/cli/single-shot.js:55`,
  `bin/faycli.js:355`) semuanya membuat orchestrator via
  `createAgentOrchestrator()`.
- Helper `findProjectRoot(startDir)` sudah ada di `src/utils/project.js:33`.
- `options.systemInstruction` di orchestrator (`:99`) adalah escape hatch override
  penuh — harus tetap menang atas instruksi dari file.

## Keputusan Desain (dari brainstorm)

| Aspek | Keputusan |
|---|---|
| Scope pencarian | Global (`~/.faycli/AGENTS.md`) + walk-up `cwd → projectRoot` |
| Multi-level | **Merge semua** AGENTS.md yang ketemu, urutan root→daun, tiap blok ber-prefix path asal |
| Wiring | Di **constructor `AgentOrchestrator`** (bukan 3 entry point CLI) — semua jalur masuk otomatis ter-cover |
| Visibilitas | Banner satu baris di awal sesi + slash command `/instructions` untuk preview |
| Nama file | Hanya `AGENTS.md`; override via config `instructionsFile` |
| Budget | Trim total ke 8 KB, potong dari ekor |

## Komponen

### 1. `loadInstructions(workingDir, config)` — baru, di `src/utils/project.js`

```js
/**
 * @param {string} workingDir
 * @param {{ instructionsFile?: string | false }} config
 * @returns {{ text: string, files: string[] }}
 */
export function loadInstructions(workingDir = process.cwd(), config = {})
```

Perilaku:

1. Nama file = `config.instructionsFile` jika string non-kosong; default
   `'AGENTS.md'`; jika `false` → return `{ text: '', files: [] }` (fitur mati).
2. Kumpulkan kandidat berurutan:
   - Global: `path.join(os.homedir(), '.faycli', <nama>)`.
   - Walk-up: mulai dari `realpath(workingDir)`, cek `<dir>/<nama>` di tiap level
     sampai **termasuk** `findProjectRoot(workingDir)`, lalu berhenti (level di
     atas project root tidak dibaca). Urutan hasil: global dulu, lalu
     **root→daun** (dari project root turun ke cwd) supaya instruksi yang lebih
     spesifik datang belakangan.
3. Baca tiap file yang ada (`fs.readFileSync` utf8). File unreadable / empty →
   skip, lanjut kandidat berikutnya, **tidak pernah throw**. Kesalahan baca
   di-log `logger.debug` — bukan `catch {}` kosong (selaras roadmap #4).
4. Gabung: tiap file jadi blok
   `\n## From <abs-path>\n\n<isi>\n`. Simpan path-nya ke `files[]`.
5. Trim: jika total > `MAX_INSTRUCTION_BYTES` (8192), pangkas dari **ekor**
   (instruksi daun paling spesifik yang dikorbankan; global + root tetap utuh),
   dipotong di batas character aman, akhirinya diberi marker `\n…[truncated]`.
6. `text` = hasil gabungan ter-trim; `files` = path yang benar-benar contribute
   (file ter-skip tidak masuk).

Konstanta baru, export dari modul yang sama:

```js
export const MAX_INSTRUCTION_BYTES = 8192;
export const DEFAULT_INSTRUCTIONS_FILE = 'AGENTS.md';
```

### 2. Wiring orchestrator — `src/agent/orchestrator.js`

- Constructor: sebelum baris `this.systemInstruction = ...`:
  ```js
  this.instructionFiles = [];
  this.customInstructions = null;
  if (!this.customSystemInstruction) {
    const cfg = new ConfigManager(); // sudah di-import? kalau belum: import
    const { text, files } = loadInstructions(this.workingDir, {
      instructionsFile: cfg.get('instructionsFile'),
    });
    this.customInstructions = text || null;
    this.instructionFiles = files;
  }
  ```
  **Catatan implementasi:** cek apakah orchestrator sudah punya akses config
  manager / logger; kalau tidak, terima lewat `options` dengan fallback
  construct sendiri — pengembang memilih yang paling kecil diff-nya saat plan.
- `getEffectiveSystemInstruction()` mengoper hook yang sudah ada:
  ```js
  return buildSystemPrompt({
    workingDir: this.workingDir,
    mode: this.mode,
    activePlanPath: this.activePlanPath,
    customInstructions: this.customInstructions,
  });
  ```
- Getter baru: `getInstructionFiles()` → `this.instructionFiles`.
- `options.systemInstruction` (override penuh, `:113-115`) tetap menang —
  instruksi file hanya dimuat saat override tidak ada. Perilaku lama tak berubah.

### 3. Banner awal sesi + `/instructions`

- `src/cli/repl.js`: setelah orchestrator tersedia, jika
  `orchestrator.getInstructionFiles().length > 0`, tulis satu baris:
  `ℹ Loaded instructions: <path1>, <path2>` (ANSI cyan/dim, ikut pola badge
  security yang sudah ada). Ini mitigasi prompt-injection dari roadmap — user
  selalu tahu file asing apa yang masuk system prompt.
- `src/cli/slash-commands.js`:
  - `SLASH_COMMANDS_HELP`: entri `{ cmd: '/instructions', desc: 'Show project instruction files loaded into the system prompt' }`.
  - Case `/instructions`: tampilkan header per file (`<path> (N bytes)`) + isi
    lengkapnya via renderer markdown yang sudah ada; jika kosong:
    `No instruction files loaded.` Sumber data: cache di orchestrator
    (getter baru) — tidak re-read disk.
  - `single-shot.js` dan `bin/faycli.js`: **tanpa banner** (output harus bersih
    untuk piping). Instruksi tetap ter-load diam-diam.

### 4. Config — `src/config/constants.js`

- `DEFAULT_CONFIG` (`:92`) tambah: `instructionsFile: 'AGENTS.md'`.
  Nilai valid: string nama file (relatif per direktori) atau `false` (matikan).
- Tidak perlu migrasi: `get('instructionsFile')` fallback ke default untuk
  config lama.

## Data Flow

```
repl.js / single-shot.js / bin/faycli.js
  └─ createAgentOrchestrator({ workingDir, ... })
       └─ constructor: loadInstructions(workingDir, config)   ← sekali, di-cache
            └─ getEffectiveSystemInstruction()
                 └─ buildSystemPrompt({ customInstructions })  ← hook sudah ada
                      └─ blok "### CUSTOM USER INSTRUCTIONS:" → LLM
```

## Error Handling

- Semua I/O di `loadInstructions` bersifat best-effort: tidak ada kondisi yang
  membuat agent gagal start. Tidak ada file → text kosong → `buildSystemPrompt`
  sudah skip blok custom (cek string non-kosong di `:267-269`).
- File unreadable (permission, race) → skip + `logger.debug`.
- Fitur hanya **membaca** file — tidak menyentuh SecurityGuard, workspace jail,
  atau write path mana pun. Termux-safe (pure `node:fs`, zero dep baru).

## Security

- **Risiko:** prompt injection dari `AGENTS.md` repo orang lain.
  Mitigasi: banner path di awal sesi REPL + `/instructions` untuk audit isi.
  Instruksi di-inject sebagai blok `### CUSTOM USER INSTRUCTIONS:` yang sudah
  ada polanya — tidak ada privilege baru, tool tetap di-gate SecurityGuard.
- 8 KB cap membatasi pemborosan context budget Termux.

## Testing — `tests/project-instructions.test.js` (baru)

Pola `node --test` yang sudah ada, fixture dir via `fs.mkdtempSync(os.tmpdir())`:

1. **Merge & urutan:** global + root AGENTS.md + subdir AGENTS.md → `files`
   berisi ketiganya, urutan blok root→daun, tiap blok ada `## From <path>`.
2. **Walk-up batas:** AGENTS.md di atas projectRoot diabaikan.
3. **Trim:** file 10 KB → hasil ≤ 8 KB + marker truncated, blok root tetap ada.
4. **Config off:** `instructionsFile: false` → `{ text: '', files: [] }`.
5. **Nama custom:** `instructionsFile: 'TEAM.md'` → baca TEAM.md, bukan AGENTS.md.
6. **Unreadable/missing:** tidak throw; file hilang di-skip.
7. **Integrasi `buildSystemPrompt`:** hasil load muncul di bawah
   `### CUSTOM USER INSTRUCTIONS:`; `customInstructions` kosong → blok tidak ada.
8. **Orchestrator:** `systemInstruction` override → `getInstructionFiles()`
   kosong, file tidak dimuat.

## Di Luar Scope (YAGNI)

- `FAY.md` (permintaan user: general AGENTS.md saja).
- Reload per-turn / watch mode — load sekali per sesi cukup; ganti file →
  `/new` atau restart.
- Instruksi per-subdir yang switch otomatis saat agent cd (walk-up statis dari
  workingDir saat start sudah menangkap kasus monorepo umum).
- Front-matter parsing (`---` YAML) di AGENTS.md — diperlakukan sebagai teks.
