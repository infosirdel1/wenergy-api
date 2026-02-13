/**
 * Vercel Cron : vérification automatique des paiements Odoo (polling serveur).
 * Lit les requests en pending_payment, interroge Odoo account.move, met à jour Firestore si paid.
 * Sécurisé par CRON_SECRET (header x-cron-secret ou Authorization: Bearer).
 */

import admin from "firebase-admin";
import { getPendingPayments, updatePaymentStatus } from "../lib/firestore.js";
import { checkOdooPaymentFromSaleOrder } from "../lib/odoo.js";

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const cronHeader = req.headers["x-cron-secret"];
  const authHeader = req.headers["authorization"];
  if (cronHeader && cronHeader === secret) return true;
  if (authHeader && authHeader === `Bearer ${secret}`) return true;
  return false;
}

// Firebase init (safe serverless)
if (!admin.apps.length) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_BASE64 is missing");
  }
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8")
  );
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const firestore = admin.firestore();

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isAuthorized(req)) {
    console.warn("[check-odoo-payments] Unauthorized: missing or invalid CRON_SECRET");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const start = Date.now();
  let pendingCount = 0;
  let checked = 0;
  let updated = 0;
  const errors = [];

  try {
    const snapshot = await getPendingPayments(firestore);
    pendingCount = snapshot.size;
    console.log(`[check-odoo-payments] Pending payments found: ${pendingCount}`);

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const quotationId = data.quotation_id;
      if (quotationId == null || quotationId === "") {
        console.warn(`[check-odoo-payments] Skip doc ${doc.id}: quotation_id absent`);
        continue;
      }

      checked += 1;
      console.log(`[check-odoo-payments] Checking sale.order ${quotationId}`);
      let paymentState;
      try {
        paymentState = await checkOdooPaymentFromSaleOrder(quotationId);
        if (paymentState === "no_invoice") {
          console.log(`[check-odoo-payments] No invoice found for sale.order ${quotationId}`);
          continue;
        }
        console.log(`[check-odoo-payments] Invoice found for sale.order ${quotationId}, payment state: ${paymentState}`);
      } catch (err) {
        console.error(`[check-odoo-payments] Odoo API error doc=${doc.id} quotationId=${quotationId}`, err.message);
        errors.push({ docId: doc.id, quotationId, error: err.message });
        continue;
      }

      if (paymentState !== "paid") {
        continue;
      }

      try {
        await updatePaymentStatus(doc.ref);
        updated += 1;
        console.log(`[check-odoo-payments] Updated doc ${doc.id} → payment_status=paid`);
      } catch (err) {
        console.error(`[check-odoo-payments] Firestore update failed doc=${doc.id}`, err.message);
        errors.push({ docId: doc.id, step: "update", error: err.message });
      }
    }

    const duration = Date.now() - start;
    console.log(`[check-odoo-payments] Done in ${duration}ms: pending=${pendingCount} checked=${checked} updated=${updated}`);

    return res.status(200).json({
      ok: true,
      pending: pendingCount,
      checked,
      updated,
      duration_ms: duration,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error("[check-odoo-payments] Fatal error", err);
    return res.status(500).json({
      ok: false,
      error: "Internal error",
      message: err.message,
    });
  }
}
