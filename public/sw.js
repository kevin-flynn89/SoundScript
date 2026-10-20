const CACHE_NAME = "soundscript-share-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith("soundscript-") && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    );
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "POST") return;

  const url = new URL(request.url);
  const targetUrl = new URL("share-target.html", self.registration.scope);
  if (url.origin !== targetUrl.origin || url.pathname !== targetUrl.pathname) return;

  event.respondWith((async () => {
    try {
      const formData = await request.formData();
      const file = formData.get("audio");

      if (!(file instanceof File) || file.size === 0) {
        return Response.redirect(new URL("?share-error=1", self.registration.scope).href, 303);
      }

      const cache = await caches.open(CACHE_NAME);
      const sharedAudioUrl = new URL("shared-audio", self.registration.scope).href;
      await cache.put(sharedAudioUrl, new Response(file, {
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-SoundScript-Filename": encodeURIComponent(file.name || "audio")
        }
      }));

      return Response.redirect(new URL("?shared=1", self.registration.scope).href, 303);
    } catch (error) {
      return Response.redirect(new URL("?share-error=1", self.registration.scope).href, 303);
    }
  })());
});
