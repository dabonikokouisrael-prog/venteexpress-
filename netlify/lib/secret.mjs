// Chiffrement du jeton d'accès WhatsApp (AES-256-GCM) — version 3.7.3.
// La clé vient de la variable Netlify WA_TOKEN_KEY (32 octets, en base64). Elle n'est JAMAIS écrite dans le code ni dans la base.
// Changer de clé : voir docs/08_V3.7.3_CE_QUI_CHANGE.md (il faudra re-chiffrer les jetons enregistrés).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function keyFromEnv(raw) {
  const k = Buffer.from(String(raw || ""), "base64");
  return k.length === 32 ? k : null;
}

// Renvoie { enc, iv, tag } en base64 : tout ce qu'il faut pour relire le secret plus tard.
export function seal(key, plain) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return { enc: enc.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64") };
}

// Relit le secret. Lève une erreur si la clé ou les données ne correspondent pas (une altération est détectée).
export function open(key, { enc, iv, tag }) {
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64")), d.final()]).toString("utf8");
}
