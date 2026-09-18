'use strict';
/* Tope legal art. 58 CT (motor único — Máxima 1): la cuota de un descuento ACORDADO
   (anticipo, préstamo) no puede superar el 15% de la remuneración total del trabajador.
   Base: total haberes de la última liquidación EMITIDA; si no hay, sueldo base de la
   ficha. Sin referencia no se valida (RRHH decide). Lo usan Solicitudes (paso RRHH) y
   el registro directo en Descuentos (Pato, 17-09-2026). */
const pool = require('../../../shared/config/database');

async function validarTope15(idUsuario, valorCuota) {
  const [[liq]] = await pool.query(
    `SELECT total_haberes FROM rh_liquidaciones WHERE id_usuario=? AND estado='EMITIDA' ORDER BY mes DESC LIMIT 1`, [idUsuario]);
  let base = Number(liq?.total_haberes) || 0;
  if (!base) { const [[f]] = await pool.query(`SELECT sueldo_base FROM rh_fichas WHERE id_usuario=?`, [idUsuario]); base = Number(f?.sueldo_base) || 0; }
  if (!base) return;
  const tope = Math.round(base * 0.15);
  if (valorCuota > tope) throw new Error(
    `La cuota de $${valorCuota.toLocaleString('es-CL')} supera el tope legal del 15% de la remuneración (art. 58 CT): máximo $${tope.toLocaleString('es-CL')} — sube el número de cuotas o baja el monto.`);
}

module.exports = { validarTope15 };
