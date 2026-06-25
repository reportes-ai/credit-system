'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Modo DESARROLLO — accessor compartido (cacheado).
   Cuando está activo, TODAS las comunicaciones (correo; a futuro WhatsApp) se
   redirigen a los correos/numero de prueba configurados en el mantenedor
   "Mantención de Sistema" (tabla mantenimiento_config, claves dev_*). Así se evita
   mandar mails reales a clientes, dealers, proveedores, etc.
   Control exclusivo de BG-ADMIN (la escritura se gatea en su controller).
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('./config/database');

let _cache = null, _ts = 0;
const TTL = 30000; // 30s

async function getDevMode() {
  if (_cache && (Date.now() - _ts) < TTL) return _cache;
  try {
    const [rows] = await pool.query("SELECT clave, valor FROM mantenimiento_config WHERE clave LIKE 'dev_%'");
    const m = {}; rows.forEach(r => { m[r.clave] = r.valor; });
    const correos = [];
    for (const i of [1, 2, 3]) {
      const e = String(m['dev_correo' + i] || '').trim();
      if (e) correos.push({ email: e, rol: String(m['dev_correo' + i + '_rol'] || 'to').toLowerCase() });
    }
    _cache = { activo: m.dev_activo === '1', correos, whatsapp: String(m.dev_whatsapp || '').trim() };
  } catch (_) {
    _cache = { activo: false, correos: [], whatsapp: '' };
  }
  _ts = Date.now();
  return _cache;
}

// Reparte los correos de dev por rol → { to, cc, bcc } (strings separados por coma).
// Si ninguno es 'to', el primero se usa como 'to' (el correo necesita destinatario).
function destinosDev(dev) {
  const por = r => dev.correos.filter(c => c.rol === r).map(c => c.email);
  let to = por('to'); const cc = por('cc'), bcc = por('bcc');
  if (!to.length && dev.correos.length) to = [dev.correos[0].email];
  return {
    to:  to.join(','),
    cc:  cc.length ? cc.join(',') : undefined,
    bcc: bcc.length ? bcc.join(',') : undefined,
  };
}

module.exports = { getDevMode, destinosDev };
