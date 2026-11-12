// Alerte e-mail au vendeur quand un visiteur écrit sur son catalogue — version 3.7.3.
// Fournisseur au choix, selon les variables Netlify renseignées :
//  - Resend : RESEND_API_KEY et NOTIFY_FROM (adresse d'expédition vérifiée chez Resend)
//  - SMTP   : SMTP_HOST, SMTP_PORT (587 par défaut), SMTP_USER, SMTP_PASS, SMTP_FROM
// Aucune clé ni adresse n'est écrite ici. L'envoi est « au mieux » : un échec n'empêche jamais le message d'être enregistré.
// Le vendeur active l'alerte dans l'appli (réglage settings.notify.email + adresse) : sans cela, rien n'est envoyé.
import { svcGet } from "./supabase.mjs";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const TIMEOUT = 4000;

export function mailProvider(e = process.env) {
  if (e.RESEND_API_KEY && e.NOTIFY_FROM) return "resend";
  if (e.SMTP_HOST && e.SMTP_FROM) return "smtp";
  return "";
}

async function sendResend(e, to, subject, text) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", signal: ctl.signal,
      headers: { Authorization: "Bearer " + e.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: e.NOTIFY_FROM, to: [to], subject, text }),
    });
    return r.ok ? { ok: true, provider: "resend" } : { ok: false, provider: "resend", error: "http_" + r.status };
  } finally { clearTimeout(t); }
}

async function sendSmtp(e, to, subject, text) {
  const nodemailer = await import("nodemailer");   // paquet « nodemailer » (site/package.json)
  const port = Number(e.SMTP_PORT) || 587;
  const tr = nodemailer.default.createTransport({
    host: e.SMTP_HOST, port, secure: port === 465,
    auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASS || "" } : undefined,
    connectionTimeout: TIMEOUT, greetingTimeout: TIMEOUT, socketTimeout: TIMEOUT,
  });
  await tr.sendMail({ from: e.SMTP_FROM, to, subject, text });
  return { ok: true, provider: "smtp" };
}

// Envoie l'alerte si le vendeur l'a activée et a une adresse valide. Renvoie un objet { ok } : un refus de Resend (erreur HTTP) renvoie { ok:false, error }, sans exception ; une panne réseau ou SMTP lève une erreur
// que l'appelant rattrape (catalogue-chat). Dans tous les cas, le message du visiteur est déjà enregistré à ce moment-là.
export async function emailSeller(c, { shopId, shop, visitor, phone, body }) {
  const provider = mailProvider();
  if (!provider) return { ok: false, skipped: "no_provider" };
  const r = await svcGet(c, "shops?id=eq." + encodeURIComponent(shopId) + "&select=settings");
  const n = r.ok && Array.isArray(r.data) && r.data[0] && r.data[0].settings && r.data[0].settings.notify;
  if (!n || n.email !== true || !EMAIL.test(String(n.email_to || ""))) return { ok: false, skipped: "off" };
  const to = String(n.email_to);
  const subject = "VenteExpress : nouveau message sur " + String(shop || "ta boutique").slice(0, 60);
  const text = String(visitor) + (phone ? " (" + phone + ")" : "") + " a écrit sur ton catalogue :\n\n" + String(body).slice(0, 600) +
    "\n\nRéponds depuis VenteExpress, onglet « Messages du site ».\n";
  return provider === "resend" ? sendResend(process.env, to, subject, text) : sendSmtp(process.env, to, subject, text);
}
