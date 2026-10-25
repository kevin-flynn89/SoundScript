const ENDPOINTS = {
  openai:    { label: "OpenAI",         baseUrl: "https://api.openai.com/v1",     family: "openai",
               recommended: { stt: "gpt-4o-transcribe", llm: "gpt-4o-mini" } },
  groq:      { label: "Groq",           baseUrl: "https://api.groq.com/openai/v1", family: "openai",
               recommended: { stt: "whisper-large-v3",     llm: "llama-3.1-8b-instant" } },
  google:    { label: "Google Gemini",  baseUrl: "https://generativelanguage.googleapis.com/v1beta", family: "google",
               recommended: { stt: "models/gemini-2.0-flash", llm: "models/gemini-2.0-flash-lite" } },
  anthropic: { label: "Anthropic",      baseUrl: "https://api.anthropic.com/v1", family: "anthropic",
               recommended: { stt: null, llm: "claude-3-5-haiku-latest" }, chatOnly: true },
  mistral:   { label: "Mistral",        baseUrl: "https://api.mistral.ai/v1",   family: "openai",
               recommended: { stt: "voxtral-mini-transcribe-2507", llm: "mistral-small-latest" } },
  custom:    { label: "Personalizzato", baseUrl: "",                            family: "openai",
               recommended: { stt: "gpt-4o-transcribe", llm: "gpt-4o-mini" } }
};

export const PROVIDERS = ENDPOINTS;

export async function listModels(entry, signal) {
  const p = ENDPOINTS[entry.provider] || ENDPOINTS.custom;
  const base = (entry.baseUrl && entry.baseUrl.trim()) || p.baseUrl;
  if (!base) return [];

  /* Anthropic: chiamata reale a /v1/models (così il tasto Testa è significativo) */
  if (p.family === "anthropic") {
    const url = base.replace(/\/$/, "") + "/models";
    const res = await fetch(url, {
      headers: { "x-api-key": entry.apiKey, "anthropic-version": "2023-06-01" },
      signal
    });
    if (!res.ok) {
      const err = new Error("HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    return (data.data || []).map((m) => ({ id: m.id, label: m.id }));
  }

  /* Google Gemini */
  if (p.family === "google") {
    const url = base.replace(/\/$/, "") + "/models?key=" + encodeURIComponent(entry.apiKey);
    const res = await fetch(url, { signal });
    if (!res.ok) {
      const err = new Error("HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    return (data.models || []).map((m) => ({ id: m.name, label: m.name }));
  }

  /* OpenAI-compatibili (OpenAI, Groq, Mistral, custom) */
  const url = base.replace(/\/$/, "") + "/models";
  const res = await fetch(url, {
    headers: { "Authorization": "Bearer " + entry.apiKey },
    signal
  });
  if (!res.ok) {
    const err = new Error("HTTP " + res.status);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return (data.data || []).map((m) => ({ id: m.id, label: m.id }));
}

export function classifyModels(models, family) {
  const stt = [];
  const chat = [];
  for (const m of models) {
    const id = m.id || m.name || "";
    const low = id.toLowerCase();
    if (family === "anthropic") {
      chat.push({ id, label: m.label || id });
    } else if (/whisper|transcribe|voxtral|speech|asr|audio/i.test(low)) {
      stt.push({ id, label: id });
    } else if (family === "google" && /flash|pro|gemini/i.test(low)) {
      stt.push({ id, label: id + " (audio)" });
      chat.push({ id, label: id });
    } else {
      chat.push({ id, label: id });
    }
  }
  return { stt, chat };
}

export async function apiTranscribe(file, entry, signal) {
  const p = ENDPOINTS[entry.provider] || ENDPOINTS.custom;
  if (p.chatOnly) throw new Error("Questo provider non supporta la trascrizione audio");

  const base = (entry.baseUrl && entry.baseUrl.trim()) || p.baseUrl;
  const model = entry.sttModel || p.recommended.stt;

  /* Google Gemini (audio inline) */
  if (p.family === "google") {
    const url = base.replace(/\/$/, "") + "/" + model + ":generateContent?key=" + encodeURIComponent(entry.apiKey);
    const bytes = await file.arrayBuffer();
    const mime = file.type || "audio/ogg";
    let b64 = "";
    const chunk = 32768;
    const u8 = new Uint8Array(bytes);
    for (let i = 0; i < u8.length; i += chunk) {
      b64 += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    b64 = btoa(b64);
    const body = {
      contents: [{
        parts: [
          { inlineData: { mimeType: mime, data: b64 } },
          { text: "Trascrivi fedelmente l'audio parola per parola, nella sua lingua originale. Restituisci solo il testo, senza commenti." }
        ]
      }]
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal
    });
    if (!res.ok) {
      const err = new Error("HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((x) => x.text || "").join(" ") || "";
    return text.trim();
  }

  /* Mistral Voxtral (multipart) */
  if (entry.provider === "mistral") {
    const url = base.replace(/\/$/, "") + "/audio/transcriptions";
    const fd = new FormData();
    fd.append("file", file, file.name || "audio");
    fd.append("model", model);
    fd.append("language", "it");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Authorization": "Bearer " + entry.apiKey },
      body: fd,
      signal
    });
    if (!res.ok) {
      const err = new Error("HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    return (data.text || "").trim();
  }

  /* OpenAI-compatibili (OpenAI, Groq, custom) */
  const url = base.replace(/\/$/, "") + "/audio/transcriptions";
  const fd = new FormData();
  fd.append("file", file, file.name || "audio");
  fd.append("model", model);
  fd.append("response_format", "json");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": "Bearer " + entry.apiKey },
    body: fd,
    signal
  });
  if (!res.ok) {
    const err = new Error("HTTP " + res.status);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return (data.text || "").trim();
}

export async function apiSummarize(transcript, entry, instruction, signal) {
  const p = ENDPOINTS[entry.provider] || ENDPOINTS.custom;
  const base = (entry.baseUrl && entry.baseUrl.trim()) || p.baseUrl;
  const model = entry.llmModel || p.recommended.llm;
  const prompt = instruction + "\n\nTESTO:\n" + transcript;

  /* Anthropic (Messages API) */
  if (p.family === "anthropic") {
    const url = base.replace(/\/$/, "") + "/messages";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": entry.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }]
      }),
      signal
    });
    if (!res.ok) {
      const err = new Error("HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
    return text.trim();
  }

  /* Google Gemini */
  if (p.family === "google") {
    const url = base.replace(/\/$/, "") + "/" + model + ":generateContent?key=" + encodeURIComponent(entry.apiKey);
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 }
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal
    });
    if (!res.ok) {
      const err = new Error("HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((x) => x.text || "").join(" ") || "";
    return text.trim();
  }

  /* OpenAI-compatibili */
  const url = base.replace(/\/$/, "") + "/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + entry.apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: model,
      temperature: 0.2,
      messages: [
        { role: "system", content: "Sei un assistente che riassume messaggi vocali in modo fedele." },
        { role: "user", content: prompt }
      ]
    }),
    signal
  });
  if (!res.ok) {
    const err = new Error("HTTP " + res.status);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}