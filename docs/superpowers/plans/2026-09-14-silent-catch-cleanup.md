# Silent `catch {}` Cleanup (Roadmap #4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hilangkan semua `catch {}` / `catch (_) {}` kosong di `src/` — yang layak di-debug diganti `logger.debug(...)`, yang legitimate control-flow diberi marker `/* silent-ok: <alasan> */`, dan grep-test di CI mencegah titik baru.

**Architecture:** `src/utils/logger.js` sudah punya `logger.debug(...)` yang no-op kecuali verbose mode — zero overhead di default. Test baru scan statis file `src/**/*.js` pakai regex, exempt baris yang mengandung `silent-ok`. Tidak ada perubahan perilaku runtime.

**Tech Stack:** Node.js ESM >=20, `node:test` (sudah dipakai semua test), Biome lint.

---

## Kategori keputusan (pahami sebelum edit)

- **LOG** — kegagalan yang harus punya jejak saat `--debug`: ganti body catch dengan `logger.debug('<module>.<fn>: <apa>', err)`.
- **SILENT-OK** — kegagalan yang memang diharapkan/normal (kaskade `JSON.parse` multi-candidate, `removeListener` cleanup, unlink best-effort): biarkan kosong, tambahkan komentar `/* silent-ok: <alasan singkat> */` di baris yang sama. Logging di sini = spam bahkan level debug.

Baris disebut di bawah berdasarkan posisi saat plan ditulis (HEAD `06085ac`); kalau bergeser beberapa baris karena edit sebelumnya, cari pola `} catch {}` / `} catch (_) {}` terdekat dengan konteks yang sama.

---

### Task 1: Grep-test silent catch (failing dulu)

**Files:**
- Create: `tests/silent-catch.test.js`

- [ ] **Step 1: Tulis test**

```js
/**
 * CI guard (roadmap #4): every empty catch block in src/ must carry a
 * `silent-ok` marker on the same line. New silent catches fail the suite.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const EMPTY_CATCH = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/;

function* walkJs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJs(full);
    else if (entry.name.endsWith('.js')) yield full;
  }
}

test('no unexplained silent catch blocks in src/', () => {
  const violations = [];
  for (const file of walkJs(SRC)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (EMPTY_CATCH.test(line) && !line.includes('silent-ok')) {
        violations.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(violations, [], `Found unexplained silent catches:\n${violations.join('\n')}`);
});
```

- [ ] **Step 2: Jalankan, pastikan FAIL**

Run: `node --test tests/silent-catch.test.js`
Expected: FAIL — daftar 28 pelanggaran (openai.js 8, confirm-menu 4, model-menu 4, reflection 3, session-menu 3, session 2, guard 1, provider-wizard 1, slash-commands 1, manager 1).

- [ ] **Step 3: Commit test dulu (menunjukkan red)**

```bash
git add tests/silent-catch.test.js
git commit -m "test(catch): add grep guard for silent catch blocks (red)"
```

---

### Task 2: `src/llm/openai.js` — 8 titik

**Files:**
- Modify: `src/llm/openai.js`

- [ ] **Step 1: Tambah import logger**

Setelah baris `import { BaseLlmClient } from './base.js';` (baris 5) tambah:

```js
import { logger } from '../utils/logger.js';
```

- [ ] **Step 2: `_handleErrorResponse` (~baris 405–412) — LOG kedua titik**

Ganti:

```js
    try {
      errorDetails = await response.json();
      if (errorDetails?.error?.message) errorMessage = errorDetails.error.message;
    } catch {}
    if (!errorMessage) {
      try {
        errorMessage = await response.text();
      } catch {}
```

menjadi:

```js
    try {
      errorDetails = await response.json();
      if (errorDetails?.error?.message) errorMessage = errorDetails.error.message;
    } catch (err) {
      logger.debug('openai._handleErrorResponse: response.json() failed', err);
    }
    if (!errorMessage) {
      try {
        errorMessage = await response.text();
      } catch (err) {
        logger.debug('openai._handleErrorResponse: response.text() failed', err);
      }
```

