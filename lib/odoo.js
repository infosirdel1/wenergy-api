/**
 * Module Odoo : vérification du statut de paiement (account.move).
 * Credentials via variables d'environnement.
 */

import axios from "axios";

const ODOO_URL = process.env.ODOO_URL;
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USER = process.env.ODOO_USER;
const ODOO_PASSWORD = process.env.ODOO_PASSWORD;

/**
 * Récupère le cookie de session Odoo (authentification JSON-RPC).
 * @returns {Promise<string>} Cookie header (session_id=...)
 */
async function getOdooSession() {
  if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_PASSWORD) {
    throw new Error("Odoo env variables missing");
  }
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
    {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    }
  );
  const cookies = authResp.headers["set-cookie"];
  const sessionId = cookies
    ?.find((c) => c.includes("session_id"))
    ?.split(";")[0]
    ?.replace("session_id=", "");
  if (!sessionId) {
    throw new Error("Odoo session not returned");
  }
  return `session_id=${sessionId}`;
}

/**
 * Vérifie le statut de paiement d'une facture Odoo (account.move).
 * @param {number|string} odooId - ID du account.move (facture) dans Odoo
 * @returns {Promise<string>} "paid" ou autre valeur de payment_state
 */
export async function checkOdooPayment(odooId) {
  const id = Number(odooId);
  if (!Number.isFinite(id)) {
    throw new Error("Invalid odooId");
  }

  const cookieHeader = await getOdooSession();

  const resp = await axios.post(
    `${ODOO_URL}/web/dataset/call_kw`,
    {
      jsonrpc: "2.0",
      method: "call",
      params: {
        model: "account.move",
        method: "read",
        args: [[id]],
        kwargs: { fields: ["payment_state"] },
      },
      id: Date.now(),
    },
    {
      headers: { Cookie: cookieHeader },
      timeout: 10000,
    }
  );

  const result = resp.data?.result;
  if (!Array.isArray(result) || result.length === 0) {
    throw new Error(`account.move ${id} not found`);
  }

  const paymentState = result[0].payment_state;
  return paymentState == null ? "unknown" : String(paymentState);
}

/**
 * Vérifie le statut de paiement à partir d'un sale.order (quotation).
 * Lit sale.order.invoice_ids puis account.move.payment_state sur la première facture.
 * @param {number|string} quotationId - ID du sale.order dans Odoo
 * @returns {Promise<string>} "paid" | "no_invoice" | autre valeur payment_state
 */
export async function checkOdooPaymentFromSaleOrder(quotationId) {
  const soId = Number(quotationId);
  if (!Number.isFinite(soId)) {
    throw new Error("Invalid quotationId");
  }

  const cookieHeader = await getOdooSession();

  const soResp = await axios.post(
    `${ODOO_URL}/web/dataset/call_kw`,
    {
      jsonrpc: "2.0",
      method: "call",
      params: {
        model: "sale.order",
        method: "read",
        args: [[soId]],
        kwargs: { fields: ["invoice_ids"] },
      },
      id: Date.now(),
    },
    {
      headers: { Cookie: cookieHeader },
      timeout: 10000,
    }
  );

  const soResult = soResp.data?.result;
  if (!Array.isArray(soResult) || soResult.length === 0) {
    throw new Error(`sale.order ${soId} not found`);
  }

  const invoiceIds = soResult[0].invoice_ids;
  if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
    return "no_invoice";
  }

  const invoiceId = invoiceIds[0];
  console.log(`[odoo] Invoice found: ${invoiceId}`);

  const moveResp = await axios.post(
    `${ODOO_URL}/web/dataset/call_kw`,
    {
      jsonrpc: "2.0",
      method: "call",
      params: {
        model: "account.move",
        method: "read",
        args: [[invoiceId]],
        kwargs: { fields: ["payment_state"] },
      },
      id: Date.now(),
    },
    {
      headers: { Cookie: cookieHeader },
      timeout: 10000,
    }
  );

  const moveResult = moveResp.data?.result;
  if (!Array.isArray(moveResult) || moveResult.length === 0) {
    throw new Error(`account.move ${invoiceId} not found`);
  }

  const paymentState = moveResult[0].payment_state;
  const state = paymentState == null ? "unknown" : String(paymentState);
  console.log(`[odoo] Payment state: ${state}`);
  return state;
}
