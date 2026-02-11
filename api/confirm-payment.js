import admin from "firebase-admin";
import axios from "axios";

// 🔐 Initialisation Firebase (OBLIGATOIRE) — avec garde serverless
if (!admin.apps.length) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_BASE64 is missing");
  }

  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8")
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const firestore = admin.firestore();

export default async function handler(req, res) {
  try {
    const { count, email } = req.query;

    if (!count || !email) {
      return res.status(400).json({ error: "Missing parameters", need: ["count", "email"] });
    }

    // 🔎 Lookup Firestore
    const snap = await firestore
      .collection("requests")
      .where("platform_count", "==", Number(count))
      .where("client.email", "==", email)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({ error: "Request not found", count: Number(count), email });
    }

    const data = snap.docs[0].data();

    if (data.payment_status !== "paid") {
      return res.status(403).json({ error: "Payment not completed", payment_status: data.payment_status });
    }

    if (!data.quotation_id) {
      return res.status(500).json({ error: "Missing quotation_id in Firestore" });
    }

    // ✅ Vérif env Odoo (sinon tu restes aveugle)
    const { ODOO_URL, ODOO_DB, ODOO_USER, ODOO_PASSWORD } = process.env;
    if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_PASSWORD) {
      return res.status(500).json({ error: "Missing Odoo env variables" });
    }

    // 🔐 Auth Odoo
    const authResp = await axios.post(
      `${ODOO_URL}/web/session/authenticate`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_PASSWORD },
        id: Date.now(),
      },
      { headers: { "Content-Type": "application/json" }, timeout: 15000 }
    );

    // Odoo peut répondre en JSON-RPC erreur même si HTTP 200
    if (authResp?.data?.error) {
      return res.status(500).json({
        error: "Odoo authenticate JSON-RPC error",
        detail: authResp.data.error,
      });
    }

    const cookies = authResp.headers?.["set-cookie"] || authResp.headers?.["Set-Cookie"];
    const session_id = Array.isArray(cookies)
      ? cookies.find((c) => c.includes("session_id="))?.split(";")[0]?.replace("session_id=", "")
      : undefined;

    if (!session_id) {
      return res.status(500).json({
        error: "Odoo authentication failed (no session_id cookie)",
        debug_headers: Object.keys(authResp.headers || {}),
      });
    }

    const cookieHeader = `session_id=${session_id}`;

    // 📄 Récupération PDF (méthode la plus fiable)
    const pdfUrl = `${ODOO_URL}/report/pdf/sale.report_saleorder/${data.quotation_id}`;

    const pdfResp = await axios.get(pdfUrl, {
      responseType: "arraybuffer",
      headers: { Cookie: cookieHeader },
      timeout: 20000,
      maxRedirects: 0, // si ça redirect login -> on le voit
      validateStatus: (s) => s >= 200 && s < 400,
    });

    const contentType = String(pdfResp.headers?.["content-type"] || "");

    // Si Odoo te renvoie HTML (login) au lieu du PDF
    if (!contentType.includes("application/pdf")) {
      const preview = Buffer.from(pdfResp.data || "").toString("utf8").slice(0, 400);
      return res.status(500).json({
        error: "Odoo did not return a PDF",
        pdfUrl,
        status: pdfResp.status,
        contentType,
        preview,
      });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=devis-${count}.pdf`);
    return res.status(200).send(Buffer.from(pdfResp.data));

  } catch (err) {
    // ✅ On renvoie la vraie erreur (sinon tu restes aveugle)
    const detail =
      err?.response?.data
        ? (typeof err.response.data === "string" ? err.response.data : err.response.data)
        : (err?.message || String(err));

    return res.status(500).json({
      error: "confirm-payment failed",
      detail,
    });
  }
}
