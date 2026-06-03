'use strict';
const pool = require('../../../../shared/config/database');

async function getParams() {
  const [rows] = await pool.query('SELECT clave, valor FROM parametros_credito');
  const p = {};
  rows.forEach(r => { p[r.clave] = parseFloat(r.valor); });
  return p;
}

async function getUF(fecha) {
  if (!fecha) return null;
  const f = fecha.toString().slice(0, 10);
  const [rows] = await pool.query('SELECT valor FROM uf WHERE fecha = ? LIMIT 1', [f]);
  return rows.length ? parseFloat(rows[0].valor) : null;
}

async function contarOpsUAC(mesStr) {
  const [rows] = await pool.query(`
    SELECT COUNT(*) AS cnt FROM operaciones_brokerage
    WHERE DATE_FORMAT(mes,'%Y-%m') = ?
      AND (financiera LIKE '%UNIDAD%' OR financiera LIKE '%UAC%')
      AND estado_credito IN ('OTORGADO','APROBADO')
  `, [mesStr]);
  return parseInt(rows[0]?.cnt) || 0;
}

/**
 * Recalcula monto_comision_fin para ops recién insertadas sin ese valor.
 * Para UNIDAD/UAC: usa el conteo total del mes YA en BD (post-insert, tier correcto).
 * Para AUTOFIN: usa fórmula PV spread.
 * @param {Array<{num_op, mes, financiera}>} ops
 * @returns {number} cantidad de registros actualizados
 */
async function calcularComisionFin(ops) {
  if (!ops.length) return 0;
  const p = await getParams();
  let actualizados = 0;

  // Agrupar UAC por mes para un solo conteo por mes
  const uacPorMes = {};
  for (const op of ops) {
    const fin = (op.financiera || '').toUpperCase();
    if (fin.includes('UNIDAD') || fin.includes('UAC')) {
      const mesStr = (op.mes || '').slice(0, 7);
      if (mesStr && !uacPorMes[mesStr]) {
        uacPorMes[mesStr] = await contarOpsUAC(mesStr);
      }
    }
  }

  for (const op of ops) {
    const fin = (op.financiera || '').toUpperCase();
    let monto_comision_fin = null;

    if (fin.includes('UNIDAD') || fin.includes('UAC')) {
      // Obtener saldo_precio y mes de la BD (ya insertado)
      const [rows] = await pool.query(
        'SELECT saldo_precio, mes FROM operaciones_brokerage WHERE num_op = ? LIMIT 1',
        [op.num_op]
      );
      if (!rows.length) continue;
      const saldo = parseFloat(rows[0].saldo_precio) || 0;
      const mesRaw = rows[0].mes;
      const mesStr = mesRaw instanceof Date
        ? mesRaw.toISOString().slice(0, 7)
        : (mesRaw || '').toString().slice(0, 7);
      const cnt = uacPorMes[mesStr] || 0;

      let pct = p.uac_pct_tier1 / 100;
      if (cnt >= p.uac_ops_tier2_max) pct = p.uac_pct_tier3 / 100;
      else if (cnt >= p.uac_ops_tier1_max) pct = p.uac_pct_tier2 / 100;

      monto_comision_fin = Math.round(saldo * pct);

    } else if (fin.includes('AUTOFIN') || fin.includes('AUTOF')) {
      const [rows] = await pool.query(
        'SELECT monto_financiado, plazo, fecha_otorgado FROM operaciones_brokerage WHERE num_op = ? LIMIT 1',
        [op.num_op]
      );
      if (!rows.length) continue;
      const monto_fin = parseFloat(rows[0].monto_financiado) || 0;
      const plazo     = parseInt(rows[0].plazo) || 0;
      const uf        = await getUF(rows[0].fecha_otorgado);

      if (plazo > 0 && monto_fin > 0) {
        const tmc_menor   = (p.autofin_tmc_menor_200 / 100) / 12;
        const tmc_mayor   = (p.autofin_tmc_mayor_200 / 100) / 12;
        const spread      = p.autofin_spread_fondo / 100;
        const costo_fondo = tmc_mayor - spread;
        const limite_200  = uf ? 200 * uf : null;
        const tasa_cli    = (limite_200 && monto_fin > limite_200) ? tmc_mayor : tmc_menor;

        if (tasa_cli > 0 && costo_fondo > 0) {
          const cuota = monto_fin * tasa_cli * Math.pow(1 + tasa_cli, plazo)
                      / (Math.pow(1 + tasa_cli, plazo) - 1);
          const pv = cuota * (1 - Math.pow(1 + costo_fondo, -plazo)) / costo_fondo;
          monto_comision_fin = Math.round(pv - monto_fin);
        }
      }
    }

    if (monto_comision_fin !== null) {
      await pool.query(
        'UPDATE operaciones_brokerage SET monto_comision_fin = ? WHERE num_op = ?',
        [monto_comision_fin, op.num_op]
      );
      actualizados++;
    }
  }

  return actualizados;
}

module.exports = { calcularComisionFin };
