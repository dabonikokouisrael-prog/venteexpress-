// Messages du catalogue public — version 3.7.3.
// Le visiteur écrit depuis la page de la boutique. Ce serveur valide, limite le débit, enregistre dans la base
// (fonctions site_chat_* de supabase/13) et prévient le vendeur par e-mail si celui-ci l'a demandé.
// Le navigateur du visiteur ne parle jamais directement à la base pour le chat : tout passe ici, côté serveur.
//   POST { action:"send", slug, token, op, name, phone, body, hp }  ->  { ok, created, dup, conv, msg } | { ok:false, err }
//   POST { action:"poll", slug, token, after? }                       ->  { ok, open, shop, messages } | { ok:false, err }
// Le jeton est créé PAR LE NAVIGATEUR DU VISITEUR (32 octets au hasard, gardés dans son navigateur) : le serveur ne le
// crée pas et ne le renvoie pas. Il ne garde que son empreinte SHA-256 : un jeton volé ne peut pas être relu depuis la base.
import { createHash } from "node:crypto";
import { env, json, throttle, clientIp } from "../lib/wa.mjs";
import { svcRpc } from "../lib/supabase.mjs";
import { emailSeller } from "../lib/notify.mjs";

export const config = { path: "/api/catalogue-chat" };

const MAX_BYTES = 6000;
const SLUG = /^[a-z0-9-]{3,40}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;                          // 32 octets encodés en base64url (sans =)
const OP = /^[A-Za-z0-9_-]{8,80}$/;                           // identifiant de la demande (un réessai ne crée pas un 2e message)
const PER_IP_SEND = { max: 12, windowMs: 10 * 60 * 1000 };    // envois par adresse, toutes boutiques confondues
const PER_IP_READ = { max: 150, windowMs: 10 * 60 * 1000 };   // lectures : la fenêtre ouverte relit toutes les 15 secondes
const PER_SHOP_SEND = { max: 400, windowMs: 60 * 60 * 1000 }; // envois par boutique et par heure
const EMAIL_WAIT_MS = 5000;                                    // attente maximale de l'e-mail avant de répondre au visiteur
const sha = t => createHash("sha256").update(t).digest("hex");

// Nettoie un texte court : pas de caractères de contrôle, espaces réduits.
const short = (x, n) => String(x == null ? "" : x).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, n);
// Message : on garde les retours à la ligne, on retire le reste des caractères de contrôle.
const text = (x, n) => String(x == null ? "" : x).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, n);

async function handle(req) {
  if (req.method !== "POST") return json({ ok: false, err: "method" }, 405);
  const raw = await req.text();
  if (raw.length > MAX_BYTES) return json({ ok: false, err: "too_big" }, 413);
  let b;
  try { b = JSON.parse(raw || "{}"); } catch { return json({ ok: false, err: "json" }, 400); }
  if (!b || typeof b !== "object") return json({ ok: false, err: "json" }, 400);
  const c = env();
  if (!c.supaUrl || !c.secretKey) return json({ ok: false, err: "service" }, 503);
  const slug = String(b.slug || "");
  if (!SLUG.test(slug)) return json({ ok: false, err: "not_found" }, 404);
  const ip = clientIp(req);
  const tok = typeof b.token === "string" && TOKEN.test(b.token) ? b.token : "";

  if (b.action === "poll") {
    if (!(await throttle("chat-read:" + ip, PER_IP_READ.max, PER_IP_READ.windowMs))) return json({ ok: false, err: "busy" }, 429);
    if (!tok) return json({ ok: false, err: "not_found" }, 200);
    const after = typeof b.after === "string" && !Number.isNaN(Date.parse(b.after)) ? new Date(Date.parse(b.after)).toISOString() : null;
    const r = await svcRpc(c, "site_chat_visitor_poll", { p_slug: slug, p_token_hash: sha(tok), p_after: after });
    if (!r.ok || !r.data) return json({ ok: false, err: "service" }, 503);
    return json(r.data, 200);
  }

  if (b.action !== "send") return json({ ok: false, err: "action" }, 400);
  // Piège à robots : champ caché que seul un robot remplit. On fait semblant d'avoir reçu, sans rien enregistrer.
  if (String(b.hp || "") !== "") return json({ ok: true, created: false, dup: true, dropped: true }, 200);

  const op = String(b.op || "");
  if (!OP.test(op)) return json({ ok: false, err: "op" }, 400);
  if (!tok) return json({ ok: false, err: "token" }, 200);
  const name = short(b.name, 60), phone = String(b.phone || "").replace(/[^0-9]/g, ""), body = text(b.body, 1000);
  if (name.length < 2) return json({ ok: false, err: "name" }, 200);
  if (phone.length < 6 || phone.length > 16) return json({ ok: false, err: "phone" }, 200);
  if (body.length < 1) return json({ ok: false, err: "body" }, 200);

  if (!(await throttle("chat-ip:" + ip, PER_IP_SEND.max, PER_IP_SEND.windowMs))) return json({ ok: false, err: "busy" }, 429);
  if (!(await throttle("chat-shop:" + slug, PER_SHOP_SEND.max, PER_SHOP_SEND.windowMs))) return json({ ok: false, err: "busy" }, 429);

  const h = sha(tok);
  const r = await svcRpc(c, "site_chat_visitor_send", {
    p_slug: slug, p_token_hash: h, p_new_token_hash: h,          // même empreinte : la conversation est créée au premier envoi
    p_name: name, p_phone: phone, p_body: body, p_op: op,
  });
  if (!r.ok || !r.data) return json({ ok: false, err: "service" }, 503);
  const d = r.data;
  if (d.ok !== true) return json({ ok: false, err: String(d.err || "service") }, 200);

  const out = { ok: true, created: d.created === true, dup: d.dup === true, conv: d.conv, msg: d.msg };
  if (d.dup !== true) {   // nouveau message : on prévient le vendeur, mais le visiteur n'attend jamais plus de 5 secondes
    let timer = null;
    const wait = new Promise(res => { timer = setTimeout(res, EMAIL_WAIT_MS); });
    const alert = emailSeller(c, { shopId: d.shop_id, shop: d.shop, visitor: name, phone, body })
      .then(r => { if (r && r.ok === false && r.error) console.error("alerte e-mail du chat :", String(r.error).slice(0, 60)); })
      .catch(e => console.error("alerte e-mail du chat :", String(e && e.message || e).slice(0, 160)));
    await Promise.race([alert, wait]);
    clearTimeout(timer);
  }
  return json(out, 200);
}

export default async req => {
  try { return await handle(req); }
  catch (e) { console.error("catalogue-chat :", String(e && e.message || e).slice(0, 200)); return json({ ok: false, err: "service" }, 500); }
};
