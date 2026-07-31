/* ─────────────────────────────────────────────────────────────────────────────
   ALINEACIÓN DE ETAPA — OP 89343 (AUTEN, ID financiera 6176412)

   Qué pasaba: la etapa vive en TRES columnas (`estado`, `estado_credito`,
   `estado_eval`) y en esta operación discrepaban — `estado` decía OTORGADO
   mientras las otras dos seguían en APROBADO. El listado resuelve la etapa
   leyendo `estado` PRIMERO, así que la operación se veía otorgada, pero
   cualquier consumidor que mire `estado_credito` (vendedores con ventas,
   fundantes, cartolas) la dejaba fuera.

   Evidencia de que SÍ se otorgó: `fecha_otorgado` = 23-07-2026 y su carta de
   aprobación 266176412DI está APROBADA. Por eso se alinean las tres a OTORGADO
   y no al revés.

   Reversible: el respaldo con los valores previos queda en
   scripts/respaldo-etapas-89343-2026-07-31.json
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const pool = require('../shared/config/database');

const NUM_OP = 89343;

(async () => {
  const [[c]] = await pool.query(
    `SELECT id, num_op, id_financiera, estado, estado_credito, estado_eval, fecha_otorgado
       FROM creditos WHERE num_op = ?`, [NUM_OP]);
  if (!c) { console.log('No existe la OP', NUM_OP); process.exit(1); }

  console.log('ANTES :', c.estado, '/', c.estado_credito, '/', c.estado_eval);

  if (!c.fecha_otorgado) {
    console.log('Sin fecha_otorgado: NO se alinea a OTORGADO. Revisar a mano.');
    process.exit(1);
  }

  fs.writeFileSync(
    path.join(__dirname, 'respaldo-etapas-89343-2026-07-31.json'),
    JSON.stringify(c, null, 2));

  const [r] = await pool.query(
    `UPDATE creditos
        SET estado = 'OTORGADO', estado_credito = 'OTORGADO', estado_eval = 'OTORGADO'
      WHERE id = ?`, [c.id]);

  const [[d]] = await pool.query(
    'SELECT estado, estado_credito, estado_eval FROM creditos WHERE id = ?', [c.id]);
  console.log('DESPUÉS:', d.estado, '/', d.estado_credito, '/', d.estado_eval, `(${r.affectedRows} fila)`);
  process.exit(0);
})();
