import axios from "axios";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") return res.status(200).json({});

  try {
    const { client, simulation } = req.body;

    const ODOO_URL = process.env.ODOO_URL;
    const ODOO_DB = process.env.ODOO_DB;
    const ODOO_USER = process.env.ODOO_USER;
    const ODOO_API_KEY = process.env.ODOO_API_KEY;

    // 1️⃣ AUTH ODOO → session_id obligatoire
    const authResp = await axios.post(
      `${ODOO_URL}/web/session/authenticate`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          db: ODOO_DB,
          login: ODOO_USER,
          password: ODOO_API_KEY,
        },
        id: Date.now()
      }
    );

    const cookies = authResp.headers["set-cookie"];
    if (!cookies) throw new Error("No session cookie from Odoo");

    const session_id = cookies
      .find(c => c.includes("session_id"))
      ?.split(";")[0]
      ?.replace("session_id=", "");

    if (!session_id) throw new Error("Session ID not found");

    const cookieHeader = `session_id=${session_id}`;

    // 2️⃣ CREATE LEAD
    const leadResp = await axios.post(
      `${ODOO_URL}/web/dataset/call_kw`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          model: "crm.lead",
          method: "create",
          args: [{
            name: `Commande Batterie – ${client.firstname} ${client.lastname}`,
            contact_name: `${client.firstname} ${client.lastname}`,
            email_from: client.email,
            phone: client.phone,
            street: client.address,
            zip: client.zip,
            city: client.city,
            type: "opportunity",
            description: `
Consommation : ${simulation.consumption}
Modèle : ${simulation.battery_model_name}
Capacité : ${simulation.total_capacity} kWh
Payback : ${simulation.payback_text}
            `,
          }],
          kwargs: {},
        },
        id: Date.now(),
      },
      {
        headers: {
          Cookie: cookieHeader
        }
      }
    );

    const leadId = leadResp.data.result;
    if (!leadId) throw new Error("Lead creation failed");

    // 3️⃣ CREATE QUOTATION
    const quotationResp = await axios.post(
      `${ODOO_URL}/web/dataset/call_kw`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          model: "sale.order",
          method: "create",
          args: [{
            partner_id: false,
            opportunity_id: leadId,
            note: "Devis généré automatiquement via simulateur Wenergy"
          }],
          kwargs: {},
        },
        id: Date.now(),
      },
      {
        headers: {
          Cookie: cookieHeader
        }
      }
    );

    const quotationId = quotationResp.data.result;
    if (!quotationId) throw new Error("Quotation creation failed");

    const quotationUrl = `${ODOO_URL}/web#id=${quotationId}&model=sale.order&view_type=form`;

    return res.status(200).json({
      status: "success",
      redirect_url: quotationUrl
    });

  } catch (err) {
    console.error("❌ ERREUR ODOO :", err.response?.data || err);
    return res.status(500).json({
      status: "error",
      detail: err.response?.data || err.toString()
    });
  }
}
