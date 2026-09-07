# Faycli Feature Roadmap

> Rekomendasi fitur pengembangan CLI yang compatible dan ringan untuk Termux, dengan fitur hampir mirip Claude Code.

## 📊 Analisis Proyek Faycli Saat Ini

**Arsitektur existing:**
- `src/agent/` — Orchestrator, Compactor, Pruner, Reflection, Session, Usage
- `src/cli/` — REPL, Slash Commands, Piping, Single-shot, Autocomplete
- `src/tools/` — Read, Write, Patch, List Dir, Execute Command
- `src/security/` — Guard, Path Validator, Rules
- `src/llm/` — OpenAI, Gemini adapters + HTTP pool + retry
- `src/ui/` — Markdown rendering, Spinner, Box, Model Menu
- `src/config/` — Config manager (27KB!) + constants
- `tests/` — 40+ test files (unit & e2e)

**Yang sudah mirip Claude Code:**
- ✅ Multi-provider LLM (OpenAI + Gemini)
- ✅ Tool-use loop (read/write/patch/execute/list_dir)
- ✅ Session management + context compaction
- ✅ Self-healing + reflection loop
- ✅ Piping support (`echo "..." | faycli`)
- ✅ i18n (EN/ID)
- ✅ Security guard + path validation
- ✅ Slash commands (/help, /model, /session, /compact, dll)
- ✅ Single-shot mode (`faycli "prompt"`)

---

## 🎯 REKOMENDASI FITUR UTAMA ("Must Have")

### Kategori 1: Core Agent & Tooling

| # | Fitur | Alasan | Effort |
|---|-------|--------|--------|
| 1 | **`grep_file` tool** — Cari teks di file/project | Claude Code punya `grep`; sangat berguna untuk navigasi kode | ⭐ Low |
| 2 | **`search_files` tool** — Cari file by pattern/nama | Analog `find` tapi LLM-aware | ⭐ Low |
| 3 | **Git integration tools** — `git_status`, `git_diff`, `git_add_commit` | Tanpa ini, agent tidak bisa bekerja dengan repo versioned | ⭐⭐ Medium |
| 4 | **`web_fetch` / `curl` tool** — Ambil URL content | Untuk riset, dokumentasi, atau debugging API | ⭐ Low |
| 5 | **`web_search` tool** — Pencarian web via CLI | Claude Code web browse; bisa pakai SearXNG/DuckDuckGo gratis | ⭐⭐ Medium |
| 6 | **Project root auto-detection** — Deteksi `.git`, `package.json`, dll otomatis | Claude Code auto-detects project context | ⭐ Low |

### Kategori 2: UX & Interaksi

| # | Fitur | Alasan | Effort |
|---|-------|--------|--------|
| 7 | **Multi-turn conversation UI yang lebih polished** — Cursor-style prompt dengan history indicator | Claude Code punya visual thread yang bersih | ⭐⭐ Medium |
| 8 | **Thought/suspicion display toggle** — Show/hide LLM reasoning steps | Debugging agent behavior; user bisa hidden di TTY terbatas | ⭐ Low |
| 9 | **Inline edit preview** — Diff view sebelum apply patch | Safety + transparency, seperti Claude Code's confirm-prompt | ⭐⭐ Medium |
| 10 | **Keyboard shortcut reference overlay** — Tekan `?` untuk lihat semua shortcut | CLI-friendly docs di-runtime | ⭐ Low |
| ~~11~~ | ~~**Quick-fix suggestions** — Agent usulkan perintah umum setelah response~~ | ~~"Would you like me to run tests?" style~~ | ~~⭐⭐ Medium~~ ⛔ *Dihapus* |
| 12 | **Context window usage bar** — Visual token meter di status line | Sudah ada tapi bisa diperbaiki tampilannya | ⭐ Low |

### Kategori 3: Termux-Specific Optimizations

| # | Fitur | Alasan | Effort |
|---|-------|--------|--------|
| 13 | **Offline/embedded mode fallback** — Local model via Ollama/Khajiit | Termux users sering di konektivitas terbatas | ⭐⭐⭐ High |
| 14 | **Battery-percentage aware mode** — Kurangi polling/reflection saat low battery | Android battery concerns | ⭐ Low |
| 15 | **Clipboard integration** — `faycli clipboard` & read from xclip/yank | Termux clipboard workflow | ⭐ Low |
| 16 | **Termux share sheet handler** — `termux-share` → pipe ke faycli | Native Android sharing | ⭐⭐ Medium |
| 17 | **Background job mode** — `faycli bg "task"` dengan notification | Long-running tasks di Termux | ⭐⭐ Medium |
| 18 | **Storage-efficient session cache** — Compress/LZ4 session files | Termux storage terbatas | ⭐ Medium |

