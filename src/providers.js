export const PROVIDERS = {
  openai: {
    family: "openai",
    label: "OpenAI",
    base: "https://api.openai.com/v1",
    recommended: { stt: "whisper-1", llm: "gpt-4o-mini" }
  },
  groq: {
    family: "openai",
    label: "Groq",
    base: "https://api.groq.com/openai/v1",
    recommended: { stt: "whisper-large-v3-turbo", llm: "llama-3.1-8b-instant" }
  },
  google: {
    family: "gemini",
    label: "Google Gemini",
    base: "https://generativelanguage.googleapis.com/v1beta",
    recommended: { stt: "models/gemini-2.0-flash", llm: "models/gemini-2.0-flash-lite" }
  },
  custom: {
    family: "openai",
    label: "Personalizzato (compatibile OpenAI)",
    base: "",
    recommended: { stt: "whisper-1", llm: "gpt-4o-mini" }
  }
};

function baseFor(settings) {
  const p = PROVIDERS[settings.provider] || PROVIDERS.openai;
  const raw = settings.provider === "custom" ? (settings.baseUrl || "") : p.base;
  return raw.replace(/\/+$/, "");
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function httpError(res, label) {
  const e = new Error(label + " HTTP " + res.status);
  e.status = res.status;
  return e;
}

export async function listModels(settings) {
  const p = PROVIDERS[settings.provider] || PROVIDERS.openai;

  if (p.family === "gemini") {
    const res = await fetch(
      baseFor(settings) + "/models?key=" + encodeURIComponent(settings.apiKey)
    );
    if (!res.ok) throw httpError(res, "Elenco modelli");
    const data = await res.json();
    return (data.models || [])
      .filter((m) =>
        (m.supportedGenerationMethods || []).includes("generateContent")
      )
      .map((m) => ({ id: m.name, label: m.displayName || m.name }));
  }

  const res = await fetch(baseFor(settings) + "/models", {
    headers: { Authorization: "Bearer " + settings.apiKey }
  });
  if (!res.ok) throw httpError(res, "Elenco modelli");
  const data = await res.json();
  return (data.data || []).map((m) => ({ id: m.id, label: m.id }));
}

/* Divide i modelli per capacità: audio/trascrizione vs chat/riepilogo */
export function classifyModels(models, family) {
  if (family === "gemini") return { stt: models.slice(), chat: models.slice() };
  const sttRe = /whisper|transcribe|voxtral|audio|speech|stt|parakeet/i;
  const stt = models.filter((m) => sttRe.test(m.id));
  const chat = models.filter((m) => !sttRe.test(m.id));
  return {
    stt: stt.length ? stt : models.slice(),
    chat: chat.length ? chat : models.slice()
  };
}

export async function apiTranscribe(file, settings) {
  const p = PROVIDERS[settings.provider] || PROVIDERS.openai;

  if (p.family === "gemini") {
    const model = settings.sttModel || p.recommended.stt;
    const b64 = toBase64(await file.arrayBuffer());
    const res = await fetch(
      baseFor(settings) + "/" + model + ":generateContent?key=" +
        encodeURIComponent(settings.apiKey),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: "Trascrivi verbatim in italiano il contenuto di questo audio. Rispondi solo con la trascrizione, senza commenti." },
              { inline_data: { mime_type: file.type || "audio/ogg", data: b64 } }
            ]
          }]
        })
      }
    );
    if (!res.ok) throw httpError(res, "API trascrizione");
    const data = await res.json();
    const text = (data?.candidates?.[0]?.content?.parts || [])
      .map((x) => x.text || "").join("").trim();
    if (!text) throw new Error("API trascrizione: testo vuoto");
    return text;
  }

  const form = new FormData();
  form.append("file", file, file.name || "audio.ogg");
  form.append("model", settings.sttModel || p.recommended.stt);
  form.append("language", "it");
  const res = await fetch(baseFor(settings) + "/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: "Bearer " + settings.apiKey },
    body: form
  });
  if (!res.ok) throw httpError(res, "API trascrizione");
  const data = await res.json();
  const text = (data.text || "").trim();
  if (!text) throw new Error("API trascrizione: testo vuoto");
  return text;
}

export async function apiSummarize(transcript, settings, instruction) {
  const p = PROVIDERS[settings.provider] || PROVIDERS.openai;
  const instr = instruction ||
    "Riassumi in italiano in massimo 3 frasi. Conserva solo le informazioni importanti. Non inventare dettagli.";

  if (p.family === "gemini") {
    const model = settings.llmModel || p.recommended.llm;
    const res = await fetch(
      baseFor(settings) + "/" + model + ":generateContent?key=" +
        encodeURIComponent(settings.apiKey),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: instr + "\n\nTESTO:\n" + transcript }] }]
        })
      }
    );
    if (!res.ok) throw httpError(res, "API riepilogo");
    const data = await res.json();
    const summary = (data?.candidates?.[0]?.content?.parts || [])
      .map((x) => x.text || "").join("").trim();
    if (!summary) throw new Error("API riepilogo: risposta vuota");
    return summary;
  }

  const res = await fetch(baseFor(settings) + "/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + settings.apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: settings.llmModel || p.recommended.llm,
      messages: [
        { role: "system", content: instr },
        { role: "user", content: transcript }
      ],
      max_tokens: 200,
      temperature: 0.2
    })
  });
  if (!res.ok) throw httpError(res, "API riepilogo");
  const data = await res.json();
  const summary = (data.choices?.[0]?.message?.content || "").trim();
  if (!summary) throw new Error("API riepilogo: risposta vuota");
  return summary;
}
