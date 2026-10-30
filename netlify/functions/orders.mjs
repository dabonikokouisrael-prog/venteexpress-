import { getStore } from "@netlify/blobs";
// Commandes passées depuis le catalogue public.
//  - POST action "create"  (public)  : le client envoie ses articles ; les PRIX sont relus dans le catalogue publié, jamais crus sur parole.
//  - POST action "list"/"ack" (vendeur, avec sa clé secrète) : l'appli du vendeur relève les nouvelles commandes puis les efface du serveur.
const H = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: H });
const okSlug = s => typeof s === "string" && /^[a-z0-9-]{3,40}$/.test(s);
const MODES = ["mixx", "moov", "bank", "cash"];
const PER_IP_HOUR = Number(process.env.ORDERS_PER_IP_HOUR) || 12, PER_SHOP_DAY = Number(process.env.ORDERS_PER_SHOP_DAY) || 150;
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", MAX_AGE = 60 * 86400000;
async function sha(t) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
const newRef = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), x => ALPHA[x % ALPHA.length]).join("");
const txt = (x, n) => String(x == null ? "" : x).replace(/[\r\n\t]+/g, " ").trim().slice(0, n);
async function bump(store, key, max) { // compteur : renvoie false si la limite est atteinte ; lève une erreur si le compteur est indisponible
  const n = Number(await store.get(key)) || 0;
  if (n >= max) return false;
  await store.set(key, String(n + 1)); return true;
}
async function handle(req) {
  const url = new URL(req.url), en = url.searchParams.get("ui") === "en", T = (fr, e) => en ? e : fr;
  if (req.method === "GET") {
    if (url.searchParams.get("ping")) {
      try { await getStore({ name: "orders", consistency: "strong" }).get("__ping__"); return j({ ok: true, detail: T("stockage OK", "storage OK") }); }
      catch (e) { return j({ error: T("Stockage Netlify indisponible : ", "Netlify storage unavailable: ") + String(e && e.message || e).slice(0, 120) }, 500); }
    }
    return j({ error: T("Méthode non permise", "Method not allowed") }, 405);
  }
  if (req.method !== "POST") return j({ error: T("Méthode non permise", "Method not allowed") }, 405);
  if ((Number(req.headers.get("content-length")) || 0) > 20000) return j({ error: T("Requête trop grosse", "Request too large") }, 413);
  let b; try { b = await req.json(); } catch { return j({ error: T("Requête invalide", "Invalid request") }, 400); }
  b = b || {};
  if (!okSlug(b.slug)) return j({ error: T("Lien invalide", "Invalid link") }, 400);
  const cats = getStore({ name: "catalogues", consistency: "strong" }), ords = getStore({ name: "orders", consistency: "strong" });
  const rec = await cats.get(b.slug, { type: "json" });
  if (!rec) return j({ error: T("Catalogue introuvable", "Catalogue not found") }, 404);
  const prefix = "o/" + b.slug + "/";

  if (b.action === "list" || b.action === "ack") {
    if (typeof b.key !== "string" || b.key.length < 16 || (await sha(b.key)) !== rec.kh) return j({ error: T("Accès refusé", "Access denied") }, 403);
    if (b.action === "ack") {
      const refs = (Array.isArray(b.refs) ? b.refs : []).slice(0, 200).filter(r => typeof r === "string" && /^[A-Z0-9]{6}$/.test(r));
      for (const r of refs) await ords.delete(prefix + r);
      return j({ ok: true, n: refs.length });
    }
    const out = [], { blobs } = await ords.list({ prefix });
    for (const bl of (blobs || []).slice(0, 50)) {
      const o = await ords.get(bl.key, { type: "json" });
      if (!o) continue;
      if (Date.now() - (o.created || 0) > MAX_AGE) { await ords.delete(bl.key); continue; }
      out.push(o);
    }
    return j({ orders: out });
  }

  // ----- Commande d'un client -----
  if (b.action !== "create") return j({ error: T("Requête invalide", "Invalid request") }, 400);
  if (b.hp) return j({ error: T("Requête refusée", "Request refused") }, 400); // champ piège : seuls les robots le remplissent
  const client = txt(b.client, 60), phone = String(b.phone || "").replace(/[^0-9]/g, "");
  if (!client) return j({ error: T("Entre ton nom.", "Enter your name.") }, 400);
  if (phone.length < 6 || phone.length > 16) return j({ error: T("Entre un numéro WhatsApp valide (avec l'indicatif du pays).", "Enter a valid WhatsApp number (with country code).") }, 400);
  const mode = MODES.includes(b.mode) ? b.mode : "";
  if (mode && !(rec.pub.modes || []).includes(mode)) return j({ error: T("Ce mode de paiement n'est pas proposé par la boutique.", "This payment method is not offered by the shop.") }, 400);
  if (!mode && (rec.pub.modes || []).length) return j({ error: T("Choisis un mode de paiement.", "Choose a payment method.") }, 400);
  const raw = Array.isArray(b.items) ? b.items.slice(0, 30) : [];
  if (!raw.length) return j({ error: T("Ton panier est vide.", "Your cart is empty.") }, 400);
  const items = [];
  for (const it of raw) {
    const p = (rec.pub.products || []).find(x => x.id === String(it && it.id || ""));
    const q = Math.floor(Number(it && it.q));
    if (!p) return j({ error: T("Un produit n'est plus au catalogue. Recharge la page.", "A product is no longer in the catalogue. Reload the page.") }, 409);
    if (!p.available) return j({ error: T("« " + p.name + " » n'est plus disponible.", "“" + p.name + "” is no longer available.") }, 409);
    if (!(q >= 1) || q > 99 || q > (p.max || 99)) return j({ error: T("Quantité indisponible pour « " + p.name + " » (maximum " + (p.max || 99) + ").", "Quantity not available for “" + p.name + "” (maximum " + (p.max || 99) + ").") }, 409);
    if (items.some(x => x.id === p.id)) return j({ error: T("Produit en double dans le panier.", "Duplicate product in the cart.") }, 400);
    if (items.length && items[0].cur !== p.cur) return j({ error: T("Une commande ne peut contenir qu'une seule devise.", "An order can only contain one currency.") }, 400);
    items.push({ id: p.id, name: p.name, q, price: p.price, cur: p.cur });
  }
  // Limites anti-abus (par visiteur et par boutique). Si le compteur est indisponible, on refuse plutôt que de laisser passer.
  try {
    const us = getStore({ name: "orders-usage", consistency: "strong" }), ip = req.headers.get("x-nf-client-connection-ip") || "anon", now = new Date().toISOString();
    if (!(await bump(us, "ip_" + now.slice(0, 13) + "_" + ip, PER_IP_HOUR))) return j({ error: T("Trop de commandes en peu de temps, réessaie plus tard.", "Too many orders in a short time, try again later.") }, 429);
    if (!(await bump(us, "shop_" + now.slice(0, 10) + "_" + b.slug, PER_SHOP_DAY))) return j({ error: T("Cette boutique a atteint sa limite de commandes du jour.", "This shop has reached its daily order limit.") }, 429);
  } catch { return j({ error: T("Service momentanément indisponible, réessaie.", "Service temporarily unavailable, try again.") }, 503); }
  let ref = "";
  for (let i = 0; i < 5; i++) { const r = newRef(); if (!(await ords.get(prefix + r))) { ref = r; break; } }
  if (!ref) return j({ error: T("Erreur serveur, réessaie.", "Server error, try again.") }, 500);
  const total = items.reduce((a, x) => a + x.q * x.price, 0), cur = items[0].cur;
  await ords.setJSON(prefix + ref, { ref, client, phone, addr: txt(b.addr, 160), note: txt(b.note, 200), items, total, cur, mode, created: Date.now() });
  const pr = (rec.priv && rec.priv.pay) || {}, instr = mode === "mixx" || mode === "moov" ? { num: (pr[mode] || {}).num || "", name: (pr[mode] || {}).name || "" } : mode === "bank" ? { info: (pr.bank || {}).info || "" } : {};
  return j({ ok: true, ref, total, cur, mode, instr, shop: rec.pub.shop, phone: rec.pub.phone });
}
export default async (req) => {
  try { return await handle(req); }
  catch (e) { console.error("orders error", e); return j({ error: new URL(req.url).searchParams.get("ui") === "en" ? "Server error, try again." : "Erreur serveur, réessaie." }, 500); }
};
export const config = { path: "/api/orders" };
