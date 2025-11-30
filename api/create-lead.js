import axios from "axios";

export default async function handler(req, res) {
  // CORS de base
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status(200).json({});
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      status: "error",
      message: "Only POST allowed",
    });
  }

  try {
    const { client, simulation } = req.body || {};

    if (!client || !simulation) {
      return res.status(400).json({
        status: "error",
        message: "Missing client or simulation data",
      });
    }

    const ODOO_URL      = process.env.ODOO_URL;
    const ODOO_DB       = process.env.ODOO_DB;
    const ODOO_USER     = process.env.ODOO_USER;
    const ODOO_PASSWORD = process.env.ODOO_PASSWORD; // ✅ MOT DE PASSE, PAS API KEY

    if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_PASSWORD) {
      throw new Error("Missing Odoo env variables (ODOO_URL / ODOO_DB / ODOO_USER / ODOO_PASSWORD)");
    }

    // 1) AUTH ODOO → /web/session/authenticate
    console.log("🔐 Auth Odoo →", ODOO_URL, ODOO_DB, ODOO_USER);

    const authResp = await axios.post(
      `${ODOO_URL}/web/session/authenticate`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          db: ODOO_DB,
          login: ODOO_USER,
          password: ODOO_PASSWORD, // ✅ ICI : MOT DE PASSE
        },
        id: Date.now(),
      },
      {
        headers: { "Content-Type": "application/json" },
      }
    );

    console.log("🔐 Auth response:", authResp.data);

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
    console.log("🍪 Session ID:", session_id);

    // 2) CREATE LEAD (crm.lead)
    console.log("📝 Création du lead…");

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
              street: client.address,
              zip: client.zip,
              city: client.city,
              type: "opportunity",
              description: `
Simulation Wenergy

Consommation : ${simulation.consumption}
Modèle : ${simulation.battery_model_name}
Capacité totale : ${simulation.total_capacity} kWh
Batteries : ${simulation.battery_count}
PV : ${simulation.has_pv}
Fournisseur : ${simulation.supplier}

Résumé :
${simulation.summary_html}

Payback :
${simulation.payback_text}
              `,
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

    console.log("📝 Lead response:", leadResp.data);

    const leadId = leadResp.data.result;
    if (!leadId) {
      throw new Error("Lead non créé (pas d'ID retourné par Odoo)");
    }

    // 3) CREATE QUOTATION (sale.order)
    console.log("📄 Création du devis…");

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

    console.log("📄 Devis response:", quotationResp.data);

    const quotationId = quotationResp.data.result;
    if (!quotationId) {
      throw new Error("Devis non créé (pas d'ID retourné par Odoo)");
    }

    const quotationUrl = `${ODOO_URL}/web#id=${quotationId}&model=sale.order&view_type=form`;

    return res.status(200).json({
      status: "success",
      lead_id: leadId,
      quotation_id: quotationId,
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
