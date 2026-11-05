// Aide commune des fonctions WhatsApp (webhook, envoi, administration).
// AUCUN secret n'est écrit ici : tout vient des variables d'environnement Netlify (voir .env.example). Rien de tout cela n'est jamais envoyé au navigateur.
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export const env = () => {
  const e = process.env;
  return {
    supaUrl: String(e.SUPABASE_URL || "").replace(/\/+$/, ""),
    anonKey: String(e.SUPABASE_ANON_KEY || ""),
    serviceKey: String(e.SUPABASE_SERVICE_ROLE_KEY || ""),
    token: String(e.WHATSAPP_ACCESS_TOKEN || ""),
    phoneId: String(e.WHATSAPP_PHONE_NUMBER_ID || ""),
    wabaId: String(e.WHATSAPP_BUSINESS_ACCOUNT_ID || ""),
    verify: String(e.WHATSAPP_VERIFY_TOKEN || ""),
    secret: String(e.META_APP_SECRET || ""),
    graph: String(e.WHATSAPP_GRAPH_URL || "https://graph.facebook.com").replace(/\/+$/, ""),
    ver: /^v\d{1,2}\.\d{1,2}$/.test(String(e.WHATSAPP_API_VERSION || "")) ? String(e.WHATSAPP_API_VERSION) : "v23.0",
    siteUrl: String(e.URL || "").replace(/\/+$/, ""),
  };
};
// Quelles variables sont renseignées (oui / non seulement : jamais les valeurs)
export const present = c => ({ supabase_url: !!c.supaUrl, supabase_anon_key: !!c.anonKey, supabase_service_key: !!c.serviceKey, access_token: !!c.token,
  phone_number_id: !!c.phoneId, business_account_id: !!c.wabaId, verify_token: !!c.verify, app_secret: !!c.secret });
export const canSend = c => !!(c.supaUrl && c.serviceKey && c.token && c.phoneId);

export const H = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
export const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: H });

// ---------------------------------------------------------------------------------------------------
// Supabase (REST / RPC). La clé « service_role » ne sert QU'ICI, côté serveur.
// ---------------------------------------------------------------------------------------------------
async function rest(c, path, { method = "POST", body, key, jwt, timeout = 8000 } = {}) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(c.supaUrl + path, {
      method, signal: ctl.signal,
      headers: { "Content-Type": "application/json", apikey: key, Authorization: "Bearer " + (jwt || key) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* réponse non JSON */ }
    return { status: r.status, ok: r.ok, data, text };
  } catch (e) {
    return { status: 0, ok: false, data: null, text: "", net: e && e.name === "AbortError" ? "timeout" : "network" };
  } finally { clearTimeout(t); }
}
export const svcRpc = (c, fn, args) => rest(c, "/rest/v1/rpc/" + fn, { body: args || {}, key: c.serviceKey });
export const userRpc = (c, jwt, fn, args) => rest(c, "/rest/v1/rpc/" + fn, { body: args || {}, key: c.anonKey, jwt });
export const svcGet = (c, path) => rest(c, "/rest/v1/" + path, { method: "GET", key: c.serviceKey });

// Jeton de l'utilisateur envoyé par l'appli (« Authorization: Bearer … ») : jamais cru sur parole, Supabase le vérifie à chaque appel.
export const bearer = req => { const m = /^Bearer\s+([A-Za-z0-9._-]{20,4000})$/.exec(req.headers.get("authorization") || ""); return m ? m[1] : ""; };

