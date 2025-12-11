import axios from "axios";

console.log("🔥 create-lead.js chargé");

// ⭐ ID du produit test dans Odoo
const PRODUCT_ID_TEST = 9;

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
    // ---------------------------------------------
    // 1) DONNÉES REÇUES DU SIMULATEUR
    // ---------------------------------------------
    const { client, simulation, order_product, test } = req.body || {};

    if (!client || !simulation || !order_product) {
      return res.status(400).json({
        status: "error",
        message: "Missing client, simulation or product data",
      });
    }

    // ---------------------------------------------
    // 2) VARIABLES ODOO
    // ---------------------------------------------
    const ODOO_URL      = process.env.ODOO_URL;
    const ODOO_DB       = process.env.ODOO_DB;
    const ODOO_USER     = process.env.ODOO_USER;
    const ODOO_PASSWORD = process.env.ODOO_PASSWORD;

    if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_PASSWORD) {
      throw new Error("Missing Odoo env variables");
    }

    // ---------------------------------------------
    // 3) AUTHENTIFICATION ODOO
    // ---------------------------------------------
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

    const cookies = authResp.headers["set-cookie"];
    if (!cookies) throw new Error("No session cookie returned");

    const session_id = cookies
      .find((c) => c.includes("session_id"))
      ?.split(";")[0]
      ?.replace("session_id=", "");

    if (!session_id) throw new Error("Session ID not found");

    const cookieHeader = `session_id=${session_id}`;

    // ---------------------------------------------
    // 4) CRÉATION DU LEAD
    // ---------------------------------------------
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
              partner_name: client.company || undefined,

              description: `
TVA : ${client.vat || ""}

Simulation :
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

    const leadId = leadResp.data.result;
    if (!leadId) throw new Error("Lead non créé");

    // ---------------------------------------------
    // 5) CRÉATION CLIENT (PARTNER)
    // ---------------------------------------------
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
              name: client.company || `${client.firstname} ${client.lastname}`,
              email: client.email,
              phone: client.phone,
              street: client.address,
              zip: client.zip,
              city: client.city,
              type: "contact",
              customer_rank: 1,
              vat: client.vat || undefined,
            },
          ],
          kwargs: {},
        },
        id: Date.now(),
      },
      { headers: { Cookie: cookieHeader } }
    );

    const partnerId = partnerResp.data.result;
    if (!partnerId) throw new Error("Partner non créé");

 // ---------------------------------------------
// 6) CRÉATION DU DEVIS (FIX)
// ---------------------------------------------
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
          partner_invoice_id: partnerId,
          partner_shipping_id: partnerId,

          pricelist_id: 1,
          payment_term_id: false,
          team_id: 1,

          note:
            "Les CGV ont été acceptées dans le simulateur.\n" +
            "Les résultats sont indicatifs et non contractuels.",
        },
      ],
      kwargs: {}   // OBLIGATOIRE Odoo 19
    },
    id: Date.now(),
  },
  { headers: { Cookie: cookieHeader } }
);

// 🔥 IL FAUT ABSOLUMENT CETTE LIGNE AVANT LE IF !
const quotationId = quotationResp.data.result;

// 🔥 DEBUG
if (!quotationId) {
  console.log("❌ DEBUG ODOO — sale.order.create response:");
  console.log(JSON.stringify(quotationResp.data, null, 2));
  throw new Error("Devis non créé");
}

    // ---------------------------------------------
    // 7) MODE TEST OU PRODUIT RÉEL
    // ---------------------------------------------
    let productId = order_product.odoo_product_id;
    let productName = order_product.name;
    let qty = order_product.quantity;
    let unitPrice = order_product.unit_price;

    if (test === true) {
      productId = PRODUCT_ID_TEST;
      productName = "TEST – 0,5 €";
      qty = 1;
      unitPrice = 0.5;
    }

   // ---------------------------------------------
// 8) AJOUT LIGNE DEVIS (FIX ODOO 19)
// ---------------------------------------------
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
          order_id: parseInt(quotationId, 10),
          product_id: parseInt(productId, 10),
          product_uom_qty: qty,
          price_unit: unitPrice,
          name: productName,
        },
      ],
      kwargs: {} // 🔥 obligatoire en Odoo 19 (comme pour le lead et le partner)
    },
    id: Date.now(),
  },
  { headers: { Cookie: cookieHeader } }
);

// Optionnel : petit debug pour vérifier
console.log("DEBUG sale.order.line.create =>", JSON.stringify(lineResp.data, null, 2));


   // ---------------------------------------------
// 9) URL PORTAIL SIGNATURE
// ---------------------------------------------
const portalResp = await axios.post(
  `${ODOO_URL}/web/dataset/call_kw`,
  {
    jsonrpc: "2.0",
    method: "call",
    params: {
      model: "sale.order",
      method: "get_portal_url",
      args: [quotationId],
      kwargs: {}   // 🔥 obligatoire en Odoo 19
    },
    id: Date.now(),
  },
  { headers: { Cookie: cookieHeader } }
);

// 🔥 DEBUG LOGS POUR COMPRENDRE LE PROBLÈME
console.log("DEBUG PORTALRESP ===>", JSON.stringify(portalResp.data, null, 2));
console.log("DEBUG PORTAL_URL RAW ===>", portalResp.data.result);

const raw = portalResp.data.result;
const portal_url = raw ? `${ODOO_URL}${raw}` : null;

    // ---------------------------------------------
    // 10) RÉPONSE → SIMULATEUR
    // ---------------------------------------------
    return res.status(200).json({
      status: "success",
      lead_id: leadId,
      partner_id: partnerId,
      quotation_id: quotationId,
      portal_url,
    });

  } catch (err) {
    console.error("❌ ERREUR ODOO :", err.response?.data || err);
    return res.status(500).json({
      status: "error",
      detail: err.response?.data || err.toString(),
    });
  }
}

