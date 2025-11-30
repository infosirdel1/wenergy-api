import axios from "axios";

export default async function handler(req, res) {

  // -----------------------------
  // 0) CORS
  // -----------------------------
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Pré-vol CORS
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // -----------------------------
  // 1) Méthode HTTP autorisée
  // -----------------------------
  if (req.method !== "POST") {
    return res.status(405).json({
      status: "error",
      message: "Only POST requests allowed"
    });
  }

  try {
    const { client, simulation } = req.body;

    if (!client || !simulation) {
      return res.status(400).json({
        status: "error",
        message: "Missing client or simulation data"
      });
    }

    // -----------------------------
    // 2) ENV variables
    // -----------------------------
    const ODOO_URL = process.env.ODOO_URL;
    const ODOO_DB = process.env.ODOO_DB;
    const ODOO_USER = process.env.ODOO_USER;
    const ODOO_API_KEY = process.env.ODOO_API_KEY;

    if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_API_KEY) {
      return res.status(500).json({
        status: "error",
        message: "Missing Odoo environment variables"
      });
    }

    // -----------------------------
    // 3) Authentification Odoo
    // -----------------------------
    const authPayload = {
      jsonrpc: "2.0",
      method: "call",
      params: {
        db: ODOO_DB,
        login: ODOO_USER,
        password: ODOO_API_KEY
      }
    };

    const authResp = await axios.post(
      `${ODOO_URL}/web/session/authenticate`,
      authPayload,
      { withCredentials: true }
    );

    const cookies = authResp.headers["set-cookie"];
    if (!cookies) {
      return res.status(500).json({
        status: "error",
        message: "Odoo authentication failed (no session cookie)"
      });
    }

    const session_id = cookies
      .find(c => c.includes("session_id"))
      ?.split(";")[0]
      ?.replace("session_id=", "");

    if (!session_id) {
      return res.status(500).json({
        status: "error",
        message: "Odoo session ID not found"
      });
    }

    const cookie = `session_id=${session_id}`;

    // -----------------------------
    // 4) Création opportunité CRM
    // -----------------------------
    const leadData = {
      name: `Commande Batterie – ${client.firstname} ${client.lastname}`,
      contact_name: `${client.firstname} ${client.lastname}`,
      email_from: client.email,
      phone: client.phone,
      street: client.address,
      zip: client.zip,
      city: client.city,
      description: `
Simulation Wenergy

Consommation : ${simulation.consumption}
Modèle : ${simulation.battery_model_name}
Capacité totale : ${simulation.total_capacity} kWh
Batteries : ${simulation.battery_count}
PV : ${simulation.has_pv}
Fournisseur : ${simulation.supplier}

Résumé :
${simulation.su
