export default async function handler(req, res) {
  try {
    const url = `${process.env.ODOO_URL}/web/session/authenticate`;

    const payload = {
      jsonrpc: "2.0",
      method: "call",
      params: {
        db: process.env.ODOO_DB,
        login: process.env.ODOO_USER,
        password: process.env.ODOO_API_KEY
      }
    };

    const od = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!od.ok) {
      return res.status(500).json({ status: "error", message: "HTTP error" });
    }

    const data = await od.json();

    if (data.error) {
      return res.status(401).json({ status: "error", message: "Auth failed", detail: data.error });
    }

    return res.status(200).json({ status: "ok", message: "Authentication successful" });

  } catch (err) {
    return res.status(500).json({ status: "error", message: "Server error", detail: err.message });
  }
}
