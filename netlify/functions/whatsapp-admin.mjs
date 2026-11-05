// Administration WhatsApp de la plateforme : https://<votre-site>/api/whatsapp/admin
// RÉSERVÉ à l'administrateur de la plateforme (vérifié par Supabase à chaque appel avec son jeton de connexion).
// Actions : env (variables présentes ?), check (tester la connexion à Meta), templates (lire l'état des modèles chez Meta),
//           create_templates (soumettre les modèles manquants à Meta), subscribe (abonner l'application au compte WhatsApp), test (message de test).
// Aucun secret n'est jamais renvoyé : seulement « renseigné / non renseigné ».
import { env, json, bearer, userRpc, svcRpc, graph, present, canSend, classify, scrub, dispatch, throttle } from "../lib/wa.mjs";

export const config = { path: "/api/whatsapp/admin" };

// Exemples demandés par Meta pour chaque variable des modèles
const SAMPLE = { client: "Awa", ref: "CMD-1042", shop: "Boutique Awa", link: "https://venteexpress.netlify.app/suivi/exemple", total: "12 500 FCFA", name: "Kofi", courier: "Kofi", reason: "client injoignable" };

const PHONE_FIELDS = "display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,name_status,throughput";

async function listTemplates(c) {
  const out = [];
  let path = `${c.wabaId}/message_templates?fields=name,language,status,category&limit=100`;
  for (let i = 0; i < 5 && path; i++) {
    const r = await graph(c, "GET", path);
    if (!r.ok) return { ok: false, err: classify(c, r) };
    for (const t of (r.data && r.data.data) || []) out.push({ name: String(t.name), language: String(t.language), status: String(t.status), category: String(t.category || "") });
    const next = r.data && r.data.paging && r.data.paging.cursors && r.data.paging.next ? r.data.paging.cursors.after : null;
    path = next ? `${c.wabaId}/message_templates?fields=name,language,status,category&limit=100&after=${encodeURIComponent(next)}` : null;
  }
  return { ok: true, list: out };
}

