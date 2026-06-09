'use strict';
const pool = require('../../../../shared/config/database');

function toDateStr(fecha) {
  if (!fecha) return null;
  return (fecha instanceof Date ? fecha.toISOString() : fecha.toString()).slice(0, 10);
}

async function getUF(fecha) {
  if (!fecha) return null;
  const f = toDateStr(fecha);
  const [rows] = await pool.query('SELECT valor FROM uf WHERE fecha = ? LIMIT 1', [f]);
  return rows.length ? parseFloat(rows[0].valor) : null;
}

async function getTasaByFecha(fecha) {
  if (!fecha) return null;
  const f = toDateStr(fecha);
  const [rows] = await pool.query(`
    SELECT tasa_mensual_menor, tasa_mensual_mayor, spread_menor, spread_mayor
    FROM tasas
    WHERE fecha_desde <= ? AND fecha_hasta >= ?
    LIMIT 1
  `, [f, f]);
  if (rows.length) return rows[0];
  // Si no hay registro exacto, usar el más reciente anterior
  const [prev] = await pool.query(
    'SELECT tasa_mensual_menor, tasa_mensual_mayor, spread_menor, spread_mayor FROM tasas WHERE fecha_hasta < ? ORDER BY fecha_hasta DESC LIMIT 1',
    [f]
  );
  return prev.length ? prev[0] : null;
}

/**
 * Recalcula monto_comision_fin para ops recién insertadas.
 * Fórmula PV spread usando tasas históricas por fecha_otorgado.
 * @param {Array<{num_op, mes, financiera}>} ops
 * @returns {number} cantidad de registros actualizados
 */
async function calcularComisionFin(ops) {
  if (!ops.length) return 0;
  let actualizados = 0;

  for (const op of ops) {
    const [rows] = await pool.query(
      'SELECT monto_financiado, monto_capitalizado, plazo, fecha_otorgado FROM creditos WHERE num_op = ? LIMIT 1',
      [op.num_op]
    );
    if (!rows.length) continue;

    const montoCap  = parseFloat(rows[0].monto_capitalizado) || parseFloat(rows[0].monto_financiado) || 0;
    const plazo     = parseInt(rows[0].plazo) || 0;
    const fechaOt   = rows[0].fecha_otorgado;

    if (plazo <= 0 || montoCap <= 0) continue;

    const tasa = await getTasaByFecha(fechaOt);
    if (!tasa) continue;

    const uf         = await getUF(fechaOt);
    const limite_200 = uf ? 200 * uf : null;
    const esMayor200 = limite_200 ? montoCap > limite_200 : false;
    const tasa_cli   = (esMayor200
      ? parseFloat(tasa.tasa_mensual_mayor)
      : parseFloat(tasa.tasa_mensual_menor)) / 100;
    const spread_val = (esMayor200
      ? parseFloat(tasa.spread_mayor)
      : parseFloat(tasa.spread_menor)) / 100;
    const costo_fondo = tasa_cli - spread_val;

    if (tasa_cli <= 0 || costo_fondo <= 0) continue;

    const cuota = montoCap * tasa_cli * Math.pow(1 + tasa_cli, plazo)
                / (Math.pow(1 + tasa_cli, plazo) - 1);
    const pv = cuota * (1 - Math.pow(1 + costo_fondo, -plazo)) / costo_fondo;
    const monto_comision_fin = Math.round(pv - montoCap);

    await pool.query(
      'UPDATE creditos SET monto_comision_fin = ? WHERE num_op = ?',
      [monto_comision_fin, op.num_op]
    );
    actualizados++;
  }

  return actualizados;
}

module.exports = { calcularComisionFin };
