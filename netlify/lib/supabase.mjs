// Accès à Supabase depuis les fonctions Netlify : UNIQUEMENT côté serveur.
//
// Deux clés, deux rôles (nouveau système de clés de Supabase) :
//   SUPABASE_ANON_KEY    = clé « Publishable » (sb_publishable_…)  publique par conception : elle remplace l'ancienne clé « anon ».
//   SUPABASE_SECRET_KEY  = clé « Secret »      (sb_secret_…)       SECRÈTE, contourne la sécurité par ligne : elle remplace l'ancienne clé « service_role ».
// Les anciennes clés (des JWT, « eyJ… ») restent acceptées tant que Supabase ne les désactive pas ; l'ancienne variable
// SUPABASE_SERVICE_ROLE_KEY n'est lue que si SUPABASE_SECRET_KEY est absente (et l'administration le signale).
//
// Règles de sécurité de ce fichier :
//   - aucune clé n'est écrite ici : tout vient des variables d'environnement Netlify ;
//   - aucune clé n'est jamais renvoyée, écrite dans un journal ni mise dans une adresse (seulement « renseignée / de quel type ») ;
//   - une clé au mauvais endroit (secrète dans SUPABASE_ANON_KEY, publique dans SUPABASE_SECRET_KEY) est REFUSÉE et signalée, jamais utilisée.
//
// Envoi des clés (voir https://supabase.com/docs/guides/api/api-keys) : les nouvelles clés ne sont pas des JWT, elles vont
// UNIQUEMENT dans l'en-tête « apikey ». L'en-tête « Authorization: Bearer … » ne porte que le jeton de connexion d'un utilisateur
// (JWT), ou, pour les anciennes clés, la clé elle-même comme avant.

const UA = "VenteExpress-Netlify";

