import axios from "axios";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ status: "error", message: "Only GET allowed" });

  try {
    const ODOO_URL      = process.env.ODOO_URL;
    const ODOO_DB       = process.env.ODOO_DB;
    const ODOO_USER     = process.env.ODOO_USER;
    const ODOO_PASSWORD = process.env.ODOO_PASSWORD;

    const authResp = await axios.post(
      `${ODOO_URL}/web/session/authenticate`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_PASSWORD },
        id: Date.now()
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const cookies = authResp.headers["set-cookie"];
    const sessionCookie = cookies?.find(c => c.includes("session_id"));
    if (!sessionCookie) throw new Error("No session cookie returned by Odoo");
    const cookieHeader = sessionCookie.split(";")[0];

    // Lire la définition du champ selection
    const fieldsResp = await axios.post(
      `${ODOO_URL}/web/dataset/call_kw`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          model: "x_analytics",
          method: "fields_get",
          args: [["x_studio_step_reached"]],
          kwargs: { attributes: ["selection", "type", "string"] }
        },
        id: Date.now()
      },
      { headers: { Cookie: cookieHeader } }
    );

    return res.status(200).json({
      status: "success",
      field: fieldsResp.data?.result?.x_studio_step_reached || null
    });

  } catch (err) {
    console.error("❌ debug-step-values error:", err.response?.data || err);
    return res.status(500).json({ status: "error", detail: err.response?.data || err.toString() });
  }
}
