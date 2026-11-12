// Logo d'une boutique, renvoyé comme une VRAIE image (/api/catalogue-image?slug=<nom>).
//
// Pourquoi : dans l'ancien système (stockage Netlify), le logo est enregistré « collé » dans le texte du
// catalogue (data:image/...;base64,...). WhatsApp, Facebook et Instagram ne savent pas lire ça dans un aperçu :
// il leur faut une adresse qui renvoie une image. Cette fonction fait exactement cela, et rien d'autre.
//
// Pour une boutique en ligne (Supabase), le logo est déjà un fichier public : on renvoie simplement vers lui.
// Aucune clé secrète n'est utilisée ici : seule la clé publique sert, et seul le logo — déjà visible sur la
// page publique — est renvoyé.

import { getStore } from "@netlify/blobs";
import { supabaseEnv, rest } from "../lib/supabase.mjs";

const okSlug = s => typeof s === "string" && /^[a-z0-9-]{3,40}$/.test(s);
const MAX = 400000;                     // au-delà, ce n'est plus un logo : on refuse plutôt que de servir n'importe quoi
const nope = (s = 404) => new Response(null, { status: s, headers: { "Cache-Control": "no-store" } });

// « data:image/jpeg;base64,xxxx » -> { type, bytes }
export function decode(src) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(src || ""));
  if (!m) return null;
  let buf;
  try { buf = Buffer.from(m[2], "base64"); } catch { return null; }
  if (!buf.length || buf.length > MAX) return null;
  return { type: m[1], bytes: buf };
}

async function cloudLogo(slug) {
  const c = supabaseEnv();
  if (!c.supaUrl || !c.anonKey) return "";
  const r = await rest(c, "/rest/v1/rpc/get_public_catalog", { body: { p_slug: slug }, key: c.anonKey, timeout: 4000 });
  const d = r && r.ok && r.data && typeof r.data === "object" ? r.data : null;
  const p = d && d.ok === true && d.shop && typeof d.shop.logo_path === "string" ? d.shop.logo_path : "";
  return p ? c.supaUrl + "/storage/v1/object/public/product-media/" + p.split("/").map(encodeURIComponent).join("/") : "";
}

export default async (req) => {
  try {
    const slug = (new URL(req.url).searchParams.get("slug") || "").toLowerCase();
    if (!okSlug(slug)) return nope(400);

    // Ancien système : l'image est dans le catalogue enregistré.
    try {
      const d = await getStore({ name: "catalogues", consistency: "strong" }).get(slug, { type: "json" });
      const img = d && d.pub && decode(d.pub.logo);
      if (img) {
        return new Response(img.bytes, {
          status: 200,
          headers: {
            "Content-Type": img.type,
            "Content-Length": String(img.bytes.length),
            "Cache-Control": "public, max-age=300, s-maxage=900",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
    } catch { /* stockage indisponible : on tente la boutique en ligne */ }

    // Boutique en ligne : le logo est déjà un fichier public.
    const url = await cloudLogo(slug);
    if (url) return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "public, max-age=300" } });
    return nope();
  } catch (e) {
    console.error("catalogue-image", e && e.message);
    return nope(500);
  }
};

export const config = { path: "/api/catalogue-image" };
