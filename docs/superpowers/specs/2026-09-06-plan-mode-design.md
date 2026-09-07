# Design Spec: Plan Mode (/plan & /build) for FAY-CLI

- Date: 2026-09-06
- Status: Approved
- Target Version: FAY-CLI v1.1.0

## 1. Overview & Objective
Menyediakan fitur eksplorasi terencana di FAY-CLI sebelum eksekusi kode. Secara default, CLI berada di **Build Mode** (siap eksekusi langsung). User dapat beralih ke **Plan Mode** dengan perintah `/plan` untuk melakukan analisis read-only dan menyusun dokumen rencana terstruktur di folder `.fay/plans/`. Setelah rencana selesai ditinjau, user mengetik `/build` untuk beralih kembali ke Build Mode dan mulai mengeksekusi rencana dengan kumpulan tools lengkap.

---

## 2. Architecture & State Management

### 2.1 Mode State
- State mode tersimpan di `AgentOrchestrator` dan disinkronkan ke interface `repl.js`:
  - `mode: 'build' | 'plan'` (default: `'build'`)
  - `activePlanPath: string | null` (path file plan aktif)
- Indikator Visual Prompt di REPL:
  - **Build Mode**: `fay-cli ❯ `
  - **Plan Mode**: `fay-cli [PLAN] ❯ ` (warna badge cyan/yellow)

### 2.2 Slash Commands
1. `/plan [judul/topik opsional]`
   - Jika sudah di mode plan: tampilkan pesan info status dan lokasi plan aktif.
   - Jika di mode build:
     - Ubah `mode = 'plan'`.
     - Inisialisasi direktori `.fay/plans/` di root proyek.
     - Buat file plan draft baru: `.fay/plans/plan-<YYYYMMDD-HHmmss>.md`.
     - Set `activePlanPath` ke file tersebut.
     - Tampilkan kartu notifikasi masuk Plan Mode.
2. `/build`
   - Jika sudah di mode build dan tidak ada plan aktif: tampilkan info bahwa CLI sudah di Build Mode.
   - Jika beralih dari mode plan:
     - Ubah `mode = 'build'`.
     - Perbarui prompt kembali normal (`fay-cli ❯ `).
     - Baca ringkasan checklist dari `activePlanPath` (jika ada).
     - Tampilkan banner kesiapan eksekusi.
     - Secara otomatis mengarahkan agent untuk mengeksekusi rencana dari checklist aktif.

---

## 3. Tool Sandboxing & Security Boundaries

### 3.1 Tool Availability by Mode
- **Build Mode**:
  - Semua tools aktif: `read_file`, `write_file`, `patch_file`, `list_dir`, `grep_file`, `search_files`, `execute_command`, `git_status`, `git_diff`, `git_add_commit`, `web_fetch`, `web_search`.
- **Plan Mode**:
  - Hanya tools analitis yang diekspos ke model:
    - Read-only tools: `read_file`, `list_dir`, `grep_file`, `search_files`, `web_fetch`, `web_search`, `git_status`, `git_diff`.
    - Restricted write: `write_file` diizinkan **hanya** untuk path di dalam `.fay/plans/`.
  - Tools yang disembunyikan/dilarang:
    - `patch_file` (dihilangkan dari function declaration).
    - `execute_command` (dihilangkan dari function declaration).
    - `git_add_commit` (dihilangkan dari function declaration).

### 3.2 SecurityGuard Enforcement
- `SecurityGuard` memvalidasi setiap tool call `write_file` saat `mode === 'plan'`:
  - Jika target path di luar direktori `.fay/plans/`, eksekusi ditolak otomatis dengan error:
    `SecurityException: File mutation is restricted to .fay/plans/ in Plan Mode. Use /build to execute.`

---

## 4. Plan Document Structure
Dokumen rencana yang dihasilkan mengikuti format markdown standar:

```markdown
# Plan: <Topic / Task Name>

- Created: <Timestamp>
- Status: Draft | In Progress | Completed

## Context & Findings
<Hasil eksplorasi pembacaan kode, arsitektur yang terpengaruh>

## Action Checklist
- [ ] 1. <Langkah spesifik 1>
- [ ] 2. <Langkah spesifik 2>
- [ ] 3. <Langkah spesifik 3>

## Verification & Tests
- <Perintah test atau kriteria keberhasilan>
```

---

## 5. System Prompt Integration
Di Plan Mode, system instruction ditambahkan instruksi perilaku:
- Instruksi: Fokus membaca konteks codebase, memetakan risiko, dan menulis rencana ke file plan aktif.
- Larangan: Jangan berasumsi atau mengeksekusi perubahan sebelum user beralih ke `/build`.

---

## 6. Error Handling & Edge Cases
1. **Model berusaha mutate file source code di Plan Mode**:
   - Ditahan di layer guard, feedback langsung diteruskan ke model bahwa sistem berada di Plan Mode.
2. **Ketik `/build` tanpa ada plan yang dibuat**:
   - CLI tetap beralih ke Build Mode biasa tanpa suntikan task plan.
3. **Session interrupted / restart**:
   - File plan di `.fay/plans/` tetap tersimpan di filesystem lokal dan bisa dilanjutkan.

---

## 7. Testing Strategy
- Unit tests di `tests/plan-mode.test.js`:
  - Transisi state `/plan` dan `/build` pada `AgentOrchestrator`.
  - Penyaringan deklarasi tools berdasarkan mode.
  - Validasi aturan izin `SecurityGuard` untuk mutasi file plan vs non-plan.
  - Formatting prompt REPL berdasarkan active mode.
