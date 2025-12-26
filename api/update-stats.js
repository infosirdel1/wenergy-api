import axios from "axios";

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status(200).json({});
  }

  if (req.method !== "POST") {
    return res.status(405).json({ status: "error", message: "Only POST allowed" });
  }

  try {
    const { session_id, step, abandon_step, completed, increment_clicked_order } = req.body || {};

    if (!session_id) {
      return res.status(400).json({
        status: "error",
        message: "Missing session_id"
      });
    }

    // --- ODOO ENV ---
    const ODOO_URL      = process.env.ODOO_URL;
    const ODOO_DB       = process.env.ODOO_DB;
    const ODOO_USER     = process.env.ODOO_USER;
    const ODOO_PASSWORD = process.env.ODOO_PASSWORD;

    if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_PASSWORD) {
      throw new Error("Missing Odoo env variables");
    }

    // --- AUTH ---
    const authResp = await axios.post(
      `${ODOO_URL}/web/session/authenticate`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          db: ODOO_DB,
          login: ODOO_USER,
          password: ODOO_PASSWORD
        },
        id: Date.now()
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const cookies = authResp.headers["set-cookie"];
    const sessionCookie = cookies?.find(c => c.includes("session_id"));
    if (!sessionCookie) throw new Error("No session cookie");

    const cookieHeader = sessionCookie.split(";")[0];

    // --- FIND RECORD ---
    const searchResp = await axios.post(
      `${ODOO_URL}/web/dataset/call_kw`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          model: "x_simulator_analytics",
          method: "search_read",
          args: [[["session_id", "=", session_id]]],
          kwargs: { limit: 1, fields: ["id"] }
        },
        id: Date.now()
      },
      { headers: { Cookie: cookieHeader } }
    );

    const record = searchResp.data?.result?.[0];
    if (!record?.id) {
      return res.status(200).json({ status: "ignored", message: "No analytics record found" });
    }

    // --- BUILD UPDATE ---
    const values = {};
    if (step) values.step = step;
    if (abandon_step !== undefined) values.abandon_step = abandon_step;
    if (completed !== undefined) values.completed = completed;
    if (increment_clicked_order) values.clicked_order = (increment_clicked_order === 1);

    // --- WRITE ---
    await axios.post(
      `${ODOO_URL}/web/dataset/call_kw`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          model: "x_simulator_analytics",
          method: "write",
          args: [[record.id], values],
          kwargs: {}
        },
        id: Date.now()
      },
      { headers: { Cookie: cookieHeader } }
    );

    return res.status(200).json({ status: "success" });

  } catch (err) {
    console.error("❌ update-stats error:", err.response?.data || err);
    return res.status(500).json({
      status: "error",
      detail: err.response?.data || err.toString()
    });
  }
}
