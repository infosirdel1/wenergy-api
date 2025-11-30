import axios from "axios";

export default async function handler(req, res) {

  // -------------------------------------------------------
  // 0) CORS — indispensable pour Vercel
  // -------------------------------------------------------
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  // Réponse aux préflight OPTIONS
  if (req.method === "OPTIONS") {
    return res.status(200).json({ status: "ok" });
  }

  // -------------------------------------------------------
  // 1) Only POST
  // -------------------------------------------------------
  if (req.method !== "POST") {
    return res.status(405).json({
      status: "error",
      message: "Only POST allowed",
    });
  }

  try {
    console.log("📩 Requête reçue :", req.body);

    const { client, simulation } = req.body;

    if (!client || !simulation) {
      return res.status(400).json({
        status: "error",
        message: "Missing data",
      });
    }

    // -------------------------------------------------------
    // 2) Variables d’environnement
    // -------------------------------------------------------
    const ODOO_URL = process.env.ODOO_URL;
    const ODOO_DB = process.env.ODOO_DB;
    const ODOO_USER = process.env.ODOO_USER;
    const ODOO_API_KEY = process.env.ODOO_API_KEY;

    if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_API_KEY) {
      return res.status(500).json({
        status: "error",
        message: "Missing Odoo environment variables",
      });
    }

    // -------------------------------------------------------
    // 3) Authentification Odoo (API key = password)
    // -------------------------------------------------------
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
      },
      { withCredentials: true }
    );

    const cookies = authResp.headers["set-cookie"];
    if (!cookies) {
      return res.status(500).json({
        status: "error",
        message: "Odoo authentication failed (no session cookie)",
      });
    }

    const session_id = cookies
      .find((c) => c.includes("session_id"))
      ?.split(";")[0]
      ?.replace("session_id=", "");

    if (!session_id) {
      return res.status(500).json({
        status: "error",
        message: "Odoo session ID not found",
      });
    }

    const cookie = `session_id=${session_id}`;

    // -------------------------------------------------------
    // 4) Création opportunité CRM
    // -------------------------------------------------------
    const leadData = {
      name: `Commande Batterie – ${client.firstname} ${client.lastname}`,
      contact_name: `${client.firstname} ${client.lastname}`,
      email_from: client.email,
      phone: client.phone,
      street: client.address,
      zip: client.zip,
      city: client.city,
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
      type: "opportunity",
    };

    const leadResp = await axios.post(
      `${ODOO_URL}/web/dataset/call_kw`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          model: "crm.lead",
          method: "create",
          args: [leadData],
          kwargs: {},
        },
      },
      { headers: { Cookie: cookie } }
    );

    const leadId = leadResp.data.result;

    // -------------------------------------------------------
    // 5) Création du devis
    // -------------------------------------------------------
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
      },
      { headers: { Cookie: cookie } }
    );

    const quotationId = quotationResp.data.result;

    const quotationUrl = `${ODOO_URL}/web#id=${quotationId}&model=sale.order&view_type=form`;

    // -------------------------------------------------------
    // SUCCESS
    // -------------------------------------------------------
    return res.status(200).json({
      status: "success",
      redirect_url: quotationUrl,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      status: "error",
      message: "Server error",
      detail: error.toString(),
    });
  }
}