async function checkConnection(c) {
  const out = { configured: !!(c.token && c.phoneId), connected: false, phone: null, webhook_subscribed: null, error: "" };
  if (!out.configured) { out.error = "Jeton ou identifiant du numéro manquant dans les variables Netlify."; return out; }
  let r = await graph(c, "GET", `${c.phoneId}?fields=${PHONE_FIELDS}`);
  if (!r.ok && r.data && r.data.error && Number(r.data.error.code) === 100) r = await graph(c, "GET", `${c.phoneId}?fields=display_phone_number,verified_name`);   // champ non géré par cette version de l'API
  if (!r.ok) { out.error = classify(c, r).text; return out; }
  const d = r.data || {};
  out.connected = true;
  out.phone = { display: String(d.display_phone_number || ""), name: String(d.verified_name || ""), quality: String(d.quality_rating || ""), platform: String(d.platform_type || ""), code_status: String(d.code_verification_status || ""), name_status: String(d.name_status || "") };
  if (c.wabaId) {
    const s = await graph(c, "GET", `${c.wabaId}/subscribed_apps`);
    out.webhook_subscribed = s.ok ? Array.isArray(s.data && s.data.data) && s.data.data.length > 0 : null;
  }
  return out;
}

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  const c = env();
  const jwt = bearer(req);
  if (!jwt) return json({ ok: false, error: "auth" }, 401);
  if (!c.supaUrl || !c.anonKey) return json({ ok: false, error: "not_configured", missing: [!c.supaUrl && "SUPABASE_URL", !c.anonKey && "SUPABASE_ANON_KEY"].filter(Boolean) }, 503);
  if (!throttle("adm:" + jwt.slice(-24), 30, 60_000)) return json({ ok: false, error: "slow_down" }, 429);

  // l'appelant est-il administrateur de la plateforme ? (Supabase vérifie le jeton)
  const info = await userRpc(c, jwt, "admin_wa_info", {});
  if (!info.ok || !info.data || info.data.ok !== true) return json({ ok: false, error: "forbidden" }, info.status === 401 ? 401 : 403);

  let b = {};
  try { b = await req.json(); } catch { /* corps vide : action par défaut */ }
  const action = String((b && b.action) || "env");
  const webhookUrl = new URL(req.url).origin + "/api/whatsapp/webhook";
  const base = { ok: true, env: present(c), api_version: c.ver, webhook_url: webhookUrl };

  if (action === "env") return json(base);

  if (action === "check") {
    const st = await checkConnection(c);
    if (c.supaUrl && c.serviceKey) {
      await svcRpc(c, "wa_platform_set", { p_key: "wa_status", p_value: {
        connected: st.connected, tested_at: new Date().toISOString(), display_phone: st.phone ? st.phone.display : "", simulation: false,
        quality: st.phone ? st.phone.quality : "", webhook_subscribed: st.webhook_subscribed, error: st.connected ? "" : st.error.slice(0, 200) } });
    }
    return json({ ...base, check: st });
  }

  // Les actions suivantes parlent à Meta et à la base : tout doit être renseigné
  if (!canSend(c)) return json({ ...base, ok: false, error: "not_configured" }, 503);

  if (action === "templates") {
    if (!c.wabaId) return json({ ...base, ok: false, error: "waba_missing" }, 400);
    const t = await listTemplates(c);
    if (!t.ok) return json({ ...base, ok: false, error: "meta", detail: t.err.text }, 502);
    const sync = await svcRpc(c, "wa_templates_sync", { p_list: t.list });
    return json({ ...base, templates: t.list.filter(x => /^ve_|^hello_world$/.test(x.name)), sync: sync.ok ? sync.data : null });
  }

  if (action === "create_templates") {
    if (!c.wabaId) return json({ ...base, ok: false, error: "waba_missing" }, 400);
    const have = await listTemplates(c);
    if (!have.ok) return json({ ...base, ok: false, error: "meta", detail: have.err.text }, 502);
    const known = new Map(have.list.map(t => [t.name + "|" + t.language, t]));
    const results = [];
    for (const ev of info.data.events) {
      const tpl = ev.template || {};
      const hit = known.get(tpl.name + "|" + tpl.lang);
      if (hit) { results.push({ event: ev.event, name: tpl.name, state: "exists", status: hit.status }); continue; }
      const vars = Array.isArray(ev.vars) ? ev.vars : [];
      const comp = { type: "BODY", text: String(ev.body || "") };
      if (vars.length) comp.example = { body_text: [vars.map(v => SAMPLE[v] || "exemple")] };
      const r = await graph(c, "POST", `${c.wabaId}/message_templates`, { name: tpl.name, language: tpl.lang, category: "UTILITY", components: [comp] }, 12_000);
      if (r.ok) results.push({ event: ev.event, name: tpl.name, state: "created", status: String((r.data && r.data.status) || "PENDING") });
      else results.push({ event: ev.event, name: tpl.name, state: "error", error: classify(c, r).text });
    }
    const after = await listTemplates(c);
    const sync = after.ok ? await svcRpc(c, "wa_templates_sync", { p_list: after.list }) : null;
    return json({ ...base, results, sync: sync && sync.ok ? sync.data : null });
  }

  if (action === "subscribe") {
    if (!c.wabaId) return json({ ...base, ok: false, error: "waba_missing" }, 400);
    const r = await graph(c, "POST", `${c.wabaId}/subscribed_apps`, {});
    if (!r.ok) return json({ ...base, ok: false, error: "meta", detail: classify(c, r).text }, 502);
    return json({ ...base, subscribed: true });
  }

  if (action === "test") {
    const phone = String((b && b.phone) || "").slice(0, 30);
    const q = await svcRpc(c, "wa_enqueue_test", { p_phone: phone });
    if (!q.ok || !q.data || q.data.ok !== true) return json({ ...base, ok: false, error: (q.data && q.data.err) || "enqueue" }, 400);
    const r = await dispatch(c, { limit: 5 });
    const mine = (r.results || []).find(x => x.id === q.data.id);
    if (!mine) return json({ ...base, test: { sent: false, queued: true, note: "Le message est en attente (réessai automatique)." } });
    return json({ ...base, test: mine.ok ? { sent: true } : { sent: false, error: scrub(c, mine.text), retry: !!mine.retry } });
  }

  return json({ ...base, ok: false, error: "unknown_action" }, 400);
};
