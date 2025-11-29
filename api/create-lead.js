import axios from "axios";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { client, simulation } = req.body;

    if (!client || !simulation) {
      return res.status(400).json({ status: "error", message: "Data missing" });
    }

    const ODOO_URL = process.env.ODOO_URL;
    const ODOO_DB = process.env.ODOO_DB;
    const ODOO_USER = process.env.ODOO_USER;
    const ODOO_API_KEY = process.env.ODOO_API_KEY;

    // Auth Odoo
    const authResp = await axios.post(`${ODOO_URL}/web/session/authenticate`, {
      jsonrpc: "2.0",
      method: "call",
      params: {
        db: ODOO_DB,
        login: ODOO_USER,
        password: ODOO_API_KEY
      }
    });

    const sessionCookie = authResp.headers["set-cookie"]
      ?.find(c => c.includes("session_id"))
      ?.split(";")[0];

    if (!sessionCookie) {
      return res.status(500).json({ error: "No session ID returned by Odoo" });
    }

    const cookie = sessionCookie;

    // Créer lead
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
      type: "opportunity"
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
          kwargs: {}
        }
      },
      { headers: { Cookie: cookie } }
    );

    const leadId = leadResp.data.result;

    // Créer le devis
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
          kwargs: {}
        }
      },
      { headers: { Cookie: cookie } }
    );

    const quotationId = quotationResp.data.result;
    const quotationUrl = `${ODOO_URL}/web#id=${quotationId}&model=sale.order&view_type=form`;

    res.json({
      status: "success",
      redirect_url: quotationUrl
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
}
