import { pipeline, env } from "@huggingface/transformers";
import { PROVIDERS, listModels, classifyModels, apiTranscribe, apiSummarize } from "./providers.js";
import "./style.css";

env.allowLocalModels = false;
env.useBrowserCache = true;

const $ = (selector) => document.querySelector(selector);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHARE_CACHE = "soundscript-share-v1";
const SETTINGS_KEY = "vtt-settings";
const LASTERR_KEY = "vtt-lasterr";
const TLDR_AUTO_SECONDS = 60;
const APP_VERSION = (typeof __APP_VERSION__ === "string") ? __APP_VERSION__ : "build dev";

let asr = null;
let llm = null;
let busy = false;
let activeModel = null;
let hasSummary = false;
let downloading = false;
let wakeLock = null;

let draftKeys = null;
let chainDirty = false;
let providerChoice = "openai";
const modelCache = {};
const dlRows = {};

/* ===== Service worker & aggiornamenti ===== */
let swReg = null;
let swApplyRequested = false;
let toastTimer = null;

const TOAST_ICONS = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  update: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
};

function hideToast() {
  const t = $("#toast");
  if (!t) return;
  t.classList.remove("show");
  clearTimeout(toastTimer);
}
function renderToast(html, sticky) {
  const t = $("#toast");
  if (!t) return;
  clearTimeout(toastTimer);
  t.classList.remove("show");
  t.innerHTML = html;
  void t.offsetWidth; /* forza il reflow: l'animazione riparte da zero */
  t.classList.add("show");
  if (!sticky) toastTimer = setTimeout(hideToast, 3000);
}
function showUpdateToast() {
  const t = $("#toast");
  if (!t) return;
  t.className = "toast update";
  renderToast(`
    <div class="toast-head">
      <div class="toast-ico update">${TOAST_ICONS.update}</div>
      <div class="toast-title">È disponibile una nuova versione</div>
      <button class="toast-close" data-toast-close aria-label="Chiudi">${TOAST_ICONS.close}</button>
    </div>
    <div class="toast-desc">Aggiorna ora per avere le ultime funzionalità e correzioni.</div>
    <div class="toast-actions">
      <button class="toast-btn primary" data-toast-update>Aggiorna ora</button>
      <button class="toast-btn ghost" data-toast-close>Più tardi</button>
    </div>
  `, true); /* sticky: si chiude solo con una scelta dell'utente */
}
function showStatusToast(type) {
  const t = $("#toast");
  if (!t) return;
  t.className = "toast";
  if (type === "success") {
    renderToast(`
      <div class="toast-head">
        <div class="toast-ico success">${TOAST_ICONS.success}</div>
        <div class="toast-title">App aggiornata</div>
        <button class="toast-close" data-toast-close aria-label="Chiudi">${TOAST_ICONS.close}</button>
      </div>
      <div class="toast-desc">Stai usando l'ultima versione disponibile (${APP_VERSION}).</div>
    `, false);
  } else {
    renderToast(`
      <div class="toast-head">
        <div class="toast-ico warning">${TOAST_ICONS.warning}</div>
        <div class="toast-title">Errore di connessione</div>
        <button class="toast-close" data-toast-close aria-label="Chiudi">${TOAST_ICONS.close}</button>
      </div>
      <div class="toast-desc">Impossibile verificare gli aggiornamenti. Riprova più tardi.</div>
    `, false);
  }
}
function applySwUpdate() {
  if (swReg && swReg.waiting) {
    swApplyRequested = true;
    swReg.waiting.postMessage({ type: "SKIP_WAITING" });
    const t = $("#toast");
    if (t) t.className = "toast";
    renderToast(`
      <div class="toast-head">
        <div class="toast-ico update">${TOAST_ICONS.update}</div>
        <div class="toast-title">Aggiornamento in corso…</div>
      </div>
      <div class="toast-desc">L'app si sta ricaricando con la nuova versione.</div>
    `, false);
  } else {
    hideToast();
  }
}
async function checkForUpdates() {
  const btn = $("#checkUpdateBtn");
  const label = $("#checkUpdateLabel");
  if (btn) btn.disabled = true;
  if (label) label.innerHTML = '<span class="mini-spinner"></span>';
  try {
    if (!("serviceWorker" in navigator) || !swReg) throw new Error("sw-non-disponibile");
    await swReg.update();
    await sleep(1200);
    if (swReg.waiting && navigator.serviceWorker.controller) showUpdateToast();
    else showStatusToast("success");
  } catch (err) {
    showStatusToast("warning");
  } finally {
    if (btn) btn.disabled = false;
    if (label) label.textContent = "Controlla";
  }
}
function setupSwUpdates(reg) {
  swReg = reg;
  reg.addEventListener("updatefound", () => {
    const nw = reg.installing;
    if (!nw) return;
    nw.addEventListener("statechange", () => {
      if (nw.state === "installed" && navigator.serviceWorker.controller) showUpdateToast();
    });
  });
  if (reg.waiting && navigator.serviceWorker.controller) showUpdateToast();
}
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (swApplyRequested) window.location.reload();
  });
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("./sw.js");
      setupSwUpdates(reg);
      try { await reg.update(); } catch (e) {}
    } catch (error) {
      console.error("Registrazione service worker fallita:", error);
    }
  });
}

function fmtDur(s) {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return m + ":" + String(ss).padStart(2, "0");
}
function fmtMB(bytes) { return (bytes / 1048576).toFixed(1) + " MB"; }
function fmtMs(ms) {
  if (ms < 10000) return (ms / 1000).toFixed(1).replace(".", ",") + " s";
  if (ms < 60000) return Math.round(ms / 1000) + " s";
  return fmtDur(ms / 1000);
}

/* ===== Regole TL;DR ===== */
const TLR_LEN = {
  breve: "Massimo 1 frase.",
  medio: "Massimo 3 frasi.",
  lungo: "Un paragrafo (5-8 frasi)."
};
const TLR_STYLE = {
  narrativo: (l) => `Riassumi ${l} il seguente messaggio vocale in forma discorsiva.`,
  elenco: (l) => `Riassumi ${l} il seguente messaggio vocale come elenco puntato.`,
  azioni: (l) => `Estrai ${l} dal seguente messaggio vocale le azioni, gli impegni e le scadenze, come elenco puntato.`,
  formale: (l) => `Riassumi ${l} il seguente messaggio vocale in tono formale.`,
  informale: (l) => `Riassumi ${l} il seguente messaggio vocale in tono amichevole.`
};
const TLR_LANG = { it: "in italiano", auto: "nella stessa lingua del testo trascritto" };
const TLR_LABEL = {
  len: { breve: "breve", medio: "medio", lungo: "lungo" },
  style: { narrativo: "narrativo", elenco: "elenco puntato", azioni: "azioni e scadenze", formale: "formale", informale: "amichevole" },
  lang: { it: "italiano", auto: "automatica" }
};
const DEFAULT_TLR = { len: "medio", style: "narrativo", lang: "it", custom: "" };

