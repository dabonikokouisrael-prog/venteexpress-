// Page publique d'une boutique (/catalogue/<nom>).
//
// Elle sert EXACTEMENT la même application que /index.html : seules les balises d'aperçu du haut de page
// (titre, description, image) sont remplacées par celles de la boutique. Ce sont elles que lisent WhatsApp,
// Facebook et Instagram quand le vendeur partage son lien. Sans elles, toutes les boutiques montrent le même
// aperçu « VenteExpress ».
//
// Sécurité : aucune clé secrète ici. La boutique en ligne est lue avec la clé PUBLISHABLE (SUPABASE_ANON_KEY),
// car get_public_catalog est ouverte au rôle « anon ». Rien d'autre que le nom, la description et le logo
// (déjà publics sur la page) n'est utilisé.
//
// Règle de prudence : si quoi que ce soit échoue (Supabase muet, stockage indisponible, lien inconnu),
// la page est servie telle quelle. Le lien du vendeur continue donc toujours de marcher ; seul l'aperçu
// reste générique.

import { getStore } from "@netlify/blobs";
import { readFile } from "node:fs/promises";
import { supabaseEnv, rest } from "../lib/supabase.mjs";

const okSlug = s => typeof s === "string" && /^[a-z0-9-]{3,40}$/.test(s);
const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clip = (s, n) => { const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const okColor = c => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);

