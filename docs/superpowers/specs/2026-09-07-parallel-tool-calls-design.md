# Design Spec: Parallel Tool Calls for FAY-CLI

- Date: 2026-09-07
- Status: Approved
- Target Version: FAY-CLI v1.2.0

## 1. Overview & Objective
Meningkatkan performa dan throughput eksekusi agent ketika model LLM (Gemini / OpenAI / OpenRouter) menghasilkan beberapa tool calls dalam satu giliran (turn). 

Saat ini, seluruh tool calls dieksekusi secara sekuensial (`for (const fc of functionCalls) await dispatch(...)`). Jika LLM memanggil 3 tool pembacaan atau pencarian file, waktu respons menjadi akumulasi linear dari durasi masing-masing tool.

Spesifikasi ini memperkenalkan **Sequential Chunking** dengan eksekusi paralel berbasis `Promise.all()` untuk tool-tool yang bersifat read-only / idempotent, sembari mempertahankan eksekusi sekuensial ketat untuk tool yang berpotensi melakukan mutasi filesystem, manipulasi git, atau memerlukan konfirmasi pengguna.

---

## 2. Tool Classification & Registry

Di `src/tools/registry.js`, kita mendeklarasikan set eksplisit untuk tool yang aman dijalankan secara paralel (read-only):

```javascript
export const READ_ONLY_TOOLS = new Set([
  'read_file',
  'grep_file',
  'search_files',
  'list_dir',
  'git_status',
  'git_diff',
  'web_fetch',
]);
```

### 2.1 Kategori Tool

1. **Read-Only (Concurrent Safe)**:
   - `read_file`, `grep_file`, `search_files`, `list_dir`, `git_status`, `git_diff`, `web_fetch`.
   - Karakteristik: Bebas efek samping (idempotent), tidak memodifikasi file atau status git, dapat berjalan serentak tanpa race condition.

2. **Mutating / Interactive (Sequential Only)**:
   - `write_file`, `patch_file`, `execute_command`, `git_add_commit`, `web_search`.
   - Karakteristik: Mengubah status disk atau git, menjalankan binary shell lokal, atau memicu dialog konfirmasi interaktif TTY via `SecurityGuard`. Wajib dieksekusi sekuensial satu demi satu.

---

## 3. Orchestration & Chunking Algorithm

Di `src/agent/orchestrator.js`, array `functionCalls` dari response LLM dibagi menjadi potongan-potongan batch (*chunks*) sebelum dieksekusi.

### 3.1 Algoritma Partisi Chunk

Fungsi pembantu `partitionToolCalls(functionCalls)`:
- Iterasi berurutan pada `functionCalls`.
- Elemen berurutan yang semuanya adalah `READ_ONLY_TOOLS` dikelompokkan ke dalam satu chunk `{ type: 'parallel', calls: [...] }`.
- Setiap tool mutatif dimasukkan sebagai chunk tersendiri `{ type: 'sequential', call: ... }`.

**Contoh Partisi:**
- Input: `[readA, grepB, writeC, readD, patchE]`
- Output Chunks:
  1. Chunk 1 (`parallel`): `[readA, grepB]` → dieksekusi bersamaan via `Promise.all`
  2. Chunk 2 (`sequential`): `writeC` → dieksekusi tunggal
  3. Chunk 3 (`parallel`): `[readD]` → dieksekusi tunggal/paralel
  4. Chunk 4 (`sequential`): `patchE` → dieksekusi tunggal

### 3.2 Preservasi Urutan History

Meskipun tool dalam chunk paralel dapat selesai dengan urutan berbeda (non-deterministik):
- Hasil masing-masing tool disimpan kembali ke array `executedToolCalls` dan `session.addFunctionResponseMessage()` **sesuai urutan index asli** dari `functionCalls` LLM.
- Hal ini menjamin konsistensi konteks prompt dan determinisme riwayat chat.

---

## 4. Error Isolation & Security

### 4.1 Independent Error Handling

Setiap eksekusi tool di dalam `Promise.all` dibungkus try/catch mandiri:
- Jika tool A gagal (misal file not found atau security blocked), tool A mengembalikan payload:
  ```json
  {
    "error": true,
    "status": "error",
    "message": "File not found: /path/to/file"
  }
  ```
- Tool B dan C yang berjalan paralel dalam batch yang sama **tidak dibatalkan** dan tetap menyelesaikan tugasnya.
- Seluruh hasil (baik sukses maupun error) dikirim kembali ke LLM agar model dapat melakukan self-correction.

### 4.2 Abort Signal & Cancellation

- `signal` dari `AbortController` (misal user menekan `Ctrl+C`) diteruskan ke masing-masing eksekusi tool.
- Jika sinyal aktif, operasi I/O dan fetch yang mendukung `signal` akan langsung berhenti.

---

## 5. UI Event Callbacks & REPL Integration

Untuk mencegah race condition pada terminal UI dan spinner:

### 5.1 Callback Event Tambahan

- `options.onBatchStart?.({ total, parallel })`: Memberi sinyal ke UI bahwa batch tool sedang dimulai. Jika `parallel === true` dan `total > 1`, UI menampilkan status:
  `Menjalankan ${total} tool paralel...`
- `options.onToolCall?.(call)`: Dipanggil saat masing-masing tool dimulai.
- `options.onToolResult?.(name, result)`: Dipanggil secara thread-safe saat masing-masing tool selesai.

### 5.2 Terminal Logging di REPL (`src/cli/repl.js`)

- Log output hasil tool menggunakan penanda status:
  - Sukses: `✔ [TOOL] <name>`
  - Gagal: `✖ [TOOL] <name> (<message>)`
- Spinner REPL tetap berputar stabil hingga seluruh chunk selesai, kemudian bertransisi ke status analisis hasil.

---

## 6. Testing Strategy

Pengujian menggunakan native `node:test` di `tests/parallel_tools.test.js`:

1. **Unit Test Chunking (`partitionToolCalls`)**:
   - Memastikan pengelompokan `[read, read, write, read]` menghasilkan 3 chunks (parallel, sequential, parallel).
   - Memastikan array kosong atau kumpulan tool sekuensial murni tidak membuat batch parallel semu.
2. **Concurrency Speedup Benchmark**:
   - Menjalankan 3 mock read tools dengan delay 50ms masing-masing.
   - Menguji bahwa total waktu eksekusi < 80ms (paralel), bukan 150ms+ (sekuensial).
3. **Error Isolation & Resilience**:
   - Menjalankan 2 tool bersamaan di mana 1 tool melempar error.
   - Memastikan tool kedua tetap menghasilkan respon sukses dan kedua respons tercatat di session.
4. **Order Integrity Verification**:
   - Memastikan urutan function response message di session cocok dengan urutan pemanggilan dari model.
