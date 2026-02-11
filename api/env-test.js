export default function handler(req, res) {
  return res.status(200).json({
    ok: true,
    url: process.env.ODOO_URL,
    db: process.env.ODOO_DB,
    user: process.env.ODOO_USER
  });
}
