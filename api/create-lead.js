import axios from "axios";

export default async function handler(req, res) {

  // -------------------------------------------------------
  // 0) CORS
  // -------------------------------------------------------
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status(200).json({ status: "ok" });
  }

  // Only POST
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
    // 1) Variables Odoo
    // -------------------------------------------------------
    const ODOO_URL = process.env.ODOO_URL;
    const ODOO_USER = process.env.ODOO_USER;      // email
    const ODOO_API_KEY = process.env.ODOO_API_KEY; // API key

    if (!ODOO_URL || !ODOO_USER || !ODOO_API_KEY) {
      return res.status(500).json({
        status: "error",
        message: "Missing Odoo environment variables",
      });
    }

    // -------------------------------------------------------
    // 2) Création de l’opportunité (API KEY = password)
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
          args: [ [leadData] ],
          kwargs: {},
        },
        id: Date.now(),
      },
      {
        auth: {
          username: ODOO_USER,
          password: ODOO_API_KEY,
        },
      }
    );

    const leadId =
  (Array.isArray(leadResp.data.result) 
    ? leadResp.data.result[0] 
    : leadResp.data.result.id);

    // -------------------------------------------------------
    // 3) Création du devis (sale.order)
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
            [
              {
                partner_id: false,
                opportunity_id: leadId,
                note: "Devis généré automatiquement via simulateur Wenergy",
              },
            ],
          ],
          kwargs: {},
        },
        id: Date.now(),
      },
      {
        auth: {
          username: ODOO_USER,
          password: ODOO_API_KEY,
        },
      }
    );

    const quotationId =
  (Array.isArray(quotationResp.data.result)
    ? quotationResp.data.result[0]
    : quotationResp.data.result.id);

    const quotationUrl = `${ODOO_URL}/web#id=${quotationId}&model=sale.order&view_type=form`;

    // -------------------------------------------------------
    // SUCCESS
    // -------------------------------------------------------
    return res.status(200).json({
      status: "success",
      redirect_url: quotationUrl,
    });

  } catch (error) {
    console.error("❌ ERREUR ODOO :", error?.response?.data || error);
    return res.status(500).json({
      status: "error",
      message: "Server error",
      detail: error?.response?.data || error.toString(),
    });
  }
}