/* ===== Impostazioni ===== */
function migrateSettings(s) {
  if (Array.isArray(s.keys)) return s;
  const keys = [];
  if (s.apiKey) {
    keys.push({
      id: "k1", provider: s.provider || "openai", apiKey: s.apiKey,
      baseUrl: s.baseUrl || "", sttModel: s.sttModel || "", llmModel: s.llmModel || ""
    });
  }
  keys.push({ id: "local" });
  if (s.mode === "local" && keys.length > 1) keys.reverse();
  const out = { ...s, keys };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(out));
  return out;
}
function loadSettingsRaw() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); }
  catch { return {}; }
}
function saveSettings(patch) {
  const current = loadSettingsRaw();
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...current, ...patch }));
}
function loadSettings() {
  let s = migrateSettings(loadSettingsRaw());
  if (!s.keys.some((k) => k.id === "local")) {
    s.keys.push({ id: "local" });
    saveSettings({ keys: s.keys });
  }
  return s;
}
function updateEntry(id, patch) {
  const s = loadSettings();
  s.keys = s.keys.map((k) => (k.id === id ? { ...k, ...patch } : k));
  saveSettings({ keys: s.keys });
}
function entryLabel(entry) {
  if (entry.id === "local") return "Offline";
  return PROVIDERS[entry.provider]?.label || entry.provider;
}
function chainLabel() { return loadSettings().keys.map(entryLabel).join(" → "); }

function tldrSettings() {
  return { ...DEFAULT_TLR, ...(loadSettings().tldr || {}) };
}
function composeInstruction(t) {
  let p = TLR_STYLE[t.style](TLR_LANG[t.lang]) + " " + TLR_LEN[t.len];
  p += " Conserva solo le informazioni importanti. Non inventare dettagli.";
  if (t.custom && t.custom.trim()) p += " " + t.custom.trim();
  return p;
}

/* ===== Ultimi errori ===== */
function loadLastErrors() {
  try { return JSON.parse(localStorage.getItem(LASTERR_KEY) || "{}"); }
  catch { return {}; }
}
function saveLastError(id, txt) {
  const m = loadLastErrors(); m[id] = txt;
  localStorage.setItem(LASTERR_KEY, JSON.stringify(m));
}
function clearLastError(id) {
  const m = loadLastErrors();
  if (id in m) { delete m[id]; localStorage.setItem(LASTERR_KEY, JSON.stringify(m)); }
}
function describeError(err) {
  if (err && err.name === "AbortError") return "timeout della richiesta (rete lenta o bloccata)";
  const st = err && err.status;
  if (st === 401 || st === 403) return "chiave non valida (HTTP " + st + ")";
  if (st === 402) return "crediti esauriti (HTTP 402)";
  if (st === 429) return "limite di frequenza (HTTP 429)";
  if (st === 400) return "modello o richiesta non valida (HTTP 400)";
  if (st === 404) return "modello non trovato (HTTP 404)";
  if (st >= 500) return "errore del provider (HTTP " + st + ")";
  return "errore di rete o CORS";
}

/* ===== Suggerimento modelli ===== */
function suggestModel(list, slot, provider) {
  const p = PROVIDERS[provider] || PROVIDERS.openai;
  const rec = slot === "stt" ? p.recommended.stt : p.recommended.llm;
  if (list.some((m) => m.id === rec)) return rec;
  if (slot === "stt") {
    const pref = list.find((m) => /turbo|v3|large|whisper|transcribe/i.test(m.id));
    if (pref) return pref.id;
  } else {
    const pref = list.find((m) => /flash-lite|flash|mini|instant|lite|nano|small/i.test(m.id));
    if (pref) return pref.id;
  }
  return list[0]?.id || "";
}
function entrySugg(entry, slot) {
  if (slot === "stt" && entry.suggStt) return entry.suggStt;
  if (slot === "llm" && entry.suggLlm) return entry.suggLlm;
  const cls = modelCache[entry.id];
  if (cls) return suggestModel(slot === "stt" ? cls.stt : cls.chat, slot, entry.provider);
  const p = PROVIDERS[entry.provider] || PROVIDERS.openai;
  return slot === "stt" ? p.recommended.stt : p.recommended.llm;
}
async function ensureModels(entry, force) {
  if (!force && modelCache[entry.id]) return modelCache[entry.id];
  const p = PROVIDERS[entry.provider] || PROVIDERS.openai;
  const models = await listModels(entry);
  const cls = classifyModels(models, p.family);
  modelCache[entry.id] = cls;
  return cls;
}

/* ===== Wake Lock ===== */
async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
        if (downloading && document.visibilityState === "visible") {
          requestWakeLock().then((ok) => setWlBanner(ok ? "ok" : "warn"));
        }
      });
      return true;
    }
  } catch (e) {
    console.warn("Wake lock non disponibile:", e);
  }
  return false;
}
async function releaseWakeLock() {
  if (wakeLock) {
    try { await wakeLock.release(); } catch (e) {}
    wakeLock = null;
  }
}
function setWlBanner(mode) {
  const b = $("#wlBanner");
  if (!b) return;
  if (mode === "ok") {
    b.hidden = false;
    b.className = "wl-banner ok";
    b.textContent = "🔆 Schermo mantenuto attivo per il download. Puoi lasciare l'app aperta senza toccare nulla.";
  } else if (mode === "warn") {
    b.hidden = false;
    b.className = "wl-banner warn";
    b.textContent = "⚠️ Il dispositivo non consente di tenere lo schermo acceso: tienilo attivo finché il download non completa.";
  } else {
    b.hidden = true;
  }
}
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && downloading && !wakeLock) {
    const ok = await requestWakeLock();
    setWlBanner(ok ? "ok" : "warn");
  }
});

function stat(message, percent) {
  const status = $("#status");
  const bar = $("#bar");
  const eq = $("#eq");
  if (status) status.textContent = message;
  if (bar) bar.style.width = percent + "%";
  if (eq) eq.hidden = !(percent > 0 && percent < 100);
}

const SHIELD_SVG = `<svg viewBox="0 -960 960 960"><path d="M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-85 32-158t87.5-127q55.5-54 130-84.5T489-880q79 0 150 26.5T763.5-780q53.5 47 85 111.5T880-527q0 108-63 170.5T650-294h-75q-18 0-31 14t-13 31q0 27 14.5 46t14.5 44q0 38-21 58.5T480-80Z"/></svg>`;
const CHEVRON_SVG = `<svg class="chev" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>`;
const CHEV_SVG = `<svg class="chev" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>`;
const TICK_SVG = `<svg class="tick" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M378-246 154-470l43-43 181 181 384-384 43 43-427 427Z"/></svg>`;

/* ===== Menu a tendina custom ===== */
function closeAllDD() {
  document.querySelectorAll(".dd.open").forEach((d) => {
    d.classList.remove("open");
    const m = d.querySelector(".dd-menu"); if (m) m.hidden = true;
    const b = d.querySelector(".dd-btn"); if (b) b.setAttribute("aria-expanded", "false");
  });
}
document.addEventListener("click", () => closeAllDD());
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAllDD(); });