- [ ] **Step 3: `extractJsonLoose` (~baris 515) — LOG**

Ganti `    } catch {}` di dalam blok `if (firstBrace !== -1 ...)` menjadi:

```js
    } catch (err) {
      logger.debug('openai.extractJsonLoose: JSON.parse failed', err);
    }
```

- [ ] **Step 4: Pipeline `parseTextToolCalls` (~baris 609, 619, 632, 644) — LOG keempatnya**

Pola sama, tag beda. Ganti tiap `} catch {}` pada:
- interpreter TAGGED_JSON (~609): `} catch (err) { logger.debug('openai.parseTextToolCalls: tagged-json parse failed', err); }`
- interpreter FENCED_JSON (~619): `} catch (err) { logger.debug('openai.parseTextToolCalls: fenced-json parse failed', err); }`
- `extractActionLineCall` (~632): `} catch (err) { logger.debug('openai.parseTextToolCalls: action-line args failed', err); }`
- `extractInlineNameCalls` (~644): `} catch (err) { logger.debug('openai.parseTextToolCalls: inline-name args failed', err); }`

- [ ] **Step 5: `classifyStandaloneJson` (~baris 665) — SILENT-OK**

Fungsi ini mencoba `JSON.parse` di SETIAP substring `{...}` teks model — kegagalan adalah hal normal, bukan anomali. Ganti `    } catch {}` menjadi:

```js
    } catch {
      /* silent-ok: not every curly-brace substring in model text is JSON */
    }
```

- [ ] **Step 6: Verifikasi per-file**

Run: `node --test tests/silent-catch.test.js tests/parse-text-tool-calls.test.js`
Expected: parse-text-tool-calls PASS; silent-catch masih FAIL (20 titik sisa — benar, file lain belum).

- [ ] **Step 7: Commit**

```bash
git add src/llm/openai.js
git commit -m "fix(llm/openai): log silent catch sites with debug-level tags"
```

---

### Task 3: `src/agent/session.js` + `src/security/guard.js` — 3 titik

**Files:**
- Modify: `src/agent/session.js` (~baris 322, 483)
- Modify: `src/security/guard.js` (~baris 310)

- [ ] **Step 1: `session.js` import logger**

Tambah di group import paling atas (setelah `import { configManager } ...`):

```js
import { logger } from '../utils/logger.js';
```

- [ ] **Step 2: `session.js` ~322 (atomic-write unlink tmp gagal) — SILENT-OK**

Rename sudah fallback ke copy; sisa tmp file = kosmetis. Ganti `      } catch (_) {}` (yang di dalam `catch (_err)` block rename) menjadi:

```js
      } catch {
        /* silent-ok: leftover tmp file after copy fallback is cosmetic */
      }
```

- [ ] **Step 3: `session.js` ~483 (`clearSessions` unlink gagal) — LOG**

Ganti `      } catch {}` menjadi:

```js
      } catch (err) {
        logger.debug('session.clearSessions: unlink failed', err);
      }
```

- [ ] **Step 4: `guard.js` import logger**

Tambah setelah `import { ansi } from '../utils/ansi.js';`:

```js
import { logger } from '../utils/logger.js';
```

- [ ] **Step 5: `guard.js` ~310 (persiapan diff preview gagal) — LOG**

Path ini menentukan apakah user dapat diff preview sebelum confirm — kegagalan diam = degradasi keamanan tak terlihat. Ganti `          } catch {}` menjadi:

```js
          } catch (err) {
            logger.debug('guard.checkToolCall: beforeContent read failed', err);
          }
```

- [ ] **Step 6: Verifikasi**

Run: `node --test tests/step4-session.test.js tests/step2-security.test.js tests/silent-catch.test.js`
Expected: session & security PASS; silent-catch masih FAIL (17 titik, semua UI/reflection/aux).

- [ ] **Step 7: Commit**

```bash
git add src/agent/session.js src/security/guard.js
git commit -m "fix(agent,security): log silent catches in session cleanup and guard diff prep"
```

---

### Task 4: Marker `silent-ok` untuk legitimate control-flow — 17 titik

