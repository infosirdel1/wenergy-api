import admin from "firebase-admin";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

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
    const data = doc.data();

    // 🔹 Mise à jour livraison
   const currentStatus = data.delivery?.status;

let pageType = "neutral";

if (!currentStatus || currentStatus === "pending") {

  await doc.ref.update({
    "delivery.status": "shipped",
    "delivery.shipped_at": admin.firestore.FieldValue.serverTimestamp(),
  });

// 🔹 Envoi email expédition
if (!data.delivery?.email_shipped_sent && data.client?.email) {

  await resend.emails.send({
    from: "Wenergy <noreply@wenergy-consulting.com>",
    to: data.client.email,
    subject: `Votre commande ${data.request_number || ""} a été expédiée`,
    html: `
      <p>Bonjour ${data.client?.firstName || ""},</p>

      <p>Votre commande <strong>${data.request_number || ""}</strong> vient d’être expédiée.</p>

      <p>Adresse de livraison :</p>

      <p>
        ${data.address?.street || ""}<br>
        ${data.address?.zipcode || ""} ${data.address?.city || ""}
      </p>

      <p>Nous vous remercions pour votre confiance.</p>

      <p>Cordialement,<br>L’équipe Wenergy</p>
    `
  });

  await doc.ref.update({
    "delivery.email_shipped_sent": true
  });

}

  pageType = "shipped";

} else if (currentStatus === "shipped") {

  await doc.ref.update({
    "delivery.status": "received",
    "delivery.received_at": admin.firestore.FieldValue.serverTimestamp(),
  });

// 🔹 Envoi email réception
if (!data.delivery?.email_received_sent && data.client?.email) {

  const installationType = data.installation_type || "";

  let installationMessage = "";

  if (installationType === "self") {
    installationMessage = `
      <p>Vous pouvez procéder à l'installation dès maintenant en suivant les instructions fournies.</p>
    `;
  } else {
    installationMessage = `
      <p><strong>Important :</strong> Si votre installation est prévue par un technicien Wenergy, merci de ne pas déballer ni utiliser le matériel avant son intervention.</p>
    `;
  }

  await resend.emails.send({
    from: "Wenergy <noreply@wenergy-consulting.com>",
    to: data.client.email,
    subject: `🎉 Félicitations ! Votre commande ${data.request_number || ""} est bien arrivée`,
    html: `
      <p>Bonjour ${data.client?.firstName || ""},</p>

      <p><strong>Bonne nouvelle !</strong> 🎉</p>

      <p>Votre commande <strong>${data.request_number || ""}</strong> a bien été livrée.</p>

      ${installationMessage}

      <p>Nous vous remercions sincèrement pour votre confiance.</p>

      <p>Bienvenue dans l'univers Wenergy ⚡</p>

      <p>Cordialement,<br>L’équipe Wenergy</p>
    `
  });

  await doc.ref.update({
    "delivery.email_received_sent": true
  });

}

  pageType = "received";

} else if (currentStatus === "received") {

  pageType = "neutral";
}

    // 🔹 Données dynamiques
    const requestNumber = data.request_number || "";
    const platformCount = data.platform_count || "";

    const firstName = data.client?.firstName || "";
    const lastName = data.client?.lastName || "";

    const street = data.address?.street || "";
    const zipcode = data.address?.zipcode || "";
    const city = data.address?.city || "";

    // 🔹 Variables page dynamique
let title = "";
let statusText = "";
let svgColor = "";

if (pageType === "shipped") {
  title = "Expédition confirmée";
  statusText = "✔ Expédiée avec succès";
  svgColor = "#1E90FF";
}

if (pageType === "received") {
  title = "Réception confirmée";
  statusText = "✔ Réception validée";
  svgColor = "#16a34a";
}

