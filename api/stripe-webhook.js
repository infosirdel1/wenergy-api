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
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

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
  if (!process.env.FIREBASE_STORAGE_BUCKET) {
    throw new Error("FIREBASE_STORAGE_BUCKET is missing");
  }
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8")
  );
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
}
const firestore = admin.firestore();
const bucket = admin.storage().bucket(process.env.FIREBASE_STORAGE_BUCKET);

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

    const odoo_order_id = orderId;
    const count = platformCount;
    const email = data.client && data.client.email ? data.client.email : null;
    console.log("signed invoice: odoo_order_id=%s count=%s email=%s", odoo_order_id, count, email);

    let saleOrderState;
    try {
      const saleReadResp = await axios.post(
        `${ODOO_URL}/web/dataset/call_kw`,
        {
          jsonrpc: "2.0",
          method: "call",
          params: {
            model: "sale.order",
            method: "search_read",
            args: [[["id", "=", odoo_order_id]]],
            kwargs: { limit: 1, fields: ["state"] },
          },
          id: Date.now(),
        },
        { headers: { Cookie: cookieHeader } }
      );
      const saleList = saleReadResp.data?.result;
      if (!Array.isArray(saleList) || saleList.length === 0) {
        console.log("signed invoice: sale.order not found, skip");
        return res.status(200).json({ received: true });
      }
      saleOrderState = saleList[0].state;
    } catch (err) {
      console.error("signed invoice: Odoo sale.order search_read failed", err.message);
      return res.status(200).json({ received: true });
    }

    if (saleOrderState !== "sale") {
      console.log("signed invoice: state is not sale (state=%s), retrying in 5s", saleOrderState);

      await new Promise(resolve => setTimeout(resolve, 5000));

      const retryResp = await axios.post(
        `${ODOO_URL}/web/dataset/call_kw`,
        {
          jsonrpc: "2.0",
          method: "call",
          params: {
            model: "sale.order",
            method: "search_read",
            args: [[["id", "=", odoo_order_id]]],
            kwargs: { limit: 1, fields: ["state"] },
          },
        },
        { headers: { Cookie: cookieHeader } }
      );

      const retryState = retryResp.data?.result?.[0]?.state;

      console.log("signed invoice: retry state=%s", retryState);

      if (retryState !== "sale") {
        console.log("signed invoice: still not sale, abort");
        return res.status(200).json({ received: true });
      }

      console.log("signed invoice: state is sale after retry");
    }

    try {
      console.log("signed invoice: fetching PDF from Odoo");
      const signedPdfResp = await axios.get(
        `${ODOO_URL}/report/pdf/sale.report_saleorder/${odoo_order_id}`,
        {
          responseType: "arraybuffer",
          headers: { Cookie: cookieHeader },
          timeout: 20000,
        }
      );
      console.log("signed invoice: PDF fetched");
      const signedPdfBuffer = Buffer.from(signedPdfResp.data);
      const signedStoragePath = `invoices/${count}_signed.pdf`;
      const signedFile = bucket.file(signedStoragePath);
      await signedFile.save(signedPdfBuffer, {
        contentType: "application/pdf",
        resumable: false,
      });
      console.log("signed invoice: PDF uploaded to %s", signedStoragePath);
      await doc.ref.update({ signedInvoiceStored: true });
      console.log("signed invoice: Firestore updated signedInvoiceStored=true");

      try {
        console.log("email: preparing attachments");

        const bucket = admin.storage().bucket();

        const filesToAttach = [
          `invoices/${count}_signed.pdf`,
          `Document mails type/Conditions_Generales_Wenergy_INTEGRAL_FR_NL_EN.pdf`,
          `Document mails type/formulaire_retractation_wenergy_v2.pdf`,
          `Document mails type/wenergy_datasheet_marstek_C_E.pdf`,
        ];

        const attachments = [];

        for (const path of filesToAttach) {
          const [fileBuffer] = await bucket.file(path).download();
         attachments.push({
  filename: path.split("/").pop(),
  content: fileBuffer.toString("base64"),
  encoding: "base64",
});
        }

        console.log("email: attachments ready");

        await resend.emails.send({
          from: "Wenergy <contact@wenergy.be>",
          to: email,
          subject: `Votre commande Wenergy – ${data.quotation_number || ""}`,
          html: `
     html: `
  <p>Bonjour,</p>

  <p>Nous vous remercions pour votre commande auprès de Wenergy.</p>

  <p>Votre paiement a bien été confirmé et votre commande est désormais validée.</p>

  <p>Vous trouverez en pièces jointes :</p>

  <ul>
    <li><strong>Votre devis signé</strong> – document contractuel confirmant votre commande.</li>
    <li><strong>Les Conditions Générales de Vente</strong> – cadre légal applicable à votre installation.</li>
    <li><strong>Le formulaire de rétractation</strong> – conformément à la réglementation en vigueur.</li>
    <li><strong>La fiche technique produit</strong> – caractéristiques techniques de votre équipement.</li>
  </ul>

  <p>Votre commande sera préparée et expédiée dans les meilleurs délais.</p>

  <p>Les délais de livraison peuvent varier en raison du poids et du volume des équipements expédiés.  
  Nous mettons tout en œuvre pour assurer un traitement et une expédition aussi rapides que possible.</p>

  <p>Si vous avez la moindre question, notre équipe reste à votre disposition.</p>

  <p>Bien cordialement,<br>
  L’équipe Wenergy</p>
`,

          attachments,
        });

        console.log("email: sent successfully");

      } catch (err) {
        console.error("email: failed", err.message);
      }
    } catch (err) {
      console.error("signed invoice: failed", err.message);
    }

    const quotationId = data.quotation_id != null ? data.quotation_id : orderId;
    const pdfResp = await axios.get(
      `${ODOO_URL}/report/pdf/sale.report_saleorder/${quotationId}`,
      {
        responseType: "arraybuffer",
        headers: { Cookie: cookieHeader },
        timeout: 20000,
      }
    );
    console.log("PDF fetched");
    const pdfBuffer = Buffer.from(pdfResp.data);
    const storagePath = `requests/${platformCount}/devis-signed-${quotationId}.pdf`;
    const file = bucket.file(storagePath);
    await file.save(pdfBuffer, {
      contentType: "application/pdf",
      resumable: false,
    });
    console.log("PDF uploaded");
    const [signedUrl] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + 1000 * 60 * 60 * 24 * 7,
    });
    await doc.ref.update({
      "pdfs.devis_signed": {
        created_at: new Date(),
        signed_url: signedUrl,
        storage_path: storagePath,
      },
      signed_at: new Date(),
    });
    console.log("Firestore updated");

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Firestore update failed", err.message);
    return res.status(500).json({ error: "Update failed" });
  }
}
