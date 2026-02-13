# Audit de sécurité — Endpoints exposés (Vercel)

**Date :** 2025  
**Périmètre :** projet Wenergy API, déploiement Vercel  
**Aucune modification de code effectuée.**

---

## 1. Fichiers dans `/api/`

| Fichier | Exposé comme endpoint |
|--------|------------------------|
| `confirm-payment.js` | Oui → `/api/confirm-payment` |
| `create-lead.js` | Oui → `/api/create-lead` |
| `create-request-simulator.js` | Oui → `/api/create-request-simulator` |
| `env-test.js` | Oui → `/api/env-test` |
| `odoo-login-test.js` | Oui → `/api/odoo-login-test` |
| `save-pdf.js` | Oui → `/api/save-pdf` |
| `update-stats.js` | Oui → `/api/update-stats` |
| `Icon` | Non (pas de `.js`, non pris en charge par `api/*.js`) |

---

## 2. Détail par endpoint

### `/api/create-lead` — `api/create-lead.js`

| Critère | Valeur |
|--------|--------|
| **Méthodes HTTP** | POST (OPTIONS pour CORS) |
| **Authentification** | Non (aucune clé, token ou signature) |
| **Variables d’environnement** | `FIREBASE_SERVICE_ACCOUNT_BASE64`, `FIREBASE_STORAGE_BUCKET`, `ODOO_URL`, `ODOO_DB`, `ODOO_USER`, `ODOO_PASSWORD` |
| **Risque** | **Moyen à critique** |

- Crée partenaire Odoo, lead, devis, lignes, réserve un count Firestore, écrit `meta/counters`, `requests/<id>`, uploade un PDF dans Storage, met à jour le document `requests` avec l’URL signée.
- Toute requête POST valide (client, simulation, order_products) déclenche créations Odoo + écritures Firestore + écriture Storage sans contrôle d’identité.

---

### `/api/create-request-simulator` — `api/create-request-simulator.js`

| Critère | Valeur |
|--------|--------|
| **Méthodes HTTP** | POST (OPTIONS pour CORS) |
| **Authentification** | Non (CORS limité à 3 origines : wenergy1.odoo.com, www.wenergy-consulting.com, wenergy-consulting.com) |
| **Variables d’environnement** | `FIREBASE_SERVICE_ACCOUNT_BASE64` |
| **Risque** | **Moyen** |

- Écrit Firestore : `counters/requests` (incrément) et `requests/<id>` (nouveau document).
- Pas d’écriture Storage. Le CORS restreint les origines mais n’est pas une authentification (contournable via outil type curl/Postman).

---

### `/api/update-stats` — `api/update-stats.js`

| Critère | Valeur |
|--------|--------|
| **Méthodes HTTP** | POST (OPTIONS pour CORS) |
| **Authentification** | Non |
| **Variables d’environnement** | `ODOO_URL`, `ODOO_DB`, `ODOO_USER`, `ODOO_PASSWORD` |
| **Risque** | **Moyen** |

- Ne touche pas à Firestore ni Storage. Crée/met à jour des enregistrements dans Odoo (modèle `x_analytics`) selon `x_studio_session_id_1` et body.
- N’importe qui peut envoyer des stats arbitraires (pollution analytics).

---

### `/api/confirm-payment` — `api/confirm-payment.js`

| Critère | Valeur |
|--------|--------|
| **Méthodes HTTP** | Toutes (aucun contrôle de méthode) ; en pratique utilisé en GET avec `count` et `email` en query |
| **Authentification** | Non (contrôle métier : document Firestore avec `platform_count` + `client.email` et `payment_status === "paid"`) |
| **Variables d’environnement** | `FIREBASE_SERVICE_ACCOUNT_BASE64`, `ODOO_URL`, `ODOO_DB`, `ODOO_USER`, `ODOO_PASSWORD` |
| **Risque** | **Moyen** |

- Lecture Firestore uniquement (lookup par count + email). Pas d’écriture Firestore ni Storage. Retourne le PDF du devis Odoo en stream si le statut est « paid ».
- Risque : énumération (count + email) pour télécharger des PDF de devis dès qu’un paiement est marqué payé.

