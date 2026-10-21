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

let asr = null;
let llm = null;
let busy = false;
let activeModel = null;

let draftKeys = null;
let chainDirty = false;
let providerChoice = "openai";
const modelCache = {};

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
  const st = err && err.status;
  if (st === 401 || st === 403) return "chiave non valida (HTTP " + st + ")";
  if (st === 402) return "crediti esauriti (HTTP 402)";
  if (st === 429) return "limite di frequenza (HTTP 429)";
  if (st === 400) return "modello o richiesta non valida (HTTP 400)";
  if (st === 404) return "modello non trovato (HTTP 404)";
  if (st >= 500) return "errore del provider (HTTP " + st + ")";
  return "errore di rete o CORS";
}

/* ===== Suggerimento modelli valutato dalla PWA ===== */
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
function applySuggFromCache(entry) {
  const cls = modelCache[entry.id];
  if (!cls) return;
  if (!entry.suggStt) entry.suggStt = suggestModel(cls.stt, "stt", entry.provider);
  if (!entry.suggLlm) entry.suggLlm = suggestModel(cls.chat, "llm", entry.provider);
}

function stat(message, percent) {
  const status = $("#status");
  const bar = $("#bar");
  const eq = $("#eq");
  if (status) status.textContent = message;
  if (bar) bar.style.width = percent + "%";
  if (eq) eq.hidden = !(percent > 0 && percent < 100);
}

const LOGO_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
  <path d="M19 10v2a7 7 0 0 1-14 0v-2" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
  <path d="M12 19v3M9 22h6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