**Files:**
- Modify: `src/agent/reflection.js` (127, 136, 148)
- Modify: `src/ui/confirm-menu.js` (218, 219, 224, 227)
- Modify: `src/ui/model-menu.js` (224, 229, 232, 278)
- Modify: `src/ui/session-menu.js` (158, 169, 174)
- Modify: `src/cli/provider-wizard.js` (193)
- Modify: `src/cli/slash-commands.js` (900)
- Modify: `src/config/manager.js` (240)

Semua SILENT-OK. Dua gaya, sesuai ruang baris:

Gaya A — baris pendek (cleanup `removeListener` dsb), marker inline:

```js
try { input.removeListener('keypress', keypressHandler); } catch { /* silent-ok: teardown best-effort */ }
```

Gaya B — baris `} catch {}` / `} catch (_) {}` milik blok multi-line, marker jadi body komentar:

```js
    } catch {
      /* silent-ok: <alasan> */
    }
```

- [ ] **Step 1: `reflection.js` 127/136/148 — Gaya B, alasan sama**

```js
  } catch {
    /* silent-ok: staged JSON.parse cascade; next candidate tried below */
  }
```

- [ ] **Step 2: `confirm-menu.js` 218/219 — Gaya A** (persis contoh di atas; baris 219 sama untuk `input.removeListener('close', onClose);`). `confirm-menu.js` 224/227 — Gaya B, alasan `/* silent-ok: readline teardown best-effort */`.

- [ ] **Step 3: `model-menu.js` 224/229/232/278 dan `session-menu.js` 158/169/174 — Gaya B**

Semua `removeListener`/teardown TTY. Body: `/* silent-ok: readline teardown best-effort */`.

- [ ] **Step 4: `provider-wizard.js` 193 — Gaya B**

```js
    } catch {
      /* silent-ok: rl may already be closed when wizard is interrupted */
    }
```

- [ ] **Step 5: `slash-commands.js` 900 — Gaya B**

```js
        } catch {
          /* silent-ok: statSync is display-only size hint */
        }
```

- [ ] **Step 6: `config/manager.js` 240 — Gaya B**

```js
      } catch {
        /* silent-ok: leftover tmp file after copy fallback is cosmetic */
      }
```

- [ ] **Step 7: Verifikasi — test harus HIJAU sekarang**

Run: `node --test tests/silent-catch.test.js`
Expected: PASS, 0 violations.

- [ ] **Step 8: Commit**

```bash
git add src/agent/reflection.js src/ui/confirm-menu.js src/ui/model-menu.js src/ui/session-menu.js src/cli/provider-wizard.js src/cli/slash-commands.js src/config/manager.js
git commit -m "chore(ui,agent): mark legitimate empty catches with silent-ok"
```

---

### Task 5: Green full suite + roadmap update

**Files:**
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: Full test + lint**

Run: `npm test`
Expected: semua PASS, termasuk `silent-catch.test.js`.
Run: `npm run lint`
Expected: bersih. Kalau Biome mengomplain baris Gaya A yang >100 char, konversi ke Gaya B.

- [ ] **Step 2: Update roadmap**

Di `docs/ROADMAP.md`: heading section 4 jadi `## 4. Bersihkan Silent \`catch {}\` — Prioritas 4 · Mudah (done)` dan baris tabel `| 4 | Bersihkan silent \`catch {}\` | 4 | Mudah | ~40 titik |` → status done seperti pola section 1.

- [ ] **Step 3: Commit**

```bash
git add docs/ROADMAP.md
git commit -m "docs(roadmap): mark silent catch cleanup as done"
```

---

## Catatan desain

- **Kenapa regex single-line saja** (`ponytail:` di test): `catch {` + newline + `}` style multi-line lolos. Semua 28 titik saat ini single-line; perlu perluasan regex kalau nanti muncul gaya itu.
- **`src/llm/retry.js` sudah impor `logger`** — contoh preseden pola ini; tidak ada pola baru yang diintroduksi.
- **Jangan sentuh** catch non-kosong (`catch { args = {}; }`, `catch { return; }`) — punya fallback eksplisit, di luar scope #4.