// ---------------------------------------------------------------------------------------------------
// Meta (Graph API)
// ---------------------------------------------------------------------------------------------------
export async function graph(c, method, path, body, timeout = 7000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(`${c.graph}/${c.ver}/${path}`, {
      method, signal: ctl.signal,
      headers: { Authorization: "Bearer " + c.token, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* réponse non JSON */ }
    return { status: r.status, ok: r.ok, data };
  } catch (e) {
    return { status: 0, ok: false, data: null, net: e && e.name === "AbortError" ? "timeout" : "network" };
  } finally { clearTimeout(t); }
}

// Erreurs passagères (on réessaie) : limites de débit, service indisponible, réseau. Les autres sont définitives (numéro sans WhatsApp, modèle absent, jeton expiré…).
const TRANSIENT = new Set([1, 2, 4, 17, 32, 613, 80007, 130429, 131000, 131016, 131056, 131057, 133004]);
const FRIENDLY = {
  190: "Jeton WhatsApp expiré ou invalide : le propriétaire de la plateforme doit en créer un nouveau.",
  10: "Autorisation WhatsApp refusée : vérifier les droits du jeton chez Meta.",
  131026: "Numéro non joignable sur WhatsApp.",
  131030: "Numéro non autorisé : en mode test, Meta n'envoie qu'aux numéros ajoutés à sa liste de test.",
  131047: "Fenêtre de 24 h fermée : seul un modèle approuvé peut être envoyé.",
  131042: "Problème de paiement du compte WhatsApp Business chez Meta.",
  131031: "Compte WhatsApp Business bloqué par Meta.",
  131048: "Meta limite l'envoi (signalements de spam).",
  132000: "Variables du modèle incorrectes.",
  132001: "Modèle introuvable chez Meta (nom ou langue différents).",
  132005: "Texte du modèle trop long après remplissage des variables.",
  132007: "Texte du modèle refusé par la politique de Meta.",
  132012: "Format des variables du modèle incorrect.",
  132015: "Modèle mis en pause par Meta.",
  132016: "Modèle désactivé par Meta.",
  133010: "Numéro WhatsApp de la plateforme non enregistré chez Meta.",
};
const RATE = new Set([4, 17, 32, 613, 80007, 130429, 131056]);
export const scrub = (c, s) => {
  let v = String(s == null ? "" : s);
  if (c && c.token) v = v.split(c.token).join("***");
  if (c && c.secret) v = v.split(c.secret).join("***");
  return v.replace(/EAA[A-Za-z0-9]{20,}/g, "***").replace(/Bearer\s+[A-Za-z0-9._-]{12,}/gi, "Bearer ***").replace(/access_token=[^&\s"']+/gi, "access_token=***").replace(/[\r\n\t]+/g, " ").trim();
};
export function classify(c, r) {
  const e = (r.data && r.data.error) || {};
  const code = e.code != null && Number.isFinite(Number(e.code)) ? Number(e.code) : null;
  const retry = !!r.net || r.status === 429 || r.status >= 500 || (code != null && TRANSIENT.has(code));
  const details = scrub(c, (e.error_data && e.error_data.details) || e.message || "");
  let text;
  if (r.net) text = r.net === "timeout" ? "Meta n'a pas répondu à temps : nouvel essai automatique." : "Connexion à Meta impossible : nouvel essai automatique.";
  else if (code != null && RATE.has(code)) text = "Limite de débit Meta atteinte : nouvel essai automatique.";
  else if (code != null && FRIENDLY[code]) text = FRIENDLY[code];
  else text = details || (r.status >= 500 ? "Erreur temporaire chez Meta : nouvel essai automatique." : "Réponse inattendue de Meta (HTTP " + r.status + ").");
  const codeStr = r.net ? "net_" + r.net : code != null ? String(code) : "http_" + r.status;
  return { retry, code: codeStr.slice(0, 40), text: ((code != null && FRIENDLY[code] && details && details !== text ? text + " (" + details + ")" : text) + (code != null ? " [" + code + "]" : "")).slice(0, 300) };
}

// Corps de la requête d'envoi : modèle approuvé (hors fenêtre de 24 h) ou texte libre (dans la fenêtre)
export function buildPayload(m) {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to: String(m.to) };
  if (m.mode === "text") return { ...base, type: "text", text: { preview_url: /https?:\/\//.test(m.body || ""), body: String(m.body || "").slice(0, 4000) } };
  const tpl = { name: String(m.template), language: { code: String(m.lang || "fr") } };
  const params = Array.isArray(m.params) ? m.params : [];
  if (params.length) tpl.components = [{ type: "body", parameters: params.map(p => ({ type: "text", text: String(p == null || p === "" ? "-" : p).slice(0, 1024) })) }];
  return { ...base, type: "template", template: tpl };
}
export async function sendOne(c, m) {
  const r = await graph(c, "POST", `${c.phoneId}/messages`, buildPayload(m));
  if (r.ok) { const id = r.data && Array.isArray(r.data.messages) && r.data.messages[0] && r.data.messages[0].id; return { ok: true, id: id ? String(id) : "" }; }
  return { ok: false, ...classify(c, r) };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function mark(c, args) {   // le résultat est noté avec quelques essais : un message envoyé mais non noté serait renvoyé plus tard
  let last = null;
  for (let i = 0; i < 3; i++) { last = await svcRpc(c, "wa_mark_result", args); if (last.ok) return last; await sleep(150 * (i + 1)); }
  console.error("wa_mark_result a échoué", last && last.status);
  return last;
}

// ---------------------------------------------------------------------------------------------------
// Envoi d'un lot : prend les messages à envoyer (la base décide : accord, STOP, fenêtre de 24 h, modèle), les envoie, note chaque résultat.
// ---------------------------------------------------------------------------------------------------
export async function dispatch(c, { shop = null, order = null, recent = null, limit = 10, deadlineMs = 8000 } = {}) {
  if (!canSend(c)) return { ok: true, configured: false, total: 0, sent: 0, failed: 0, retried: 0, results: [] };
  const t0 = Date.now();
  const cl = await svcRpc(c, "wa_claim_batch", { p_limit: limit, p_shop: shop, p_order: order, p_recent_minutes: recent });
  if (!cl.ok || !cl.data || !Array.isArray(cl.data.messages)) return { ok: false, error: "claim_failed", status: cl.status };
  const out = { ok: true, configured: true, total: cl.data.messages.length, sent: 0, failed: 0, retried: 0, results: [] };
  const queue = cl.data.messages.slice();
  const worker = async () => {
    while (queue.length) {
      const m = queue.shift();
      if (Date.now() - t0 > deadlineMs) {    // plus assez de temps : on remet le message en file (réessai dans 1 minute)
        await mark(c, { p_id: m.id, p_ok: false, p_err_code: "deadline", p_err_text: "Envoi reporté (délai de la fonction dépassé).", p_retry: true });
        out.retried++; continue;
      }
      const r = await sendOne(c, m);
      const mk = await mark(c, r.ok ? { p_id: m.id, p_ok: true, p_wa_id: r.id, p_provider: "meta" } : { p_id: m.id, p_ok: false, p_err_code: r.code, p_err_text: r.text, p_retry: r.retry });
      if (r.ok) out.sent++; else if (r.retry && mk.data && mk.data.status === "queued") out.retried++; else out.failed++;
      out.results.push(r.ok ? { id: m.id, event: m.event, ok: true } : { id: m.id, event: m.event, ok: false, code: r.code, text: r.text, retry: r.retry });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Webhook : signature (HMAC-SHA256 du corps brut avec le secret de l'application Meta) et poignée de main de vérification
// ---------------------------------------------------------------------------------------------------
export function verifySignature(secret, raw, header) {
  if (!secret || !header || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const mac = createHmac("sha256", secret).update(raw).digest();
  const given = Buffer.from(header.slice(7), "hex");
  return given.length === mac.length && timingSafeEqual(given, mac);
}
export function sameSecret(a, b) {   // comparaison à temps constant (les empreintes ont toutes la même longueur)
  const h = s => createHash("sha256").update(String(s)).digest();
  return !!a && !!b && timingSafeEqual(h(a), h(b));
}

// ---------------------------------------------------------------------------------------------------
// Limiteur très simple (par instance) pour l'envoi déclenché sans compte (après une commande du catalogue public)
// ---------------------------------------------------------------------------------------------------
const hits = new Map();
export function throttle(key, max, windowMs) {
  const now = Date.now(), h = hits.get(key);
  if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return true; }
  if (h.n >= max) return false;
  h.n++; return true;
}
export const clientIp = req => String(req.headers.get("x-nf-client-connection-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0] || "?").trim().slice(0, 64);
