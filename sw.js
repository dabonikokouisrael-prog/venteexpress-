/* VenteExpress : hors ligne léger (version 3.7.3). La page de l'appli reste ouvrable sans réseau (stock, ventes, prix, factures).
   Les appels /api/* (IA, catalogue, messages) ne sont jamais mis en cache : ils reprennent quand le réseau revient.
   Les pages publiques (catalogue, facture, suivi) passent toujours par le réseau : leurs données ne doivent jamais être anciennes. */
const V = "ve-v6", SHELL = "/";
const NET_ONLY = ["/catalogue/", "/facture/", "/suivi/"];
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
  if (NET_ONLY.some(p => u.pathname.indexOf(p) === 0)) return;          /* pages publiques : réseau seulement, jamais de copie */
  if (r.mode === "navigate") {
    /* Réseau d'abord (version à jour), cache si le réseau est absent ou trop lent (4 s). Seule l'entrée « / » est gardée. */
    e.respondWith((async () => {
      try {
        const res = await withTimeout(fetch(r), 4000);
        if (u.pathname === "/" && res.ok && (res.headers.get("content-type") || "").indexOf("text/html") >= 0) { const c = await caches.open(V); c.put(SHELL, res.clone()); }
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
