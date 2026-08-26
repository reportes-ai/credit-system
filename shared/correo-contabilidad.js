/* Para y CC del correo de Órdenes de Pago a Contabilidad.
   Motor único: lo configurado en Post Venta → Mantenedores → «Correo de Orden de
   Pago a Contabilidad» (postventa_config: correo_contabilidad + correo_contabilidad_cc).
   Lo usan el envío de ODP de Post Venta (Saldo Precio y Comisión) y el envío
   manual desde Órdenes de Pago → Historial. */
const pool = require('./config/database');

/* Devuelve { to, cc: [] }. `ccExtra` (ej: el email de quien envía) se suma al CC
   configurado, sin duplicar y sin repetir al destinatario. */
async function destinatariosContabilidad(ccExtra) {
  let to = 'contabilidad@autofacilchile.cl', cc = [];
  try {
    const [rows] = await pool.query(
      "SELECT clave, valor FROM postventa_config WHERE clave IN ('correo_contabilidad','correo_contabilidad_cc')");
    for (const r of rows) {
      let v; try { v = JSON.parse(r.valor); } catch (_) { continue; }
      if (r.clave === 'correo_contabilidad' && v && String(v).trim()) to = String(v).trim();
      if (r.clave === 'correo_contabilidad_cc' && v)
        cc = String(v).split(/[,;]/).map(s => s.trim()).filter(Boolean);
    }
  } catch (_) {}
  for (const e of (Array.isArray(ccExtra) ? ccExtra : [ccExtra])) {
    const m = String(e || '').trim();
    if (m && !cc.some(x => x.toLowerCase() === m.toLowerCase())) cc.push(m);
  }
  cc = cc.filter(x => x.toLowerCase() !== to.toLowerCase());
  return { to, cc: cc.length ? cc : undefined };
}

module.exports = { destinatariosContabilidad };