// ---------------------------------------------------------------------------------------------------
// Lecture et classement des clés
// ---------------------------------------------------------------------------------------------------
const clean = v => String(v == null ? "" : v).replace(/[​-‍﻿]/g, "").trim().replace(/^(["'`])([\s\S]*)\1$/, "$2").trim();

function jwtPayload(v) {
  const m = /^[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/.exec(v);
  if (!m) return null;
  try { const p = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")); return p && typeof p === "object" ? p : null; } catch { return null; }
}

// Type d'une clé : missing | publishable | secret | legacy_anon | legacy_service | invalid  (+ « ref » du projet pour les anciennes clés)
export function keyInfo(raw) {
  const v = clean(raw);
  if (!v) return { kind: "missing", ref: "" };
  if (/^sb_publishable_[^\s"'`<>]{10,}$/.test(v)) return { kind: "publishable", ref: "" };
  if (/^sb_secret_[^\s"'`<>]{10,}$/.test(v)) return { kind: "secret", ref: "" };
  const p = jwtPayload(v);
  if (p && (p.role === "anon" || p.role === "service_role")) return { kind: p.role === "anon" ? "legacy_anon" : "legacy_service", ref: typeof p.ref === "string" ? p.ref : "" };
  return { kind: "invalid", ref: "" };
}

function cleanUrl(raw) {
  const v = clean(raw).replace(/\/+$/, "").replace(/\/(rest|auth|storage|realtime|functions)\/v1$/i, "").replace(/\/+$/, "");
  if (!v) return { url: "", state: "missing", host: "" };
  let u; try { u = new URL(v); } catch { return { url: "", state: "invalid", host: "" }; }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
  if ((u.protocol !== "https:" && !(u.protocol === "http:" && local)) || /(^|\.)supabase\.com$/i.test(u.hostname) || u.username || u.password) return { url: "", state: "invalid", host: "" };
  return { url: u.origin + u.pathname.replace(/\/+$/, ""), state: "ok", host: u.hostname.toLowerCase() };
}

// Messages (en français : ils s'affichent dans l'administration de la plateforme, jamais chez les clients)
const MSG = {
  url_invalid: ["error", "SUPABASE_URL n'est pas l'adresse d'un projet Supabase (attendu : https://xxxx.supabase.co, sans /rest/v1)."],
  anon_invalid: ["error", "SUPABASE_ANON_KEY n'a pas le format d'une clé Supabase : colle la clé « Publishable » (sb_publishable_…)."],
  anon_is_secret: ["error", "SUPABASE_ANON_KEY contient une clé SECRÈTE : elle ne doit pas être là. Mets-y la clé « Publishable » (sb_publishable_…)."],
  anon_legacy: ["warn", "SUPABASE_ANON_KEY contient l'ancienne clé « anon » : elle marche tant que Supabase ne la désactive pas. Remplace-la par la clé « Publishable » (sb_publishable_…)."],
  secret_invalid: ["error", "SUPABASE_SECRET_KEY n'a pas le format d'une clé secrète Supabase : colle la clé « Secret » (sb_secret_…)."],
  secret_is_public: ["error", "SUPABASE_SECRET_KEY contient une clé PUBLIQUE : mets-y la clé « Secret » (sb_secret_…)."],
  secret_old_var: ["warn", "La clé secrète est lue dans l'ancienne variable SUPABASE_SERVICE_ROLE_KEY : ça marche, mais crée SUPABASE_SECRET_KEY avec la clé « Secret » (sb_secret_…), puis supprime l'ancienne variable."],
  secret_legacy: ["warn", "La clé secrète est l'ancienne clé « service_role » : elle marche tant que Supabase ne la désactive pas. Remplace-la par la clé « Secret » (sb_secret_…)."],
  old_var_unused: ["warn", "L'ancienne variable SUPABASE_SERVICE_ROLE_KEY existe encore : elle n'est plus utilisée. Supprime-la dans Netlify."],
  other_project: ["error", "Une des clés vient d'un autre projet Supabase que celui de SUPABASE_URL."],
};
export const problemText = code => (MSG[code] || ["error", String(code)])[1];

// Lit les variables d'environnement Supabase. Retourne ce que les fonctions utilisent (supaUrl, anonKey, secretKey : vides si absentes OU inutilisables)
// et un diagnostic « sb » sans aucune valeur secrète.
export function supabaseEnv(e = process.env) {
  const url = cleanUrl(e.SUPABASE_URL);
  const rawAnon = clean(e.SUPABASE_ANON_KEY);
  const rawNew = clean(e.SUPABASE_SECRET_KEY), rawOld = clean(e.SUPABASE_SERVICE_ROLE_KEY);
  const secretRaw = rawNew || rawOld, secretSource = rawNew ? "SUPABASE_SECRET_KEY" : rawOld ? "SUPABASE_SERVICE_ROLE_KEY" : "";
  const a = keyInfo(rawAnon), s = keyInfo(secretRaw);
  const codes = [];

  let anonKey = "", anon = a.kind === "missing" ? "missing" : "invalid";
  if (a.kind === "publishable" || a.kind === "legacy_anon") { anonKey = rawAnon; anon = "ok"; if (a.kind === "legacy_anon") codes.push("anon_legacy"); }
  else if (a.kind === "secret" || a.kind === "legacy_service") { anon = "wrong"; codes.push("anon_is_secret"); }
  else if (a.kind === "invalid") codes.push("anon_invalid");

  let secretKey = "", secret = s.kind === "missing" ? "missing" : "invalid";
  if (s.kind === "secret" || s.kind === "legacy_service") {
    secretKey = secretRaw; secret = "ok";
    if (secretSource === "SUPABASE_SERVICE_ROLE_KEY") codes.push("secret_old_var"); else if (s.kind === "legacy_service") codes.push("secret_legacy");
    if (rawNew && rawOld) codes.push("old_var_unused");
  } else if (s.kind === "publishable" || s.kind === "legacy_anon") { secret = "wrong"; codes.push("secret_is_public"); }
  else if (s.kind === "invalid") codes.push("secret_invalid");

  if (url.state === "invalid") codes.push("url_invalid");
  // Une ancienne clé (JWT) porte le nom de son projet : s'il ne correspond pas à l'adresse, la clé vient d'ailleurs.
  const ref = /\.supabase\.(co|in|red)$/.test(url.host) ? url.host.split(".")[0] : "";
  if (ref && [a, s].some(k => (k.kind === "legacy_anon" || k.kind === "legacy_service") && k.ref && k.ref !== ref)) codes.push("other_project");

  return {
    supaUrl: url.url, anonKey, secretKey,
    sb: {
      url: url.state, anon, secret, anonKind: a.kind, secretKind: s.kind, secretSource,
      problems: codes.map(code => ({ code, level: MSG[code][0], text: MSG[code][1] })),
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Appels REST / RPC
// ---------------------------------------------------------------------------------------------------
export function authHeaders(key, jwt) {
  const h = { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA, apikey: key };
  if (jwt) h.Authorization = "Bearer " + jwt;                      // jeton de connexion de l'utilisateur (JWT)
  else if (!/^sb_/.test(key)) h.Authorization = "Bearer " + key;   // anciennes clés (JWT) : comme avant ; les nouvelles clés ne vont JAMAIS ici
  return h;
}

export async function rest(c, path, { method = "POST", body, key, jwt, timeout = 8000 } = {}) {
  if (!c.supaUrl || !key) return { status: 0, ok: false, data: null, text: "", net: "config" };   // rien n'est envoyé sans adresse ni clé utilisable
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(c.supaUrl + path, {
      method, signal: ctl.signal, headers: authHeaders(key, jwt),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* réponse non JSON */ }
    return { status: r.status, ok: r.ok, data, text };
  } catch (e) {
    return { status: 0, ok: false, data: null, text: "", net: e && e.name === "AbortError" ? "timeout" : "network" };
  } finally { clearTimeout(t); }
}
// Avec la clé SECRÈTE : réservé aux fonctions serveur (envoi WhatsApp, webhook). Contourne la sécurité par ligne.
export const svcRpc = (c, fn, args) => rest(c, "/rest/v1/rpc/" + fn, { body: args || {}, key: c.secretKey });
export const svcGet = (c, path) => rest(c, "/rest/v1/" + path, { method: "GET", key: c.secretKey });
// Avec la clé PUBLISHABLE + le jeton de l'utilisateur : Supabase vérifie le jeton et applique ses droits à chaque appel.
export const userRpc = (c, jwt, fn, args) => rest(c, "/rest/v1/rpc/" + fn, { body: args || {}, key: c.anonKey, jwt });

// Jeton de l'utilisateur envoyé par l'appli (« Authorization: Bearer … ») : jamais cru sur parole, Supabase le vérifie à chaque appel.
export const bearer = req => { const m = /^Bearer\s+([A-Za-z0-9._-]{20,4000})$/.exec(req.headers.get("authorization") || ""); return m ? m[1] : ""; };

// ---------------------------------------------------------------------------------------------------
// Diagnostic : pourquoi Supabase a refusé un appel (texte simple, jamais le contenu brut de la réponse)
// ---------------------------------------------------------------------------------------------------
export function explain(r) {
  const d = r && r.data && typeof r.data === "object" ? r.data : {};
  const msg = String(d.message || d.error_description || d.msg || "").toLowerCase();
  if (r.net === "config") return { code: "config", text: "Variables Supabase manquantes ou inutilisables (voir la liste ci-dessus)." };
  if (r.net) return { code: "net_" + r.net, text: r.net === "timeout" ? "Supabase n'a pas répondu à temps." : "Connexion à Supabase impossible : SUPABASE_URL est-elle correcte ?" };
  if (r.status === 401 && /legacy/.test(msg)) return { code: "legacy_disabled", text: "Supabase a désactivé les anciennes clés (anon / service_role) : utilise les nouvelles clés Publishable et Secret." };
  if (d.code === "42501" || r.status === 403) return { code: "key_forbidden", text: "Supabase reconnaît la clé mais elle n'a pas les droits d'une clé secrète : as-tu mis la clé Publishable à la place de la clé Secret ?" };
  if (r.status === 401) return { code: "key_refused", text: "Supabase refuse la clé : clé d'un autre projet, supprimée ou mal copiée ?" };
  if (r.status === 404 || d.code === "PGRST202") return { code: "db_outdated", text: "Supabase répond, mais la base n'a pas les fonctions WhatsApp (fichiers 08 à 10 pas encore installés)." };
  if (r.status >= 500) return { code: "supabase_down", text: "Supabase a répondu par une erreur temporaire (HTTP " + r.status + ")." };
  return { code: "http_" + r.status, text: "Réponse inattendue de Supabase (HTTP " + r.status + ")." };
}

// Test de la clé SECRÈTE sans rien modifier : appel d'une fonction en lecture seule que seule la clé secrète a le droit d'appeler.
// Clé valable -> 200 ; clé publique, mauvaise ou refusée -> erreur expliquée.
export async function testSecretKey(c) {
  if (!c.supaUrl || !c.secretKey) return { ok: false, status: 0, ...explain({ net: "config" }) };
  const r = await svcRpc(c, "wa_public_order", { p_slug: "test-cle-secrete", p_ref: "ZZZ000" });
  return r.ok ? { ok: true, status: r.status } : { ok: false, status: r.status, ...explain(r) };
}