</svg>`;
const EQ_HTML = `<div class="equalizer" id="eq" hidden><span></span><span></span><span></span><span></span><span></span></div>`;
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
      (opts.suggId && o.id === opts.suggId ? `<span class="sugg-tag">modello suggerito</span>` : "");
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
    <header class="header">
      <div class="logo">${LOGO_SVG}</div>
      <div class="brand">SoundScript</div>
    </header>

    <main>
      <section class="card hero">
        <h1>Trascrivi i tuoi vocali.</h1>
        <p>Condividi un audio da WhatsApp oppure selezionalo qui.<br>
        L'app prova le chiavi in ordine e chiude con i modelli locali.</p>
      </section>

      <section class="card">
        <div id="drop" class="drop">
          <div style="font-size:34px;margin-bottom:10px">🎙️</div>
          <div style="font-weight:600;margin-bottom:6px">Trascina qui un audio</div>
          <p class="muted">oppure scegli un file</p>
          <button id="pick" class="btn primary" style="margin-top:14px">Scegli audio</button>
          <input id="file" class="hidden" type="file"
            accept="audio/*,.ogg,.opus,.m4a,.mp3,.wav,.aac">
        </div>
        <div class="status-row">${EQ_HTML}<div id="status" class="status" role="status" aria-live="polite">Pronto.</div></div>
        <div class="progress"><div id="bar" class="progress-bar"></div></div>
      </section>

      <section id="resultStt" class="card result-card hidden">
        <div class="section-label">Trascrizione</div>
        <div class="chips"><span class="chip active">Motore: <b id="engStt"></b></span></div>
        <textarea id="txt" aria-label="Testo della trascrizione"></textarea>
        <div class="actions">
          <button id="copy" class="btn secondary">Copia trascrizione</button>
          <button id="share" class="btn secondary">Condividi</button>
        </div>
      </section>

      <section id="resultTldr" class="card">
        <div class="section-label">Riepilogo TL;DR</div>

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
          <button id="savePreset" class="btn secondary">Salva preset</button>
        </div>

        <div class="actions">
          <button id="regen" class="btn primary">⟳ Rigenera TL;DR</button>
        </div>

        <div class="chips" style="margin-top:14px"><span class="chip active" id="chipLlm" hidden>Motore: <b id="engLlm"></b></span></div>
        <div id="sum" class="tldr-box">Il TL;DR comparirà qui dopo l'elaborazione.</div>
        <p id="tldrMeta" class="muted" style="margin-top:8px"></p>

        <div class="actions">
          <button id="all" class="btn primary" disabled>Copia tutto</button>
          <button id="save" class="btn ghost" disabled>Salva</button>
        </div>
      </section>

      <section class="card">
        <div class="section-label">Chiavi API e priorità</div>
        <div class="stack">
          <div id="ddProvider" class="dd"></div>
          <input id="apiKey" type="password" placeholder="Incolla qui la chiave API">
          <input id="baseUrl" type="text" placeholder="URL base (solo Personalizzato)">
          <button id="saveKey" class="btn primary">Salva API key</button>
          <p id="keysMsg" class="muted"></p>
        </div>
        <ul id="keyList" class="chain-list"></ul>
        <div class="actions">
          <button id="saveChain" class="btn primary">Salva ordine provider</button>
          <span id="unsavedChip" class="chip warn" hidden>Modifiche non salvate</span>
        </div>
        <p id="prefMsg" class="muted"></p>
        <p class="muted" style="margin-top:8px">
          Le modifiche alla catena (aggiunte, rimozioni, ordine) restano in bozza
          finché non premi "Salva ordine provider". I modelli scelti si confermano
          con "Salva preferenza modello" dentro i dettagli della chiave.
        </p>
      </section>

      <section class="card">
        <div class="section-label">Modelli locali (fallback offline)</div>
        <div id="ddLocal" class="dd"></div>
        <button id="preload" class="btn secondary" style="margin-top:10px">
          Scarica modelli locali ora
        </button>
        <p class="muted" style="margin-top:8px">
          Mette i modelli in cache subito: il fondo della catena sarà immediato.
          WebGPU viene usato quando disponibile, con ripiego su WASM.
        </p>
      </section>

      <section class="card">
        <div class="section-label">Privacy</div>
        <p class="muted">
          Le chiavi restano su questo dispositivo e vengono inviate solo ai
          provider corrispondenti. Senza chiavi utilizzabili, l'audio non
          esce dal dispositivo: elaborazione locale.
        </p>
      </section>
    </main>
  `;

  $("#pick").onclick = () => $("#file").click();
  $("#file").onchange = (event) => {
    const file = event.target.files?.[0];
    if (file) process(file);
    event.target.value = "";
  };

  const drop = $("#drop");
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("dragover"); };
  drop.ondragleave = () => drop.classList.remove("dragover");
  drop.ondrop = (e) => {
    e.preventDefault(); drop.classList.remove("dragover");
    const file = e.dataTransfer?.files?.[0];
    if (file) process(file);
  };

  $("#preload").onclick = async () => {
    if (busy) return;
    busy = true;
    try {
      if (navigator.storage?.persist) await navigator.storage.persist();
      stat("Scarico il modello Whisper locale…", 10);
      await getASR();
      stat("Scarico il modello TL;DR locale…", 60);
      await getLLM();
      stat("Modelli locali pronti in cache.", 100);
    } catch (error) {
      stat("Download modelli locali non riuscito: " + (error?.message || error), 0);
    } finally { busy = false; }
  };

  const settings = loadSettings();
  providerChoice = settings.lastProvider || "openai";
  buildProviderDD();
  buildLocalDD();

  /* ===== TL;DR ===== */
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
    if (busy) return;
    busy = true;
    const sum = $("#sum");
    sum.classList.add("loading");
    sum.textContent = "Rigenero il TL;DR con le nuove regole…";
    try {
      const r = await runSummaryChain(transcript, 0);
      if (r.summary) showTldr(r.summary, r.engine);
      else {
        sum.classList.remove("loading");
        sum.textContent = "TL;DR non disponibile su questo dispositivo.";
        $("#engLlm").textContent = "non disponibile";
        $("#chipLlm").hidden = false;
      }
      stat("Completato.", 100);
    } catch (error) {
      sum.classList.remove("loading");
      stat("Errore nella rigenerazione: " + (error?.message || error), 0);
    } finally { busy = false; }
  };

  $("#copy").onclick = async () => { await copyText($("#txt").value); stat("Trascrizione copiata.", 100); };
  $("#all").onclick = async () => {
    await copyText($("#txt").value + "\n\nTL;DR\n" + $("#sum").textContent);
    stat("Trascrizione e riepilogo copiati.", 100);
  };
  $("#save").onclick = () => {
    try {
      const items = JSON.parse(localStorage.getItem("vtt-history") || "[]");
      items.unshift({ date: new Date().toISOString(), transcript: $("#txt").value, summary: $("#sum").textContent });
      localStorage.setItem("vtt-history", JSON.stringify(items.slice(0, 20)));
      stat("Salvato nella cronologia locale.", 100);
    } catch (error) { console.error(error); stat("Impossibile salvare nella cronologia locale.", 0); }
  };
  $("#share").onclick = async () => {
    const text = $("#txt").value + "\n\nTL;DR\n" + $("#sum").textContent;
    try {
      if (navigator.share) await navigator.share({ title: "SoundScript", text });
      else { await copyText(text); stat("Testo copiato: puoi incollarlo dove vuoi.", 100); }
    } catch (error) { if (error?.name !== "AbortError") { console.error(error); stat("Impossibile condividere il testo.", 0); } }
  };

  /* ===== Chiavi ===== */
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
      : entryLabel(entry) + " · " + (entry.apiKey || "").slice(0, 6) + "…";
    li.appendChild(lab);

    if (entry.id !== "local") {
      const tog = document.createElement("button");
      tog.className = "btn ghost"; tog.textContent = "dettagli";
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
    <button class="kmodels btn secondary">Aggiorna modelli disponibili</button>
    <p class="kmsg muted"></p>
    <label class="muted">Modello trascrizione (solo audio)</label>
    <div class="ddhost" data-slot="stt"></div>
    <div class="sugg" data-sugg="stt"></div>
    <p class="note" data-note="stt"></p>
    <div class="actions">
      <button class="btn primary" data-savepref="stt">Salva preferenza modello</button>
      <span class="chip ok" data-chip="stt" hidden></span>
    </div>
    <label class="muted">Modello riepilogo (solo chat)</label>
    <div class="ddhost" data-slot="llm"></div>
    <div class="sugg" data-sugg="llm"></div>
    <p class="note" data-note="llm"></p>
    <div class="actions">
      <button class="btn primary" data-savepref="llm">Salva preferenza modello</button>
      <span class="chip ok" data-chip="llm" hidden></span>
    </div>
    <div class="lasterr"></div>
    <button class="kremove btn ghost">Rimuovi chiave</button>`;

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
async function createPipeline(task, model, dtype) {
  try {
    stat("Caricamento modello locale con WebGPU…", 15);
    return await pipeline(task, model, { dtype, device: "webgpu" });
  } catch (webgpuError) {
    console.warn("WebGPU non disponibile, provo WASM:", webgpuError);
    stat("WebGPU non disponibile. Modalità compatibile…", 20);
    return await pipeline(task, model, { dtype: "q8", device: "wasm" });
  }
}
async function getASR() {
  const model = loadSettings().localModel || "onnx-community/whisper-tiny";
  if (asr && activeModel === model) return asr;
  asr = null; activeModel = model;
  asr = await createPipeline("automatic-speech-recognition", model, "fp32");
  return asr;
}
async function getLLM() {
  if (llm) return llm;
  llm = await createPipeline("text-generation", "onnx-community/Qwen2.5-0.5B-Instruct", "q4");
  return llm;
}
async function localTranscribe(file) {
  stat("Preparo l'audio…", 5);
  const audio = await decode(file);
  stat("Trascrizione locale in corso…", 30);
  const transcriber = await getASR();
  const result = await transcriber(audio, { language: "italian", task: "transcribe", chunk_length_s: 30, stride_length_s: 5 });
  return (result.text || "").trim();
}
async function localSummarize(transcript, instruction) {
  stat("Creo il riepilogo TL;DR locale…", 75);
  const summarizer = await getLLM();
  const prompt = instruction + "\n\nTESTO:\n" + transcript;
  const output = await summarizer(prompt, { max_new_tokens: 200, temperature: 0.2, do_sample: false });
  return (output[0]?.generated_text || "").replace(prompt, "").trim();
}

/* ===== Retry: scelto → suggerito → (catena) ===== */
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
            const why = st === 429 ? "limite di frequenza" : (st ? "errore del provider" : "rete instabile");
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
  const chain = loadSettings().keys;
  const instruction = composeInstruction(tldrSettings());
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
        return { summary, engine: entry.id === "local" ? "locale" : "API " + entryLabel(entry) };
      }
    } catch (error) {
      console.warn("Riepilogo fallito (" + entryLabel(entry) + "):", error);
      stat(entryLabel(entry) + " non disponibile per il TL;DR (" +
        (loadLastErrors()[entry.id] || "errore") + "): provo la successiva…", 70);
    }
  }
  return { summary: "", engine: "" };
}

async function process(file) {
  if (busy) { stat("Attendi che termini l'elaborazione in corso."); return; }
  if (!file || file.size === 0) { stat("Il file audio è vuoto o non valido."); return; }
  busy = true;
  const fileInput = $("#file");
  if (fileInput) fileInput.disabled = true;
  try {
    const chain = loadSettings().keys;
    let transcript = "", sttEngine = "", okIndex = -1;
    for (let i = 0; i < chain.length; i++) {
      const entry = chain[i];
      try {
        if (entry.id === "local") {
          transcript = await localTranscribe(file);
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
    showTranscript(transcript, sttEngine);

    const r = await runSummaryChain(transcript, okIndex);
    if (r.summary) showTldr(r.summary, r.engine);
    else {
      const sum = $("#sum");
      sum.textContent = "TL;DR non disponibile su questo dispositivo.";
      $("#engLlm").textContent = "non disponibile";
      $("#chipLlm").hidden = false;
      $("#all").disabled = false; $("#save").disabled = false;
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

function showTranscript(transcript, engine) {
  $("#resultStt").classList.remove("hidden");
  $("#engStt").textContent = engine;
  $("#txt").value = transcript;
}
function showTldr(summary, engine) {
  const sum = $("#sum");
  sum.classList.remove("loading");
  sum.textContent = summary;
  $("#engLlm").textContent = engine;
  $("#chipLlm").hidden = false;
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

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try { await navigator.serviceWorker.register("./sw.js"); console.log("Service worker registrato."); }
    catch (error) { console.error("Registrazione service worker fallita:", error); }
  });
}

render();
