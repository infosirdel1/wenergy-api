// api/create-request-simulator.js

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// ==============================
// CORS (Odoo -> Vercel)
// ==============================
const ALLOWED_ORIGINS = [
  "https://wenergy1.odoo.com",
  "https://www.wenergy-consulting.com",
  "https://wenergy-consulting.com",
];

function setCors(req, res) {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (origin) {
    return res.status(403).json({ error: "origin_not_allowed" });
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
  res.setHeader("Content-Type", "application/json");
}


// ==============================
// INIT FIREBASE ADMIN (1 seule fois)
// ==============================
if (!getApps().length) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("Missing FIREBASE_SERVICE_ACCOUNT env var");
  }
  initializeApp({
    credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

const db = getFirestore();

// ==============================
// API HANDLER
// ==============================
export default async function handler(req, res) {
  setCors(req, res);

  // ✅ PRE-FLIGHT CORS
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

  if (!firstname || !lastname || !zipcode || !city || !installation_type) {
    return res.status(400).json({ error: "missing_fields" });
  }

  let amount = 0;
  if (installation_type === "battery") {
    amount = 150;
  } else if (installation_type === "pv") {
    const panels = Math.max(1, Number(pv_count || 1));
    amount = 300 + (panels - 1) * 65;
  }

  try {
    const counterRef = db.collection("counters").doc("requests");
    let createdRequestId = null;
    let nextNumber = null;

    await db.runTransaction(async (tx) => {
      const counterSnap = await tx.get(counterRef);

      nextNumber = counterSnap.exists
        ? (counterSnap.data().value || 0) + 1
        : 1;

      tx.set(counterRef, { value: nextNumber }, { merge: true });

      const requestRef = db.collection("requests").doc();
      createdRequestId = requestRef.id;

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

    return res.status(200).json({
      status: "ok",
      request_id: createdRequestId,
      request_number: nextNumber,
    });
  } catch (err) {
    console.error("[SIMU → FIRESTORE] error", err);
    return res.status(500).json({ error: "firestore_error" });
  }
}
