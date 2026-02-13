/**
 * Stripe webhook : payment_intent.succeeded → mise à jour Firestore payment_status = "paid"
 * Body brut obligatoire pour vérification de la signature Stripe.
 */
export const config = {
  api: { bodyParser: false },
};

import Stripe from "stripe";
import axios from "axios";
import admin from "firebase-admin";

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
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
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const signature = req.headers["stripe-signature"];
  if (!signature) {
    return res.status(400).json({ error: "Missing stripe-signature" });
  }

  const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_WEBHOOK_SECRET || !STRIPE_SECRET_KEY) {
    console.error("Stripe env missing");
    return res.status(500).json({ error: "Server configuration error" });
  }

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    console.error("Raw body read failed", err.message);
    return res.status(400).json({ error: "Invalid body" });
  }

  let event;
  try {
    const stripe = new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: "2023-10-16",
    });
    event = stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Stripe signature verification failed", err.message);
    return res.status(400).json({ error: "Invalid signature" });
  }

  if (event.type !== "payment_intent.succeeded") {
    return res.status(200).json({ received: true });
  }

  const paymentIntentId = event.data?.object?.id;
  if (!paymentIntentId) {
    return res.status(200).json({ received: true });
  }

  const ODOO_URL = process.env.ODOO_URL;
  const ODOO_DB = process.env.ODOO_DB;
  const ODOO_USER = process.env.ODOO_USER;
  const ODOO_PASSWORD = process.env.ODOO_PASSWORD;
  if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_PASSWORD) {
    console.error("Odoo env missing");
    return res.status(500).json({ error: "Server configuration error" });
  }

  let cookieHeader;
  try {
    const authResp = await axios.post(
      `${ODOO_URL}/web/session/authenticate`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_PASSWORD },
        id: Date.now(),
      },
      { headers: { "Content-Type": "application/json" } }
    );
    const cookies = authResp.headers["set-cookie"];
    const sessionId = cookies
      ?.find((c) => c.includes("session_id"))
      ?.split(";")[0]
      ?.replace("session_id=", "");
    if (!sessionId) throw new Error("No session");
    cookieHeader = `session_id=${sessionId}`;
  } catch (err) {
    console.error("Odoo auth failed", err.message);
    return res.status(500).json({ error: "Odoo unavailable" });
  }

  let state;
  let saleOrderIds;
  try {
    const txResp = await axios.post(
      `${ODOO_URL}/web/dataset/call_kw`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          model: "payment.transaction",
          method: "search_read",
          args: [[["provider_reference", "=", paymentIntentId]]],
          kwargs: { limit: 1, fields: ["state", "sale_order_ids"] },
        },
        id: Date.now(),
      },
      { headers: { Cookie: cookieHeader } }
    );
    const txList = txResp.data?.result;
    if (!Array.isArray(txList) || txList.length === 0) {
      return res.status(200).json({ received: true });
    }
    const tx = txList[0];
    state = tx.state;
    saleOrderIds = tx.sale_order_ids;
  } catch (err) {
    console.error("Odoo payment.transaction failed", err.message);
    return res.status(500).json({ error: "Odoo read failed" });
  }

  if (state !== "done") {
    return res.status(200).json({ received: true });
  }

  const orderId = Array.isArray(saleOrderIds) ? saleOrderIds[0] : saleOrderIds;
  if (!orderId) {
    return res.status(200).json({ received: true });
  }

  let platformCount;
  try {
    const orderResp = await axios.post(
      `${ODOO_URL}/web/dataset/call_kw`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          model: "sale.order",
          method: "read",
          args: [[orderId]],
          kwargs: { fields: ["x_studio_platform_count"] },
        },
        id: Date.now(),
      },
      { headers: { Cookie: cookieHeader } }
    );
    const orderList = orderResp.data?.result;
    if (!Array.isArray(orderList) || orderList.length === 0) {
      return res.status(200).json({ received: true });
    }
    const val = orderList[0].x_studio_platform_count;
    if (val === undefined || val === null) {
      return res.status(200).json({ received: true });
    }
    platformCount = Number(val);
    if (!Number.isFinite(platformCount)) {
      return res.status(200).json({ received: true });
    }
  } catch (err) {
    console.error("Odoo sale.order read failed", err.message);
    return res.status(500).json({ error: "Odoo read failed" });
  }

  try {
    const snap = await firestore
      .collection("requests")
      .where("platform_count", "==", platformCount)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(200).json({ received: true });
    }

    const doc = snap.docs[0];
    const data = doc.data();
    if (data.payment_status === "paid") {
      return res.status(200).json({ received: true });
    }

    await doc.ref.update({
      payment_status: "paid",
      updated_at: new Date(),
    });

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Firestore update failed", err.message);
    return res.status(500).json({ error: "Update failed" });
  }
}
