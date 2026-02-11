import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// Vérification du fonctionnement
app.get("/", (req, res) => {
  res.send("Wenergy API opérationnelle");
});

// 🔥 ROUTE : créer opportunité + devis dans Odoo
app.post("/create-lead", async (req, res) => {
  try {
    const { client, simulation } = req.body;

    // Vérification basique
    if (!client || !simulation) {
      return res.status(400).json({ status: "error", message: "Data missing" });
    }

    // Informations Odoo
    const ODOO_URL = process.env.ODOO_URL;      
    const ODOO_DB  = process.env.ODOO_DB;       
    const ODOO_USER = process.env.ODOO_USER;    
    const ODOO_API_KEY = process.env.ODOO_API_KEY;

    // ===============================
    // 1️⃣ AUTHENTIFICATION ODOO
    // ===============================
    const auth = {
      db: ODOO_DB,
      login: ODOO_USER,
      password: ODOO_API_KEY
    };

    const authResp = await axios.post(`${ODOO_URL}/web/session/authenticate`, {
      jsonrpc: "2.0",
      method: "call",
      params: auth
    });

    const session_id = authResp.headers["set-cookie"]
      .find(c => c.includes("session_id"))
      .split(";")[0]
      .replace("session_id=", "");

    const cookie = `session_id=${session_id}`;

    // ==================================
    // 2️⃣ CRÉATION OPPORTUNITÉ CRM
    // ==================================
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

    // ==================================
    // 3️⃣ CRÉATION D'UN DEVIS
    // ==================================
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

    // URL du devis
    const quotationUrl = `${ODOO_URL}/web#id=${quotationId}&model=sale.order&view_type=form`;

    // ==================================
    // 🔥 SUCCESS
    // ==================================
    res.json({
      status: "success",
      redirect_url: quotationUrl
    });

  } catch (err) {
    console.error("API ERROR:", err);
    res.status(500).json({
      status: "error",
      message: "Server error",
      detail: err.toString()
    });
  }
});

export default app;
