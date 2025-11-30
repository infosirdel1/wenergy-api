import axios from "axios";

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") return res.status(200).json({});

  try {
    console.log("📩 Incoming body:", req.body);

    const { client, simulation } = req.body;

    // 🌍 ENV VARIABLES
    const ODOO_URL = process.env.ODOO_URL;
    const ODOO_DB = process.env.ODOO_DB;
    const ODOO_USER = process.env.ODOO_USER;
    const ODOO_PASSWORD = process.env.ODOO_PASSWORD; // 🔥 IMPORTANT

    if (!ODOO_PASSWORD) {
      throw new Error("❌ ODOO_PASSWORD manquant dans Vercel !");
    }

    console.log("🔐 Auth →", `${ODOO_URL}/web/session/authenticate`);

    // 1️⃣ AUTH ODOO → GET session_id
    const authResp = await axios.post(
      `${ODOO_URL}/web/session/authenticate`,
      {
        jsonrpc: "2.0",
        method: "call",
        id: Date.now(),
        params: {
          db: ODOO_DB,
          login: ODOO_USER,
          password: ODOO_PASSWORD,
        },
      },
      { withCredentials: true }
    );

    console.log("🔐 Auth Response:", authResp.data);

    const cookies = authResp.headers["set-cookie"];
    if (!cookies) throw new Error("❌ Aucun cookie retourné par Odoo.");

    const session_id = cookies
      .find((c) => c.includes("session_id"))
      ?.split(";")[0]
      ?.replace("session_id=", "");

    if (!session_id) throw new Error("❌ Session ID introuvable.");

    const cookieHeader = `session_id=${session_id}`;
    console.log("🍪 Session ID:", session_id);

    // 2️⃣ CREATE LEAD
    console.log("📝 Création du lead…");

    const leadResp = await axios.post(
      `${ODOO_URL}/web/dataset/call_kw`,
      {
        jsonrpc: "2.0",
        method: "call",
        id: Date.now(),
        params: {
          model: "crm.lead",
          method: "create",
          args: [
            {
              name: `Simulation – ${client?.nom || "Client"}`,
              contact_name: client?.nom || "",
              email_from: client?.email || "",
              phone: client?.telephone || "",
              description: JSON.stringify(simulation, null, 2),
            },
          ],
          kwargs: {},
        },
      },
      { headers: { Cookie: cookieHeader } }
    );

    const leadId = leadResp.data.result;
    if (!leadId) throw new Error("❌ Lead non créé.");

    console.log("🟢 Lead créé :", leadId);

    // 3️⃣ CREATE QUOTATION
    console.log("📄 Création du devis…");

    const quotationResp = await axios.post(
      `${ODOO_URL}/web/dataset/call_kw`,
      {
        jsonrpc: "2.0",
        method: "call",
        id: Date.now(),
        params: {
          model: "sale.order",
          method: "create",
          args: [
            {
              partner_id: false, // pas de fiche client encore
              opportunity_id: leadId,
              note: "Devis généré automatiquement via le simulateur Wenergy",
            },
          ],
          kwargs: {},
        },
      },
      { headers: { Cookie: cookieHeader } }
    );

    const quotationId = quotationResp.data.result;
    if (!quotationId) throw new Error("❌ Devis non créé.");

    console.log("🟢 Devis créé :", quotationId);

    const quotationUrl = `${ODOO_URL}/web#id=${quotationId}&model=sale.order&view_type=form`;

    return res.status(200).json({
      status: "success",
      quotation_id: quotationId,
      lead_id: leadId,
      redirect_url: quotationUrl,
    });
  } catch (err) {
    console.error("❌ ERREUR :", err.response?.data || err);
    return res.status(500).json({
      status: "error",
      detail: err.response?.data || err.toString(),
    });
  }
}
