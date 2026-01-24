import axios from "axios";
import admin from "firebase-admin";

if (!process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  throw new Error("FIREBASE_SERVICE_ACCOUNT_BASE64 is missing");
}

const serviceAccount = JSON.parse(
  Buffer.from(
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
    "base64"
  ).toString("utf8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const firestore = admin.firestore();

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
const body = req.body || {};

const client         = body.client;
const simulation     = body.simulation;
const order_products = body.order_products;
const test           = body.test;

// ✅ DEBUG HARD — ce que reçoit vraiment l’API
console.log("========== CREATE-LEAD INPUT ==========");
console.log("client =", JSON.stringify(client, null, 2));
console.log("simulation =", JSON.stringify(simulation, null, 2));
console.log("order_products =", JSON.stringify(order_products, null, 2));

const debugLines = (order_products || []).map(l => ({
  odoo_product_id: l?.odoo_product_id,
  quantity: l?.quantity,
  unit_price_ht: l?.unit_price_ht,
}));
console.log("order_products (lines) =", JSON.stringify(debugLines, null, 2));
console.log("=======================================");

if (!client || !simulation || !Array.isArray(order_products)) {
  return res.status(400).json({
    status: "error",
    message: "Missing client, simulation or order_products",
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
    // 4) CRÉATION CLIENT (PARTNER)
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
    // 5) CRÉATION DU LEAD
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
              partner_id: partnerId,
              partner_name: client.company || undefined,
              x_studio_consumption: Number(simulation.consumption) || 0,
              x_studio_capacity: Number(simulation.total_capacity) || 0,
              x_studio_invest_ttc: Number(simulation.invest_ttc) || 0,
              x_studio_preference_de_livraison: client.delivery_pref || "",

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
          
          x_studio_preference_de_livraison: client.delivery_pref || "",

          note:
            "Le client reconnaît avoir lu, compris et accepté l’intégralité des Conditions Générales de Vente applicables. Les informations, estimations, projections et résultats fournis par le simulateur sont strictement indicatifs. Ils ne constituent ni une offre commerciale, ni une proposition contractuelle, ni un engagement, ni une garantie de résultat ou de performance. Les données produites par le simulateur reposent exclusivement sur les informations disponibles au moment du calcul et ne sauraient engager la responsabilité de Wenergy. Aucune relation contractuelle n’est créée, modifiée ou interprétée à partir du simulateur : seule l’acquisition effective d’un produit ou service Wenergy constitue un engagement contractuel entre les parties.",
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
// 8) AJOUT DES LIGNES DE DEVIS (HT)
// ---------------------------------------------
const productsToCreate = test === true
  ? [{ odoo_product_id: PRODUCT_ID_TEST, quantity: 1, unit_price_ht: 0.5 }]
  : order_products;

for (const item of productsToCreate) {

  const productId = Number(item.odoo_product_id);
  const qty       = Number(item.quantity);
  const unitPrice = Number(item.unit_price_ht);

  if (
    !Number.isFinite(productId) ||
    !Number.isFinite(qty) ||
    qty <= 0 ||
    !Number.isFinite(unitPrice) ||
    unitPrice < 0
  ) {
    console.error("INVALID ORDER LINE:", item);
    throw new Error("Invalid order_products line");
  }

  await axios.post(
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
            product_id: productId,
            product_uom_qty: qty,
            price_unit: unitPrice,
          },
        ],
        kwargs: {}
      },
      id: Date.now(),
    },
    { headers: { Cookie: cookieHeader } }
  );
}

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
console.log("DEBUG PORTAL_URL RAW ===>", portalResp.data.result);

const raw = portalResp.data.result;
const portal_url = raw ? `${ODOO_URL}${raw}` : null;


// ---------------------------------------------
// 10) SOURCE PRODUITS (order_products) — MAPPING ODOO
// ---------------------------------------------
let batteryCount = 0;
let panelCount = 0;

for (const p of order_products || []) {
  const qty = Number(p.quantity) || 0;
  const pid = Number(p.odoo_product_id);

  // 🔋 Batteries (IDs 4 et 5)
  if (pid === 4 || pid === 5) {
    batteryCount += qty;
  }

  // ☀️ Panneaux (ID 16)
  if (pid === 16) {
    panelCount += qty;
  }
}

console.log("[FS FINAL] batteryCount =", batteryCount);
console.log("[FS FINAL] panelCount   =", panelCount);


    
// ---------------------------------------------
// 11) WRITE FIRESTORE + COUNT (SAFE SERVERLESS)
// ---------------------------------------------
try {
  await Promise.race([

    firestore.runTransaction(async (tx) => {

      // ===== COMPTEUR GLOBAL =====
      const counterRef = firestore.collection("meta").doc("counters");
      const counterSnap = await tx.get(counterRef);

      const current =
        counterSnap.exists && Number.isFinite(counterSnap.data()?.requests)
          ? counterSnap.data().requests
          : 0;

      const next = current + 1;

      // 🔢 update compteur
      tx.set(counterRef, { requests: next }, { merge: true });

      // ===== TYPE TRAVAUX (RÈGLE MÉTIER VALIDÉE) =====
      const workType = panelCount > 0 ? "pv" : "battery";

      // ===== DEBUG =====
      console.log("[FS] batteryCount =", batteryCount);
      console.log("[FS] panelCount   =", panelCount);
      console.log("[FS] workType     =", workType);

      // ===== CRÉATION REQUEST =====
      const requestRef = firestore.collection("requests").doc();

      tx.set(requestRef, {
        created_at: new Date(),

        // ✅ NUMÉRO UNIQUE + ORIGINE
        request_number: `S-${String(next).padStart(6, "0")}`,
        source: "simulateur_ui",

        address: {
          street: client.street || "",
          number: client.street_number || "",
          city: client.city || "",
          zipcode: client.zip || "",
        },

        client: {
          firstName: client.firstname || "",
          lastName: client.lastname || "",
          phone: client.phone || "",
        },

        work: {
          type: workType,
          battery_count: batteryCount,
          panel_count: panelCount,
        },

        payment_status: "pending",
      });
    }),

    // ⏱️ garde serverless
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Firestore timeout")), 10000)
    )

  ]);

  console.log("🔥 Firestore write + count OK");

} catch (err) {
  console.error("❌ Firestore skipped:", err.message);
}


    // ---------------------------------------------
    // 12) RÉPONSE → SIMULATEUR
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
