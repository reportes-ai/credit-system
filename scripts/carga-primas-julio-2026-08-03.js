'use strict';
/* Reposición de las primas de seguro de 10 operaciones de julio 2026 que quedaron
   en NULL: la carga del Informe Canal las había truncado (normInt leía el punto de
   miles chileno como decimal, "320.118" → 320) y el 02-08 se anularon a la espera
   de la recarga. Valores entregados por Pato desde el Informe Canal (03-08-2026).
   Idempotente: solo escribe donde la columna está NULL o quedó bajo el piso válido. */
const pool = require('../shared/config/database');

const DATOS = [
  // num_op,  rdh,      rep_menor, cesantia
  [89283,     892129,   0,         0],
  [89246,     577150,   0,         0],
  [89285,     686854,   480335,    507976],
  [89216,     320118,   0,         0],
  [89191,     306857,   362702,    266429],
  [6189618,   204951,   0,         0],
  [89198,     358881,   0,         0],
  [89286,     252146,   362702,    218926],
  [89212,     367718,   480335,    271952],
  [6189286,   115640,   0,         0],
];

(async () => {
  const ids = [];
  for (const [op, rdh, rep, ces] of DATOS) {
    const [[c]] = await pool.query(
      'SELECT id, num_op, seguro_rdh, seguro_cesantia, seguro_rep_menor FROM creditos WHERE num_op=? LIMIT 1', [op]);
    if (!c) { console.log(`⚠ ${op}: no existe`); continue; }
    const total = rdh + rep + ces;
    await pool.query(
      `UPDATE creditos SET seguro_rdh=?, seguro_rep_menor=?, seguro_cesantia=?, seguros=?, updated_at=NOW()
        WHERE id=?`, [rdh, rep, ces, total, c.id]);
    ids.push(c.id);
    console.log(`✓ ${op}  RDH ${rdh.toLocaleString('es-CL')} · Rep ${rep.toLocaleString('es-CL')} · Ces ${ces.toLocaleString('es-CL')} → total ${total.toLocaleString('es-CL')}`);
  }
  console.log(`\n${ids.length} operaciones actualizadas. Recalculando…`);
  const { recalcularPorOps } = require('../services/creditos/src/utils/recalcular-mes');
  await recalcularPorOps(ids);
  console.log('Recálculo listo.');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