if (pageType === "neutral") {
  title = "Commande déjà traitée";
  statusText = "✔ Livraison déjà confirmée";
  svgColor = "#6b7280";
}
    
    if (pageType === "shipped") {
      return res.status(200).send(`
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Expédition confirmée</title>

<style>
html, body { margin:0; padding:0; height:100%; }

body {
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  background:#0f172a;
  display:flex;
  justify-content:center;
  align-items:center;
  position:relative;
}

.card {
  background:white;
  width:95%;
  max-width:520px;
  padding:60px 50px;
  border-radius:20px;
  box-shadow:0 30px 80px rgba(0,0,0,0.45);
  text-align:center;
}

.header { margin-bottom:45px; }

svg { width:70px; margin-bottom:25px; }

h1 { margin:0; font-size:30px; font-weight:700; color:#111; }

.status {
  color:#16a34a;
  font-weight:700;
  margin-top:12px;
  font-size:19px;
}

.section {
  margin-top:30px;
  padding-top:25px;
  border-top:1px solid #eee;
  text-align:left;
}

.inline-row {
  display:flex;
  justify-content:space-between;
  gap:30px;
  margin-bottom:15px;
}

.block { flex:1; }

.label { font-size:13px; color:#666; }

.value {
  font-size:17px;
  font-weight:600;
  color:#111;
  margin-top:6px;
}

.footer {
  margin-top:45px;
  font-size:13px;
  color:#777;
  text-align:center;
}
</style>
</head>

<body>

<div class="card">

  <div class="header">
    <svg viewBox="0 0 24 24" fill="none" stroke="#1E90FF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <rect x="1" y="3" width="15" height="13"></rect>
      <polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon>
      <circle cx="5.5" cy="18.5" r="2.5"></circle>
      <circle cx="18.5" cy="18.5" r="2.5"></circle>
    </svg>

    <h1>Expédition confirmée</h1>
    <div class="status">✔ Expédiée avec succès</div>
  </div>

  <div class="section">
    <div class="inline-row">
      <div class="block">
        <div class="label">Commande</div>
        <div class="value">${requestNumber}</div>
      </div>
      <div class="block">
        <div class="label">Référence</div>
        <div class="value">${platformCount}</div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="label">Client</div>
    <div class="value">${firstName} ${lastName}</div>

    <div class="label" style="margin-top:18px;">Adresse de livraison</div>
    <div class="value">
      ${street}<br>
      ${zipcode} ${city}
    </div>
  </div>

  <div class="footer">
    Wenergy — Système logistique sécurisé
  </div>

</div>

</body>
</html>
`);
    }

    if (pageType === "received") {
      return res.status(200).send(`
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Réception confirmée</title>

<style>
html, body { margin:0; padding:0; height:100%; }

body {
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  background:#0f172a;
  display:flex;
  justify-content:center;
  align-items:center;
}

.card {
  background:white;
  width:95%;
  max-width:520px;
  padding:60px 50px;
  border-radius:20px;
  box-shadow:0 30px 80px rgba(0,0,0,0.45);
  text-align:center;
}

.header { margin-bottom:45px; }

.icon-wrapper { margin-bottom:25px; }

.icon-wrapper svg {
  width:110px;
  height:110px;
  stroke:#16a34a;
}

h1 { margin:0; font-size:30px; font-weight:700; color:#111; }

.status {
  color:#16a34a;
  font-weight:700;
  margin-top:12px;
  font-size:19px;
}

.section {
  margin-top:30px;
  padding-top:25px;
  border-top:1px solid #eee;
  text-align:left;
}

.inline-row {
  display:flex;
  justify-content:space-between;
  gap:30px;
  margin-bottom:15px;
}

.block { flex:1; }

.label { font-size:13px; color:#666; }

.value {
  font-size:17px;
  font-weight:600;
  color:#111;
  margin-top:6px;
}

.footer {
  margin-top:45px;
  font-size:13px;
  color:#777;
  text-align:center;
}
</style>
</head>

<body>

<div class="card">
  <div class="header">
    <div class="icon-wrapper">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-checklist">
        <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
        <path d="M9.615 20h-2.615a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8" />
        <path d="M14 19l2 2l4 -4" />
        <path d="M9 8h4" />
        <path d="M9 12h2" />
      </svg>
    </div>

    <h1>Réception confirmée</h1>
    <div class="status">✔ Réception validée</div>
  </div>

  <div class="section">
    <div class="inline-row">
      <div class="block">
        <div class="label">Commande</div>
        <div class="value">${requestNumber}</div>
      </div>
      <div class="block">
        <div class="label">Référence</div>
        <div class="value">${platformCount}</div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="label">Client</div>
    <div class="value">${firstName} ${lastName}</div>

    <div class="label" style="margin-top:18px;">Adresse de livraison</div>
    <div class="value">
      ${street}<br>
      ${zipcode} ${city}
    </div>
  </div>

  <div class="footer">
    Wenergy — Système logistique sécurisé
  </div>
</div>

</body>
</html>
  `);
    }

    return res.status(200).send(`
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Commande déjà traitée</title>
<style>
html, body { margin:0; padding:0; height:100%; }
body {
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  background:#0f172a;
  display:flex;
  justify-content:center;
  align-items:center;
}
.card {
  background:white;
  width:95%;
  max-width:520px;
  padding:60px 50px;
  border-radius:20px;
  box-shadow:0 30px 80px rgba(0,0,0,0.45);
  text-align:center;
}
h1 { margin:0; font-size:30px; font-weight:700; color:#111; }
p { margin-top:14px; color:#333; font-size:16px; }
.small { margin-top:24px; color:#777; font-size:13px; }
</style>
</head>
<body>
  <div class="card">
    <h1>Commande déjà traitée</h1>
    <p>La réception a déjà été confirmée.</p>
    <div class="small">Wenergy — Système logistique sécurisé</div>
  </div>
</body>
</html>
`);

  } catch (error) {
    console.error(error);
    return res.status(500).send("Erreur serveur");
  }
}
