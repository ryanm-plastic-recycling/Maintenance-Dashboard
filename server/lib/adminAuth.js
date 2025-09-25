// server/lib/adminAuth.js (ESM)
export const ADMIN_USER  = process.env.BASIC_AUTH_USER || '';
export const ADMIN_PASS  = process.env.BASIC_AUTH_PASS || '';
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN     || '';

function unauthorized(res, realm='PACE Admin') {
  res.set('WWW-Authenticate', `Basic realm="${realm}"`);
  return res.status(401).json({ ok:false, error:'unauthorized' });
}

export function requireBasicAuth(req, res, next) {
  if (!ADMIN_USER || !ADMIN_PASS) return unauthorized(res);
  const hdr = req.headers.authorization || '';
  if (!hdr.startsWith('Basic ')) return unauthorized(res);
  const [u,p] = Buffer.from(hdr.slice(6), 'base64').toString().split(':',2);
  if (u === ADMIN_USER && p === ADMIN_PASS) return next();
  return unauthorized(res);
}

export function requireBearer(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(401).json({ ok:false, error:'unauthorized' });
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : (req.query.admin_token || '');
  if (token === ADMIN_TOKEN) return next();
  return res.status(401).json({ ok:false, error:'unauthorized' });
}

export function requireAdmin(req, res, next) {
  if (ADMIN_TOKEN && (req.headers.authorization?.startsWith('Bearer ') || req.query.admin_token)) {
    return requireBearer(req, res, next);
  }
  return requireBasicAuth(req, res, next);
}

console.log('[adminAuth] basic?', !!ADMIN_USER && !!ADMIN_PASS, 'bearer?', !!ADMIN_TOKEN);
