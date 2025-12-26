// /api/update-stats.js
import axios from "axios";

export default async function handler(req, res) {
  // -----------------------------
  // CORS
  // -----------------------------
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  // ⚠️ stats = back-only → on ne “crie” jamais côté user
  if (req.method !== "POST") return res.status(200).json({ status: "ignored" });

  try {
    // -----------------------------
    // INPUT (back-only)
    // -----------------------------
    const body = req.body || {};

    const x_studio_session_id_1 = body.x_studio_session_id_1; // ✅ champ texte (char) Odoo
    const step = body.step;
    const abandon_step = body.abandon_step;
    const completed = body.completed;
    const increment_clicked_order = body.increment_clicked_order;

    console.log("🟢 update-stats called", {
      x_studio_session_id_1,
      step,
      abandon_step,
      completed,
      increment_clicked_order,
    });

    if (!x_studio_session_id_1) {
      // pas d’erreur user
      console.warn("🟡 update-stats ignored: missing x_studio_session_id_1");
      return res.status(200).json({ status: "ignored" });
    }

    // -----------------------------
    // ENV ODOO
    // -----------------------------
    const ODOO_URL = process.env.ODOO_URL;
    const ODOO_DB = process.env.ODOO_DB;
    const ODOO_USER = process.env.ODOO_USER;
    const ODOO_PASSWORD = process.env.ODOO_PASSWORD;

    if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_PASSWORD) {
      console.error("❌ Missing Odoo env variables");
      return res.status(200).json({ status: "ignored" });
    }

    // -----------------------------
    // AUTH ODOO
    // -----------------------------
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
    const sessionCookie = cookies?.find((c) => c.includes("session_id"));
    if (!sessionCookie) {
      console.error("❌ No session cookie returned by Odoo");
      return res.status(200).json({ status: "ignored" });
    }

    const cookieHeader = sessionCookie.split(";")[0];

    // -----------------------------
    // SEARCH EXISTING ANALYTICS (x_analytics)
    // -----------------------------
    const searchResp = await axios.post(
      `${ODOO_URL}/web/dataset/call_kw`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          model: "x_analytics",
          method: "search_read",
          args: [
            [["x_studio_session_id_1", "=", x_studio_session_id_1]],
            ["id", "x_studio_clicked_order_count"],
          ],
          kwargs: { limit: 1 },
        },
        id: Date.now(),
      },
      { headers: { Cookie: cookieHeader } }
    );

    const record = searchResp.data?.result?.[0] || null;
    let recordId = record?.id || null;

    // baseCount = valeur actuelle connue
    let baseCount = record?.x_studio_clicked_order_count || 0;
    let wasCreated = false;

    // -----------------------------
    // CREATE RECORD IF MISSING
    // -----------------------------
    if (!recordId) {
      wasCreated = true;

      const initCount = increment_clicked_order === 1 ? 1 : 0;
      baseCount = initCount;

      const createResp = await axios.post(
        `${ODOO_URL}/web/dataset/call_kw`,
        {
          jsonrpc: "2.0",
          method: "call",
          params: {
            model: "x_analytics",
            method: "create",
            args: [
              {
                // ✅ IMPORTANT : on écrit bien dans le champ texte
                x_studio_session_id_1: x_studio_session_id_1,

                // ✅ init cohérent
                x_studio_step_reached: step ?? "start",
                x_studio_abandon_step: abandon_step ?? null,
                x_studio_order_sent: completed === true,
                x_studio_clicked_order_count: initCount,
                x_studio_event_log: "[init]",
              },
            ],
            kwargs: {},
          },
          id: Date.now(),
        },
        { headers: { Cookie: cookieHeader } }
      );

      recordId = createResp.data?.result || null;

      if (!recordId) {
        console.error("❌ create returned no id", createResp.data);
        return res.status(200).json({ status: "ignored" });
      }
    }

    // -----------------------------
    // BUILD UPDATE PAYLOAD (STRICT)
    // -----------------------------
    const values = {};

    if (step !== undefined) values.x_studio_step_reached = step;
    if (abandon_step !== undefined) values.x_studio_abandon_step = abandon_step;
    if (completed === true) values.x_studio_order_sent = true;

    // ⚠️ ne pas double-incrémenter si on vient de créer avec initCount=1
    if (increment_clicked_order === 1 && !wasCreated) {
      values.x_studio_clicked_order_count = baseCount + 1;
    }

    if (Object.keys(values).length === 0) {
      return res.status(200).json({ status: "noop" });
    }

    // -----------------------------
    // WRITE UPDATE
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
          kwargs: {},
        },
        id: Date.now(),
      },
      { headers: { Cookie: cookieHeader } }
    );

    if (writeResp.data?.error) {
      console.error("❌ Odoo write error", writeResp.data.error);
      return res.status(200).json({ status: "ignored" });
    }

    return res.status(200).json({ status: "success" });
  } catch (err) {
    // back-only : log serveur, mais jamais d’erreur visible user
    console.error("❌ update-stats error:", err.response?.data || err);
    return res.status(200).json({ status: "ignored" });
  }
}
