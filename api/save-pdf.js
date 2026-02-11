import admin from "firebase-admin";
import axios from "axios";

// ---------- Firebase init (safe serverless) ----------
if (!admin.apps.length) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_BASE64 is missing");
  }

  if (!process.env.FIREBASE_STORAGE_BUCKET) {
    throw new Error("FIREBASE_STORAGE_BUCKET is missing");
  }

  const serviceAccount = JSON.parse(
    Buffer.from(
      process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
      "base64"
    ).toString("utf8")
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
}

const firestore = admin.firestore();
const bucket = admin.storage().bucket();

export default async function handler(req, res) {
  try {
    const { count, email } = req.query;

    if (!count || !email) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    // 1️⃣ Lookup Firestore
    const snap = await firestore
      .collection("requests")
      .where("platform_count", "==", Number(count))
      .where("client.email", "==", email)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({ error: "Request not found" });
    }

    const docRef = snap.docs[0].ref;
    const data = snap.docs[0].data();

    if (!data.quotation_id) {
      return res.status(500).json({ error: "Missing quotation_id in Firestore" });
    }

    // 2️⃣ Auth Odoo
    const { ODOO_URL, ODOO_DB, ODOO_USER, ODOO_PASSWORD } = process.env;

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
    const session_id = cookies
      ?.find((c) => c.includes("session_id="))
      ?.split(";")[0]
      ?.replace("session_id=", "");

    if (!session_id) {
      return res.status(500).json({ error: "Odoo authentication failed" });
    }

    // 3️⃣ Fetch PDF
    const pdfResp = await axios.get(
      `${ODOO_URL}/report/pdf/sale.report_saleorder/${data.quotation_id}`,
      {
        responseType: "arraybuffer",
        headers: { Cookie: `session_id=${session_id}` },
      }
    );

    if (
      !pdfResp.headers["content-type"] ||
      !pdfResp.headers["content-type"].includes("application/pdf")
    ) {
      return res.status(500).json({ error: "Odoo did not return PDF" });
    }

    const pdfBuffer = Buffer.from(pdfResp.data);

    // 4️⃣ Upload Storage
    const storagePath = `requests/${Number(count)}/devis-${data.quotation_id}.pdf`;
    const file = bucket.file(storagePath);

    await file.save(pdfBuffer, {
      metadata: { contentType: "application/pdf" },
      resumable: false,
    });

    // 5️⃣ Signed URL
    const [signedUrl] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + 1000 * 60 * 60 * 24 * 7,
    });

    // 6️⃣ Update Firestore
    await docRef.set(
      {
        pdfs: {
          devis: {
            storage_path: storagePath,
            signed_url: signedUrl,
            created_at: admin.firestore.FieldValue.serverTimestamp(),
          },
        },
      },
      { merge: true }
    );

    return res.status(200).json({
      ok: true,
      storage_path: storagePath,
      signed_url: signedUrl,
    });

  } catch (err) {
    console.error("❌ save-pdf failed:", err);
    return res.status(500).json({
      error: "save-pdf failed",
      detail: err.message,
    });
  }
}
