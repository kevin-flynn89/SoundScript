/* Timbro di build: viene sostituito automaticamente da vite.config.js
   a ogni deploy. Serve solo a far cambiare i byte di questo file,
   così il browser rileva la nuova versione. */
const SW_BUILD = "__SW_BUILD__";

const CORE_CACHE = "soundscript-core-v2";
const SHARE_CACHE = "soundscript-share-v1";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./share-target.html",
  "./icon-light.svg",
  "./icon-dark.svg",
  "./icon-dark-transparent.svg",
  "./logo-light.svg",
  "./logo-dark.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CORE_CACHE)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .catch(() => {})
  );
  /* Soluzione A: attivazione silenziosa del SW nuovo, senza attendere
     la chiusura delle tab. Il main.js mostrerà un toast informativo
     leggero quando il controllerchange scatterà. */
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith("soundscript-core-") && k !== CORE_CACHE)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

/* Messaggio residuo (retrocompatibilità con versioni precedenti). */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method === "POST" && url.pathname.endsWith("/share-target.html")) {
    event.respondWith(handleShare(req));
    return;
  }

  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CORE_CACHE).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      const fresh = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CORE_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || fresh;
    })
  );
});

async function handleShare(req) {
  try {
    const form = await req.formData();
    const file = form.get("audio") ||
      Array.from(form.values()).find((v) => v instanceof File);
    if (!file) return Response.redirect("./?share-error=1", 303);
    const cache = await caches.open(SHARE_CACHE);
    await cache.put(
      new URL("shared-audio", self.location.href).href,
      new Response(file, {
        headers: { "X-SoundScript-Filename": encodeURIComponent(file.name || "audio") }
      })
    );
    return Response.redirect("./?shared=1", 303);
  } catch (err) {
    return Response.redirect("./?share-error=1", 303);
  }
}