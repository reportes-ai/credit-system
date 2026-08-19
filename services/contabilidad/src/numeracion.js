'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   MOTOR ÚNICO de numeración de comprobantes contables (correlativo POR MES).

   numero = MM*10000 + secuencia mensual → se muestra T-2026-080001
   (08 = agosto, 0001 = primer comprobante del mes). La unicidad la sigue
   dando uq_tipo_anio_num: el mes va codificado dentro de `numero`.

   Los comprobantes ANTERIORES a este cambio (numero < 10000, correlativo
   anual puro) conservan su número histórico tal como fue emitido:
   T-2026-00295 se sigue mostrando igual. Solo cambia cómo nacen los nuevos.
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
