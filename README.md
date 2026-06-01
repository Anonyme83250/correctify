# Correctify Desktop

🌐 **Website & download: [correctify.fr](https://correctify.fr/)**

**AI writing assistant for your whole desktop.** Select text in *any* application —
Outlook, the new Outlook, Word, Teams, a browser, any text field — press a global
shortcut, and the selection is replaced in place with a corrected, polished version.

It's the desktop counterpart of the Correctify browser/Thunderbird extension. Same
engine: you bring your own API key for **Google Gemini**, **OpenAI** or **Anthropic**,
auto-detected from the key prefix.

> Free & open source (MIT). Bring your own API key — no account, no subscription.

---

## How it works

Correctify is a **tray / menu-bar app** (no main window). On the shortcut it
simulates **Copy → sends the selection to the AI → simulates Paste** with the
corrected text. Keystroke simulation uses `osascript` (macOS) and PowerShell
`SendKeys` (Windows) — **no native modules to compile**.

The AI provider is picked automatically from your key:

| Key prefix      | Provider  | Models used                                   |
|-----------------|-----------|-----------------------------------------------|
| `AIza…`         | Google    | `gemini-2.5-flash-lite` → `gemini-2.5-flash`  |
| `sk-…`          | OpenAI    | `gpt-4o-mini`                                 |
| `sk-ant-…`      | Anthropic | `claude-haiku-4-5`                            |

Beyond plain correction, a tray submenu offers rewrite **tones**: professional,
courteous, concise, formal, simplified, joking. UI available in **French & English**.

---

## Run in development

```bash
cd desktop
npm install
npm start
```

A tray icon appears (Windows taskbar / macOS menu bar). On first launch the options
window opens — paste your API key.

### Usage
1. Select text in any application.
2. Press the shortcut (default **Ctrl+Alt+C**, **Cmd+Alt+C** on Mac).
3. **Release the keys** and wait ~1 s — the text is replaced by its corrected version.

---

## Configuration

Your API key and preferences are stored locally (JSON in your user profile) — never
sent anywhere except directly to the AI provider you chose.

The contact form / feedback / anonymous usage stats are optional features that talk to
a `correctify.fr`-style backend. They require a separate signing key and are **off by
default in the open-source build**. To enable them with your own backend, copy
[`src/secret.example.js`](src/secret.example.js) to `src/secret.js` and fill in your
key (or set the `CORRECTIFY_API_KEY` environment variable). Core text correction works
fine without it.

---

## ⚠️ macOS — permission required

To simulate Copy/Paste, macOS requires authorising the app under
**System Settings → Privacy & Security → Accessibility**. The app prompts for this on
first use; tick Correctify (or Electron in development), then try again.

---

## Build the executables

```bash
npm run dist:win    # → dist/  (NSIS .exe installer)  — must run on Windows
npm run dist:mac    # → dist/  (.dmg)                  — must run on macOS
```

> A macOS `.dmg` must be built **on a Mac** (signing/notarisation). The Windows
> installer must be built **on Windows** (Wine would be needed on Linux). Always re-run
> `npm install` on the target machine: `node_modules/` contains the OS-specific Electron
> binary and must not be copied across operating systems.

---

## Project layout

| File | Role |
|---|---|
| `src/main.js`            | Main process: tray, global shortcut, copy/correct/paste sequence |
| `src/ai.js`              | Multi-provider AI call (Gemini/OpenAI/Anthropic) + retry/backoff/fallback |
| `src/win-helper.js/.ps1` | Persistent PowerShell helper for Windows text replacement (UI Automation / `EM_SETSEL`) |
| `src/rich-paste.js`      | Rich-text diff/paste helpers |
| `src/settings-store.js`  | Read/write options (JSON in the user folder) |
| `src/preload.js`         | Secure IPC bridge to the options window |
| `src/settings.html` / `src/settings.js` | Options window (API key, shortcut, language…) |
| `src/i18n.js`            | FR/EN strings |

---

## Known limitations

- The clipboard technique pastes **plain text** (no rich formatting). This is
  intentional: it works in every field, including simple editors.
- The global shortcut must be free. If the OS or another app already uses it, pick a
  different one in the options. A combo **without Ctrl** (e.g. `Alt+Q`) avoids any
  interference with the simulated Copy.

---

## License

[MIT](LICENSE) © Anonyma