---

### `/api/save-pdf` — `api/save-pdf.js`

| Critère | Valeur |
|--------|--------|
| **Méthodes HTTP** | Toutes (aucun contrôle de méthode) ; en pratique GET avec `count` et `email` en query |
| **Authentification** | Non (seulement présence de `count` et `email`) |
| **Variables d’environnement** | `FIREBASE_SERVICE_ACCOUNT_BASE64`, `FIREBASE_STORAGE_BUCKET`, `ODOO_URL`, `ODOO_DB`, `ODOO_USER`, `ODOO_PASSWORD` |
| **Risque** | **Critique** |

- Lit Firestore (requests par count + email), récupère le PDF Odoo, **écrit dans Storage** (`requests/<count>/devis-<quotation_id>.pdf`), puis **met à jour Firestore** (champ `pdfs.devis` avec path et signed_url) sans vérifier de token ni signature.
- Toute personne connaissant un couple (count, email) peut déclencher écriture Storage + mise à jour Firestore pour ce document.

---

### `/api/odoo-login-test` — `api/odoo-login-test.js`

| Critère | Valeur |
|--------|--------|
| **Méthodes HTTP** | Toutes (aucun contrôle) |
| **Authentification** | Non |
| **Variables d’environnement** | `ODOO_URL`, `ODOO_DB`, `ODOO_USER`, `ODOO_API_KEY` |
| **Risque** | **Faible** (exposition d’info) |

- Teste l’auth Odoo et renvoie ok/error. N’écrit ni Firestore ni Storage. Risque : révélation que les identifiants Odoo fonctionnent (et possibilité de tester des creds si l’API key était devinée ailleurs).

---

### `/api/env-test` — `api/env-test.js`

| Critère | Valeur |
|--------|--------|
| **Méthodes HTTP** | Toutes (aucun contrôle) |
| **Authentification** | Non |
| **Variables d’environnement** | `ODOO_URL`, `ODOO_DB`, `ODOO_USER` (renvoyés dans la réponse JSON) |
| **Risque** | **Critique** |

- Retourne en clair dans le body : `url`, `db`, `user` (valeurs des variables d’environnement). **Fuite d’informations sensibles** (URL et nom de base Odoo, utilisateur). À désactiver ou supprimer en production.

---

## 3. Synthèse des vérifications demandées

| Vérification | Résultat |
|-------------|----------|
| **Requêtes sans vérification de signature** | Tous les endpoints sont appelables sans signature (aucun HMAC, Stripe signing secret, etc.). |
| **Modification Firestore sans authentification** | Oui. `create-lead`, `create-request-simulator`, `save-pdf` écrivent dans Firestore sans auth utilisateur (pas de token, pas de signature). |
| **Écriture Storage sans contrôle** | Oui. `create-lead` et `save-pdf` écrivent dans Firebase Storage sans contrôle d’identité (uniquement count/email ou body du simulateur). |
| **Clés secrètes exposées dans le code** | Non. Les secrets passent par `process.env.*`. En revanche, **`/api/env-test` expose en JSON les valeurs de `ODOO_URL`, `ODOO_DB`, `ODOO_USER`** dans la réponse HTTP. |

---

## 4. bodyParser / corps brut (webhook Stripe)

- **Aucun fichier dans `api/` ne désactive le parsing du body.**
- Aucune utilisation de `bodyParser.raw`, `getRawBody` ou équivalent dans le code applicatif (hors `node_modules`).
- Sur Vercel, les serverless functions reçoivent en général un body déjà parsé (JSON). Pour un futur webhook Stripe, il faudra **une route dédiée** qui lit le **body brut** (Buffer) pour vérifier la signature `Stripe-Signature` ; cette route devra soit utiliser la config Vercel pour désactiver le parsing sur ce path, soit lire le raw body si exposé par le runtime.

---

## 5. `vercel.json`

