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
import crypto from "crypto";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";

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
    let saleOrderName;
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
            kwargs: { limit: 1, fields: ["state", "name"] },
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
      saleOrderName = saleList[0].name;
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

    // ===============================
    // WAIT FOR POSTED INVOICE (max 30s)
    // ===============================

    let invoiceId = null;
    let invoicePdfBuffer = null;

    for (let attempt = 1; attempt <= 6; attempt++) {

      try {
        const invoiceResp = await axios.post(
          `${ODOO_URL}/web/dataset/call_kw`,
          {
            jsonrpc: "2.0",
            method: "call",
            params: {
              model: "account.move",
              method: "search_read",
              args: [[
                ["invoice_origin", "=", saleOrderName],
                ["move_type", "=", "out_invoice"],
                ["state", "=", "posted"]
              ]],
              kwargs: { limit: 1, fields: ["id"] },
            },
            id: Date.now(),
          },
          { headers: { Cookie: cookieHeader } }
        );

        const invoices = invoiceResp.data?.result;

        if (Array.isArray(invoices) && invoices.length > 0) {
          invoiceId = invoices[0].id;
          console.log("invoice: found on attempt %s id=%s", attempt, invoiceId);
          break;
        }

        console.log("invoice: not found attempt %s/6", attempt);

      } catch (err) {
        console.error("invoice search failed attempt %s", attempt, err.message);
      }

      if (attempt < 6) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    if (invoiceId) {
      try {
        const invoicePdfResp = await axios.get(
          `${ODOO_URL}/report/pdf/account.report_invoice/${invoiceId}`,
          {
            responseType: "arraybuffer",
            headers: { Cookie: cookieHeader },
            timeout: 20000,
          }
        );

        invoicePdfBuffer = Buffer.from(invoicePdfResp.data);
        console.log("invoice PDF fetched");

        // Upload invoice PDF to Storage
        const invoiceStoragePath = `requests/${count}/facture-${invoiceId}.pdf`;
        const invoiceFile = bucket.file(invoiceStoragePath);

        await invoiceFile.save(invoicePdfBuffer, {
          contentType: "application/pdf",
          resumable: false,
        });

        const [invoiceSignedUrl] = await invoiceFile.getSignedUrl({
          action: "read",
          expires: Date.now() + 1000 * 60 * 60 * 24 * 7,
        });

        // Update Firestore with invoice info
        await doc.ref.update({
          "pdfs.invoice": {
            created_at: new Date(),
            invoice_id: invoiceId,
            storage_path: invoiceStoragePath,
            signed_url: invoiceSignedUrl,
          },
          invoice_sent_at: new Date(),
        });

        // ===============================
        // INIT DELIVERY DATA
        // ===============================

        const deliveryToken = crypto.randomBytes(32).toString("hex");

        await doc.ref.update({
          delivery: {
            status: "pending",
            token: deliveryToken,
            shipped_at: null,
            received_at: null,
            odoo_order_id: orderId,
            odoo_order_name: saleOrderName
          }
        });

        // ===============================
        // GENERATE SUPPLIER DELIVERY PDF
        // ===============================

        try {

          const supplierData = data.supplier_order_snapshot || {};
          const lines = Array.isArray(supplierData.lines) ? supplierData.lines : [];

          const docPdf = new PDFDocument({ margin: 40 });
          const chunks = [];
          // ===============================
          // FILIGRANE LOGO WENERGY
          // ===============================

          try {
            const [logoBuffer] = await bucket
              .file("Document mails type/Logo Wenergy.png")
              .download();

            docPdf.save();
            docPdf.opacity(0.05);

            docPdf.image(logoBuffer, 90, 250, {
              width: 420
            });

            docPdf.opacity(1);
            docPdf.restore();

          } catch (err) {
            console.error("Logo watermark failed", err.message);
          }
          const pageWidth = 595;
          const margin = 40;
          const contentWidth = pageWidth - margin * 2;
          const wenergyBlue = "#005BBB";

          docPdf.on("data", chunk => chunks.push(chunk));

          const drawTitle = (title, options = {}) => {
            docPdf.fillColor(wenergyBlue).fontSize(14).font("Helvetica-Bold");
            const yBefore = docPdf.y;
            docPdf.text(title, margin, yBefore, { width: contentWidth, align: options.align || "left" });
            const yAfter = docPdf.y;
            docPdf.strokeColor(wenergyBlue).lineWidth(0.5).moveTo(margin, yAfter + 2).lineTo(margin + contentWidth, yAfter + 2).stroke();
            docPdf.y = yAfter + 6;
            docPdf.fillColor("black").font("Helvetica").fontSize(options.bodySize || 11);
          };

          const drawHLine = () => {
            docPdf.strokeColor("black").lineWidth(0.3).moveTo(margin, docPdf.y).lineTo(margin + contentWidth, docPdf.y).stroke();
            docPdf.moveDown(0.5);
          };

          docPdf.fontSize(14).font("Helvetica-Bold").fillColor(wenergyBlue);
          docPdf.text("BON DE LIVRAISON FOURNISSEUR", margin, docPdf.y, { width: contentWidth, align: "center" });
          const mainTitleY = docPdf.y;
          docPdf.strokeColor(wenergyBlue).lineWidth(0.5).moveTo(margin, mainTitleY + 4).lineTo(margin + contentWidth, mainTitleY + 4).stroke();
          docPdf.y = mainTitleY + 10;
          docPdf.moveDown(0.5);
          drawHLine();
          docPdf.fillColor("black").font("Helvetica").fontSize(11);

          drawTitle("INFORMATIONS COMMANDE");
          docPdf.text(`Référence : ${data.request_number || ""}`);
          docPdf.text(`Commande interne : ${data.platform_count || ""}`);
          docPdf.moveDown(1);

          drawTitle("CLIENT");
          docPdf.text(`${data.client?.firstName || ""} ${data.client?.lastName || ""}`);
          docPdf.text(`${data.address?.street || ""} ${data.address?.number || ""}`);
          docPdf.text(`${data.address?.zipcode || ""} ${data.address?.city || ""}`);
          docPdf.text(`Préférence livraison : ${data.delivery_preference || ""}`);
          docPdf.moveDown(1);

          drawTitle("PRODUITS");
          docPdf.font("Helvetica-Bold").text("Produit", margin, docPdf.y);
          docPdf.text("Qté", margin + contentWidth - 30, docPdf.y, { width: 30, align: "right" });
          docPdf.moveDown(0.4);
          docPdf.font("Helvetica").strokeColor("black").lineWidth(0.2).moveTo(margin, docPdf.y).lineTo(margin + contentWidth, docPdf.y).stroke();
          docPdf.moveDown(0.4);

          const colQtyX = margin + contentWidth - 35;
          lines.forEach(line => {
            const lineY = docPdf.y;
            const name = String(line.product_name || "").trim() || "—";
            const qtyStr = `x${Number(line.quantity) || 0}`;
            docPdf.fillColor("black").font("Helvetica").fontSize(11);
            docPdf.text(name, margin, lineY, { width: colQtyX - margin - 10 });
            const afterNameY = docPdf.y;
            docPdf.text(qtyStr, colQtyX, lineY, { width: 35, align: "right" });
            docPdf.y = Math.max(afterNameY, lineY + 14);
            docPdf.moveDown(0.6);
          });

          // ===============================
          // QR CODE SECTION
          // ===============================

          docPdf.moveDown(1); // descend bien plus bas

          // Texte grand + interligne large
          const qrSectionY = docPdf.y;
          docPdf.font("Helvetica-Bold").fontSize(16).fillColor("black");
          docPdf.text("Scanner le QR code à l'expédition", margin, qrSectionY, {
            width: 300
          });
          docPdf.moveDown(0.4);
          docPdf.text("Scanner le QR code à la réception", margin, docPdf.y, {
            width: 300
          });
          docPdf.moveDown(0.8);
          const qrSize = 150;
          const qrX = margin + contentWidth - qrSize;
          const qrY = qrSectionY;

          // ===============================
          // QR CODE RÉEL
          // ===============================

      const deliveryUrl = `https://wenergy-api.vercel.app/api/scan?count=${data.platform_count}`;

          const qrDataUrl = await QRCode.toDataURL(deliveryUrl);

          const qrImage = Buffer.from(
            qrDataUrl.replace(/^data:image\/png;base64,/, ""),
            "base64"
          );

          docPdf.image(qrImage, qrX, qrY, {
            width: qrSize,
          });

          const pdfBuffer = await new Promise((resolve) => {
            docPdf.on("end", () => resolve(Buffer.concat(chunks)));
            docPdf.end();
          });

          const supplierPath = `requests/${data.platform_count}/bon-livraison-fournisseur.pdf`;
          const supplierFile = bucket.file(supplierPath);

          await supplierFile.save(pdfBuffer, {
            contentType: "application/pdf",
            resumable: false,
          });

          const [supplierUrl] = await supplierFile.getSignedUrl({
            action: "read",
            expires: Date.now() + 1000 * 60 * 60 * 24 * 7,
          });

          await doc.ref.update({
            "pdfs.supplier_delivery_note": {
              created_at: new Date(),
              storage_path: supplierPath,
              signed_url: supplierUrl,
            }
          });

          console.log("✅ Supplier delivery PDF generated");

          // ===============================
          // SEND SUPPLIER EMAIL (PDF ATTACHED ONLY)
          // ===============================

          try {

            const supplierEmail = "info.sirdel@gmail.com"; // TEMP fournisseur test

            // Télécharger le PDF depuis Storage pour l'attacher
            const [supplierPdfBuffer] = await bucket
              .file(`requests/${data.platform_count}/bon-livraison-fournisseur.pdf`)
              .download();

            await resend.emails.send({
              from: "Wenergy <noreply@wenergy-consulting.com>",
              to: supplierEmail,
              subject: `Nouvelle commande fournisseur – ${data.request_number || ""}`,
              html: `
      <p>Bonjour,</p>

      <p>Veuillez trouver en pièce jointe le bon de livraison fournisseur relatif à la commande :</p>

      <p><strong>${data.request_number || ""}</strong></p>

      <p>Adresse de livraison :</p>
      <p>
        ${data.client?.firstName || ""} ${data.client?.lastName || ""}<br>
        ${data.address?.street || ""} ${data.address?.number || ""}<br>
        ${data.address?.zipcode || ""} ${data.address?.city || ""}
      </p>

      <p>Merci de préparer l'expédition.</p>

      <p>Cordialement,<br>
      Wenergy</p>
    `,
              attachments: [
                {
                  filename: "bon-livraison-fournisseur.pdf",
                  content: supplierPdfBuffer.toString("base64"),
                  encoding: "base64",
                }
              ],
            });

            console.log("✅ Supplier email sent");

          } catch (err) {
            console.error("❌ Supplier email failed", err.message);
          }

        } catch (err) {
          console.error("❌ Supplier PDF generation failed", err.message);
        }

        console.log("delivery initialized");

        console.log("Firestore updated with invoice data");
      } catch (err) {
        console.error("invoice PDF fetch failed", err.message);
      }
    } else {
      console.log("invoice: not found after 30s, abort email");
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

        if (invoicePdfBuffer) {
          attachments.push({
            filename: `facture-${count}.pdf`,
            content: invoicePdfBuffer.toString("base64"),
            encoding: "base64",
          });
        }

        for (const path of filesToAttach) {
          const [fileBuffer] = await bucket.file(path).download();
         attachments.push({
  filename: path.split("/").pop(),
  content: fileBuffer.toString("base64"),
  encoding: "base64",
});
        }

        console.log("email: attachments ready");

        if (!invoicePdfBuffer) {
          console.log("email aborted: invoice missing");
          return res.status(200).json({ received: true });
        }

        await resend.emails.send({
          from: "Wenergy <noreply@wenergy-consulting.com>",
          to: email,
          subject: `Votre commande Wenergy – ${data.quotation_number || ""}`,
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
