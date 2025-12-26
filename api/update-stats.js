import axios from "axios";

export default async function handler(req, res) {

  /* ============================================================
     S.1 – CORS
     ============================================================ */

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ status: "error", message: "Only POST allowed" });
  }

  try {
    console.log("🟢 update-stats called", req.body);

    /* ============================================================
       S.2 – INPUT (API contract stable)
       ============================================================ */

    const {
      session_id,
      step,
      abandon_step,
      completed,
      increment_clicked_order,
      x_studio_consumption_input   // ← AJOUT
    } = req.body || {};

    if (!session_id) {
      return res.status(400).json({ status: "error", message: "Missing session_id" });
    }

    /* ============================================================
       S.3 – ENV ODOO
       ============================================================ */

    const ODOO_URL      = process.env.ODOO_URL;
    const ODOO_DB       = process.env.ODOO_DB;
    const ODOO_USER     = process.env.ODOO_USER;
    const ODOO_PASSWORD = process.env.ODOO_PASSWORD;

    if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_PASSWORD) {
      throw new Error("Missing Odoo env variables");
    }

    /* ============================================================
       S.4 – AUTH ODOO (cookie session)
       ============================================================ */

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
    if (!sessionCookie) throw new Error("No session cookie returned by Odoo");
    const cookieHeader = sessionCookie.split(";")[0];

    /* ============================================================
       S.5 – SEARCH existing record by session
       ============================================================ */

    const searchResp = await axios.post(
      `${ODOO_URL}/web/dataset/call_kw`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          model: "x_analytics",
          method: "search_read",
          args: [[["x_studio_session_id_1", "=", session_id]]],
          kwargs: {
            limit: 1,
            fields: [
              "id",
              "x_studio_clicked_order_count",
              "x_studio_event_log"
            ]
          }
        },
        id: Date.now()
      },
      { headers: { Cookie: cookieHeader } }
    );

    const record = Array.isArray(searchResp.data?.result)
      ? searchResp.data.result[0]
      : null;

    let recordId = record?.id || null;

    /* ============================================================
       S.6 – CREATE if missing (x_name obligatoire)
       ============================================================ */

    if (!recordId) {
      const initCount = increment_clicked_order === 1 ? 1 : 0;

      const createResp = await axios.post(
        `${ODOO_URL}/web/dataset/call_kw`,
        {
          jsonrpc: "2.0",
          method: "call",
          params: {
            model: "x_analytics",
            method: "create",
            args: [{
              x_name: `Session ${session_id}`,
              x_studio_session_id_1: session_id,
              x_studio_step_reached: step ?? "start",
              x_studio_abandon_step: abandon_step ?? null,
              x_studio_order_sent: completed === true,
              x_studio_clicked_order_count: initCount,
              x_studio_event_log: "[init]"
            }],
            kwargs: {}
          },
          id: Date.now()
        },
        { headers: { Cookie: cookieHeader } }
      );

      recordId = createResp.data?.result || null;

      if (!recordId) {
        return res.status(500).json({
          status: "error",
          message: "Create failed: no id returned"
        });
      }
    }

    /* ============================================================
       S.7 – BUILD UPDATE (strict)
       ============================================================ */

    const values = {};

    if (step !== undefined) {
      values.x_studio_step_reached = step;
    }

    if (abandon_step !== undefined) {
      values.x_studio_abandon_step = abandon_step;
    }

    if (completed === true) {
      values.x_studio_order_sent = true;
    }

    if (increment_clicked_order === 1) {
      const prev = Number(record?.x_studio_clicked_order_count || 0);
      values.x_studio_clicked_order_count = prev + 1;
    }

    // 🔥 CONSOMMATION (AJOUT UNIQUE)
    if (x_studio_consumption_input !== undefined) {
      values.x_studio_consumption_input = x_studio_consumption_input;
    }

    values.x_studio_event_datetime = new Date().toISOString();

    const prevLog = (record?.x_studio_event_log || "").toString();
    const line =
      `[${new Date().toISOString()}] ` +
      `step=${step ?? ""} ` +
      `abandon=${abandon_step ?? ""} ` +
      `completed=${completed === true ? "1" : "0"} ` +
      `clicked=${increment_clicked_order === 1 ? "1" : "0"}`;

    values.x_studio_event_log = prevLog ? `${prevLog}\n${line}` : line;

    if (Object.keys(values).length === 0) {
      return res.status(200).json({ status: "noop" });
    }

    /* ============================================================
       S.8 – WRITE
       ============================================================ */

    const writeResp = await axios.post(
      `${ODOO_URL}/web/dataset/call_kw`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          model: "x_analytics",
          method: "write",
          args: [[recordId], values],
          kwargs: {}
        },
        id: Date.now()
      },
      { headers: { Cookie: cookieHeader } }
    );

    console.log("✅ writeResp", writeResp.data);

    return res.status(200).json({
      status: "success",
      record_id: recordId
    });

  } catch (err) {

    console.error("❌ update-stats error:", err.response?.data || err);

    return res.status(500).json({
      status: "error",
      detail: err.response?.data || err.toString()
    });
  }
}