```json
{
  "version": 2,
  "builds": [{ "src": "api/*.js", "use": "@vercel/node" }],
  "routes": [{ "src": "/api/(.*)", "dest": "/api/$1.js" }]
}
```

| Élément | Présent | Détail |
|--------|--------|--------|
| **Routes custom** | Oui | Une seule : `/api/(.*)` → `/api/$1.js` (chaque fichier `api/<name>.js` = endpoint `/api/<name>`). |
| **Rewrite** | Non | Aucun rewrite (hors la route ci‑dessus). |
| **Middleware** | Non | Aucun fichier `middleware.js` à la racine ; pas de middleware Vercel configuré. |

---

## 6. `index.js` — exposition publique

- **`index.js` n’est pas exposé par la configuration Vercel actuelle.**
- `vercel.json` ne build que `api/*.js`. Il n’y a pas de build pour la racine ni de route pointant vers `index.js`.
- Donc en l’état : pas de serveur Express démarré côté Vercel ; les routes définies dans `index.js` (GET `/`, POST `/create-lead`) **ne sont pas servies** par ce déploiement. Seuls les handlers dans `api/*.js` le sont.

---

## 7. Liste récapitulative des endpoints exposés

| Endpoint | Méthodes | Auth | Firestore | Storage | Niveau de risque |
|----------|----------|------|-----------|---------|------------------|
| `/api/create-lead` | POST | Non | Écriture (counters + requests) | Écriture | Moyen à critique |
| `/api/create-request-simulator` | POST | Non (CORS only) | Écriture | Non | Moyen |
| `/api/update-stats` | POST | Non | Non | Non | Moyen |
| `/api/confirm-payment` | Toutes | Non | Lecture | Non | Moyen |
| `/api/save-pdf` | Toutes | Non | Lecture + écriture | Écriture | Critique |
| `/api/odoo-login-test` | Toutes | Non | Non | Non | Faible |
| `/api/env-test` | Toutes | Non | Non | Non | Critique (fuite env) |

---

## 8. Risques identifiés

1. **`/api/env-test`** : exposition en production de `ODOO_URL`, `ODOO_DB`, `ODOO_USER` dans la réponse.
2. **`/api/save-pdf`** : écriture Storage + mise à jour Firestore avec seulement `count` + `email` en query, sans authentification.
3. **`/api/create-lead`** : création complète (Odoo + Firestore + Storage) sans auth ni rate‑limit, exposée au spam et abus.
4. **`/api/create-request-simulator`** : création de documents `requests` et incrément compteur ; CORS seul ne protège pas contre les appels directs.
5. **`/api/confirm-payment`** : accès au PDF par connaissance de (count, email) une fois le paiement marqué payé (énumération possible).

---

## 9. Recommandations

1. **Désactiver ou supprimer `/api/env-test`** en production (ou le protéger par une auth forte et ne jamais renvoyer les valeurs d’env en clair).
2. **Ne pas exposer** `ODOO_URL`, `ODOO_DB`, `ODOO_USER` dans aucune réponse (vérifier logs et autres endpoints).
3. **Authentifier ou restreindre** les endpoints qui modifient des données :
   - `create-lead` : token partagé secret (header), ou auth utilisateur, et/ou rate limiting.
   - `create-request-simulator` : au minimum un secret partagé ou vérification d’origine fiable (pas seulement CORS).
   - `save-pdf` : lier l’appel à une session ou un token (ex. token court livré après vérification du paiement), pas seulement count + email en query.
4. **`confirm-payment`** : renforcer le contrôle d’accès (ex. token à usage unique ou signé après paiement) pour limiter l’énumération.
5. **Webhook Stripe (futur)** : créer une route dédiée (ex. `api/stripe-webhook.js`) qui reçoit le **body brut** (sans parsing JSON préalable), vérifie `Stripe-Signature` avec le secret webhook, puis traite l’événement.
6. **Rate limiting** : ajouter un rate limit (Vercel ou middleware) sur `create-lead`, `create-request-simulator` et `save-pdf` pour limiter les abus.

---

*Fin du rapport d’audit.*