function makeDropdown(host, opts) {
  host.innerHTML = "";
  host.classList.add("dd");
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "dd-btn";
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  if (opts.ariaLabel) btn.setAttribute("aria-label", opts.ariaLabel);
  btn.innerHTML = `<span class="val"></span>${CHEV_SVG}`;
  const current = opts.options.find((o) => o.id === opts.value) || opts.options[0];
  btn.querySelector(".val").textContent = current ? current.label : "";
  host.appendChild(btn);

  const menu = document.createElement("div");
  menu.className = "dd-menu"; menu.hidden = true; menu.setAttribute("role", "listbox");
  opts.options.forEach((o) => {
    const it = document.createElement("button");
    it.type = "button";
    it.className = "dd-item" + (o.id === opts.value ? " sel" : "");
    it.setAttribute("role", "option");
    it.setAttribute("aria-selected", o.id === opts.value ? "true" : "false");
    it.innerHTML = `${TICK_SVG}<span class="name"></span>` +
      (opts.suggId && o.id === opts.suggId ? `<span class="star-tag">⭐</span>` : "");
    it.querySelector(".name").textContent = o.label;
    it.onclick = (e) => {
      e.stopPropagation();
      closeAllDD();
      if (o.id !== opts.value) opts.onChange(o.id);
    };
    menu.appendChild(it);
  });
  host.appendChild(menu);

  btn.onclick = (e) => {
    e.stopPropagation();
    const isOpen = !menu.hidden;
    closeAllDD();
    if (!isOpen) {
      menu.hidden = false;
      host.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
    }
  };
}

