import { getStore } from "@netlify/blobs";
// Lien sécurisé vers une facture.
//  - POST action "save"   (vendeur, avec la clé secrète de sa boutique en ligne) : publie ou met à jour la facture et renvoie un jeton imprévisible (144 bits).
//  - POST action "revoke" (vendeur) : désactive le lien.
//  - GET ?t=<jeton> (public) : renvoie la facture. Sans le jeton rien n'est accessible, et rien ne peut être listé.
// Le serveur ne croit que ce qu'il a validé : seuls les champs prévus sont gardés, tronqués et nettoyés ; l'appli les affiche toujours en texte (jamais en HTML).
const H = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };
const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: H });
const okSlug = s => typeof s === "string" && /^[a-z0-9-]{3,40}$/.test(s);
const TOKEN = /^[A-Za-z0-9_-]{22,32}$/;
const MODES = ["mixx", "moov", "bank", "cash"];
const TTL = (Number(process.env.INVOICE_TTL_DAYS) || 365) * 86400000;
const PER_IP_HOUR = Number(process.env.INVOICES_PER_IP_HOUR) || 60, PER_SHOP_DAY = Number(process.env.INVOICES_PER_SHOP_DAY) || 300;
const MAX_BODY = 90000;
async function sha(t) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
const newToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const txt = (x, n) => String(x == null ? "" : x).replace(/[\r\n\t]+/g, " ").trim().slice(0, n);
const amount = (x, max) => { const n = Number(x); return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 100) / 100 : 0; };
const okPhoto = (s, max = 46000) => typeof s === "string" && s.length < max && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(s);
async function bump(store, key, max) { // compteur : false si la limite est atteinte ; lève une erreur si le compteur est indisponible
  const n = Number(await store.get(key)) || 0;
  if (n >= max) return false;
  await store.set(key, String(n + 1)); return true;
}
function clean(b) {
  b = b && typeof b === "object" ? b : {};
  if (Array.isArray(b.lines) && b.lines.length > 100) return null; // on refuse plutôt que de tronquer en silence (le total serait faux)
  const lines = (Array.isArray(b.lines) ? b.lines : []).filter(l => l && typeof l === "object")
    .map(l => ({ n: txt(l.n, 200), q: Math.max(1, Math.min(99999, Math.floor(Number(l.q)) || 1)), p: amount(l.p, 1e12), cur: txt(l.cur, 5) || "FCFA" }));
  const no = String(b.no || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 12);
  if (!lines.length || !no) return null;
  const sh = b.shop && typeof b.shop === "object" ? b.shop : {}, cl = b.client && typeof b.client === "object" ? b.client : {};
  const phone = x => String(x == null ? "" : x).replace(/[^0-9+() .-]/g, "").trim().slice(0, 30);
  return {
    v: 1, lang: b.lang === "en" ? "en" : "fr", no, date: Math.floor(amount(b.date, 8.64e15)) || Date.now(),
    shop: { name: txt(sh.name, 60), phone: phone(sh.phone), addr: txt(sh.addr, 120) },
    client: { name: txt(cl.name, 60), phone: phone(cl.phone) },
    lines, paid: !!b.paid,
    modes: (Array.isArray(b.modes) ? b.modes : []).filter(k => MODES.includes(k)).slice(0, 4),
    instr: (Array.isArray(b.instr) ? b.instr : []).slice(0, 6).map(x => txt(x, 200)).filter(Boolean),
    ask: !!b.ask
  };
}
async function handle(req) {
  const url = new URL(req.url), en = url.searchParams.get("ui") === "en", T = (fr, e) => en ? e : fr;
  const store = getStore({ name: "invoices", consistency: "strong" });
  const gone = () => j({ error: T("Ce lien est invalide ou a expiré. Demande un nouveau lien à la boutique.", "This link is invalid or has expired. Ask the shop for a new link.") }, 404);
  if (req.method === "GET") {
    if (url.searchParams.get("ping")) {
      try { await store.get("__ping__"); return j({ ok: true, detail: T("stockage OK", "storage OK") }); }
      catch (e) { return j({ error: T("Stockage Netlify indisponible : ", "Netlify storage unavailable: ") + String(e && e.message || e).slice(0, 120) }, 500); }
    }
    const t = url.searchParams.get("t") || "";
    if (!TOKEN.test(t)) return gone();
    const rec = await store.get("i/" + t, { type: "json" });
    if (!rec) return gone();
    if (Date.now() > (rec.exp || 0)) { await store.delete("i/" + t); return gone(); }
    const logo = await store.get("logo/" + rec.slug);
    return j({ ok: true, inv: rec.inv, logo: okPhoto(logo) ? logo : "" });
  }
  if (req.method !== "POST") return j({ error: T("Méthode non permise", "Method not allowed") }, 405);
  if ((Number(req.headers.get("content-length")) || 0) > MAX_BODY) return j({ error: T("Requête trop grosse", "Request too large") }, 413);
  let b; try { b = await req.json(); } catch { return j({ error: T("Requête invalide", "Invalid request") }, 400); }
  b = b || {};
  if (!okSlug(b.slug) || typeof b.key !== "string" || b.key.length < 16) return j({ error: T("Données invalides", "Invalid data") }, 400);
  const rec = await getStore({ name: "catalogues", consistency: "strong" }).get(b.slug, { type: "json" });
  if (!rec) return j({ error: T("Active d'abord ta boutique en ligne (onglet Catalogue public).", "Turn on your online shop first (Public catalogue tab).") }, 404);
  if ((await sha(b.key)) !== rec.kh) return j({ error: T("Accès refusé", "Access denied") }, 403);

  if (b.action === "revoke") {
    if (!TOKEN.test(b.token || "")) return j({ error: T("Données invalides", "Invalid data") }, 400);
    const old = await store.get("i/" + b.token, { type: "json" });
    if (old && old.slug !== b.slug) return j({ error: T("Accès refusé", "Access denied") }, 403);
    if (old) await store.delete("i/" + b.token);
    return j({ ok: true });
  }
  if (b.action !== "save") return j({ error: T("Requête invalide", "Invalid request") }, 400);
  const inv = clean(b.inv);
  if (!inv) return j({ error: T("Facture invalide", "Invalid invoice") }, 400);
  try { // limites d'enregistrements : par visiteur et par heure, par boutique et par jour (anti-abus du stockage)
    const us = getStore({ name: "invoice-usage", consistency: "strong" }), ip = req.headers.get("x-nf-client-connection-ip") || "anon", now = new Date().toISOString();
    if (!(await bump(us, "ip_" + ip + "_" + now.slice(0, 13), PER_IP_HOUR)) || !(await bump(us, "shop_" + b.slug + "_" + now.slice(0, 10), PER_SHOP_DAY)))
      return j({ error: T("Trop de factures partagées aujourd'hui, réessaie plus tard.", "Too many invoices shared today, try again later.") }, 429);
  } catch { return j({ error: T("Service momentanément indisponible, réessaie.", "Service temporarily unavailable, try again.") }, 503); }
  let token = "", created = Date.now();
  if (TOKEN.test(b.token || "")) { // mise à jour du même lien (statut payé, nom du client…) : seulement si ce jeton appartient à cette boutique
    const old = await store.get("i/" + b.token, { type: "json" });
    if (old && old.slug === b.slug) { token = b.token; created = old.created || created; }
  }
  if (!token) token = newToken();
  const now = Date.now();
  await store.setJSON("i/" + token, { slug: b.slug, created, updated: now, exp: now + TTL, inv });
  const logo = b.inv && b.inv.logo;
  if (okPhoto(logo)) await store.set("logo/" + b.slug, logo);
  return j({ ok: true, token, exp: now + TTL });
}
export default async (req) => {
  try { return await handle(req); }
  catch (e) { console.error("invoice error", e); return j({ error: new URL(req.url).searchParams.get("ui") === "en" ? "Server error, try again." : "Erreur serveur, réessaie." }, 500); }
};
export const config = { path: "/api/invoice" };
