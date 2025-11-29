export default function handler(req, res) {
  res.status(200).json({
    ODOO_URL: process.env.ODOO_URL || null,
    ODOO_DB: process.env.ODOO_DB || null,
    ODOO_USER: process.env.ODOO_USER || null,
    ODOO_API_KEY: process.env.ODOO_API_KEY ? "OK" : "MISSING"
  });
}