### Kategori 4: Configuration & Developer Experience

| # | Fitur | Alasan | Effort |
|---|-------|--------|--------|
| 19 | **`.fayclirc` project-level config** — Per-project model/provider/rules | Seperti `.cursorrules` di Cursor/Claude Code | ⭐ Low |
| 20 | **Config schema validation** — Validate config file on load | Mencegah broken config | ⭐ Low |
| 21 | **Plugin/hook system** — `pre_agent`, `post_agent`, `on_tool_call` | Extensibility tanpa core change | ⭐⭐ Medium |
| 22 | **Telemetry opt-in** — Anonymous usage stats | Bantu prioritize fitur | ⭐ Low |
| 23 | **`faycli doctor` diagnostic command** — Check config, network, permissions | Troubleshooting cepat di Termux | ⭐ Low |
| 24 | **Snapshot/restore sessions** — `faycli snapshot save/restore` | Multi-device sync via cloud/gist | ⭐⭐ Medium |

### Kategori 5: Advanced Agent Capabilities

| # | Fitur | Alasan | Effort |
|---|-------|--------|--------|
| 25 | **Parallel tool calls** — Jalankan multiple reads/writes sekaligus | Speedup signifikan di network-bound LLM | ⭐⭐ Medium |
| 26 | **Memory/persistent notes** — `faycli note add/show` cross-session | User preferences, learnings across sessions | ⭐ Medium |
| 27 | **Multi-agent/workspace** — beberapa task paralel di workspace sama | Project besar butuh paralelisme | ⭐⭐⭐ High |
| 28 | **Cost estimator per request** — Estimasi token + biaya sebelum kirim | Transparansi biaya LLM | ⭐ Low |
| 29 | **Fallback chain** — Provider A gagal → otomatis ke Provider B | Reliability tinggi | ⭐⭐ Medium |
| 30 | **Structured output modes** — JSON/YAML/Markdown toggle response format | Programmatic consumption | ⭐ Low |

---

## 💎 NICE-TO-HAVE FEATURES

| # | Fitur | Catatan |
|---|-------|---------|
| 31 | **Image/Vision input** — Upload screenshot → analyze | Tergantung provider support vision |
| 32 | **Audio transcript tool** — Record voice → text → agent | `rec` + Whisper本地 |
| 33 | **GUI overlay mode** — Floating terminal widget (Termux:API) | Android-only gimmick |
| 34 | **Shared clipboard bot** — `faycli @user` broadcast | Unik untuk collaboration |
| 35 | **Web server mode** — expose faycli via HTTP API | Integration dengan external tools |
| 36 | **WebSocket real-time streaming** — push updates to web client | Dashboard view |
| 37 | **File watcher mode** — `faycli watch *.js` auto-agent on change | Automation power user |
| 38 | **Emojified responses** — Theme customization | Fun factor |
| 39 | **Voice response TTS** — Baca hasil agent via text-to-speech | Accessibility |
| 40 | **AR overlay hint** — Termux + ARCore experimental | 🚀 Moonshot |

---

## 📋 Prioritas Implementasi

```
P0 (Launch critical):       #1 grep_file, #2 search_files, #3 git tools, 
                            #6 project detection, #13 offline mode
                            
P1 (UX polish):             #7 improved UI, #8 thought toggle, 
                            #10 keyboard hints, #15 clipboard,
                            #21 .fayclirc, #24 doctor command
                            
P2 (Reliability):           #5 web_search, #11 quick-fixes, 
                            #25 parallel tools, #29 fallback chain
                            
P3 (Nice-to-have):          Semua fitur kategori "Nice to Have"
```

---

## 🏁 Kesimpulan

Faycli **sudah sangat dekat** dengan fitur Claude Code di subset tooling dasar. Gap terbesar ada di:

1. **Tooling depth** — belum ada grep/git/web tools (ini yang paling dirasakan user)
2. **Agent reliability** — fallback chain, parallel calls
3. **Termux native integration** — share sheet, background, clipboard
4. **DX polish** — project config, doctor command, snapshot

Mulailah dari **P0** dulu, karena grep + git integration adalah "missing link" terbesar antara faycli sekarang vs pengalaman Claude Code sesungguhnya.
