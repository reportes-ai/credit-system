/* ─────────────────────────────────────────────────────────────────────────────
   ALINEACIÓN DE ETAPA — OP 88558 (AUTOMOTORA SALAZAR SPA, Unidad de Crédito)

   Qué pasaba: `estado_credito` y `estado_eval` decían ANULADO, pero `estado`
   había quedado en OTORGADO. Como el listado resuelve la etapa leyendo `estado`
   PRIMERO, un crédito anulado se seguía mostrando como otorgado.

   NO viene del módulo Anular Operación: no tiene fila en `anulaciones_operacion`
   ni la nota "| ANULADA …" en `comentarios` que ese flujo deja. Se anuló por otra
   vía (edición directa o carga), que escribió solo dos de las tres columnas.
   Confirmado por Pato el 31-07-2026: la operación está efectivamente anulada.

   Reversible: valores previos en scripts/respaldo-etapas-88558-2026-07-31.json
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const pool = require('../shared/config/database');

(async () => {
  const [[c]] = await pool.query(
    `SELECT id, num_op, id_financiera, estado, estado_credito, estado_eval
       FROM creditos WHERE num_op = 88558`);
  if (!c) { console.log('No existe la OP 88558'); process.exit(1); }
  console.log('ANTES  :', c.estado, '/', c.estado_credito, '/', c.estado_eval);

  fs.writeFileSync(path.join(__dirname, 'respaldo-etapas-88558-2026-07-31.json'),
    JSON.stringify(c, null, 2));

  await pool.query(
    `UPDATE creditos SET estado='ANULADO', estado_credito='ANULADO', estado_eval='ANULADO'
      WHERE id = ?`, [c.id]);

  const [[d]] = await pool.query(
    'SELECT estado, estado_credito, estado_eval FROM creditos WHERE id = ?', [c.id]);
  console.log('DESPUÉS:', d.estado, '/', d.estado_credito, '/', d.estado_eval);

  // La anulación solo vale si además no quedó comisión viva en la cartola.
  const [cm] = await pool.query(
    'SELECT id, movimiento, mes_cartola FROM cartolas_movimientos WHERE num_op IN (?, ?)',
    [String(c.num_op), String(c.id_financiera)]);
  console.log('Movimientos en cartola:', cm.length ? JSON.stringify(cm) : 'ninguno ✔');
  process.exit(0);
})();
