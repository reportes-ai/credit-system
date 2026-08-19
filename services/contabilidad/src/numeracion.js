'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   MOTOR ÚNICO de numeración de comprobantes contables (correlativo POR MES).

   numero = MM*10000 + secuencia mensual → se muestra T-2026-080001
   (08 = agosto, 0001 = primer comprobante del mes). La unicidad la sigue
   dando uq_tipo_anio_num: el mes va codificado dentro de `numero`.

   Lo histórico se renumeró al mismo formato (one-shot de más abajo), así que
   TODO el libro queda con numeración mensual homogénea.
   ═══════════════════════════════════════════════════════════════════════════ */
const RANGO = 10000;   // 4 dígitos de secuencia por mes (tope 9.999/mes por tipo)

/* Siguiente número del mes (dentro de una transacción, con FOR UPDATE).
   `offset` permite el reintento anti-carrera del motor de asientos. */
async function siguienteNumero(conn, tipo, anio, mes, offset = 0) {
  const base = Number(mes) * RANGO;
  const [[{ sig }]] = await conn.query(
    'SELECT COALESCE(MAX(numero), ?) + 1 sig FROM ctb_comprobantes WHERE tipo=? AND anio=? AND numero BETWEEN ? AND ? FOR UPDATE',
    [base, tipo, anio, base, base + RANGO - 1]);
  return Number(sig) + offset;
}

/* Formato visible. 6 dígitos para los mensuales (MM + 4), 5 para los
   históricos anuales — así ningún número ya impreso cambia. */
const fmtComprobante = (tipo, anio, numero) =>
  `${String(tipo)[0]}-${anio}-${String(numero).padStart(Number(numero) >= RANGO ? 6 : 5, '0')}`;

module.exports = { siguienteNumero, fmtComprobante, RANGO };

/* ── One-shot: renumerar TODO lo histórico al formato mensual ────────────────
   Autorizado por Pato (19-08-2026, "renumera todo — aún no estamos trabajando
   con la contabilidad"): cada comprobante existente toma numero = MM*10000 +
   secuencia del mes, ordenado por fecha e id dentro de su tipo+año. Tras esto
   ya no quedan números del formato anual viejo (< 10000). */
const pool = require('../../../shared/config/database');
require('../../../shared/migrate').migrar('ctb-renumerar-mensual-v1', async () => {
  // 1) Estacionar los números altos de corridas parciales para no chocar con uq_tipo_anio_num
  await pool.query('UPDATE ctb_comprobantes SET numero = numero + 1000000 WHERE numero >= ?', [RANGO]);
  // 2) Reasignar por tipo+año, en orden cronológico, secuencia por mes
  const [grupos] = await pool.query('SELECT DISTINCT tipo, anio FROM ctb_comprobantes');
  for (const g of grupos) {
    const [rows] = await pool.query(
      'SELECT id, MONTH(fecha) mes FROM ctb_comprobantes WHERE tipo=? AND anio=? ORDER BY fecha, id', [g.tipo, g.anio]);
    const seq = {};
    for (const r of rows) {
      const m = Number(r.mes) || 12;
      seq[m] = (seq[m] || 0) + 1;
      await pool.query('UPDATE ctb_comprobantes SET numero=? WHERE id=?', [m * RANGO + seq[m], r.id]);
    }
    console.log(`[ctb renumerar] ${g.tipo} ${g.anio}: ${rows.length} comprobantes al formato mensual`);
  }
});
