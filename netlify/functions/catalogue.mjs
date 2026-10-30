import { getStore } from "@netlify/blobs";
const H = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: H });
const okSlug = s => typeof s === "string" && /^[a-z0-9-]{3,40}$/.test(s);
const okPhoto = (s, max = 90000) => typeof s === "string" && s.length < max && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(s);
const MAX_BODY = 5000000, NEW_PER_DAY = Number(process.env.CATALOGUE_NEW_PER_DAY) || 5;
async function sha(t) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function handle(req) {
  const url = new URL(req.url), en = url.searchParams.get("ui") === "en", T = (fr, e) => en ? e : fr;
  const store = getStore({ name: "catalogues", consistency: "strong" });
  if (req.method === "GET") {
    if (url.searchParams.get("ping")) {
      try { await store.get("__ping__"); return j({ ok: true, detail: T("stockage OK", "storage OK") }); }
      catch (e) { return j({ error: T("Stockage Netlify indisponible : ", "Netlify storage unavailable: ") + String(e && e.message || e).slice(0, 120) }, 500); }
    }
    const slug = url.searchParams.get("slug") || "";
    if (!okSlug(slug)) return j({ error: T("Lien invalide", "Invalid link") }, 400);
    const d = await store.get(slug, { type: "json" });
    return d ? j(d.pub) : j({ error: T("Catalogue introuvable", "Catalogue not found") }, 404);
  }
  if (req.method === "POST") {
    const len = Number(req.headers.get("content-length")) || 0;
    if (len > MAX_BODY) return j({ error: T("Catalogue trop lourd (photos). Réduis le nombre de photos.", "Catalogue too large (photos). Reduce the number of photos.") }, 413);
    let b; try { b = await req.json(); } catch { return j({ error: T("Requête invalide", "Invalid request") }, 400); }
    const { slug, key, shop, phone, products, logo, desc, lang, pay } = b || {};
    if (!okSlug(slug) || typeof key !== "string" || key.length < 16) return j({ error: T("Données invalides", "Invalid data") }, 400);
    const kh = await sha(key);
    const old = await store.get(slug, { type: "json" });
    if (old && old.kh !== kh) return j({ error: T("Ce nom de lien est déjà pris, choisis-en un autre.", "This link name is already taken, choose another one.") }, 409);
    if (!old) {
      // Limite de créations par visiteur et par jour (anti-spam du stockage) : refuse si le compteur est indisponible
      try {
        const ip = req.headers.get("x-nf-client-connection-ip") || "anon";
        const us = getStore({ name: "catalogue-usage", consistency: "strong" }), uk = ip + "_" + new Date().toISOString().slice(0, 10);
        const n = Number(await us.get(uk)) || 0;
        if (n >= NEW_PER_DAY) return j({ error: T("Trop de nouveaux catalogues aujourd'hui, réessaie demain.", "Too many new catalogues today, try again tomorrow.") }, 429);
        await us.set(uk, String(n + 1));
      } catch { return j({ error: T("Service momentanément indisponible, réessaie.", "Service temporarily unavailable, try again.") }, 503); }
    }
    // Liste blanche : seuls ces champs deviennent publics (jamais prix d'achat, bénéfice, quantités)
    const pub = {
      shop: String(shop || "").slice(0, 60),
      phone: String(phone || "").replace(/[^0-9]/g, "").slice(0, 16),
      lang: lang === "en" ? "en" : "fr",
      desc: String(desc || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 160),
      logo: okPhoto(logo, 46000) ? logo : "",
      updated: Date.now(),
      products: (Array.isArray(products) ? products : []).slice(0, 60).filter(p => p && typeof p === "object").map(p => ({
        id: String((p && p.id) || "").slice(0, 20), name: String(p.name || "").slice(0, 100),
        desc: String(p.desc || "").slice(0, 1000), price: Number(p.price) || 0,
        cur: String(p.cur || "FCFA").slice(0, 5),
        cat: String(p.cat || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 30),
        photo: okPhoto(p.photo) ? p.photo : "",
        photos: (Array.isArray(p.photos) ? p.photos : []).slice(0, 3).filter(x => okPhoto(x, 90000)),
        available: !!p.available,
        max: Math.max(1, Math.min(99, Math.floor(Number(p.max)) || 20))
      }))
    };
    // Modes de paiement : seule la liste des modes activés est publique ; numéros et coordonnées restent côté serveur (renvoyés au client après sa commande)
    const MODES = ["mixx", "moov", "bank", "cash"], P = (pay && typeof pay === "object") ? pay : {};
    const txt = (x, n) => String(x == null ? "" : x).replace(/[\r\t]+/g, " ").trim().slice(0, n);
    const priv = { pay: {
      mixx: { num: txt(P.mixx && P.mixx.num, 30), name: txt(P.mixx && P.mixx.name, 40) },
      moov: { num: txt(P.moov && P.moov.num, 30), name: txt(P.moov && P.moov.name, 40) },
      bank: { info: txt(P.bank && P.bank.info, 200) }
    } };
    pub.modes = (Array.isArray(P.modes) ? P.modes : []).filter(k => MODES.includes(k)
      && (k === "cash" || (k === "bank" ? priv.pay.bank.info : priv.pay[k].num))).slice(0, 4);
    await store.setJSON(slug, { kh, pub, priv });
    return j({ ok: true });
  }
  return j({ error: "Méthode non permise" }, 405);
};
export default async (req) => {
  try { return await handle(req); }
  catch (e) { console.error("catalogue error", e); return j({ error: new URL(req.url).searchParams.get("ui") === "en" ? "Server error, try again." : "Erreur serveur, réessaie." }, 500); }
};
export const config = { path: "/api/catalogue" };
