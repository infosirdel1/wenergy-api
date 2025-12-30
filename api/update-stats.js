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

    console.log("🧪 RAW BODY =", JSON.stringify(req.body));
    console.log("🧪 BODY KEYS =", Object.keys(req.body || {}));
    
    const {
      x_studio_session_id_1,
      step,
      completed,
      increment_clicked_order,
      x_studio_consumption_input,
      x_studio_lang
    } = req.body || {};

    if (!x_studio_session_id_1) {
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
          args: [[["x_studio_session_id_1", "=", x_studio_session_id_1]]],
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
              x_name: `Session ${x_studio_session_id_1}`,
              x_studio_session_id_1: x_studio_session_id_1,

              ...(req.body.hasOwnProperty("x_studio_consumption_input")
              ? { x_studio_consumption_input: req.body.x_studio_consumption_input }
              : {}),

              ...(req.body.hasOwnProperty("x_studio_lang")
              ? { x_studio_lang: req.body.x_studio_lang }
              :  {}),

            x_studio_step_reached: step ?? "start",
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

// x_studio_step_reached est un champ "selection" → on évite les valeurs invalides
const ALLOWED_STEPS = ["start", "battery", "pv", "results", "order"];

if (step !== undefined && ALLOWED_STEPS.includes(step)) {
  values.x_studio_step_reached = step;
}

if (req.body.hasOwnProperty("x_studio_know_conso")) {
  values.x_studio_know_conso = req.body.x_studio_know_conso;
}

    if (completed === true) {
      values.x_studio_order_sent = true;
    }

    if (increment_clicked_order === 1) {
      const prev = Number(record?.x_studio_clicked_order_count || 0);
      values.x_studio_clicked_order_count = prev + 1;
    }
    
  if (req.body.hasOwnProperty("x_studio_consumption_input")) {
  values.x_studio_consumption_input = req.body.x_studio_consumption_input;
}
values.x_studio_event_datetime =
  new Date().toISOString().replace("T", " ").substring(0, 19);

const ALLOWED_LANGS = ["fr", "nl", "en"];

if (
  req.body.hasOwnProperty("x_studio_lang") &&
  ALLOWED_LANGS.includes(req.body.x_studio_lang)
) {
  values.x_studio_lang = req.body.x_studio_lang;
}

    const ALLOWED_COUNTRIES = ["be", "fr"];

if (
  req.body.hasOwnProperty("x_studio_country") &&
  ALLOWED_COUNTRIES.includes(req.body.x_studio_country)
) {
  values.x_studio_country = req.body.x_studio_country;
}

const ALLOWED_DEVICES = ["desktop", "mobile", "tablet"];

// BATTERY — modèle
if (req.body.hasOwnProperty("x_studio_battery_model")) {
  values.x_studio_battery_model = req.body.x_studio_battery_model;
}

// BATTERY — nombre
if (req.body.hasOwnProperty("x_studio_battery_count")) {
  values.x_studio_battery_count = req.body.x_studio_battery_count;
}

    // INSTALLATION — option
const ALLOWED_INSTALL_OPTIONS = ["battery_only", "battery_pv", "none"];

if (
  req.body.hasOwnProperty("x_studio_install_option") &&
  ALLOWED_INSTALL_OPTIONS.includes(req.body.x_studio_install_option)
) {
  values.x_studio_install_option = req.body.x_studio_install_option;
}

    // PV — présence (yes/no)
const ALLOWED_PV = ["yes", "no"];

if (
  req.body.hasOwnProperty("x_studio_has_pv") &&
  ALLOWED_PV.includes(req.body.x_studio_has_pv)
) {
  values.x_studio_has_pv = req.body.x_studio_has_pv;
}

    // PV — nombre de panneaux
if (req.body.hasOwnProperty("x_studio_pv_panels")) {
  values.x_studio_pv_panels = String(req.body.x_studio_pv_panels);
}

    // INSTALLATION — type de pose (char libre)
if (req.body.hasOwnProperty("x_studio_pose_type")) {
  values.x_studio_pose_type = req.body.x_studio_pose_type;
}

    // RESULT — gain total
if (req.body.hasOwnProperty('x_studio_gain_eur')) {
  values.x_studio_gain_eur = req.body.x_studio_gain_eur;
}

// RESULT — payback (année)
if (req.body.hasOwnProperty('x_studio_payback_year')) {
  values.x_studio_payback_year = req.body.x_studio_payback_year;
}

// RESULT — investissement total TTC
if (req.body.hasOwnProperty('x_studio_invest_ttc')) {
  values.x_studio_invest_ttc = req.body.x_studio_invest_ttc;
}

// COMMANDE — envoyée (statut final)
if (req.body.hasOwnProperty("x_studio_command_sent")) {
  values.x_studio_command_sent = req.body.x_studio_command_sent;
}
    
if (
  req.body.hasOwnProperty("x_studio_device") &&
  ALLOWED_DEVICES.includes(req.body.x_studio_device)
) {
  values.x_studio_device = req.body.x_studio_device;
}

const ALLOWED_SOURCES = ["ads", "direct", "organic", "referral", "unknown"];

if (
  req.body.hasOwnProperty("x_studio_source") &&
  ALLOWED_SOURCES.includes(req.body.x_studio_source)
) {
  values.x_studio_source = req.body.x_studio_source;
}

    const prevLog = (record?.x_studio_event_log || "").toString();
    const line =
      `[${new Date().toISOString()}] ` +
      `step=${step ?? ""} ` +
      `completed=${completed === true ? "1" : "0"} ` +
      `clicked=${increment_clicked_order === 1 ? "1" : "0"}`;

    values.x_studio_event_log = prevLog ? `${prevLog}\n${line}` : line;

    if (Object.keys(values).length === 0) {
      return res.status(200).json({ status: "noop" });
    }

    console.log("🧪 VALUES AVANT WRITE =", values);

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