function render() {
  $("#app").innerHTML = `
    <main>
      <div class="hero">
        <img class="hero-logo hero-logo-light" alt="SoundScript" src="logo-light.svg">
        <img class="hero-logo hero-logo-dark" alt="SoundScript" src="logo-dark.svg">
        <p class="sub">Condividi un audio da WhatsApp oppure selezionalo qui. L'app prova le chiavi in ordine e chiude con i modelli locali.</p>
      </div>

      <section class="card" style="margin-top:0">
        <div class="card-label">Cosa fa l'app</div>
        <div class="feature-grid">
          <div class="feature-item">
            <div class="feature-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
            </div>
            <div>
              <h3>Elaborazione locale</h3>
              <p>I modelli Whisper e Qwen girano sul tuo dispositivo. Zero dati al cloud.</p>
            </div>
          </div>
          <div class="feature-item">
            <div class="feature-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            </div>
            <div>
              <h3>Catena API intelligente</h3>
              <p>Configura più provider. Se uno esaurisce i crediti, l'app passa al successivo.</p>
            </div>
          </div>
          <div class="feature-item">
            <div class="feature-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            </div>
            <div>
              <h3>Condivisione diretta</h3>
              <p>Condividi un vocale da WhatsApp direttamente a SoundScript.</p>
            </div>
          </div>
        </div>
      </section>

      <div class="drop" id="drop">
        <strong>Trascina qui un audio</strong>
        <span>oppure tocca per scegliere un file</span>
        <button id="pick" class="btn primary" style="margin-top:var(--space-md)">Scegli audio</button>
        <input id="file" class="hidden" type="file"
          accept="audio/*,.ogg,.opus,.m4a,.mp3,.wav,.aac">
      </div>

      <div class="status-row">
        <div class="spinner" id="eq" hidden></div>
        <div id="status" class="status" role="status" aria-live="polite">Pronto.</div>
      </div>
      <div class="progress"><div id="bar" class="progress-bar"></div></div>

      <div id="resultStt" class="card hidden">
        <div class="card-label">Trascrizione</div>
        <div class="chips">
          <span class="chip">Motore: <b id="engStt"></b></span>
          <span class="chip">Durata: <b id="durStt"></b></span>
        </div>
        <textarea id="txt" aria-label="Testo della trascrizione"></textarea>
        <div class="actions">
          <button id="copy" class="btn">Copia trascrizione</button>
          <button id="share" class="btn">Condividi</button>
        </div>
      </div>

      <div class="faq">
        <details class="faq-item t0" id="faqTldr">
          <summary>
            <span class="si" aria-hidden="true">${SHIELD_SVG}</span>
            <span class="ttl">Riepilogo TL;DR</span>
            ${CHEVRON_SVG}
          </summary>
          <div class="faq-body">
            <p class="note" id="autoNote" style="margin:0 0 var(--space-sm)"></p>

            <div class="field-label" style="margin-top:0">Lunghezza</div>
            <div class="seg" data-group="len">
              <button data-v="breve">Breve · 1 frase</button>
              <button data-v="medio">Medio · 3 frasi</button>
              <button data-v="lungo">Lungo · paragrafo</button>
            </div>

            <div class="field-label">Stile</div>
            <div class="seg" data-group="style">
              <button data-v="narrativo">Narrativo</button>
              <button data-v="elenco">Elenco puntato</button>
              <button data-v="azioni">Azioni e scadenze</button>
              <button data-v="formale">Formale</button>
              <button data-v="informale">Amichevole</button>
            </div>

            <div class="field-label">Lingua del riepilogo</div>
            <div class="seg" data-group="lang">
              <button data-v="it">Italiano</button>
              <button data-v="auto">Automatica · lingua dell'audio</button>
            </div>

            <div class="field-label">Istruzioni personalizzate <span class="muted">(opzionali)</span></div>
            <input id="tldrCustom" type="text" placeholder="es. evidenzia solo date e nomi di persone">

            <div class="field-label">Anteprima del prompt inviato al modello</div>
            <div class="prompt-box" id="promptBox"></div>

            <div class="field-label">Preset salvati</div>
            <div class="preset-row" id="presetRow"></div>
            <div class="preset-row">
              <input id="presetName" type="text" placeholder="Nome del preset (es. Scadenze rapide)" style="flex:1;min-width:160px">
              <button id="savePreset" class="btn">Salva preset</button>
            </div>

            <div class="actions">
              <button id="regen" class="btn primary">Genera TL;DR</button>
            </div>

            <div class="chips" style="margin-top:var(--space-md)">
              <span class="chip" id="chipLlm" hidden>Motore: <b id="engLlm"></b></span>
            </div>
            <div id="sum" class="tldr-box">Il TL;DR comparirà qui dopo l'elaborazione.</div>
            <p id="tldrMeta" class="muted" style="margin-top:var(--space-sm)"></p>

            <div class="actions">
              <button id="all" class="btn primary" disabled>Copia tutto</button>
              <button id="save" class="btn" disabled>Salva</button>
            </div>
          </div>
        </details>

        <details class="faq-item t1" id="faqKeys">
          <summary>
            <span class="si" aria-hidden="true">${SHIELD_SVG}</span>
            <span class="ttl">Chiavi API e priorità</span>
            ${CHEVRON_SVG}
          </summary>
          <div class="faq-body">
            <div class="dd" id="ddProvider"></div>
            <input id="apiKey" type="password" placeholder="Incolla qui la chiave API" style="margin-top:var(--space-sm)">
            <input id="baseUrl" type="text" placeholder="URL base (solo Personalizzato)" style="margin-top:var(--space-sm)">
            <div class="actions">
              <button id="saveKey" class="btn primary">Salva API key</button>
            </div>
            <p id="keysMsg" class="muted" style="margin-top:var(--space-sm)"></p>
            <ul id="keyList" class="chain-list"></ul>
            <div class="actions">
              <button id="saveChain" class="btn primary">Salva ordine provider</button>
              <span id="unsavedChip" class="chip warn" hidden>Modifiche non salvate</span>
            </div>
            <p id="prefMsg" class="muted" style="margin-top:var(--space-sm)"></p>
            <p class="muted" style="margin-top:var(--space-sm)">
              Le modifiche alla catena restano in bozza finché non premi "Salva ordine provider".
            </p>
          </div>
        </details>

        <details class="faq-item t2" id="faqLocal">
          <summary>
            <span class="si" aria-hidden="true">${SHIELD_SVG}</span>
            <span class="ttl">Modelli locali (fallback offline)</span>
            ${CHEVRON_SVG}
          </summary>
          <div class="faq-body">
            <div id="ddLocal"></div>
            <div class="actions">
              <button id="preload" class="btn">Scarica modelli locali ora</button>
            </div>
            <div class="wl-banner" id="wlBanner" hidden></div>
            <div class="disclaimer">
              <span class="ic">ⓘ</span>
              <span>
                Il fallback offline scarica i modelli sul dispositivo al primo utilizzo:
                <b>trascrizione (Whisper)</b> poche decine di MB, <b>riepilogo (modello lingua)</b> alcune centinaia di MB.
                Preparali in <b>Wi‑Fi</b> con "Scarica modelli locali ora": durante il download
                <b>l'app mantiene lo schermo acceso</b>.
              </span>
            </div>
            <div class="dl-area" id="dlArea" hidden>
              <div class="dl-head">
                <div class="spinner" id="dlSpinner"></div>
                <div class="dl-step" id="dlStep">Modello trascrizione (Whisper)</div>
                <div class="dl-stepcount" id="dlStepCount">1 di 2</div>
              </div>
              <div class="dl-file">
                <span id="dlFile">…</span>
                <span id="dlPct">0%</span>
              </div>
              <div class="dl-bar"><div class="dl-fill" id="dlFill"></div></div>
              <div class="dl-meta" style="display:flex;justify-content:space-between;margin-top:var(--space-xs);font-size:.8125rem;color:var(--on-surface-variant)">
                <span id="dlLoaded">0 MB</span>
                <span id="dlTotal">di 0 MB</span>
              </div>
              <div class="dl-list" id="dlList"></div>
              <div class="dl-done" id="dlDone" hidden>
                <span class="dl-check">✓</span>
                <span>Modelli locali pronti in cache. Il fallback funzionerà anche senza rete.</span>
              </div>
            </div>
          </div>
        </details>

        <details class="faq-item t3" id="faqInfo">
          <summary>
            <span class="si" aria-hidden="true">${SHIELD_SVG}</span>
            <span class="ttl">Info e aggiornamenti</span>
            ${CHEVRON_SVG}
          </summary>
          <div class="faq-body">
            <div class="settings-item">
              <div>
                <div class="settings-item-title">Aggiornamenti</div>
                <div class="settings-item-desc">Verifica manuale se esiste una nuova versione</div>
              </div>
              <button class="btn" id="checkUpdateBtn"><span id="checkUpdateLabel">Controlla</span></button>
            </div>
            <div class="settings-item">
              <div>
                <div class="settings-item-title">Versione corrente</div>
                <div class="settings-item-desc" id="appVersion">—</div>
              </div>
            </div>
            <p class="muted" style="margin-top:var(--space-sm)">
              Quando esce una nuova versione compare un toast in basso: "Aggiorna ora" la applica subito,
              "Più tardi" la rimanda alla prossima apertura.
            </p>
          </div>
        </details>
      </div>

      <div class="toast" id="toast" role="status" aria-live="polite"></div>
    </main>
  `;

  /* Comandi del toast: delegation, collegati UNA volta sola e sempre vivi */
  const toastEl = $("#toast");
  if (toastEl) {
    toastEl.addEventListener("click", (e) => {
      if (e.target.closest("[data-toast-close]")) { hideToast(); return; }
      if (e.target.closest("[data-toast-update]")) { applySwUpdate(); return; }
    });
  }

  $("#pick").onclick = () => $("#file").click();
  $("#file").onchange = (event) => {
    const file = event.target.files?.[0];
    if (file) process(file);
    event.target.value = "";
  };

  const drop = $("#drop");
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => {
    e.preventDefault(); drop.classList.remove("over");
    const file = e.dataTransfer?.files?.[0];
    if (file) process(file);
  };

  $("#preload").onclick = async () => {
    if (busy) return;
    busy = true;
    downloading = true;
    const btn = $("#preload");
    btn.disabled = true;
    showDlArea();
    const wlOk = await requestWakeLock();
    setWlBanner(wlOk ? "ok" : "warn");
    try {
      if (navigator.storage?.persist) await navigator.storage.persist();
      setDlStep("Modello trascrizione (Whisper)", "1 di 2");
      await getASR(true);
      setDlStep("Modello riepilogo (TL;DR)", "2 di 2");
      await getLLM(true);
      hideDlSpinner();
      showDlDone();
      stat("Modelli locali pronti in cache.", 100);
    } catch (error) {
      hideDlSpinner();
      stat("Download modelli locali non riuscito: " + (error?.message || error), 0);
    } finally {
      downloading = false;
      await releaseWakeLock();
      setWlBanner(null);
      busy = false;
      btn.disabled = false;
    }
  };

  const settings = loadSettings();
  providerChoice = settings.lastProvider || "openai";
  buildProviderDD();
  buildLocalDD();

  document.querySelectorAll(".seg button").forEach((b) => {
    b.onclick = () => {
      const group = b.closest(".seg").dataset.group;
      const t = tldrSettings();
      t[group] = b.dataset.v;
      saveSettings({ tldr: t });
      syncTldrUi();
    };
  });
  $("#tldrCustom").oninput = (e) => {
    const t = tldrSettings();
    t.custom = e.target.value;
    saveSettings({ tldr: t });
    syncTldrUi();
  };
  $("#savePreset").onclick = () => {
    const name = $("#presetName").value.trim();
    if (!name) { stat("Scrivi un nome per il preset.", 0); return; }
    const s = loadSettings();
    const presets = Array.isArray(s.tldrPresets) ? s.tldrPresets : [];
    presets.push({ name, ...tldrSettings() });
    saveSettings({ tldrPresets: presets });
    $("#presetName").value = "";
    renderPresets();
    stat("Preset salvato: " + name, 100);
  };
  $("#regen").onclick = async () => {
    const transcript = $("#txt").value.trim();
    if (!transcript) { stat("Nessuna trascrizione da riassumere: elabora prima un audio.", 0); return; }
    if (busy) { stat("Elaborazione già in corso: attendi.", 0); return; }
    busy = true;
    const sum = $("#sum");
    sum.classList.add("loading");
    sum.textContent = "Genero il TL;DR con le regole impostate…";
    try {
      const r = await runSummaryChain(transcript, 0);
      if (r.summary) showTldr(r.summary, r.engine, "Riepilogo generato con le regole impostate.", r.ms);
      else showTldrFail(r.reasons);
      stat("Completato.", 100);
    } catch (error) {
      sum.classList.remove("loading");
      stat("Errore nella generazione: " + (error?.message || error), 0);
    } finally { busy = false; }
  };

  $("#copy").onclick = async () => { await copyText($("#txt").value); stat("Trascrizione copiata.", 100); };
  $("#all").onclick = async () => {
    await copyText(fullText());
    stat(hasSummary ? "Trascrizione e riepilogo copiati." : "Trascrizione copiata.", 100);
  };
  $("#save").onclick = () => {
    try {
      const items = JSON.parse(localStorage.getItem("vtt-history") || "[]");
      items.unshift({
        date: new Date().toISOString(),
        transcript: $("#txt").value,
        summary: hasSummary ? $("#sum").textContent : ""
      });
      localStorage.setItem("vtt-history", JSON.stringify(items.slice(0, 20)));
      stat("Salvato nella cronologia locale.", 100);
    } catch (error) { console.error(error); stat("Impossibile salvare nella cronologia locale.", 0); }
  };
  $("#share").onclick = async () => {
    const text = fullText();
    try {
      if (navigator.share) await navigator.share({ title: "SoundScript", text });
      else { await copyText(text); stat("Testo copiato: puoi incollarlo dove vuoi.", 100); }
    } catch (error) { if (error?.name !== "AbortError") { console.error(error); stat("Impossibile condividere il testo.", 0); } }
  };

  $("#checkUpdateBtn").onclick = checkForUpdates;
  const ver = $("#appVersion");
  if (ver) ver.textContent = APP_VERSION;

  $("#saveKey").onclick = async () => {
    const key = $("#apiKey").value.trim();
    const msg = $("#keysMsg");
    if (!key) { msg.textContent = "Incolla prima una chiave API."; return; }
    const entry = {
      id: "k" + Date.now(), provider: providerChoice, apiKey: key,
      baseUrl: $("#baseUrl").value.trim(),
      sttModel: "", llmModel: "", suggStt: "", suggLlm: "", isNew: true
    };
    const localIndex = draftKeys.findIndex((k) => k.id === "local");
    draftKeys.splice(localIndex < 0 ? draftKeys.length : localIndex, 0, entry);
    $("#apiKey").value = ""; $("#baseUrl").value = "";
    markDirty(); renderKeyList();
    msg.textContent = "Chiave aggiunta alla bozza. Rilevo i modelli disponibili…";
    try {
      const cls = await ensureModels(entry, true);
      entry.suggStt = suggestModel(cls.stt, "stt", entry.provider);
      entry.suggLlm = suggestModel(cls.chat, "llm", entry.provider);
      entry.sttModel = entry.suggStt;
      entry.llmModel = entry.suggLlm;
      msg.textContent = "Modelli rilevati. Suggeriti: trascrizione " + entry.suggStt +
        ", riepilogo " + entry.suggLlm + ". Premi Salva ordine provider per attivare.";
    } catch (error) {
      const p = PROVIDERS[entry.provider] || PROVIDERS.openai;
      entry.suggStt = p.recommended.stt; entry.suggLlm = p.recommended.llm;
      entry.sttModel = entry.suggStt; entry.llmModel = entry.suggLlm;
      msg.textContent = "Rilevamento modelli non riuscito (" + (error?.message || error) +
        "): userò i consigliati del provider. Premi Salva ordine provider per attivare.";
    }
    renderKeyList();
  };

  $("#saveChain").onclick = () => {
    draftKeys.forEach((k) => delete k.isNew);
    saveSettings({ keys: JSON.parse(JSON.stringify(draftKeys)) });
    chainDirty = false;
    $("#unsavedChip").hidden = true;
    $("#keysMsg").textContent = "Ordine provider salvato e attivo.";
    updatePrefMsg();
    renderKeyList();
  };

  draftKeys = JSON.parse(JSON.stringify(loadSettings().keys));
  chainDirty = false;

  renderKeyList();
  updatePrefMsg();
  syncTldrUi();
  renderPresets();
  loadShared();
}

