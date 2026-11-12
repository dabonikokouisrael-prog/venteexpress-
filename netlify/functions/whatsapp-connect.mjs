// Connexion WhatsApp par Meta (inscription intégrée, « Embedded Signup ») — version 3.7.3. PRÉPARÉE, DÉSACTIVÉE PAR DÉFAUT.
// Rien ne se passe tant que META_CONNECT_ENABLED n'est pas « true » dans les variables Netlify.
//   GET  /api/whatsapp/connect : { enabled, app_id, config_id, api_version, feature_type }   (identifiants PUBLICS, aucun secret)
//   POST /api/whatsapp/connect : administrateur de la plateforme connecté, body { code, waba_id, phone_number_id? }
//        -> échange le code contre un jeton CÔTÉ SERVEUR, le chiffre (WA_TOKEN_KEY), l'enregistre (supabase/14).
//           Si Meta n'a pas donné phone_number_id (cas de la cohabitation avec l'appli WhatsApp Business), le serveur
//           lit lui-même les numéros du compte WhatsApp Business et prend le premier.
//           Le jeton ne sort jamais de ce serveur : la réponse ne contient que le numéro affiché.
// Ce code N'EST PAS TESTABLE ici : il faut un compte Meta réel, une application validée et un numéro. Voir docs/08.
import { env, json, throttle, clientIp } from "../lib/wa.mjs";
import { svcRpc, userRpc, bearer } from "../lib/supabase.mjs";
import { keyFromEnv, seal } from "../lib/secret.mjs";

export const config = { path: "/api/whatsapp/connect" };

const enabled = () => process.env.META_CONNECT_ENABLED === "true";
const DIGITS = /^\d{5,30}$/;
const CODE = /^[\x21-\x7e]{10,600}$/;   // code d'échange : caractères visibles, pas d'espace

// Appel Graph : le jeton part dans l'en-tête Authorization, jamais dans l'adresse (les adresses finissent dans les journaux).
async function graphGet(url, token) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 7000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: token ? { Authorization: "Bearer " + token } : {} });
    const data = await r.json().catch(() => null);
    return { ok: r.ok, data };
  } catch { return { ok: false, data: null }; }
  finally { clearTimeout(t); }
}

function publicConfig(c) {
  const ready = enabled() && !!process.env.META_APP_ID && !!process.env.META_CONFIG_ID;
  return {
    ok: true, enabled: ready,
    app_id: ready ? String(process.env.META_APP_ID) : "",
    config_id: ready ? String(process.env.META_CONFIG_ID) : "",
    api_version: c.ver,
    feature_type: ready ? String(process.env.META_FEATURE_TYPE || "") : "",
  };
}

async function connect(req, c) {
  if (!enabled()) return json({ ok: false, err: "disabled" }, 404);
  const jwt = bearer(req);
  if (!jwt) return json({ ok: false, err: "auth" }, 401);
  if (!(await throttle("wa-connect:" + clientIp(req), 10, 60 * 60 * 1000))) return json({ ok: false, err: "busy" }, 429);
  const key = keyFromEnv(process.env.WA_TOKEN_KEY);
  if (!key || !process.env.META_APP_ID || !process.env.META_APP_SECRET || !c.supaUrl || !c.secretKey) return json({ ok: false, err: "config" }, 503);

  const adm = await userRpc(c, jwt, "is_platform_admin", {});
  if (!adm.ok) return json({ ok: false, err: "auth" }, 401);
  if (adm.data !== true) return json({ ok: false, err: "forbidden" }, 403);

  let b;
  try { b = JSON.parse((await req.text()) || "{}"); } catch { return json({ ok: false, err: "json" }, 400); }
  const code = String((b && b.code) || ""), waba = String((b && b.waba_id) || ""), pnid0 = String((b && b.phone_number_id) || "");
  if (!CODE.test(code) || !DIGITS.test(waba) || (pnid0 && !DIGITS.test(pnid0))) return json({ ok: false, err: "input" }, 400);

  // 1) échange du code contre un jeton (serveur seulement)
  const ex = await graphGet(c.graph + "/" + c.ver + "/oauth/access_token?client_id=" + encodeURIComponent(process.env.META_APP_ID)
    + "&client_secret=" + encodeURIComponent(process.env.META_APP_SECRET) + "&code=" + encodeURIComponent(code), "");
  if (!ex.ok || !ex.data || !ex.data.access_token) return json({ ok: false, err: "exchange" }, 502);
  const token = String(ex.data.access_token);

  // 2) numéros du compte WhatsApp Business : on prend celui que Meta a donné, sinon le premier
  const list = await graphGet(c.graph + "/" + c.ver + "/" + encodeURIComponent(waba) + "/phone_numbers?fields=id,display_phone_number", token);
  const rows = list.ok && list.data && Array.isArray(list.data.data) ? list.data.data : [];
  const pick = rows.find(x => x && String(x.id) === pnid0) || rows[0];
  const pnid = pnid0 || (pick ? String(pick.id) : "");
  if (!DIGITS.test(pnid)) return json({ ok: false, err: "no_phone" }, 409);
  const mine = rows.find(x => x && String(x.id) === pnid);
  const display = mine && mine.display_phone_number ? String(mine.display_phone_number).slice(0, 30) : "";

  // 3) chiffrement et enregistrement (la clé de chiffrement reste dans WA_TOKEN_KEY)
  const s = seal(key, token);
  const r = await svcRpc(c, "wa_connection_save", {
    p_waba_id: waba, p_phone_number_id: pnid, p_display_phone: display,
    p_token_enc: s.enc, p_token_iv: s.iv, p_token_tag: s.tag, p_key_version: 1,
  });
  if (!r.ok) return json({ ok: false, err: "save" }, 502);
  return json({ ok: true, waba_id: waba, phone_number_id: pnid, display_phone: display });
}

export default async req => {
  try {
    const c = env();
    if (req.method === "GET") return json(publicConfig(c));
    if (req.method === "POST") return await connect(req, c);
    return json({ ok: false, err: "method" }, 405);
  } catch (e) {
    console.error("whatsapp-connect :", String(e && e.message || e).slice(0, 200));
    return json({ ok: false, err: "service" }, 500);
  }
};
