// Limitador de peticiones en memoria por IP (sin dependencias).
// Ventana deslizante: guarda timestamps por IP y descarta los fuera de la ventana.
// Uso: router.post('/login', rateLimit({ ventanaMs: 60000, max: 10 }), login)
// Requiere app.set('trust proxy', 1) para que req.ip sea la IP real detrás de Render.

function rateLimit({ ventanaMs = 60000, max = 10, mensaje = 'Demasiados intentos. Espera un momento e intenta de nuevo.' } = {}) {
  const hits = new Map(); // ip -> [timestamps]

  // Limpieza periódica para que el Map no crezca sin límite
  const limpiador = setInterval(() => {
    const corte = Date.now() - ventanaMs;
    for (const [ip, ts] of hits) {
      const vivos = ts.filter(t => t > corte);
      if (vivos.length) hits.set(ip, vivos); else hits.delete(ip);
    }
  }, ventanaMs);
  if (limpiador.unref) limpiador.unref();

  return function (req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || 'desconocida';
    const ahora = Date.now();
    const corte = ahora - ventanaMs;
    const ts = (hits.get(ip) || []).filter(t => t > corte);
    if (ts.length >= max) {
      const esperaSeg = Math.ceil((ts[0] + ventanaMs - ahora) / 1000);
      res.set('Retry-After', String(esperaSeg));
      return res.status(429).json({ success: false, data: null, error: mensaje });
    }
    ts.push(ahora);
    hits.set(ip, ts);
    next();
  };
}

module.exports = rateLimit;