function fullText() {
  return $("#txt").value + (hasSummary ? "\n\nTL;DR\n" + $("#sum").textContent : "");
}

function showTldrFail(reasons) {
  hasSummary = false;
  const ft = $("#faqTldr"); if (ft) ft.open = true;
  const sum = $("#sum");
  sum.classList.remove("loading");
  sum.textContent = "TL;DR non generato. Motivi:\n• " +
    (reasons && reasons.length ? reasons.join("\n• ") : "errore sconosciuto") +
    "\n\nSuggerimento: controlla crediti e modelli delle chiavi nei dettagli, " +
    "oppure prepara il fallback con \"Scarica modelli locali ora\".";
  $("#chipLlm").hidden = true;
  $("#regen").textContent = "⟳ Rigenera TL;DR";
  $("#all").disabled = false;
  $("#save").disabled = false;
}

/* ===== UI download ===== */
function showDlArea() {
  const area = $("#dlArea");
  if (!area) return;
  area.hidden = false;
  $("#dlDone").hidden = true;
  $("#dlSpinner").hidden = false;
  $("#dlList").innerHTML = "";
  for (const k in dlRows) delete dlRows[k];
}
function hideDlSpinner() { const s = $("#dlSpinner"); if (s) s.hidden = true; }
function showDlDone() {
  const d = $("#dlDone"); if (d) d.hidden = false;
  const f = $("#dlFill"); if (f) f.style.width = "100%";
}
function setDlStep(label, count) {
  const s = $("#dlStep"); if (s) s.textContent = label;
  const c = $("#dlStepCount"); if (c) c.textContent = count;
}
function updateDlProgress(pct, loaded, total, fileName) {
  const f = $("#dlFile"); if (f) f.textContent = fileName || "…";
  const p = $("#dlPct"); if (p) p.textContent = Math.round(pct) + "%";
  const fill = $("#dlFill"); if (fill) fill.style.width = pct + "%";
  const l = $("#dlLoaded"); if (l) l.textContent = fmtMB(loaded);
  const t = $("#dlTotal"); if (t) t.textContent = "di " + fmtMB(total);
}
function addDlRow(file, total) {
  const list = $("#dlList");
  if (!list || dlRows[file]) return;
  const row = document.createElement("div");
  row.className = "dl-file-row wait";
  row.innerHTML = '<span class="dot"></span><span class="dlname"></span>';
  row.querySelector(".dlname").textContent = file + (total ? " · " + fmtMB(total) : "");
  list.appendChild(row);
  dlRows[file] = row;
}
function markDlRowRun(file, total) {
  const row = dlRows[file];
  if (!row) return;
  row.className = "dl-file-row run";
  if (total) row.querySelector(".dlname").textContent = file + " · " + fmtMB(total);
}
function markDlRowDone(file) {
  const row = dlRows[file];
  if (row) row.className = "dl-file-row ok";
}

function buildProviderDD() {
  makeDropdown($("#ddProvider"), {
    value: providerChoice,
    options: Object.keys(PROVIDERS).map((k) => ({ id: k, label: PROVIDERS[k].label })),
    ariaLabel: "Provider",
    onChange: (id) => {
      providerChoice = id;
      saveSettings({ lastProvider: id });
      buildProviderDD();
    }
  });
}
function buildLocalDD() {
  const s = loadSettings();
  const opts = [
    { id: "onnx-community/whisper-tiny", label: "Tiny — più leggero" },
    { id: "onnx-community/whisper-base", label: "Base — più accurato" }
  ];
  const val = opts.some((o) => o.id === s.localModel) ? s.localModel : opts[0].id;
  makeDropdown($("#ddLocal"), {
    value: val,
    options: opts,
    ariaLabel: "Modello Whisper locale",
    onChange: (id) => {
      saveSettings({ localModel: id });
      asr = null; activeModel = null;
      buildLocalDD();
    }
  });
}

