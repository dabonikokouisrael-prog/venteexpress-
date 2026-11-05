// Filet de sécurité : toutes les 10 minutes, envoie ce qui est resté en attente (réessais après une erreur passagère, messages créés hors ligne…).
// Les réessais suivent le calendrier fixé par la base : 1 min, 5 min, 30 min, 2 h (au plus 5 essais). Au-delà de 24 h une notification est abandonnée.
// Pour arrêter cette tâche : supprimer ce fichier (l'envoi à la demande continue de fonctionner).
import { env, dispatch, canSend } from "../lib/wa.mjs";

export const config = { schedule: "*/10 * * * *" };

export default async () => {
  const c = env();
  if (!canSend(c)) { console.log("whatsapp-retry : WhatsApp non configuré, rien à faire."); return; }
  const t = { total: 0, sent: 0, failed: 0, retried: 0 };
  for (let i = 0; i < 3; i++) {                    // 3 lots de 50 au maximum par passage
    const r = await dispatch(c, { limit: 50, deadlineMs: 20_000 });
    if (!r.ok) { console.error("whatsapp-retry : lot refusé", r.error || r.status); break; }
    t.total += r.total; t.sent += r.sent; t.failed += r.failed; t.retried += r.retried;
    if (r.total < 50) break;
  }
  console.log("whatsapp-retry :", JSON.stringify(t));
};
