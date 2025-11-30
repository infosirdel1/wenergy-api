import axios from "axios";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status(200).json({ status: "ok" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      status: "error",
      message: "Only POST allowed",
    });
  }

  try {
    const { client, simulation } = req.body;

    const ODOO_URL = process.env.ODOO_URL;
    const ODOO_USER = process.env.ODOO_USER;
    const ODOO_API_KEY = process.env.ODOO_API_KEY;

    if (!ODOO_URL || !ODOO_USER || !ODOO_API_KEY) {
      return res.status(500).json({ status: "error", message: "Missing env vars" });
    }

    // 🔥 1) CREATE LEAD
    const leadData = {
      name: `Commande Batterie – ${client.firstname} ${client.lastname}`,
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
    };

    const leadResp = await axios.post(
      `${ODOO_URL}/web/dataset/call_kw`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          model: "crm.lead",
          method: "create",
          args: [leadData],   // ✅ pas de tableau dans un tableau
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

    const leadId = leadResp.data.result; // ✅ simple entier
    if (!leadId) throw new Error("Lead creation failed");

    // 🔥 2) CREATE QUOTATION
    const quotationData = {
      partner_id: false,
      opportunity_id: leadId,
      note: "Devis généré automatiquement via simulateur Wenergy",
    };

    const quotationResp = await axios.post(
      `${ODOO_URL}/web/dataset/call_kw`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          model: "sale.order",
          method: "create",
          args: [quotationData],  // ✅ pas [[...]]
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

    const quotationId = quotationResp.data.result; // ✅ simple entier
    if (!quotationId) throw new Error("Quotation creation failed");

    const quotationUrl = `${ODOO_URL}/web#id=${quotationId}&model=sale.order&view_type=form`;

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
