import axios from "axios";

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status(200).json({});
  }

  if (req.method !== "POST") {
    return res.status(405).json({ status: "error", message: "Only POST allowed" });
  }

  try {
    const { client, simulation } = req.body;

    // 🔐 Variables Odoo
    const ODOO_URL      = process.env.ODOO_URL;
    const ODOO_DB       = process.env.ODOO_DB;
    const ODOO_USER     = process.env.ODOO_USER;
    const ODOO_PASSWORD = process.env.ODOO_PASSWORD; // <-- MOT DE PASSE, PAS API KEY

    if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_PASSWORD) {
      throw new Error("Missing Odoo env variables (URL / DB / USER / PASSWORD)");
    }

    // 1) AUTH ODOO : /web/session/authenticate
    const authResp = await axios.post(
      `${ODOO_URL}/web/session/authenticate`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          db: ODOO_DB,
          login: ODOO_USER,
          password: ODOO_PASSWORD, // <-- ICI LE MOT DE PASSE
        },
        id: Date.now(),
      },
      {
        headers: { "Content-Type": "application/json" },
      }
    );

    const cookies = authResp.headers["set-cookie"];
    if (!cookies) {
      throw new Error("No session cookie returned");
    }

    const session_id = cookies
      .find((c) => c.includes("session_id"))
      ?.split(";")[0]
      ?.replace("session_id=", "");

    if (!session_id) {
      throw new Error("Session ID not found in cookies");
    }

    const cookieHeader = `session_id=${session_id}`;

    // 2) CREATE LEAD (crm.lead)
    const leadResp = await axios.post(
      `${ODOO_URL}/web/dataset/call_kw`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          model: "crm.lead",
          method: "create",
          args: [
            {
              name: `Demande simulateur – ${client.firstname} ${client.lastname}`,
              contact_name: `${client.firstname} ${client.lastname}`,
              email_from: client.email,
              phone: client.phone,
              description: JSON.stringify(simulation, null, 2),
              street: client.address,
              zip: client.zip,
              city: client.city,
              type: "opportunity",
            },
          ],
          kwargs: {},
        },
        id: Date.now(),
      },
      {
        headers: { Cookie: cookieHeader },
      }
    );

    const leadId = leadResp.data.result;
    if (!leadId) {
      throw new Error("Lead non créé");
    }

    // 3) CREATE QUOTATION (sale.order)
    const quotationResp = await axios.post(
      `${ODOO_URL}/web/dataset/call_kw`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          model: "sale.order",
          method: "create",
          args: [
            {
              partner_id: false,
              opportunity_id: leadId,
              note: "Devis généré automatiquement via simulateur Wenergy",
            },
          ],
          kwargs: {},
        },
        id: Date.now(),
      },
      {
        headers: { Cookie: cookieHeader },
      }
    );

    const quotationId = quotationResp.data.result;
    if (!quotationId) {
      throw new Error("Devis non créé");
    }

    const quotationUrl = `${ODOO_URL}/web#id=${quotationId}&model=sale.order&view_type=form`;

    return res.status(200).json({
      status: "success",
      quotation_id: quotationId,
      lead_id: leadId,
      redirect_url: quotationUrl,
    });
  } catch (err) {
    console.error("❌ ERREUR ODOO :", err.response?.data || err);
    return res.status(500).json({
      status: "error",
      detail: err.response?.data || err.toString(),
    });
  }
}
