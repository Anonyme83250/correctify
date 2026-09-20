# Correctify Desktop

**AI spelling and grammar checker for your whole desktop. Select text in any application, press a shortcut, and it is corrected in place.**

[![License: MIT](https://img.shields.io/badge/License-MIT-1fa2d6.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-1fa2d6.svg)](#requirements)
[![Electron](https://img.shields.io/badge/built%20with-Electron-1fa2d6.svg)](https://www.electronjs.org/)
[![Bring your own API key](https://img.shields.io/badge/BYO-API%20key-1fa2d6.svg)](#configuration)

Correctify Desktop is a free and open source **AI proofreader** that lives in your system tray. It works in Outlook, Word, Teams, Slack, Gmail, Thunderbird, your browser, your code editor, and pretty much any text field on your machine. No copy and paste into a chatbot, no browser extension per application, no account.

> Website: [correctify.fr](https://correctify.fr/)

---

## Table of contents

- [Why Correctify](#why-correctify)
- [Features](#features)
- [Works with any AI provider](#works-with-any-ai-provider)
- [Requirements](#requirements)
- [Install](#install)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Privacy](#privacy)
- [Build an installer](#build-an-installer)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)
- [Version française](#version-française)

---

## Why Correctify

Most AI writing assistants make you leave what you are doing: open a tab, paste your paragraph, copy the answer back, fix the formatting. Correctify removes that round trip.

You select your sentence where you wrote it, you press `Ctrl + Alt + C`, and a second later the corrected sentence has taken its place, with your bold, your colours and your bullet points intact.

## Features

| | |
|---|---|
| **Works everywhere** | Any Windows or macOS application with a text field: e-mail clients, office suites, chat apps, browsers, code editors, CRM and ERP web apps |
| **Corrects in place** | The selected text is replaced where it stands, not pasted into a side panel |
| **Keeps your formatting** | Bold, italics, colours, fonts and lists survive the correction, including inside Word and Outlook |
| **Seven tones** | Standard proofreading, plus professional, courteous, concise, formal, simplified and joking rewrites |
| **French and English** | Interface and corrections in both languages, with automatic language detection on the selected text |
| **Summary of changes** | A small panel lists what was corrected, so you learn instead of just accepting |
| **Global shortcut** | Fully configurable, recorded by pressing the keys you want |
| **Dark mode** | Follows your taste, not your system, and applies to every panel |
| **Clipboard safe** | Your previous clipboard content is put back after the correction |
| **Bring your own key** | No subscription, no account, no quota on top of the one you already pay for |

## Works with any AI provider

You type the API address yourself, so Correctify is not tied to any vendor. Three API shapes are supported, which covers essentially the whole market:

| API type | Base URL example | Works with |
|---|---|---|
| **OpenAI** | `https://api.openai.com/v1` | OpenAI, Mistral, Groq, OpenRouter, Together, DeepSeek, Perplexity, LiteLLM, vLLM, and any OpenAI compatible endpoint |
| **OpenAI** (local) | `http://localhost:11434/v1` | **Ollama**, **LM Studio**, LocalAI, Jan, text generation WebUI |
| **Google Gemini** | `https://generativelanguage.googleapis.com/v1` | Google AI Studio, Gemini API |
| **Anthropic Claude** | `https://api.anthropic.com/v1` | Anthropic API |

Running a local model through Ollama or LM Studio means your text never leaves your computer at all, and costs nothing per correction.

## Requirements

- **Windows 10 or 11** for the full experience (in place replacement uses PowerShell and Windows UI Automation)
- **macOS** is supported through simulated keystrokes, and needs the Accessibility permission
- **Node.js 18+** and npm, only if you run or build from source
- An API key from the provider of your choice, or a local model server

## Install

### From source

```bash
git clone https://github.com/Anonyme83250/correctify.git
cd correctify
npm install
npm start
```

The app starts in the system tray. On the very first launch the options window opens by itself, because nothing is configured yet.

### From a release

Download the installer from the [Releases](../../releases) page, run it, and Correctify appears in the tray.

## Configuration

Everything lives in one window, reachable from the tray icon. Four fields and you are done:

1. **API URL**: the base address of the API you want to call, for example `https://api.openai.com/v1` or `http://localhost:11434/v1`
2. **API type**: `OpenAI`, `Google Gemini` or `Anthropic Claude`, so Correctify knows how to talk to that address
3. **Model**: the exact model name your provider expects, for example `gpt-4o-mini`, `gemini-3.1-flash-lite`, `claude-haiku-4-5-20251001` or `llama3.1`
4. **API key**: yours. Leave it empty for a local server that does not ask for one.

Then pick your shortcut, your tone, your correction language, and save. Settings are stored in a plain `settings.json` inside your user data folder:

- Windows: `%APPDATA%\Correctify\settings.json`
- macOS: `~/Library/Application Support/Correctify/settings.json`

## How it works

On each shortcut press, Correctify:

1. Waits for you to physically release the shortcut keys, so the simulated `Ctrl + C` is not swallowed
2. Captures the foreground window and, on Windows, the exact selection through UI Automation or the Word COM object
3. Copies the selection, retrying across four copy methods because some applications ignore a simulated `Ctrl + C`
4. Builds a prompt in the language of your text, with your chosen tone, and calls your API directly
5. Puts the corrected text back on the clipboard, with an HTML flavour rebuilt from your original formatting
6. Replaces the selection: on Word and Outlook through minimal diff edits, so only the changed words are touched and the rest of your formatting is untouched
7. Shows you a summary of what changed

If you clicked away during the correction, nothing is pasted into the wrong window: Correctify waits for your original window to come back to the foreground, then applies the change. A notification lets you apply it immediately instead.

## Privacy

- The API address, the model and the key you type **stay on your machine**, in your local settings file
- Correctify calls **your provider directly**, with no server in between
- **No telemetry, no analytics, no usage counter, no crash reporter, no account**
- The only network requests the app ever makes are the ones to the API address you typed
- With a local model server, nothing leaves your computer

## Build an installer

```bash
npm run dist        # current platform
npm run dist:win    # Windows NSIS installer
npm run dist:mac    # macOS dmg
```

Output lands in `dist/`. The build is unsigned: Windows SmartScreen will warn on first run unless you sign it with your own certificate.

## Project layout

```
src/
  main.js            Electron main process: tray, shortcut, correction pipeline
  ai.js              API calls (OpenAI / Gemini / Anthropic shapes), prompts, retries
  settings-store.js  Local settings, stored as JSON
  settings.html/.js  Options window
  hud.html           Floating "correcting..." indicator, with a cancel button
  summary.html       Panel listing what was corrected
  error.html         Error panel
  rich-paste.js      Carries your formatting over to the corrected text
  win-helper.js      Persistent PowerShell host (Windows)
  win-helper.ps1     UI Automation, Word COM, keyboard and clipboard plumbing
  i18n.js            French and English strings
  debug.js           Single debug switch, off by default
```

## Troubleshooting

**"No text selected"** while text clearly is selected: some applications refuse a simulated `Ctrl + C`. Set `DEBUG` and `DEBUG_VERBOSE` to `true` in `src/debug.js`, run `npm start`, and the console shows exactly which copy method failed.

**"This window is running as administrator"**: Windows blocks keyboard injection into elevated windows. Run Correctify as administrator too.

**The correction comes back in the wrong language**: force it in the options, with the "Correction language" setting.

**Nothing happens at all**: check that the shortcut was registered, another application may already own it. The tray menu tells you which shortcut is active.

## Contributing

Issues and pull requests are welcome. Useful things to add: more API shapes, more interface languages, a Linux path for the text replacement layer, and more applications in the plain text list of `main.js`.

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Anonyma.

---

## Version française

**Correctify Desktop, le correcteur orthographique et grammatical par IA pour tout votre bureau.** Vous sélectionnez du texte dans n'importe quelle application, vous appuyez sur votre raccourci, et le texte est corrigé sur place.

Correctify vit dans la barre des tâches et fonctionne dans Outlook, Word, Teams, Slack, Gmail, Thunderbird, votre navigateur, votre éditeur de code, et à peu près tous les champs de texte de votre machine. Pas de copier coller vers un chatbot, pas d'extension à installer application par application, pas de compte à créer.

### Ce qu'il fait

- **Corrige sur place**, là où vous écrivez, sans passer par un panneau latéral
- **Conserve votre mise en forme** : gras, italique, couleurs, polices et listes survivent à la correction, y compris dans Word et Outlook
- **Sept tons** : correction simple, plus professionnel, courtois, concis, soutenu, simplifié et blagueur
- **Français et anglais**, avec détection automatique de la langue du texte sélectionné
- **Résumé des corrections** affiché après coup, pour apprendre au lieu de subir
- **Raccourci global** entièrement configurable
- **Mode sombre**, presse-papier restauré, lancement au démarrage

### Vous apportez votre propre API

Vous saisissez vous même l'adresse de l'API, son type, le modèle et votre clé. Correctify n'est donc lié à aucun fournisseur : OpenAI, Mistral, Groq, OpenRouter, Google Gemini, Anthropic Claude, ou votre propre serveur local avec **Ollama** ou **LM Studio**. Avec un modèle local, votre texte ne quitte jamais votre ordinateur, et chaque correction est gratuite.

### Installation

```bash
git clone https://github.com/Anonyme83250/correctify.git
cd correctify
npm install
npm start
```

Au premier lancement, la fenêtre d'options s'ouvre toute seule : renseignez l'URL de l'API, son type, le nom du modèle et votre clé, choisissez votre raccourci, et c'est prêt.

### Vie privée

L'adresse, le modèle et la clé restent sur votre machine. Correctify appelle directement votre fournisseur, sans serveur intermédiaire. Aucune statistique, aucune analyse d'usage, aucun compte, aucun rapport d'erreur : les seules requêtes réseau de l'application sont celles qui partent vers l'adresse que vous avez saisie.

---

**Keywords**: AI spell checker, AI grammar checker, AI proofreader, desktop spell checker, correcteur orthographique IA, correcteur grammatical, rewrite text with AI, reformuler un texte, Electron tray app, global hotkey text correction, OpenAI API, Ollama, LM Studio, Google Gemini, Anthropic Claude, self hosted AI writing assistant, Windows, macOS, open source, MIT.