/* ===== UI TL;DR ===== */
function syncTldrUi() {
  const t = tldrSettings();
  document.querySelectorAll(".seg").forEach((g) => {
    const k = g.dataset.group;
    g.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.v === t[k]));
  });
  const ci = $("#tldrCustom");
  if (ci && document.activeElement !== ci) ci.value = t.custom || "";
  $("#promptBox").textContent = composeInstruction(t) + "\n\nTESTO:\n[trascrizione del vocale]";
  updateTldrMeta();
}
function updateTldrMeta() {
  const t = tldrSettings();
  $("#tldrMeta").textContent =
    "Stile: " + TLR_LABEL.style[t.style] +
    " · Lunghezza: " + TLR_LABEL.len[t.len] +
    " · Lingua: " + TLR_LABEL.lang[t.lang];
}
function renderPresets() {
  const row = $("#presetRow");
  row.innerHTML = "";
  const presets = Array.isArray(loadSettings().tldrPresets) ? loadSettings().tldrPresets : [];
  presets.forEach((p, i) => {
    const c = document.createElement("span");
    c.className = "preset-chip";
    const lab = document.createElement("span");
    lab.textContent = p.name;
    const x = document.createElement("span");
    x.className = "x"; x.title = "Elimina"; x.textContent = "×";
    lab.onclick = () => {
      saveSettings({ tldr: { len: p.len, style: p.style, lang: p.lang, custom: p.custom || "" } });
      syncTldrUi();
      stat("Preset applicato: " + p.name, 100);
    };
    x.onclick = (e) => {
      e.stopPropagation();
      const s = loadSettings();
      s.tldrPresets = s.tldrPresets.filter((_, k) => k !== i);
      saveSettings({ tldrPresets: s.tldrPresets });
      renderPresets();
    };
    c.appendChild(lab); c.appendChild(x);
    row.appendChild(c);
  });
}

/* ===== Catena in bozza ===== */
function markDirty() {
  chainDirty = true;
  const chip = $("#unsavedChip");
  if (chip) chip.hidden = false;
}
function updatePrefMsg() { $("#prefMsg").textContent = "Catena attiva: " + chainLabel() + "."; }

function renderKeyList() {
  const list = $("#keyList");
  list.innerHTML = "";
  for (const entry of draftKeys) {
    const li = document.createElement("li");
    li.className = "chain-item";
    if (entry.isNew) li.classList.add("draftnew");
    li.dataset.id = entry.id;

    const handle = document.createElement("span");
    handle.className = "handle"; handle.dataset.handle = "1"; handle.textContent = "⋮⋮";
    li.appendChild(handle);

    const lab = document.createElement("span");
    lab.className = "chain-label";
    lab.textContent = entry.id === "local"
      ? "Fallback offline (modelli locali)"
      : entryLabel(entry);
    li.appendChild(lab);

    if (entry.id !== "local") {
      const tog = document.createElement("button");
      tog.className = "btn"; tog.textContent = "dettagli"; tog.style.minHeight = "32px"; tog.style.padding = "0 12px"; tog.style.fontSize = ".75rem";
      li.appendChild(tog);
      const det = document.createElement("div");
      det.className = "details";
      li.appendChild(det);
      tog.onclick = () => {
        if (det.classList.contains("open")) det.classList.remove("open");
        else openDetails(det, entry, false);
      };
    }
    list.appendChild(li);
  }
  enableSort(list);
}

async function openDetails(det, entry, force) {
  det.classList.add("open");
  if (det.dataset.filled && !force) {
    refreshKeyNotes(entry, det);
    refreshLastErr(det, entry);
    return;
  }
  det.innerHTML = `
    <button class="kmodels btn" style="align-self:flex-start">Aggiorna modelli disponibili</button>
    <p class="kmsg muted"></p>
    <label class="muted">Modello trascrizione (solo audio)</label>
    <div class="ddhost" data-slot="stt"></div>
    <div class="chip" data-sugg="stt" style="margin-top:var(--space-xs)"></div>
    <p class="note" data-note="stt" style="margin-top:var(--space-xs)"></p>
    <div class="actions">
      <button class="btn primary" data-savepref="stt">Salva preferenza modello</button>
      <span class="chip ok" data-chip="stt" hidden></span>
    </div>
    <label class="muted" style="margin-top:var(--space-md)">Modello riepilogo (solo chat)</label>
    <div class="ddhost" data-slot="llm"></div>
    <div class="chip" data-sugg="llm" style="margin-top:var(--space-xs)"></div>
    <p class="note" data-note="llm" style="margin-top:var(--space-xs)"></p>
    <div class="actions">
      <button class="btn primary" data-savepref="llm">Salva preferenza modello</button>
      <span class="chip ok" data-chip="llm" hidden></span>
    </div>
    <div class="lasterr"></div>
    <button class="kremove btn" style="align-self:flex-start">Rimuovi chiave</button>`;

  const msg = det.querySelector(".kmsg");
  msg.textContent = "Carico i modelli con questa chiave…";
  let cls = null;
  try {
    cls = await ensureModels(entry, !!force);
    entry.suggStt = suggestModel(cls.stt, "stt", entry.provider);
    entry.suggLlm = suggestModel(cls.chat, "llm", entry.provider);
    if (!entry.sttModel) entry.sttModel = entry.suggStt;
    if (!entry.llmModel) entry.llmModel = entry.suggLlm;
    msg.textContent = cls.stt.length + " modelli audio e " + cls.chat.length + " modelli chat trovati.";
  } catch (error) {
    const p = PROVIDERS[entry.provider] || PROVIDERS.openai;
    entry.suggStt = entry.suggStt || p.recommended.stt;
    entry.suggLlm = entry.suggLlm || p.recommended.llm;
    if (!entry.sttModel) entry.sttModel = entry.suggStt;
    if (!entry.llmModel) entry.llmModel = entry.suggLlm;
    cls = {
      stt: [{ id: entry.suggStt, label: entry.suggStt }],
      chat: [{ id: entry.suggLlm, label: entry.suggLlm }]
    };
    msg.textContent = "Lettura modelli non riuscita: " + (error?.message || error) + ". Mostro il suggerito.";
  }
  det._cls = cls;
  buildKeyDropdowns(det, entry);
  wireDetails(det, entry);
  det.dataset.filled = "1";
  refreshKeyNotes(entry, det);
  refreshLastErr(det, entry);
}

function buildKeyDropdowns(det, entry) {
  const cls = det._cls || { stt: [], chat: [] };
  makeDropdown(det.querySelector('[data-slot="stt"]'), {
    value: entry.sttModel,
    options: cls.stt,
    suggId: entry.suggStt,
    ariaLabel: "Modello trascrizione",
    onChange: (id) => {
      entry.sttModel = id;
      markDirty();
      buildKeyDropdowns(det, entry);
      refreshKeyNotes(entry, det);
    }
  });
  makeDropdown(det.querySelector('[data-slot="llm"]'), {
    value: entry.llmModel,
    options: cls.chat,
    suggId: entry.suggLlm,
    ariaLabel: "Modello riepilogo",
    onChange: (id) => {
      entry.llmModel = id;
      markDirty();
      buildKeyDropdowns(det, entry);
      refreshKeyNotes(entry, det);
    }
  });
}

