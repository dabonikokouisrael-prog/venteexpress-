import { getStore } from "@netlify/blobs";
const H = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: H });
const okSlug = s => typeof s === "string" && /^[a-z0-9-]{3,40}$/.test(s);
const okPhoto = s => typeof s === "string" && s.length < 90000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(s);
const MAX_BODY = 5000000, NEW_PER_DAY = Number(process.env.CATALOGUE_NEW_PER_DAY) || 5;
async function sha(t) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function handle(req) {
  const store = getStore({ name: "catalogues", consistency: "strong" });
  if (req.method === "GET") {
    if (new URL(req.url).searchParams.get("ping")) {
      try { await store.get("__ping__"); return j({ ok: true, detail: "stockage OK" }); }
      catch (e) { return j({ error: "Stockage Netlify indisponible : " + String(e && e.message || e).slice(0, 120) }, 500); }
    }
    const slug = new URL(req.url).searchParams.get("slug") || "";
    if (!okSlug(slug)) return j({ error: "Lien invalide" }, 400);
    const d = await store.get(slug, { type: "json" });
    return d ? j(d.pub) : j({ error: "Catalogue introuvable" }, 404);
  }
  if (req.method === "POST") {
    const len = Number(req.headers.get("content-length")) || 0;
    if (len > MAX_BODY) return j({ error: "Catalogue trop lourd (photos). Réduis le nombre de photos." }, 413);
    let b; try { b = await req.json(); } catch { return j({ error: "Requête invalide" }, 400); }
    const { slug, key, shop, phone, products } = b || {};
    if (!okSlug(slug) || typeof key !== "string" || key.length < 16) return j({ error: "Données invalides" }, 400);
    const kh = await sha(key);
    const old = await store.get(slug, { type: "json" });
    if (old && old.kh !== kh) return j({ error: "Ce nom de lien est déjà pris, choisis-en un autre." }, 409);
    if (!old) {
      // Limite de créations par visiteur et par jour (anti-spam du stockage) : refuse si le compteur est indisponible
      try {
        const ip = req.headers.get("x-nf-client-connection-ip") || "anon";
        const us = getStore({ name: "catalogue-usage", consistency: "strong" }), uk = ip + "_" + new Date().toISOString().slice(0, 10);
        const n = Number(await us.get(uk)) || 0;
        if (n >= NEW_PER_DAY) return j({ error: "Trop de nouveaux catalogues aujourd'hui, réessaie demain." }, 429);
        await us.set(uk, String(n + 1));
      } catch { return j({ error: "Service momentanément indisponible, réessaie." }, 503); }
    }
    // Liste blanche : seuls ces champs deviennent publics (jamais prix d'achat, bénéfice, quantités)
    const pub = {
      shop: String(shop || "").slice(0, 60),
      phone: String(phone || "").replace(/[^0-9]/g, "").slice(0, 16),
      updated: Date.now(),
      products: (Array.isArray(products) ? products : []).slice(0, 60).filter(p => p && typeof p === "object").map(p => ({
        id: String((p && p.id) || "").slice(0, 20), name: String(p.name || "").slice(0, 100),
        desc: String(p.desc || "").slice(0, 1000), price: Number(p.price) || 0,
        cur: String(p.cur || "FCFA").slice(0, 5),
        photo: okPhoto(p.photo) ? p.photo : "",
        available: !!p.available
      }))
    };
    await store.setJSON(slug, { kh, pub });
    return j({ ok: true });
  }
  return j({ error: "Méthode non permise" }, 405);
};
export default async (req) => {
  try { return await handle(req); } catch (e) { console.error("catalogue error", e); return j({ error: "Erreur serveur, réessaie." }, 500); }
};
export const config = { path: "/api/catalogue" };
