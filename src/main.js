import { pipeline, env } from "@huggingface/transformers";
import { PROVIDERS, listModels, apiTranscribe, apiSummarize } from "./providers.js";
import "./style.css";

env.allowLocalModels = false;
env.useBrowserCache = true;

const $ = (selector) => document.querySelector(selector);

const SHARE_CACHE = "soundscript-share-v1";
const SETTINGS_KEY = "vtt-settings";

let asr = null;
let llm = null;
let busy = false;
let activeModel = null;

/* ===== Regole TL;DR personalizzabili ===== */
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
          <select id="provider">
            <option value="openai">OpenAI</option>
            <option value="groq">Groq</option>
            <option value="google">Google Gemini</option>
            <option value="custom">Personalizzato (compatibile OpenAI)</option>
          </select>
          <input id="apiKey" type="password" placeholder="Incolla qui la chiave API">
          <input id="baseUrl" type="text" placeholder="URL base (solo Personalizzato)">
          <button id="addKey" class="btn secondary">Aggiungi chiave</button>
          <p id="keysMsg" class="muted"></p>
        </div>
        <ul id="keyList" class="chain-list"></ul>
        <p id="prefMsg" class="muted"></p>
        <p class="muted" style="margin-top:8px">
          Trascina la maniglia ⋮ col dito per decidere l'ordine.
          Ogni modifica si salva da sola. Se una chiave esaurisce i
          crediti, l'app passa alla voce successiva della catena.
        </p>
      </section>

      <section class="card">
        <div class="section-label">Modelli locali (fallback offline)</div>
        <select id="model">
          <option value="onnx-community/whisper-tiny">Tiny — più leggero</option>
          <option value="onnx-community/whisper-base">Base — più accurato</option>
        </select>
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

  $("#model").onchange = () => { asr = null; activeModel = null; };

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
  const modelSel = $("#model");
  if (settings.localModel &&
      [...modelSel.options].some((o) => o.value === settings.localModel)) {
    modelSel.value = settings.localModel;
  }

  $("#addKey").onclick = () => {
    const key = $("#apiKey").value.trim();
    const msg = $("#keysMsg");
    if (!key) { msg.textContent = "Incolla prima una chiave API."; return; }
    const s = loadSettings();
    const entry = {
      id: "k" + Date.now(), provider: $("#provider").value, apiKey: key,
      baseUrl: $("#baseUrl").value.trim(), sttModel: "", llmModel: ""
    };
    const localIndex = s.keys.findIndex((k) => k.id === "local");
    s.keys.splice(localIndex < 0 ? s.keys.length : localIndex, 0, entry);
    saveSettings({ keys: s.keys });
    $("#apiKey").value = ""; $("#baseUrl").value = "";
    msg.textContent = "Chiave aggiunta: trascina ⋮ per ordinare la priorità.";
    renderKeyList(); updatePrefMsg();
  };

  /* ===== controlli TL;DR ===== */
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

  renderKeyList();
  updatePrefMsg();
  syncTldrUi();
  renderPresets();
  loadShared();
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

function updatePrefMsg() { $("#prefMsg").textContent = "All'avvio uso: " + chainLabel() + "."; }

function renderKeyList() {
  const s = loadSettings();
  const list = $("#keyList");
  list.innerHTML = "";
  for (const entry of s.keys) {
    const li = document.createElement("li");
    li.className = "chain-item";
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
      det.innerHTML = `
        <button class="kmodels btn secondary">Carica modelli disponibili</button>
        <p class="kmsg muted"></p>
        <div class="kselects">
          <label class="muted">Modello trascrizione</label><select class="kstt"></select>
          <label class="muted">Modello TL;DR</label><select class="kllm"></select>
        </div>
        <button class="kremove btn ghost">Rimuovi chiave</button>`;
      li.appendChild(det);

      tog.onclick = () => det.classList.toggle("open");
      det.querySelector(".kmodels").onclick = async () => {
        const msg = det.querySelector(".kmsg");
        msg.textContent = "Carico i modelli con questa chiave…";
        try {
          const models = await listModels(entry);
          if (!models.length) { msg.textContent = "Nessun modello trovato."; return; }
          const p = PROVIDERS[entry.provider] || PROVIDERS.openai;
          const stt = fillModelSelect(det.querySelector(".kstt"), models, p.recommended.stt, entry.sttModel);
          const llm = fillModelSelect(det.querySelector(".kllm"), models, p.recommended.llm, entry.llmModel);
          updateEntry(entry.id, { sttModel: stt, llmModel: llm });
          det.querySelector(".kselects").classList.add("open");
          msg.textContent = models.length + " modelli trovati: quelli consigliati hanno il flag.";
        } catch (error) {
          msg.textContent = "Lettura non riuscita: " + (error?.message || error);
        }
      };
      det.querySelector(".kremove").onclick = () => {
        const s2 = loadSettings();
        s2.keys = s2.keys.filter((k) => k.id !== entry.id);
        saveSettings({ keys: s2.keys });
        renderKeyList(); updatePrefMsg();
      };
    }
    list.appendChild(li);
  }
  enableSort(list);
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
    const s = loadSettings();
    s.keys.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    saveSettings({ keys: s.keys });
    updatePrefMsg();
  });
}

function fillModelSelect(sel, models, recommendedId, savedId) {
  sel.innerHTML = "";
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label + (m.id === recommendedId ? " — consigliato" : "");
    sel.appendChild(opt);
  }
  const chosen =
    savedId && models.some((m) => m.id === savedId) ? savedId :
    models.some((m) => m.id === recommendedId) ? recommendedId :
    models[0]?.id || "";
  sel.value = chosen;
  return chosen;
}

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
  const model = $("#model").value;
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

/* ===== Catena di riepilogo (riusata da process e da Rigenera) ===== */
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
        summary = await apiSummarize(transcript, entry, instruction);
      }
      if (summary) {
        return { summary, engine: entry.id === "local" ? "locale" : "API " + entryLabel(entry) };
      }
    } catch (error) {
      console.warn("Riepilogo fallito (" + entryLabel(entry) + "):", error);
      stat(entryLabel(entry) + " non disponibile per il TL;DR: provo la successiva…", 70);
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
        if (entry.id === "local") { transcript = await localTranscribe(file); sttEngine = "locale"; }
        else { stat("Trascrizione con " + entryLabel(entry) + "…", 30); transcript = await apiTranscribe(file, entry); sttEngine = "API " + entryLabel(entry); }
        if (transcript) { okIndex = i; break; }
      } catch (error) {
        console.warn("Voce catena fallita (" + entryLabel(entry) + "):", error);
        stat(entryLabel(entry) + " non disponibile: provo la successiva…", 30);
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