function wireDetails(det, entry) {
  det.querySelector(".kmodels").onclick = () => openDetails(det, entry, true);
  det.querySelector(".kremove").onclick = () => {
    draftKeys = draftKeys.filter((k) => k.id !== entry.id);
    markDirty();
    renderKeyList();
  };
  det.querySelector('[data-savepref="stt"]').onclick = () => savePref(entry, "stt", det);
  det.querySelector('[data-savepref="llm"]').onclick = () => savePref(entry, "llm", det);
}

function savePref(entry, slot, det) {
  if (slot === "stt") entry.prefStt = entry.sttModel;
  else entry.prefLlm = entry.llmModel;
  updateEntry(entry.id, {
    sttModel: entry.sttModel, llmModel: entry.llmModel,
    suggStt: entry.suggStt, suggLlm: entry.suggLlm,
    prefStt: entry.prefStt, prefLlm: entry.prefLlm
  });
  refreshKeyNotes(entry, det);
  stat("Preferenza salvata: " + (slot === "stt" ? entry.sttModel : entry.llmModel), 100);
}

function refreshKeyNotes(entry, det) {
  ["stt", "llm"].forEach((slot) => {
    const model = slot === "stt" ? entry.sttModel : entry.llmModel;
    const sugg = slot === "stt" ? entry.suggStt : entry.suggLlm;
    const suggEl = det.querySelector('[data-sugg="' + slot + '"]');
    const noteEl = det.querySelector('[data-note="' + slot + '"]');
    const chip = det.querySelector('[data-chip="' + slot + '"]');
    if (suggEl) suggEl.textContent = "Modello suggerito: " + (sugg || "—");
    if (noteEl) {
      noteEl.textContent = model !== sugg
        ? "Preferenza non vincolante: in caso di errori su " + model +
          ", l'app proverà " + sugg + " (stessa chiave) prima di passare al provider successivo."
        : "Stai usando il modello suggerito: in caso di errori l'app passerà al provider successivo.";
    }
    if (chip) {
      const pref = slot === "stt" ? entry.prefStt : entry.prefLlm;
      chip.hidden = pref !== model;
      if (!chip.hidden) chip.textContent = "Preferenza salvata: " + model;
    }
  });
}

function refreshLastErr(det, entry) {
  const box = det.querySelector(".lasterr");
  if (box) box.textContent = "Ultimo errore: " + (loadLastErrors()[entry.id] || "nessuno");
}

function enableSort(listEl) {
  let item = null;
  listEl.addEventListener("pointerdown", (e) => {
    const h = e.target.closest("[data-handle]");
    if (!h) return;
    item = h.closest("li");
    item.classList.add("dragging");
    e.preventDefault();
  });
  document.addEventListener("pointermove", (e) => {
    if (!item) return;
    const siblings = [...listEl.querySelectorAll("li:not(.dragging)")];
    const next = siblings.find((el) => {
      const r = el.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    if (next) listEl.insertBefore(item, next); else listEl.appendChild(item);
  });
  document.addEventListener("pointerup", () => {
    if (!item) return;
    item.classList.remove("dragging"); item = null;
    const order = [...listEl.querySelectorAll("li")].map((li) => li.dataset.id);
    draftKeys.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    markDirty();
    renderKeyList();
  });
}

/* ===== Modelli locali ===== */
async function decode(file) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("Il browser non supporta la decodifica audio richiesta.");
  const context = new AudioContextClass();
  try {
    const audioBuffer = await context.decodeAudioData(await file.arrayBuffer());
    const sampleRate = 16000;
    const offlineContext = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * sampleRate), sampleRate);
    const source = offlineContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineContext.destination);
    source.start();
    const rendered = await offlineContext.startRendering();
    return rendered.getChannelData(0);
  } finally { await context.close().catch(() => {}); }
}

function makeProgressCallback() {
  let lastPct = -1;
  return (p) => {
    if (!p || !p.file) return;
    if (p.status === "initiate") { addDlRow(p.file, p.total || 0); return; }
    if (p.status === "done") { markDlRowDone(p.file); return; }
    if (p.status === "progress" && p.total) {
      const pct = (p.loaded / p.total) * 100;
      if (Math.abs(pct - lastPct) < 0.5 && p.loaded !== p.total) return;
      lastPct = pct;
      updateDlProgress(pct, p.loaded, p.total, p.file);
      markDlRowRun(p.file, p.total);
    }
  };
}

async function createPipeline(task, model, dtype, showProgress) {
  const cb = showProgress ? makeProgressCallback() : undefined;
  try {
    stat("Caricamento modello locale con WebGPU…", 15);
    return await pipeline(task, model, { dtype, device: "webgpu", progress_callback: cb });
  } catch (webgpuError) {
    console.warn("WebGPU non disponibile, provo WASM:", webgpuError);
    stat("WebGPU non disponibile. Modalità compatibile…", 20);
    return await pipeline(task, model, { dtype: "q8", device: "wasm", progress_callback: cb });
  }
}
async function getASR(showProgress) {
  const model = loadSettings().localModel || "onnx-community/whisper-tiny";
  if (asr && activeModel === model) return asr;
  asr = null; activeModel = model;
  asr = await createPipeline("automatic-speech-recognition", model, "fp32", showProgress);
  return asr;
}
async function getLLM(showProgress) {
  if (llm) return llm;
  llm = await createPipeline("text-generation", "onnx-community/Qwen2.5-0.5B-Instruct", "q4", showProgress);
  return llm;
}
async function localTranscribe(file, audio) {
  const a = audio || await decode(file);
  if (!asr) {
    stat("Primo uso della trascrizione locale: scarico il modello Whisper…", 30);
  } else {
    stat("Trascrizione locale in corso…", 30);
  }
  const transcriber = await getASR(false);
  const result = await transcriber(a, { language: "italian", task: "transcribe", chunk_length_s: 30, stride_length_s: 5 });
  return (result.text || "").trim();
}
async function localSummarize(transcript, instruction) {
  if (!llm) {
    stat("Primo uso del riepilogo locale: scarico il modello TL;DR…", 75);
  } else {
    stat("Creo il riepilogo TL;DR locale…", 75);
  }
  const summarizer = await getLLM(false);
  const prompt = instruction + "\n\nTESTO:\n" + transcript;
  const output = await summarizer(prompt, { max_new_tokens: 200, temperature: 0.2, do_sample: false });
  return (output[0]?.generated_text || "").replace(prompt, "").trim();
}

/* ===== Retry ===== */
async function callWithRetry(entry, slot, pct, makeCall) {
  const chosen = slot === "stt" ? entry.sttModel : entry.llmModel;
  const sugg = entrySugg(entry, slot);
  const seq = [chosen];
  if (sugg && sugg !== chosen) seq.push(sugg);

  for (let s = 0; s < seq.length; s++) {
    const model = seq[s];
    if (s > 0) {
      stat(entryLabel(entry) + ": il modello scelto ha dato errore, uso il suggerito " + model + "…", pct);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await makeCall(entry, model);
        if (s > 0) saveLastError(entry.id, "il modello scelto ha dato errore; completato con il suggerito " + model);
        else clearLastError(entry.id);
        return out;
      } catch (err) {
        saveLastError(entry.id, describeError(err));
        const st = err && err.status;
        if (st === 401 || st === 403 || st === 402) throw err;
        if (st === 429 || (st >= 500 && st <= 599) || !st) {
          if (attempt === 0) {
            const why = st === 429 ? "limite di frequenza" : (st ? "errore del provider" : "rete instabile o timeout");
            stat(entryLabel(entry) + ": " + why + ", riprovo tra 1,5 s…", pct);
            await sleep(1500);
            continue;
          }
          break;
        }
        break;
      }
    }
  }
  throw new Error("Tentativi esauriti per " + entryLabel(entry));
}