// --- Le nom du lien -------------------------------------------------------------------------------
// Netlify peut nous envoyer ici par une règle de réécriture (netlify.toml). Selon le chemin emprunté, le nom
// de la boutique arrive dans « ?slug= », dans l'adresse d'origine ou dans le chemin lui-même : on essaie tout.
export function readSlug(req) {
  const tries = [];
  try { const u = new URL(req.url); tries.push(u.searchParams.get("slug") || "", u.pathname); } catch { /* adresse illisible */ }
  for (const h of ["x-nf-original-path", "x-original-path", "x-forwarded-url", "x-nf-request-url"]) {
    const v = req.headers && req.headers.get ? req.headers.get(h) : null;
    if (v) tries.push(v);
  }
  for (const t of tries) {
    if (!t) continue;
    const one = String(t).trim().toLowerCase();
    if (okSlug(one)) return one;
    const m = /\/catalogue\/([a-z0-9-]{3,40})(?:[/?#]|$)/.exec(one);
    if (m && okSlug(m[1])) return m[1];
  }
  return "";
}

// --- La boutique ----------------------------------------------------------------------------------
async function fromCloud(slug) {
  const c = supabaseEnv();
  if (!c.supaUrl || !c.anonKey) return null;
  const r = await rest(c, "/rest/v1/rpc/get_public_catalog", { body: { p_slug: slug }, key: c.anonKey, timeout: 4000 });
  const d = r && r.ok && r.data && typeof r.data === "object" ? r.data : null;
  if (!d || d.ok !== true) return null;
  const s = (d.shop && typeof d.shop === "object") ? d.shop : {};
  const path = typeof s.logo_path === "string" ? s.logo_path : "";
  return {
    shop: String(s.name || ""),
    desc: String(s.desc || ""),
    // Le logo est déjà un fichier public du stockage : une vraie adresse, ce qu'exigent les aperçus.
    img: path ? c.supaUrl + "/storage/v1/object/public/product-media/" + path.split("/").map(encodeURIComponent).join("/") : "",
    accent: okColor(s.accent) ? String(s.accent) : "",
  };
}

async function fromBlobs(slug, origin) {
  const d = await getStore({ name: "catalogues", consistency: "strong" }).get(slug, { type: "json" });
  const p = d && d.pub;
  if (!p) return null;
  return {
    shop: String(p.shop || ""),
    desc: String(p.desc || ""),
    // Ici le logo est une image « collée » dans le texte : les aperçus ne savent pas la lire, on passe donc
    // par /api/catalogue-image qui la renvoie comme une vraie image.
    img: p.logo ? origin + "/api/catalogue-image?slug=" + encodeURIComponent(slug) : "",
    accent: okColor(p.accent) ? String(p.accent) : "",
  };
}

// --- Les balises ----------------------------------------------------------------------------------
const mix = (hex, to, k) => {
  const n = p => Math.round(parseInt(hex.slice(p, p + 2), 16) * (1 - k) + to * k);
  return "#" + [n(1), n(3), n(5)].map(x => Math.max(0, Math.min(255, x)).toString(16).padStart(2, "0")).join("");
};

export function tags(s, canonical) {
  const name = clip(s.shop, 60);
  const title = name ? name + " — Catalogue" : "VenteExpress";
  const desc = clip(s.desc, 160) || (name
    ? "Vois les produits de " + name + ", leurs prix, et commande sur WhatsApp."
    : "Annonces, stock, ventes, commandes et livraisons pour les vendeurs d'Afrique de l'Ouest.");
  const L = [
    "<title>" + esc(title) + "</title>",
    '<meta name="description" content="' + esc(desc) + '">',
    '<link rel="canonical" href="' + esc(canonical) + '">',
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="VenteExpress">',
    '<meta property="og:title" content="' + esc(title) + '">',
    '<meta property="og:description" content="' + esc(desc) + '">',
    '<meta property="og:url" content="' + esc(canonical) + '">',
  ];
  if (s.img) {
    L.push('<meta property="og:image" content="' + esc(s.img) + '">');
    L.push('<meta property="og:image:alt" content="' + esc(name || "VenteExpress") + '">');
    L.push('<meta name="twitter:card" content="summary_large_image">');
    L.push('<meta name="twitter:image" content="' + esc(s.img) + '">');
  } else {
    L.push('<meta name="twitter:card" content="summary">');
  }
  L.push('<meta name="twitter:title" content="' + esc(title) + '">');
  L.push('<meta name="twitter:description" content="' + esc(desc) + '">');
  // Couleur choisie par le vendeur : posée tout de suite, pour que la boutique ait ses couleurs dès l'affichage.
  if (okColor(s.accent)) {
    const c = s.accent.toLowerCase();
    L.push('<meta name="theme-color" content="' + esc(c) + '">');
    L.push("<style>:root{--navy:" + c + ";--navy2:" + mix(c, 255, .14) + ";--blue:" + c + ";--blue-d:" + mix(c, 0, .22) + ";--blue-l:" + mix(c, 255, .9) + "}</style>");
  }
  return L.join("\n") + "\n";
}

// Retire les anciennes balises d'aperçu (uniquement dans le haut de page) et pose les nouvelles.
export function inject(html, block) {
  const i = html.indexOf("</head>");
  if (i < 0) return html;
  const head = html.slice(0, i)
    .replace(/<title>[\s\S]*?<\/title>\s*/i, "")
    .replace(/<meta\s+name="description"[^>]*>\s*/gi, "")
    .replace(/<meta\s+name="theme-color"[^>]*>\s*/gi, "")
    .replace(/<meta\s+property="og:[^"]*"[^>]*>\s*/gi, "")
    .replace(/<meta\s+name="twitter:[^"]*"[^>]*>\s*/gi, "");
  return head + block + html.slice(i);
}

// --- L'application --------------------------------------------------------------------------------
let SHELL = null;                       // gardée en mémoire entre deux appels « à chaud »
export async function shell(origin) {
  if (SHELL) return SHELL;
  const here = new URL(".", import.meta.url).pathname;
  const paths = ["index.html", process.cwd() + "/index.html", here + "../../index.html", here + "../../../index.html"];
  for (const p of paths) {
    try { const t = await readFile(p, "utf8"); if (t.includes("</head>")) { SHELL = t; return t; } } catch { /* pas là : on essaie le suivant */ }
  }
  try {                                  // dernier recours : relire le fichier publié du site
    const r = await fetch(origin + "/index.html", { headers: { "x-ve-shell": "1" } });
    if (r.ok) { const t = await r.text(); if (t.includes("</head>")) { SHELL = t; return t; } }
  } catch { /* réseau indisponible */ }
  return null;
}

const page = (html, cache) => new Response(html, {
  status: 200,
  headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": cache, "X-Content-Type-Options": "nosniff" },
});

export default async (req) => {
  let origin = "";
  try { origin = new URL(req.url).origin; } catch { origin = ""; }
  let html = null;
  try { html = await shell(origin); } catch { html = null; }
  // Sans l'application, mieux vaut laisser Netlify servir la page statique que renvoyer une erreur.
  if (!html) return new Response(null, { status: 302, headers: { Location: "/", "Cache-Control": "no-store" } });

  try {
    const slug = readSlug(req);
    if (!okSlug(slug)) return page(html, "public, max-age=0, must-revalidate");
    let s = null;
    try { s = await fromCloud(slug); } catch { s = null; }
    if (!s) { try { s = await fromBlobs(slug, origin); } catch { s = null; } }
    if (!s || !s.shop) return page(html, "public, max-age=0, must-revalidate");
    return page(inject(html, tags(s, origin + "/catalogue/" + slug)), "public, max-age=120, s-maxage=300");
  } catch (e) {
    console.error("catalogue-page", e && e.message);
    return page(html, "public, max-age=0, must-revalidate");
  }
};
