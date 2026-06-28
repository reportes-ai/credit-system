'use strict';
/* ─────────────────────────────────────────────────────────────────
   rateLimit — limitador en memoria, sin dependencias.
   Suficiente para una sola instancia (el gateway corre como un proceso
   en Render). Ventana deslizante por clave lógica + IP del cliente.

   Uso:
     const { rateLimit } = require('../../../../shared/middleware/rate-limit');
     router.post('/login', rateLimit({ key:'login', windowMs: 15*60*1000, max: 8 }), ctrl.login);
   ───────────────────────────────────────────────────────────────── */
const buckets = new Map(); // id -> [timestamps]

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : '') ||
         req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}

function rateLimit({ windowMs = 60000, max = 30, key = 'rl', keyFn } = {}) {
  return (req, res, next) => {
    try {
      const id = key + ':' + (keyFn ? keyFn(req) : clientIp(req));
      const now = Date.now();
      let arr = buckets.get(id);
      if (!arr) { arr = []; buckets.set(id, arr); }
      while (arr.length && arr[0] <= now - windowMs) arr.shift();
      if (arr.length >= max) {
        const retry = Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000));
        res.setHeader('Retry-After', String(retry));
        return res.status(429).json({ success: false, data: null, error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
      }
      arr.push(now);
      next();
    } catch (_) { next(); } // ante cualquier error del limitador, no bloquear el flujo
  };
}

// Limpieza horaria para que el Map no crezca indefinidamente.
const _timer = setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets) {
    while (arr.length && arr[0] <= now - 24 * 3600 * 1000) arr.shift();
    if (!arr.length) buckets.delete(k);
  }
}, 3600 * 1000);
if (_timer.unref) _timer.unref();

module.exports = { rateLimit, clientIp };
