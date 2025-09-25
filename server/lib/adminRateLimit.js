// server/lib/adminRateLimit.js (ESM)
import rateLimit from 'express-rate-limit';
import slowDown  from 'express-slow-down';

// identify caller by admin token (if present) or IP
function tokenOrIp(req){
  const hdr = req.headers.authorization || '';
  if (hdr.startsWith('Bearer ')) return 'tok:' + hdr.slice(7);
  // Basic user (optional): treat all basic tries per IP
  if (hdr.startsWith('Basic ')) return 'ip:' + req.ip;
  return 'ip:' + req.ip;
}

// Soft throttle: add delay as calls increase (discourages scraping)
export const adminSlowdown = slowDown({
  windowMs: 60_000,          // 1 minute window
  delayAfter: 5,             // after 5 reqs/min, start delaying
  delayMs: 250,              // +250ms per extra request
  keyGenerator: tokenOrIp,
});

// Hard cap: block bursts
export const adminLimiter = rateLimit({
  windowMs: 10 * 60_000,     // 10 minute window
  max: 50,                   // 50 admin calls / 10 min / token-or-ip
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: tokenOrIp,
  message: { ok:false, error:'Too many requests to admin API. Try again soon.' },
});

// Separate limiter for *auth attempts* (Basic-only, by IP)
export const adminAuthLimiter = rateLimit({
  windowMs: 10 * 60_000,
  max: 20,                   // 20 attempts / 10 min / IP
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  skip: (req) => (req.headers.authorization||'').startsWith('Bearer '), // don’t count token uses
  message: { ok:false, error:'Too many auth attempts. Try later.' },
});
