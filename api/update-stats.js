import axios from "axios";

export default async function handler(req, res) {

  /* ============================================================
     S.1 – CORS & MÉTHODE
     ============================================================ */

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ status: "error", message: "Only POST allowed" });
  }

  try {

    /* ============================================================
       S.2 – INPUT FRONT
       ============================================================ */

    const {
      client,
      simulation,
      order_products,
      test
    } = req.body || {};

    if (!client || !simulation) {
      return res.status(400).json({ status: "error", message: "Missing client or simulation" });
    }

    const session_id = simulation.session_id || null;
    const consumption_input = simulation.consumption_input || null;

    /* ============================================================
       S.3 – ENV ODOO
       ============================================================ */

    const ODOO_URL      = process.env.ODOO_URL;
    const ODOO_DB       = process.env.ODOO_DB;
    const ODOO_USER     = process.env.ODOO_USER;
    const ODOO_PASSWORD = process.env.ODOO_PASSWORD;

    if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_PASSWORD) {
      throw new Error("Missing Odoo env variables");
    }

    /* ============================================================
       S.4 – AUTH ODOO
       ============================================================ */

    const authResp = await axios.post(
      `${ODOO_URL}/web/session/authenticate`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          db: ODOO_DB,
          login: ODOO_USER,
          password: ODOO_PASSWORD
        },
        id: Date.now()
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const cookies = authResp.headers["set-cookie"];
    const sessionCookie = cookies?.find(c => c.includes("session_id"));
    if (!sessionCookie) throw new Error("No Odoo session cookie");

    const cookieHeader = sessionCookie.split(";")[0];

    /* ============================================================
       S.5 – CONSTRUCTION DES VALEURS LEAD / ANALYTICS
       ============================================================ */

    const values = {
      // identification session
      x_studio_session_id_1: session_id,

      // données client
      x_studio_firstname: client.firstname,
      x_studio_lastname: client.lastname,
      x_studio_email: client.email,
      x_studio_phone: client.phone || null,

      // 🔥 DONNÉE MÉTIER CLÉ
      x_studio_consumption_input: consumption_input,

      // méta
      x_studio_event_log: "[lead created via simulator]"
    };

    /* ============================================================
       S.6 – CRÉATION DU LEAD (x_analytics ou crm.lead selon ton modèle)
       ============================================================ */

    const createResp = await axios.post(
      `${ODOO_URL}/web/dataset/call_kw`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          model: "x_analytics",
          method: "create",
          args: [values],
          kwargs: {}
        },
        id: Date.now()
      },
      { headers: { Cookie: cookieHeader } }
    );

    const leadId = createResp.data?.result;

    if (!leadId) {
      return res.status(500).json({ status: "error", message: "Lead creation failed" });
    }

    /* ============================================================
       S.7 – RÉPONSE
       ============================================================ */

    return res.status(200).json({
      status: "success",
      lead_id: leadId
    });

  } catch (err) {

    console.error("❌ create-lead error:", err.response?.data || err);

    return res.status(500).json({
      status: "error",
      detail: err.response?.data || err.toString()
    });
  }
}
