'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   MOTOR ÚNICO del SLA de pago del Saldo Precio.

   La regla vive en el mantenedor Categoría y Potencial Dealer:
     · dealer_categorias.pago_horas_habiles → horas hábiles por categoría
       (Socio 72 · Partner 48 · Super Partner 24)
     · parametros_credito.sp_fundantes_corte_hora → hora de corte (14:00):
       fundantes recibidos e ingresados ANTES del corte, el plazo corre desde
       ese día; después, desde el día hábil siguiente.

   Consumidores: Saldo Precio en Proceso de Pago (Tesorería), Saldos Precios
   a Pagar (Post Venta). Días hábiles = lun–vie sin feriados (shared/feriados).
   ═══════════════════════════════════════════════════════════════════════════ */
const pool = require('./config/database');
const { sumarDiasHabiles } = require('./feriados');

let _cache = null, _exp = 0;
async function config() {
  if (_cache && _exp > Date.now()) return _cache;
  const out = { horas: { SOCIO: 72, PARTNER: 48, SUPER_PARTNER: 24 }, corte: 14 };
  try {
    const [cats] = await pool.query('SELECT codigo, pago_horas_habiles FROM dealer_categorias');
    for (const c of cats) if (Number(c.pago_horas_habiles) > 0) out.horas[String(c.codigo).toUpperCase()] = Number(c.pago_horas_habiles);
  } catch (_) {}
  try {
    const [[r]] = await pool.query("SELECT valor FROM parametros_credito WHERE clave='sp_fundantes_corte_hora'");
    const h = r ? parseInt(r.valor, 10) : NaN;
    if (h >= 0 && h <= 23) out.corte = h;
  } catch (_) {}
  _cache = out; _exp = Date.now() + 60 * 1000;
  return out;
}

/* Horas del SLA para una categoría (acepta variantes sin guión bajo). */
function horasDe(categoria, cfg) {
  const k = String(categoria || 'SOCIO').toUpperCase().trim();
  return cfg.horas[k] || cfg.horas[k.replace(/[\s_]/g, '')] ||
    (k.replace(/[\s_]/g, '') === 'SUPERPARTNER' ? cfg.horas.SUPER_PARTNER : null) ||
    cfg.horas.SOCIO || 72;
}

const fmt = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

/* Hora de PARED (Chile) de un DATETIME leído de la base, reconstruida con el mismo offset con
   que mysql2 lo interpretó (pool.offsetBD). Devuelve un Date "local" con esos componentes, para
   que getHours()/getDate()/getDay() den la hora y el día de Chile en cualquier servidor.
   (10-09-2026: la API de JM devolvía vencimientos un día hábil antes — getHours() en un host
   con otro reloj marcaba AM fundantes recibidos a las 14:11.) */
function horaPared(valor) {
  const d = new Date(valor);
  if (isNaN(d)) return null;
  const off = String(pool.offsetBD ? pool.offsetBD() : '') ;
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(off);
  if (m) {
    const min = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
    const u = new Date(d.getTime() + min * 60000);
    return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds());
  }
  const s = d.toLocaleString('sv-SE', { timeZone: off || 'America/Santiago' });   // 'YYYY-MM-DD HH:mm:ss'
  return new Date(s.replace(' ', 'T'));
}

/* Fecha de vencimiento del pago: recepción de fundantes + horas hábiles de la
   categoría, con la hora de corte. Devuelve
   { fecha: Date, iso, horas, hora: 'HH:mm', ampm, base: 'YYYY-MM-DD' (desde cuándo corre) } o null. */
function vencimiento(recepcion, categoria, cfg) {
  if (!recepcion) return null;
  const horas = horasDe(categoria, cfg);
  const d = horaPared(recepcion);
  if (!d) return null;
  const pm = d.getHours() >= cfg.corte;
  const base = pm ? sumarDiasHabiles(d, 1) : d;
  const fecha = sumarDiasHabiles(base, Math.ceil(horas / 24));
  return { fecha, iso: fmt(fecha), horas, base: fmt(base), ampm: pm ? 'PM' : 'AM',
           hora: String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') };
}

module.exports = { config, vencimiento, horasDe, horaPared };
