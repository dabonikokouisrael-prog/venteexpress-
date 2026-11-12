// Webhook WhatsApp (Meta) : https://<votre-site>/api/whatsapp/webhook
//  - GET  : vérification demandée par Meta quand vous enregistrez l'adresse (hub.mode / hub.verify_token / hub.challenge)
//  - POST : états des messages (envoyé, remis, lu, échec), réponses des clients (STOP…), état des modèles. Signature obligatoire.
import { env, json, verifySignature, sameSecret } from "../lib/wa.mjs";
import { svcRpc } from "../lib/supabase.mjs";

export const config = { path: "/api/whatsapp/webhook" };

const MAX_BYTES = 3 * 1024 * 1024;   // limite documentée par Meta pour une notification

// Notifications que la base sait traiter aujourd'hui. Tout le reste est ignoré sans erreur (voir plus bas).
const KNOWN_FIELDS = new Set(["messages", "message_template_status_update"]);
const fieldNames = body => (Array.isArray(body && body.entry) ? body.entry : [])
  .flatMap(e => (e && Array.isArray(e.changes) ? e.changes : []))
  .map(ch => (ch && typeof ch.field === "string") ? ch.field.slice(0, 40) : "")
  .filter(Boolean);

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
  if (!c.secret || !c.supaUrl || !c.secretKey) {
    // Dans le journal de la fonction (visible par toi seul dans Netlify) : seulement les NOMS des variables à corriger, jamais une valeur.
    console.error("whatsapp-webhook : non configuré. À renseigner :", [!c.secret && "META_APP_SECRET", !c.supaUrl && "SUPABASE_URL", !c.secretKey && "SUPABASE_SECRET_KEY"].filter(Boolean).join(", "), "| remarques :", c.sb.problems.map(p => p.code).join(",") || "-");
    return json({ ok: false, error: "not_configured" }, 503);
  }

  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_BYTES) return json({ ok: false, error: "too_large" }, 413);
  const raw = Buffer.from(await req.arrayBuffer());
  if (raw.length > MAX_BYTES) return json({ ok: false, error: "too_large" }, 413);

  if (!verifySignature(c.secret, raw, req.headers.get("x-hub-signature-256") || "")) return json({ ok: false, error: "bad_signature" }, 401);

  let body;
  try { body = JSON.parse(raw.toString("utf8")); } catch { return json({ ok: false, error: "bad_json" }, 400); }
  if (!body || typeof body !== "object" || body.object !== "whatsapp_business_account") return json({ ok: true, ignored: true });

  const kept = onlyOurNumber(c, body);

  // Coexistence (le numéro reste aussi dans l'appli WhatsApp Business du téléphone) : Meta envoie alors des
  // notifications en plus (messages écrits à la main depuis le téléphone, historique, synchronisation des
  // contacts). La base les ignore sans rien casser — mais tant qu'on ne les voit pas passer, impossible de
  // savoir si la Coexistence est réellement active. On note donc leur nom dans le journal Netlify (aucun
  // contenu de message, seulement le nom du champ), une fois par notification.
  const fields = [...new Set(fieldNames(kept))], extra = fields.filter(f => !KNOWN_FIELDS.has(f));
  if (extra.length) console.log("whatsapp-webhook : notifications reçues et non utilisées (Coexistence) :", extra.join(", "));

  const r = await svcRpc(c, "wa_ingest", { p_payload: kept });
  // Échec côté base : on répond 500 pour que Meta renvoie la notification plus tard (les doublons sont écartés par la base).
  if (!r.ok || !r.data || r.data.ok !== true) {
    console.error("whatsapp-webhook : wa_ingest a échoué", r.status);
    return json({ ok: false, error: "storage" }, 500);
  }
  return json({ ok: true, statuses: r.data.statuses, inbound: r.data.inbound, templates: r.data.templates });
};
