'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   TIPO DE CAMBIO A PESOS — motor único (Máxima 1).
   Monedas: CLP (1), UF (motor shared/uf.js), UTM y USD (mantenedor de indicadores,
   última cotización ≤ fecha). Sin cotización → error explícito: nadie inventa un
   monto. Nació en Pagos Recurrentes (08-2026) y se extrajo el 08-09-2026 para que
   los Descuentos de Remuneración en UF/UTM/USD usen exactamente la misma conversión.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('./config/database');
const { getUF } = require('./uf');

const MONEDAS = ['CLP', 'UF', 'UTM', 'USD'];
const ETIQUETA = { CLP: 'Pesos', UF: 'UF', UTM: 'UTM', USD: 'Dólares' };

async function tipoCambio(moneda, fechaISO) {
  moneda = String(moneda || 'CLP').toUpperCase();
  if (moneda === 'CLP') return 1;
  if (moneda === 'UF') {
    const v = await getUF(fechaISO);
    if (v) return v;
    const [[u]] = await pool.query('SELECT valor FROM uf ORDER BY fecha DESC LIMIT 1');
    if (u) return parseFloat(u.valor);
    throw new Error('No hay UF cargada');
  }
  const tabla = moneda === 'UTM' ? 'utm' : moneda === 'USD' ? 'dolar' : null;
  if (!tabla) throw new Error('Moneda no soportada: ' + moneda);
  const [[r]] = await pool.query(`SELECT valor, fecha FROM ${tabla} WHERE fecha <= ? ORDER BY fecha DESC LIMIT 1`, [fechaISO]);
  if (!r) throw new Error(`No hay ${moneda} cargado en el mantenedor de indicadores`);
  return parseFloat(r.valor);
}

/* Los cuatro tipos de cambio de una fecha, para convertir muchos montos con una
   sola consulta por moneda. Una moneda sin cotización queda en null (no lanza). */
async function tiposCambio(fechaISO) {
  const out = { CLP: 1 };
  for (const m of ['UF', 'UTM', 'USD']) {
    try { out[m] = await tipoCambio(m, fechaISO); } catch (_) { out[m] = null; }
  }
  return out;
}

/* Fecha de referencia para un MES 'YYYY-MM': el último día del mes, o hoy si el
   mes todavía no termina (una cotización futura no existe). */
function fechaDeMes(mes) {
  const [y, m] = String(mes).split('-').map(Number);
  const fin = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const hoy = new Date().toISOString().slice(0, 10);
  return fin < hoy ? fin : hoy;
}

const aCLP = (montoOrigen, tc) => Math.round((parseFloat(montoOrigen) || 0) * (parseFloat(tc) || 0));

module.exports = { MONEDAS, ETIQUETA, tipoCambio, tiposCambio, fechaDeMes, aCLP };
