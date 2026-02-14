import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();

export default async function handler(req, res) {
  try {
    const { count } = req.query;

    if (!count) {
      return res.status(400).send("Missing count parameter");
    }

    const snapshot = await db
      .collection("requests")
      .where("platform_count", "==", Number(count))
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).send("Commande introuvable");
    }

    const doc = snapshot.docs[0];

    await doc.ref.update({
  "delivery.status": "shipped",
  "delivery.shipped_at": admin.firestore.FieldValue.serverTimestamp(),
});

    return res.status(200).send(`
      <html>
        <body style="font-family: Arial; text-align:center; margin-top:50px;">
          <h1>✅ Commande marquée comme expédiée</h1>
          <p>Référence : ${count}</p>
        </body>
      </html>
    `);

  } catch (error) {
    console.error(error);
    return res.status(500).send("Erreur serveur");
  }
}
