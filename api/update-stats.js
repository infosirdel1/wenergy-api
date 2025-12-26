import axios from "axios";

export default async function handler(req, res) {
  // -----------------------------
  // CORS
  // -----------------------------
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ status: "error", message: "Only POST allowed" });
  }

  try {
    console.log("🟢 update-stats called", req.body);

    // -----------------------------
    // INPUT (API contract stable)
    // -----------------------------
    const {
      session_id,
      step,
      abandon_step,
      completed,
      increment_clicked_order
    } = req.body || {};

    if (!session_id) {
      return res.status(400).json({ status: "error", message: "Missing session_id" });
    }

    // -----------------------------
    // ENV ODOO
    // -----------------------------
    const ODOO_URL      = process.env.ODOO_URL;
    const ODOO_DB       = process.env.ODOO_DB;
    const ODOO_USER     = process.env.ODOO_USER;
    const ODOO_PASSWORD = process.env.ODOO_PASSWORD;

    if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_PASSWORD) {
      throw new Error("Missing Odoo env variables");
    }

    // -----------------------------
    // AUTH ODOO (cookie session)
    // -----------------------------
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

    // -----------------------------
    // SEARCH existing record by x_studio_session_id_1 (TEXT)
    // -----------------------------
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
            // on lit le compteur si on doit incrémenter
            fields: ["id", "x_studio_clicked_order_count", "x_studio_event_log"]
          }
        },
        id: Date.now()
      },
      { headers: { Cookie: cookieHeader } }
    );

    const record = Array.isArray(searchResp.data?.result) ? searchResp.data.result[0] : null;
    let recordId = record?.id || null;

    // -----------------------------
    // CREATE if missing (x_name obligatoire)
    // -----------------------------
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
              // obligatoire
              x_name: `Session ${session_id}`,

              // clé session (texte)
              x_studio_session_id_1: session_id,

              // init
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
        console.error("❌ create returned no id", createResp.data);
        return res.status(500).json({ status: "error", message: "Create failed: no id returned" });
      }
    }

    // -----------------------------
    // BUILD UPDATE (strict)
    // -----------------------------
    const values = {};

    if (step !== undefined) values.x_studio_step_reached = step;
    if (abandon_step !== undefined) values.x_studio_abandon_step = abandon_step;
    if (completed === true) values.x_studio_order_sent = true;

    // compteur clic commander
    if (increment_clicked_order === 1) {
      const prev = Number(record?.x_studio_clicked_order_count || 0);
      values.x_studio_clicked_order_count = prev + 1;
    }

    // datetime (si ton champ existe dans Odoo : x_studio_event_datetime)
    values.x_studio_event_datetime = new Date().toISOString();

    // event log append (si champ existe : x_studio_event_log)
    const prevLog = (record?.x_studio_event_log || "").toString();
    const line = `[${new Date().toISOString()}] step=${step ?? ""} abandon=${abandon_step ?? ""} completed=${completed === true ? "1" : "0"} clicked=${increment_clicked_order === 1 ? "1" : "0"}`;
    values.x_studio_event_log = prevLog ? `${prevLog}\n${line}` : line;

    // si rien à écrire (théoriquement rare)
    if (Object.keys(values).length === 0) {
      return res.status(200).json({ status: "noop" });
    }

    // -----------------------------
    // WRITE
    // -----------------------------
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

    // writeResp.data?.result doit être true
    console.log("✅ writeResp", writeResp.data);

    return res.status(200).json({ status: "success", record_id: recordId });

  } catch (err) {
    console.error("❌ update-stats error:", err.response?.data || err);
    return res.status(500).json({
      status: "error",
      detail: err.response?.data || err.toString()
    });
  }
}
