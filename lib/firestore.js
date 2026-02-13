/**
 * Module Firestore : requêtes ciblées pour le polling de paiements.
 * Utilise un index sur payment_status pour ne pas scanner toute la collection.
 */

import admin from "firebase-admin";

/** Valeurs considérées comme "en attente de paiement" */
const PENDING_STATUSES = ["pending", "pending_payment"];

/**
 * Récupère les documents requests en attente de paiement.
 * Requête indexée sur payment_status (index composite recommandé si orderBy ajouté).
 * @param {FirebaseFirestore.Firestore} firestore - Instance Firestore initialisée
 * @returns {Promise<FirebaseFirestore.QuerySnapshot>}
 */
export async function getPendingPayments(firestore) {
  return firestore
    .collection("requests")
    .where("payment_status", "in", PENDING_STATUSES)
    .get();
}

/**
 * Met à jour le statut de paiement d'un document request.
 * @param {FirebaseFirestore.DocumentReference} docRef - Référence du document
 * @param {object} [options] - Options (pour extension future)
 * @returns {Promise<void>}
 */
export async function updatePaymentStatus(docRef, options = {}) {
  await docRef.update({
    payment_status: "paid",
    paid_at: admin.firestore.FieldValue.serverTimestamp(),
    ...options,
  });
}
