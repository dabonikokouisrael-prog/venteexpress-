// Envoi des messages WhatsApp en attente : https://<votre-site>/api/whatsapp/dispatch
// La base de données décide de TOUT ce qui peut partir (réglages de la boutique, accord du client, STOP, fenêtre de 24 h, modèle approuvé) ;
// cette fonction ne fait que transmettre à Meta, avec le jeton qui reste ici, côté serveur.
//  - avec un compte (en-tête Authorization) : membre de la boutique -> envoie les messages de CETTE boutique ({shop} et, au choix, {order})
//  - sans compte : uniquement après une commande du catalogue public ({slug, ref} donnés au client) -> les messages de CETTE commande, créés il y a moins de 10 minutes
import { env, json, bearer, userRpc, svcRpc, dispatch, canSend, throttle, clientIp } from "../lib/wa.mjs";

export const config = { path: "/api/whatsapp/dispatch" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER_ID = /^[A-Za-z0-9_-]{6,40}$/;
const str = (v, re) => (typeof v === "string" && re.test(v) ? v : null);

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  const c = env();
  let b;
  try { b = await req.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
  if (!b || typeof b !== "object") return json({ ok: false, error: "bad_json" }, 400);

  // WhatsApp n'est pas encore branché sur ce site : rien à envoyer, ce n'est pas une erreur pour l'appli
  if (!canSend(c)) return json({ ok: true, configured: false, sent: 0 });

  const jwt = bearer(req);
  if (jwt) {
    const shop = str(b.shop, UUID), order = str(b.order, ORDER_ID);
    if (!shop) return json({ ok: false, error: "shop_required" }, 400);
    if (!throttle("u:" + jwt.slice(-24), 60, 60_000)) return json({ ok: false, error: "slow_down" }, 429);
    const who = await userRpc(c, jwt, "my_wa", { p_shop: shop.toLowerCase() });   // Supabase vérifie le jeton ET l'appartenance à la boutique
    if (!who.ok || !who.data || who.data.ok !== true) return json({ ok: false, error: "forbidden" }, who.status === 401 ? 401 : 403);
    const r = await dispatch(c, { shop: shop.toLowerCase(), order, limit: 10 });
    return json({ ok: r.ok, configured: r.configured !== false, total: r.total || 0, sent: r.sent || 0, failed: r.failed || 0, retried: r.retried || 0 });
  }

  const slug = str(b.slug, /^[A-Za-z0-9-]{3,40}$/), ref = str(b.ref, /^[A-Za-z0-9]{3,20}$/);
  if (!slug || !ref) return json({ ok: false, error: "order_required" }, 400);
  if (!throttle("ip:" + clientIp(req), 20, 60_000) || !throttle("o:" + slug + ":" + ref, 5, 60_000)) return json({ ok: false, error: "slow_down" }, 429);
  const f = await svcRpc(c, "wa_public_order", { p_slug: slug, p_ref: ref });
  const id = f.ok && typeof f.data === "string" ? f.data : null;
  if (!id) return json({ ok: true, sent: 0 });                 // commande inconnue ou trop ancienne : même réponse que « rien à envoyer »
  const r = await dispatch(c, { order: id, recent: 10, limit: 5 });
  return json({ ok: r.ok, sent: r.sent || 0 });
};
