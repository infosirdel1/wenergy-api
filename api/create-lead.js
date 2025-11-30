import axios from "axios";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") return res.status(200).json({});

  try {
    const { client, simulation } = req.body;

    const ODOO_URL = process.env.ODOO_URL;
    const ODOO_DB = process.env.ODOO_DB;
    const ODOO_USER = process.env.ODOO_USER;
    const ODOO_API_KEY = process.env.ODOO_API_KEY;

    // 1️⃣ AUTH ODOO → session_id
console.log("🔐 Auth Odoo – URL =", `${ODOO_URL}/web/session/authenticate`);
console.log("🔐 Auth Odoo – DB =", ODOO_DB);
console.log("🔐 Auth Odoo – USER =", ODOO_USER);

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
    id: Date.now(),
  },
  {
    headers: {
      "Content-Type": "application/json",
    },
    // (withCredentials ne change rien en Node, mais on le laisse)
    withCredentials: true,
  }
);

console.log("🔐 Auth Odoo – status =", authResp.status);
console.log("🔐 Auth Odoo – data   =", authResp.data);
console.log("🔐 Auth Odoo – cookies=", authResp.headers["set-cookie"]);

const cookies = authResp.headers["set-cookie"];
if (!cookies) {
  throw new Error("No session cookie from Odoo (set-cookie vide)");
}

const session_id = cookies
  .find((c) => c.includes("session_id"))
  ?.split(";")[0]
  ?.replace("session_id=", "");

if (!session_id) {
  throw new Error("Session ID not found in cookies");
}

const cookieHeader = `session_id=${session_id}`;

    const leadId = leadResp.data.result;
    if (!leadId) throw new Error("Lead creation failed");

    // 3️⃣ CREATE QUOTATION
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
          kwargs: {},
        },
        id: Date.now(),
      },
      {
        headers: {
          Cookie: cookieHeader
        }
      }
    );

    const quotationId = quotationResp.data.result;
    if (!quotationId) throw new Error("Quotation creation failed");

    const quotationUrl = `${ODOO_URL}/web#id=${quotationId}&model=sale.order&view_type=form`;

    return res.status(200).json({
      status: "success",
      redirect_url: quotationUrl
    });

  } catch (err) {
    console.error("❌ ERREUR ODOO :", err.response?.data || err);
    return res.status(500).json({
      status: "error",
      detail: err.response?.data || err.toString()
    });
  }
}
