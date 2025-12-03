import axios from "axios";

export default async function handler(req, res) {
  // --- CORS ---
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
    
    const { order_product } = req.body;

    if (!client || !simulation) {
      return res.status(400).json({
        status: "error",
        message: "Missing client or simulation data",
      });
    }

    const ODOO_URL      = process.env.ODOO_URL;
    const ODOO_DB       = process.env.ODOO_DB;
    const ODOO_USER     = process.env.ODOO_USER;
    const ODOO_PASSWORD = process.env.ODOO_PASSWORD;

    if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_PASSWORD) {
      throw new Error("Missing Odoo env variables");
    }

    // 1) AUTH ODOO
    console.log("🔐 Auth Odoo →", ODOO_URL, ODOO_DB, ODOO_USER);

    const authResp = await axios.post(
      `${ODOO_URL}/web/session/authenticate`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          db: ODOO_DB,
          login: ODOO_USER,
          password: ODOO_PASSWORD,
        },
        id: Date.now(),
      },
      { headers: { "Content-Type": "application/json" } }
    );

    console.log("🔐 Auth response:", authResp.data);

    const cookies = authResp.headers["set-cookie"];
    if (!cookies) throw new Error("No session cookie returned");

    const session_id = cookies
      .find((c) => c.includes("session_id"))
      ?.split(";")[0]
      ?.replace("session_id=", "");

    if (!session_id) throw new Error("Session ID not found in cookies");

    const cookieHeader = `session_id=${session_id}`;
    console.log("🍪 Session ID:", session_id);

    // 2) CREATE LEAD
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
          partner_name: client.company || undefined, // OK
          // ❌ NE PAS METTRE "vat" ICI, ODOO LE REFUSE
          
          description: `
TVA : ${client.vat || ""}

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
  { headers: { Cookie: cookieHeader } }
);

    console.log("📝 Lead response:", leadResp.data);

    const leadId = leadResp.data.result;
    if (!leadId) throw new Error("Lead non créé");

    // 3) CREATE PARTNER (res.partner)
    console.log("👤 Création du client…");

    const partnerResp = await axios.post(
      `${ODOO_URL}/web/dataset/call_kw`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          model: "res.partner",
          method: "create",
          args: [
            {
              name: client.company || `${client.firstname} ${client.lastname}`, // société si présente
              email: client.email,
              phone: client.phone,
              street: client.address,
              zip: client.zip,
              city: client.city,
              type: "contact",
              customer_rank: 1,
              vat: client.vat || undefined, // ✅ TVA sur le partenaire
            },
          ],
          kwargs: {},
        },
        id: Date.now(),
      },
      { headers: { Cookie: cookieHeader } }
    );

    console.log("👤 Partner response:", partnerResp.data);

    const partnerId = partnerResp.data.result;
    if (!partnerId) {
      throw new Error("Client non créé (partner_id manquant)");
    }

    // 4) CREATE QUOTATION (sale.order)
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
              partner_id: partnerId,
              note: "« Les conditions générales de vente ont été acceptées au moment de l’action “Commander & accepter”. Les données présentées dans le simulateur reposent sur des projections d’évolution du prix de l’électricité — incluant notamment une hypothèse d’inflation annuelle de 5 % — ainsi que sur les caractéristiques techniques certifiées du matériel sélectionné. Ces informations ont pour seul objectif de fournir une estimation réaliste et cohérente, sans toutefois constituer une offre contractuelle au sens juridique du terme. »",
            },
          ],
          kwargs: {},
        },
        id: Date.now(),
      },
      { headers: { Cookie: cookieHeader } }
    );

    console.log("📄 Devis response:", quotationResp.data);

    const quotationId = quotationResp.data.result;

    // 🔗 Récupération du lien portail pour la signature
console.log("🔗 Récupération URL portail…");

const portalResp = await axios.post(
  `${ODOO_URL}/web/dataset/call_kw`,
  {
    jsonrpc: "2.0",
    method: "call",
    params: {
      model: "sale.order",
      method: "get_portal_url",
      args: [quotationId],
      kwargs: {},
    },
    id: Date.now(),
  },
  { headers: { Cookie: cookieHeader } }
);

console.log("🔗 URL portail:", portalResp.data);

const portalUrl = portalResp.data.result;
if (!portalUrl) throw new Error("Impossible de récupérer l’URL portail Odoo");

    if (!quotationId) throw new Error("Devis non créé (pas d'ID retourné par Odoo)");

    const quotationUrl = `${ODOO_URL}/web#id=${quotationId}&model=sale.order&view_type=form`;

  // -------------------------------------------------------
// ⭐ 5) AJOUT DE LA LIGNE PRODUIT DANS LE DEVIS ⭐
// -------------------------------------------------------
console.log("📦 Ajout de la ligne produit…");
console.log("💥 order_product reçu :", order_product);

// Validation basique
if (!order_product || !order_product.odoo_product_id) {
  throw new Error("No product code provided (order_product vide ou invalide)");
}

const lineResp = await axios.post(
  `${ODOO_URL}/web/dataset/call_kw`,
  {
    jsonrpc: "2.0",
    method: "call",
    params: {
      model: "sale.order.line",
      method: "create",
      args: [
        {
          order_id: quotationId,
          product_id: order_product.odoo_product_id,   // ⭐ DIRECT
          product_uom_qty: order_product.quantity || 1,
          price_unit: order_product.unit_price || 0,   // ⭐ Optionnel
          name: order_product.name || "Produit",
        },
      ],
      kwargs: {},
    },
    id: Date.now(),
  },
  { headers: { Cookie: cookieHeader } }
);

console.log("📦 Ligne produit ajoutée :", lineResp.data);

if (!lineResp.data.result) {
  throw new Error("Échec création ligne devis");
}

   return res.status(200).json({
  status: "success",
  lead_id: leadId,
  partner_id: partnerId,
  quotation_id: quotationId,
  redirect_url: quotationUrl,
  portal_url: portalUrl
});

  } catch (err) {
    console.error("❌ ERREUR ODOO :", err.response?.data || err);
    return res.status(500).json({
      status: "error",
      detail: err.response?.data || err.toString(),
    });
  }
}
