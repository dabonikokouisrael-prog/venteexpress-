/* VenteExpress : hors ligne léger. La page de l'appli reste ouvrable sans réseau (stock, ventes, prix, factures).
   Les appels /api/* (IA, catalogue) ne sont jamais mis en cache : ils reprennent quand le réseau revient. */
const V = "ve-v5", SHELL = "/";
self.addEventListener("install", e => {
  e.waitUntil(caches.open(V).then(c => c.add(new Request(SHELL, { cache: "reload" }))).then(() => self.skipWaiting(), () => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
const withTimeout = (p, ms) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("timeout")), ms);
  p.then(r => { clearTimeout(t); res(r); }, err => { clearTimeout(t); rej(err); });
});
self.addEventListener("fetch", e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== self.location.origin || u.pathname.indexOf("/api/") === 0) return;
  if (r.mode === "navigate") {
    /* Réseau d'abord (version à jour), cache si le réseau est absent ou trop lent (4 s) */
    e.respondWith((async () => {
      try {
        const res = await withTimeout(fetch(r), 4000);
        if (res.ok && (res.headers.get("content-type") || "").indexOf("text/html") >= 0) { const c = await caches.open(V); c.put(SHELL, res.clone()); }
        return res;
      } catch (err) {
        const hit = await (await caches.open(V)).match(SHELL);
        return hit || Response.error();
      }
    })());
    return;
  }
  e.respondWith(fetch(r).then(res => {
    if (res.ok) { const cp = res.clone(); caches.open(V).then(c => c.put(r, cp)); }
    return res;
  }).catch(() => caches.match(r).then(hit => hit || Response.error())));
});
