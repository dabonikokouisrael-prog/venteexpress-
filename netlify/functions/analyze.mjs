import { getStore } from "@netlify/blobs";
const H = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: H });
export default async (req) => {
  const key = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (req.method === "GET") return key ? j({ ok: true, detail: "clé IA présente" }) : j({ error: "Clé ANTHROPIC_API_KEY absente dans Netlify" }, 503);
  if (req.method !== "POST") return j({ error: "Méthode non permise" }, 405);
  if (!key) return j({ error: "IA non configurée (clé manquante)" }, 503);
  let b; try { b = await req.json(); } catch { return j({ error: "Requête invalide" }, 400); }
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(b && b.image || "");
  if (!m || m[2].length > 1500000) return j({ error: "Image invalide ou trop lourde" }, 400);
  // Limites quotidiennes (protègent ta clé) : par visiteur ET globale. Si le compteur est indisponible, on refuse.
  try {
    const ip = req.headers.get("x-nf-client-connection-ip") || "anon";
    const day = new Date().toISOString().slice(0, 10), store = getStore({ name: "ai-usage", consistency: "strong" });
    const k = ip + "_" + day, g = "global_" + day;
    const n = Number(await store.get(k)) || 0, tot = Number(await store.get(g)) || 0;
    const max = Number(process.env.AI_DAILY_LIMIT) || 30, maxAll = Number(process.env.AI_GLOBAL_DAILY_LIMIT) || 300;
    if (n >= max) return j({ error: "Limite quotidienne atteinte, réessaie demain." }, 429);
    if (tot >= maxAll) return j({ error: "Service IA saturé aujourd'hui, réessaie demain." }, 429);
    await store.set(k, String(n + 1)); await store.set(g, String(tot + 1));
  } catch { return j({ error: "Service IA momentanément indisponible" }, 503); }
  const name = String((b.name || "")).replace(/[\r\n"{}]/g, " ").slice(0, 100);
  const prompt = "Tu aides un vendeur en ligne africain francophone. Regarde cette photo de produit" + (name ? " (nom donné : " + name + ")" : "") +
    ". Réponds UNIQUEMENT avec un JSON : {\"name\":\"nom court du produit\",\"features\":[\"4 à 6 points forts courts, attractifs, uniquement ce qui est visible ou très probable\"]}. N'invente ni marque ni chiffres.";
  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5", max_tokens: 500,
        messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } }, { type: "text", text: prompt }] }] })
    });
  } catch { return j({ error: "Service IA injoignable" }, 502); }
  if (!r.ok) { console.error("anthropic", r.status, (await r.text()).slice(0, 300)); return j({ error: r.status === 401 ? "Clé IA refusée par Anthropic (vérifie ANTHROPIC_API_KEY)" : r.status === 429 ? "IA surchargée ou crédit insuffisant, réessaie plus tard" : "Erreur du service IA ("+r.status+")" }, 502); }
  const out = await r.json(), txt = (out.content || []).map(c => c.text || "").join("");
  try {
    const o = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
    return j({ name: String(o.name || "").slice(0, 100), features: (Array.isArray(o.features) ? o.features : []).slice(0, 6).map(x => String(x).slice(0, 120)) });
  } catch { return j({ error: "Réponse IA illisible, réessaie." }, 502); }
};
export const config = { path: "/api/analyze" };
