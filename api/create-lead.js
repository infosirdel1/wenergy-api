import axios from "axios";

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
    // 1) EXTRACTION DES DONNÉES + MODE TEST
    // ---------------------------------------------
    const { client, simulation, order_product, test } = req.body || {};

    if (!client || !simulation) {
      return res.status(400).json({
        status: "error",
        message: "Missing client or simulation data",
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

    const cookies = authResp.headers["set-cookie"];
    if (!cookies) throw new Error("No session cookie returned");

    const session_id = cookies
      .find((c) => c.includes("session_id"))
      ?.split(";")[0]
      ?.replace("session_id=", "");

    if (!session_id) throw new Error("Session ID not found in cookies");

    const cookieHeader = `session_id=${session_id}`;

    // ---------------------------------------------
    // 4) CRÉATION LEAD
    // ---------------------------------------------
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
              partner_name: client.company || undefined,

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

    const leadId = leadResp.data.result;
    if (!leadId) throw new Error("Lead non créé");

    // ---------------------------------------------
    // 5) CRÉATION CLIENT
    // ---------------------------------------------
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
    if (!partnerId) throw new Error("Client non créé");

    // ---------------------------------------------
    // 6) CRÉATION DU DEVIS
    // ---------------------------------------------
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
              note: "« Les Conditions Générales de Vente ont été lues et acceptées lors de l’utilisation du simulateur en ligne.\nLe résultat fourni par le simulateur est une estimation basée sur une production photovoltaïque moyenne de 5 % et ne constitue en aucun cas une offre contractuelle.\nSeules les informations reprises dans le devis signé et la facture font foi. »",

            },
          ],
          kwargs: {},
        },
        id: Date.now(),
      },
      { headers: { Cookie: cookieHeader } }
    );

    const quotationId = quotationResp.data.result;

   // ---------------------------------------------
// 7) PRODUIT FINAL : NORMAL OU TEST
// ---------------------------------------------
console.log("📦 Ajout produit… (mode test =", test, ")");

// --------------------------------------------------
// 🆕 MAPPING SIMULATEUR → PRODUITS ODOO
// --------------------------------------------------
const PRODUCT_MAP = {
  venus_c: {
    odoo_product_id: 12,  // ➜ À REMPLIR avec ton ID réel
    name: "Marstek Venus C – 2.56 kWh",
  },
  venus_e: {
    odoo_product_id: 13,  // ➜ À REMPLIR avec ton ID réel
    name: "Marstek Venus E Gen 3.0 – 5.12 kWh",
  },
};

function getRealProductFromSimulator(code, qty, unitPrice) {
  const prod = PRODUCT_MAP[code];
  if (!prod) return null;

  return {
    name: prod.name,
    odoo_product_id: prod.odoo_product_id,
    quantity: qty,
    unit_price: unitPrice,
  };
}

let finalProduct = null;

if (test === true) {
  console.log("🧪 MODE TEST ACTIVÉ → produit TEST 0,5 €");

  finalProduct = {
    name: "TEST – 0,5 €",
    odoo_product_id: PRODUCT_ID_TEST,
    quantity: 1,
    unit_price: 0.5,
  };
} else {
  finalProduct = getRealProductFromSimulator(
    simulation.battery_model_raw,
    order_product.quantity,
    order_product.unit_price
  );
}

if (!finalProduct || !finalProduct.odoo_product_id) {
  throw new Error("Produit invalide (test ou réel)");
}

    // ---------------------------------------------
    // 8) AJOUT LIGNE DE VIS
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
              order_id: quotationId,
              product_id: finalProduct.odoo_product_id,
              product_uom_qty: finalProduct.quantity || 1,
              price_unit: finalProduct.unit_price || 0,
              name: finalProduct.name || "Produit",
            },
          ],
          kwargs: {},
        },
        id: Date.now(),
      },
      { headers: { Cookie: cookieHeader } }
    );

    if (!lineResp.data.result) throw new Error("Échec création ligne devis");

    // ---------------------------------------------
    // 9) URL PORTAIL POUR SIGNATURE
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
          kwargs: {},
        },
        id: Date.now(),
      },
      { headers: { Cookie: cookieHeader } }
    );

    const portalUrl = portalResp.data.result;

    // ---------------------------------------------
// 10) RÉPONSE CLIENT
// ---------------------------------------------
return res.status(200).json({
  status: "success",
  lead_id: leadId,
  partner_id: partnerId,
  quotation_id: quotationId,
  
  // ⭐ OBLIGATOIRE pour que la signature s’ouvre dans le simulateur
  url_sign: portalUrl,
});

