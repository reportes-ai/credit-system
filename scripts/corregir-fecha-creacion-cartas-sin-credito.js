'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Segunda pasada del arreglo de fecha_creacion (ver
   scripts/corregir-fecha-creacion-cartas.js para el origen del daño).

   Aquí van las cartas SIN crédito asociado, donde no hay una hora real contra la
   cual comparar. El ancla es más débil pero igual de firme en un punto: una carta
   no puede haber nacido después de que la aprobaron. Se resta el mínimo número de
   saltos de 4 horas que la deja antes de su propia aprobación — es una ESTIMACIÓN
   del piso, no la hora exacta.

   Quedan FUERA, a propósito:
   - Las 371 de la migración del 13-06-2026 (14:20 a 14:37). No las movió el bug:
     esa es la hora en que se cargaron, y sus documentos son de enero a junio.
     Restarles horas no recupera nada porque nunca tuvieron hora de digitación.
   - Excesos mayores a 48 h, que el bug no explica.

   Uso:  node scripts/corregir-fecha-creacion-cartas-sin-credito.js            (simula)
         node scripts/corregir-fecha-creacion-cartas-sin-credito.js --aplicar
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../shared/config/database');

const APLICAR  = process.argv.includes('--aplicar');
const PASO_MIN = 240;    // 4 horas
const TOPE_MIN = 2880;   // 48 horas: más allá, la causa es otra

const fmt = d => new Date(d).toLocaleString('es-CL');

(async () => {
  const [filas] = await pool.query(`
    SELECT id, op_carta, fecha_creacion, fecha_aprobacion,
           TIMESTAMPDIFF(MINUTE, fecha_aprobacion, fecha_creacion) AS exceso
      FROM cartas_aprobacion
     WHERE fecha_aprobacion IS NOT NULL
       AND fecha_creacion > fecha_aprobacion
       AND NOT (DATE(fecha_creacion) = '2026-06-13' AND TIME(fecha_creacion) BETWEEN '14:00' AND '15:00')
       AND TIMESTAMPDIFF(MINUTE, fecha_aprobacion, fecha_creacion) <= ?
     ORDER BY id`, [TOPE_MIN]);

  const plan = filas.map(f => {
    const saltos = Math.ceil(f.exceso / PASO_MIN);
    return { ...f, saltos, nueva: new Date(new Date(f.fecha_creacion).getTime() - saltos * PASO_MIN * 60000) };
  });

  console.log(`Cartas a estimar: ${plan.length}`);
  plan.slice(0, 10).forEach(p =>
    console.log(`  ${String(p.op_carta || '(sin número)').padEnd(16)} ${fmt(p.fecha_creacion)} → ${fmt(p.nueva)}   (−${p.saltos * 4} h)`));
  if (plan.length > 10) console.log(`  … y ${plan.length - 10} más`);

  if (!APLICAR) { console.log('\nSIMULACIÓN. Para escribir: --aplicar'); process.exit(0); }

  const respaldo = path.join(__dirname, `respaldo-fecha-creacion-estimada-${Date.now()}.json`);
  fs.writeFileSync(respaldo, JSON.stringify(plan.map(p =>
    ({ id: p.id, op_carta: p.op_carta, antes: p.fecha_creacion, despues: p.nueva, saltos: p.saltos })), null, 2));
  console.log(`\nRespaldo: ${respaldo}`);

  let ok = 0, sinEfecto = 0;
  for (const p of plan) {
    const [r] = await pool.query(
      'UPDATE cartas_aprobacion SET fecha_creacion = ? WHERE id = ? AND fecha_creacion = ?',
      [p.nueva, p.id, p.fecha_creacion]);
    if (r.affectedRows === 1) ok++; else { sinEfecto++; console.log(`  ⚠ sin efecto: ${p.op_carta}`); }
  }
  console.log(`\nCorregidas: ${ok}${sinEfecto ? ` · sin efecto: ${sinEfecto}` : ''}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
