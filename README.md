# 🎙️ SoundScript

<div align="center">

**Transcribe voice messages. Summarize them. 100% private.**

[🇬🇧 English](#english) · [🇮🇹 Italiano](#italiano)

[![Deploy to GitHub Pages](https://github.com/kevin-flynn89/SoundScript/actions/workflows/deploy.yml/badge.svg)](https://github.com/kevin-flynn89/SoundScript/actions/workflows/deploy.yml)
[![PWA](https://img.shields.io/badge/PWA-Installable-5A67D8?style=flat&logo=googlechrome)](https://kevin-flynn89.github.io/SoundScript/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

---

<a id="english"></a>

# 🇧 English

## What is SoundScript?

SoundScript is a **Progressive Web App** that transcribes voice messages (from WhatsApp, Telegram, or any audio file) into text and generates a smart TL;DR summary — all running locally in your browser, with an intelligent API fallback chain.

👉 **Live demo:** [kevin-flynn89.github.io/SoundScript](https://kevin-flynn89.github.io/SoundScript/)

## ✨ Features

### 🔐 Privacy-first
- **Zero data leaves your device** when using local models
- API keys stored only in your browser's localStorage
- Audio files processed on-device or sent directly to your chosen provider

### 🤖 Smart API chain
Configure multiple providers in priority order. If one runs out of credits or goes down, SoundScript automatically falls through to the next — ending with fully offline local models.

Supported providers:
- **OpenAI** (Whisper + GPT)
- **Groq** (Whisper-large-v3 + Llama)
- **Google Gemini** (audio-native multimodal)
- **Anthropic Claude** (TL;DR only — no audio transcription)
- **Mistral** (Voxtral + Mistral Small)
- **Custom OpenAI-compatible endpoint**

### 🧠 Local fallback
- **Whisper** (Tiny or Base) for transcription
- **Qwen2.5-0.5B-Instruct** for summaries
- WebGPU when available, WASM fallback
- Wake Lock keeps the screen on during downloads
- Progress UI with per-file status

### 📝 Smart TL;DR
- Auto-generated for audio longer than 60 seconds
- Customizable: length (1 sentence / 3 sentences / paragraph), style (narrative, bullet list, actions & deadlines, formal, friendly), language
- Saved presets for one-click reuse
- Live prompt preview

### 🎧 Built-in audio player
- Play the transcribed audio right inside the app
- ±10 seconds skip, draggable seek bar, playback speed (1×, 1.25×, 1.5×, 2×, 0.75×)
- Icon toggles dynamically between ▶ and ❚❚

### 📚 History with search
- Last 20 transcriptions saved locally
- Full-text search across transcript, summary and date
- Export to JSON
- One-click reload into the editor
- Audio not stored (privacy by design)

### 📱 PWA & mobile
- Installable on iOS and Android
- Share a voice note from WhatsApp directly to SoundScript
- Responsive layout: phone, tablet, desktop
- Dark mode follows the system
- Offline-capable via service worker

### 🔄 Silent updates
- Toast notification when a new build is deployed
- "Update now" / "Later" choice
- Manual check in the Info section
- Version stamp derived from the build date

### 🎨 Design
- Custom SVG logo (light + dark variants)
- Organic blob shapes (cookie, clover, sun)
- Indigo → cyan gradient signature
- Roboto Flex variable font
- Smooth animations, reduced-motion aware

## ️ Tech stack

- **Vite** — build tool
- **Vanilla JS** (ES modules) — no framework overhead
- **@huggingface/transformers** — local Whisper & Qwen
- **GitHub Pages + GitHub Actions** — zero-cost hosting, auto-deploy on push to `main`
- **Service Worker** — cache, share target, update detection

## 🚀 Deploy your own

1. Fork this repository
2. Enable **GitHub Pages** → Source: **GitHub Actions**
3. Push to `main` — the workflow builds and deploys automatically
4. Open `https://<your-username>.github.io/SoundScript/`

The workflow also generates PNG icons (180 / 192 / 512 / maskable 512) from `icon-light.svg` at build time, so iOS and Android get proper install icons without you having to create them manually.

## ⚙️ Configure providers

1. Open the **API keys & priority** section
2. Pick a provider from the dropdown — a link to the official key portal appears automatically
3. Paste your API key and click **Save API key**
4. Add more providers and reorder them by drag & drop
5. Click **Save provider order** to activate the chain

The local fallback is always appended at the end.

##  Project structure

SoundScript/
├── .github/workflows/deploy.yml # CI/CD: build + generazione PNG + deploy
├── index.html # punto di ingresso
├── vite.config.js # config Vite + timbro build SW
├── public/
│ ├── manifest.json # manifest PWA + share target
│ ├── sw.js # service worker
│ ├── share-target.html # gestore condivisione WhatsApp
│ ├── icon-light.svg # icona PWA (chiara)
│ ├── icon-dark.svg # icona PWA (scura)
│ ├── icon-dark-transparent.svg # favicon
│ ├── logo-light.svg # logo hero (chiaro)
│ └── logo-dark.svg # logo hero (scuro)
└── src/
├── main.js # logica dell'app
├── style.css # design system
└── providers.js # integrazioni API


##  Contributing

Pull requests welcome! A few guidelines:
- Keep the app dependency-free (no new npm packages unless strictly necessary)
- Match the existing design tokens (`--primary`, `--radius-*`, etc.)
- Test on mobile before opening a PR
- Write commit messages in English

## 📄 License

[MIT](LICENSE) — do whatever you want with it.

---

<a id="italiano"></a>

# 🇮🇹 Italiano

## Cos'è SoundScript?

SoundScript è una **Progressive Web App** che trascrive messaggi vocali (da WhatsApp, Telegram o qualsiasi file audio) in testo e ne genera un riassunto TL;DR intelligente — il tutto eseguito localmente nel tuo browser, con una catena di fallback API intelligente.

👉 **Demo live:** [kevin-flynn89.github.io/SoundScript](https://kevin-flynn89.github.io/SoundScript/)

## ✨ Funzionalità

### 🔐 Privacy al primo posto
- **Nessun dato lascia il tuo dispositivo** quando usi i modelli locali
- Chiavi API salvate solo nel localStorage del browser
- File audio elaborati sul dispositivo o inviati direttamente al provider scelto

### 🤖 Catena API intelligente
Configura più provider in ordine di priorità. Se uno esaurisce i crediti o va offline, SoundScript passa automaticamente al successivo — fino ai modelli locali completamente offline.

Provider supportati:
- **OpenAI** (Whisper + GPT)
- **Groq** (Whisper-large-v3 + Llama)
- **Google Gemini** (multimodale nativo audio)
- **Anthropic Claude** (solo TL;DR — nessuna trascrizione audio)
- **Mistral** (Voxtral + Mistral Small)
- **Endpoint personalizzato compatibile OpenAI**

### 🧠 Fallback locale
- **Whisper** (Tiny o Base) per la trascrizione
- **Qwen2.5-0.5B-Instruct** per i riassunti
- WebGPU quando disponibile, fallback WASM
- Wake Lock mantiene lo schermo acceso durante i download
- UI di progresso con stato per ogni file

### 📝 TL;DR intelligente
- Generato automaticamente per audio oltre i 60 secondi
- Personalizzabile: lunghezza (1 frase / 3 frasi / paragrafo), stile (narrativo, elenco puntato, azioni e scadenze, formale, amichevole), lingua
- Preset salvati per riuso con un click
- Anteprima live del prompt inviato al modello

### 🎧 Player audio integrato
- Riproduci l'audio trascritto direttamente nell'app
- Salto ±10 secondi, barra di avanzamento trascinabile, velocità (1×, 1.25×, 1.5×, 2×, 0.75×)
- Icona che cambia dinamicamente tra ▶ e ❚❚

### 📚 Cronologia con ricerca
- Ultime 20 trascrizioni salvate in locale
- Ricerca full-text su trascrizione, riassunto e data
- Esportazione in JSON
- Ricarica con un click nell'editor
- Audio non conservato (privacy by design)

### 📱 PWA e mobile
- Installabile su iOS e Android
- Condividi un vocale da WhatsApp direttamente a SoundScript
- Layout responsive: telefono, tablet, desktop
- Dark mode che segue il sistema
- Funzionamento offline tramite service worker

### 🔄 Aggiornamenti silenziosi
- Notifica toast quando viene deployata una nuova build
- Scelta "Aggiorna ora" / "Più tardi"
- Controllo manuale nella sezione Info
- Versione generata dalla data di build

### 🎨 Design
- Logo SVG personalizzato (varianti chiara e scura)
- Forme organiche (biscotto, trifoglio, sole)
- Gradiente firma indaco → ciano
- Font variabile Roboto Flex
- Animazioni fluide, rispetto di `prefers-reduced-motion`

## 🛠️ Stack tecnologico

- **Vite** — strumento di build
- **Vanilla JS** (moduli ES) — nessun framework
- **@huggingface/transformers** — Whisper e Qwen locali
- **GitHub Pages + GitHub Actions** — hosting gratuito, deploy automatico su push a `main`
- **Service Worker** — cache, share target, rilevamento aggiornamenti

## 🚀 Deploy del tuo

1. Forka questo repository
2. Abilita **GitHub Pages** → Source: **GitHub Actions**
3. Push su `main` — il workflow builda e deploya in automatico
4. Apri `https://<tuo-username>.github.io/SoundScript/`

Il workflow genera anche le icone PNG (180 / 192 / 512 / maskable 512) da `icon-light.svg` al momento della build, così iOS e Android ricevono icone di installazione corrette senza che tu debba crearle a mano.

## ⚙️ Configurazione provider

1. Apri la sezione **Chiavi API e priorità**
2. Scegli un provider dal menu a tendina — appare automaticamente il link al portale ufficiale per ottenere la chiave
3. Incolla la tua API key e clicca **Salva API key**
4. Aggiungi altri provider e riordinali con drag & drop
5. Clicca **Salva ordine provider** per attivare la catena

Il fallback locale viene sempre aggiunto in fondo.

## 📂 Struttura del progetto

SoundScript/
├── .github/workflows/deploy.yml # CI/CD: build + generazione PNG + deploy
├── index.html # punto di ingresso
├── vite.config.js # config Vite + timbro build SW
── public/
│ ├── manifest.json # manifest PWA + share target
│ ├── sw.js # service worker
│ ├── share-target.html # gestore condivisione WhatsApp
│ ├── icon-light.svg # icona PWA (chiara)
│ ├── icon-dark.svg # icona PWA (scura)
│ ├── icon-dark-transparent.svg # favicon
│ ├── logo-light.svg # logo hero (chiaro)
│ └── logo-dark.svg # logo hero (scuro)
└── src/
├── main.js # logica dell'app
├── style.css # design system
└── providers.js # integrazioni API


## 🤝 Contributi

Pull request benvenute! Alcune linee guida:
- Mantieni l'app senza dipendenze (niente nuovi pacchetti npm se non strettamente necessari)
- Rispetta i token di design esistenti (`--primary`, `--radius-*`, ecc.)
- Testa su mobile prima di aprire una PR
- Scrivi i messaggi di commit in inglese

## 📄 Licenza

[MIT](LICENSE) — fanne quello che vuoi.
