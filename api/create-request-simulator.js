// api/create-request-simulator.js

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// ==============================
// INIT FIREBASE ADMIN (1 seule fois)
// ==============================
if (!getApps().length) {
  initializeApp({
    credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

const db = getFirestore();

// ==============================
// API HANDLER
// ==============================
export default async function handler(req, res) {

  // ==============================
  // CORS (OBLIGATOIRE – SIMULATEUR ODOO)
  // ==============================
  res.setHeader("Access-Control-Allow-Origin", "https://wenergy1.odoo.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const {
    firstname,
    lastname,
    phone,
    street,
    number,
    zipcode,
    city,
    installation_type, // "battery" | "pv"
    pv_count = 0,
  } = req.body || {};

  // ==============================
  // VALIDATION MINIMALE
  // ==============================
  if (!firstname || !lastname || !zipcode || !city || !installation_type) {
    return res.status(400).json({ error: "missing_fields" });
  }

  // ==============================
  // CALCUL MONTANT (LOGIQUE SERVEUR)
  // ==============================
  let amount = 0;

  if (installation_type === "battery") {
    amount = 150;
  } else if (installation_type === "pv") {
    const panels = Math.max(1, Number(pv_count || 1));
    amount = 300 + (panels - 1) * 65;
  }

  try {
    const counterRef = db.collection("counters").doc("requests");

    await db.runTransaction(async (tx) => {
      const counterSnap = await tx.get(counterRef);
      const nextNumber = counterSnap.exists
        ? (counterSnap.data().value || 0) + 1
        : 1;

      tx.set(counterRef, { value: nextNumber }, { merge: true });

      const requestRef = db.collection("requests").doc();

      tx.set(requestRef, {
        request_number: nextNumber,
        created_at: Date.now(),
        source: "simulator",
        payment_status: "pending_payment",

        client: {
          firstName: firstname,
          lastName: lastname,
          phone: phone || "",
        },

        address: {
          street: street || "",
          number: number || "",
          zipcode,
          city,
        },

        work: {
          type: installation_type,
          pv_count: Number(pv_count || 0),
          amount,
        },
      });
    });

    return res.status(200).json({ status: "ok" });

  } catch (err) {
    console.error("[SIMU → FIRESTORE] error", err);
    return res.status(500).json({ error: "firestore_error" });
  }
}
