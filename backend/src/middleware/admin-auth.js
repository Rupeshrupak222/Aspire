// Admin authentication middleware.
// Accepts the token via `x-admin-token` header or `Authorization: Bearer <token>`.
// Uses a timing-safe comparison against process.env.ADMIN_TOKEN.
const crypto = require('crypto');

function adminAuth(req, res, next) {
  const expected = process.env.ADMIN_TOKEN || '';
  let got = req.headers['x-admin-token'] || '';
  const auth = req.headers['authorization'] || '';
  if (!got && auth.startsWith('Bearer ')) got = auth.slice(7);
  if (!expected) return res.status(500).json({ error: 'ADMIN_TOKEN is not configured on the server' });
  const a = Buffer.from(String(got));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = adminAuth;
