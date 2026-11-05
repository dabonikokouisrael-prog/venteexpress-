// Webhook WhatsApp (Meta) : https://<votre-site>/api/whatsapp/webhook
//  - GET  : vérification demandée par Meta quand vous enregistrez l'adresse (hub.mode / hub.verify_token / hub.challenge)
//  - POST : états des messages (envoyé, remis, lu, échec), réponses des clients (STOP…), état des modèles. Signature obligatoire.
import { env, json, svcRpc, verifySignature, sameSecret } from "../lib/wa.mjs";

export const config = { path: "/api/whatsapp/webhook" };

const MAX_BYTES = 3 * 1024 * 1024;   // limite documentée par Meta pour une notification

// Une notification peut concerner plusieurs numéros : on ne garde que celui de la plateforme (les mises à jour de modèles n'ont pas de numéro et sont gardées).
function onlyOurNumber(c, body) {
  if (!c.phoneId || !body || !Array.isArray(body.entry)) return body;
  return {
    ...body,
    entry: body.entry.map(e => ({
      ...e,
      changes: (e && Array.isArray(e.changes) ? e.changes : []).filter(ch => {
        const pid = ch && ch.value && ch.value.metadata && ch.value.metadata.phone_number_id;
        return pid == null || String(pid) === c.phoneId;
      }),
    })),
  };
}

export default async (req) => {
  const c = env();

  if (req.method === "GET") {
    const q = new URL(req.url).searchParams;
    const challenge = q.get("hub.challenge");
    if (q.get("hub.mode") === "subscribe" && c.verify && sameSecret(q.get("hub.verify_token") || "", c.verify) && challenge !== null && challenge.length <= 200) {
      return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    }
    return new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }

  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST", "Cache-Control": "no-store" } });

  // Sans secret d'application on ne peut rien vérifier : on refuse tout plutôt que de croire n'importe qui.
  if (!c.secret || !c.supaUrl || !c.serviceKey) return json({ ok: false, error: "not_configured" }, 503);

  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_BYTES) return json({ ok: false, error: "too_large" }, 413);
  const raw = Buffer.from(await req.arrayBuffer());
  if (raw.length > MAX_BYTES) return json({ ok: false, error: "too_large" }, 413);

  if (!verifySignature(c.secret, raw, req.headers.get("x-hub-signature-256") || "")) return json({ ok: false, error: "bad_signature" }, 401);

  let body;
  try { body = JSON.parse(raw.toString("utf8")); } catch { return json({ ok: false, error: "bad_json" }, 400); }
  if (!body || typeof body !== "object" || body.object !== "whatsapp_business_account") return json({ ok: true, ignored: true });

  const r = await svcRpc(c, "wa_ingest", { p_payload: onlyOurNumber(c, body) });
  // Échec côté base : on répond 500 pour que Meta renvoie la notification plus tard (les doublons sont écartés par la base).
  if (!r.ok || !r.data || r.data.ok !== true) {
    console.error("whatsapp-webhook : wa_ingest a échoué", r.status);
    return json({ ok: false, error: "storage" }, 500);
  }
  return json({ ok: true, statuses: r.data.statuses, inbound: r.data.inbound, templates: r.data.templates });
};