async function runSummaryChain(transcript, start) {
  const t0 = performance.now();
  const chain = loadSettings().keys;
  const instruction = composeInstruction(tldrSettings());
  const reasons = [];
  for (let i = start; i < chain.length; i++) {
    const entry = chain[i];
    try {
      let summary;
      if (entry.id === "local") {
        summary = await localSummarize(transcript, instruction);
      } else {
        stat("Riepilogo TL;DR con " + entryLabel(entry) + "…", 70);
        summary = await callWithRetry(entry, "llm", 70,
          (e, m) => apiSummarize(transcript, Object.assign({}, e, { llmModel: m }), instruction));
      }
      if (summary) {
        return {
          summary,
          engine: entry.id === "local" ? "locale" : "API " + entryLabel(entry),
          reasons,
          ms: performance.now() - t0
        };
      }
      reasons.push(entryLabel(entry) + ": risposta vuota");
    } catch (error) {
      console.warn("Riepilogo fallito (" + entryLabel(entry) + "):", error);
      reasons.push(entryLabel(entry) + ": " +
        (entry.id === "local"
          ? (error?.message || "errore del modello locale")
          : (loadLastErrors()[entry.id] || error?.message || "errore")));
      stat(entryLabel(entry) + " non disponibile per il TL;DR: provo la successiva…", 70);
    }
  }
  return { summary: "", engine: "", reasons, ms: performance.now() - t0 };
}

async function process(file) {
  if (busy) { stat("Attendi che termini l'elaborazione in corso."); return; }
  if (!file || file.size === 0) { stat("Il file audio è vuoto o non valido."); return; }
  busy = true;
  hasSummary = false;
  const fileInput = $("#file");
  if (fileInput) fileInput.disabled = true;
  try {
    stat("Preparo l'audio…", 5);
    let audio = null, duration = null;
    try {
      audio = await decode(file);
      duration = audio.length / 16000;
    } catch (decErr) {
      console.warn("Decodifica non riuscita: durata sconosciuta.", decErr);
    }
    const autoTldr = duration === null || duration >= TLDR_AUTO_SECONDS;

    const tStt = performance.now();
    const chain = loadSettings().keys;
    let transcript = "", sttEngine = "", okIndex = -1;
    for (let i = 0; i < chain.length; i++) {
      const entry = chain[i];
      try {
        if (entry.id === "local") {
          transcript = await localTranscribe(file, audio);
          sttEngine = "locale";
        } else {
          stat("Trascrizione con " + entryLabel(entry) + "…", 30);
          transcript = await callWithRetry(entry, "stt", 30,
            (e, m) => apiTranscribe(file, Object.assign({}, e, { sttModel: m })));
          sttEngine = "API " + entryLabel(entry);
        }
        if (transcript) { okIndex = i; break; }
      } catch (error) {
        console.warn("Voce catena fallita (" + entryLabel(entry) + "):", error);
        stat(entryLabel(entry) + " non disponibile (" +
          (loadLastErrors()[entry.id] || "errore") + "): provo la successiva…", 30);
      }
    }
    if (!transcript) throw new Error("Nessuna chiave né il modello locale hanno riconosciuto testo.");
    showTranscript(transcript, sttEngine, duration, performance.now() - tStt);

    if (autoTldr) {
      $("#autoNote").textContent = duration === null
        ? "Durata non leggibile: il riepilogo viene generato automaticamente."
        : "Audio oltre il minuto (" + fmtDur(duration) + "): il riepilogo viene generato automaticamente.";
      const r = await runSummaryChain(transcript, okIndex);
      if (r.summary) showTldr(r.summary, r.engine, null, r.ms);
      else showTldrFail(r.reasons);
    } else {
      $("#autoNote").textContent = "Audio breve (" + fmtDur(duration) +
        "): trascrizione completata. Il riepilogo non è stato generato automaticamente.";
      $("#sum").textContent = "Nessun TL;DR per ora: tocca Genera TL;DR se ti serve.";
      $("#regen").textContent = "Genera TL;DR";
    }
    stat("Completato.", 100);
  } catch (error) {
    console.error("Errore durante l'elaborazione:", error);
    stat("Impossibile elaborare l'audio: " + (error?.message || String(error)), 0);
  } finally {
    busy = false;
    if (fileInput) fileInput.disabled = false;
  }
}

function showTranscript(transcript, engine, duration, ms) {
  $("#resultStt").classList.remove("hidden");
  $("#engStt").textContent = engine + " · " + fmtMs(ms);
  $("#durStt").textContent = duration === null ? "n/d" : fmtDur(duration);
  $("#txt").value = transcript;
  $("#all").disabled = false;
  $("#save").disabled = false;
}
function showTldr(summary, engine, note, ms) {
  hasSummary = true;
  const ft = $("#faqTldr"); if (ft) ft.open = true;
  const sum = $("#sum");
  sum.classList.remove("loading");
  sum.textContent = summary;
  $("#engLlm").textContent = engine + (ms != null ? " · " + fmtMs(ms) : "");
  $("#chipLlm").hidden = false;
  $("#regen").textContent = "⟳ Rigenera TL;DR";
  if (note) $("#autoNote").textContent = note;
  updateTldrMeta();
  $("#all").disabled = false;
  $("#save").disabled = false;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  const textarea = document.createElement("textarea");
  textarea.value = text; textarea.style.position = "fixed"; textarea.style.opacity = "0";
  document.body.appendChild(textarea); textarea.select();
  const copied = document.execCommand("copy"); textarea.remove();
  if (!copied) throw new Error("Copia negli appunti non riuscita.");
}

async function loadShared() {
  const params = new URLSearchParams(location.search);
  if (params.has("share-error")) { history.replaceState({}, "", location.pathname); stat("Non è stato possibile ricevere l'audio. Riprova.", 0); return; }
  if (params.get("shared") !== "1") return;
  try {
    if (!("caches" in window)) throw new Error("La cache del browser non è disponibile.");
    const cache = await caches.open(SHARE_CACHE);
    const audioUrl = new URL("shared-audio", document.baseURI).href;
    const response = await cache.match(audioUrl);
    if (!response) { stat("Audio condiviso non trovato. Prova a condividerlo di nuovo.", 0); return; }
    const blob = await response.blob();
    const encoded = response.headers.get("X-SoundScript-Filename") || "audio";
    let filename = "audio";
    try { filename = decodeURIComponent(encoded); } catch { filename = "audio"; }
    await cache.delete(audioUrl);
    history.replaceState({}, "", location.pathname);
    await process(new File([blob], filename, { type: blob.type || "audio/ogg" }));
  } catch (error) {
    console.error("Errore nel recupero dell'audio condiviso:", error);
    history.replaceState({}, "", location.pathname);
    stat("Errore nella ricezione dell'audio condiviso. Riprova.", 0);
  }
}

render();
