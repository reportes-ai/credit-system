'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Tercera y última pasada del arreglo de fecha_creacion en cartas de aprobación.

   Las 371 cartas cargadas en la migración del 13-06-2026 (entre 14:20 y 14:37)
   no fueron víctimas del bug de las 4 horas: esa es, literalmente, la hora en que
   entraron al sistema. Sus documentos son de enero a junio, así que la columna
   decía "cuándo se migró" y no "cuándo se emitió la carta", y cualquier informe
   por fecha de emisión las amontonaba todas en un mismo día de junio.

   Se igualan a la fecha del documento (columna `fecha`), que es el dato correcto
   y ya coincide con su fecha_aprobacion. Se pierde el rastro de cuándo se
   migraron — decisión tomada a conciencia: ese dato no le sirve a nadie y el que
   sí importa estaba mal.

   Uso:  node scripts/alinear-fecha-creacion-migracion.js            (simula)
         node scripts/alinear-fecha-creacion-migracion.js --aplicar
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../shared/config/database');

const APLICAR = process.argv.includes('--aplicar');
// La firma exacta de la carga: mismo día, dentro de la ventana en que corrió.
const VENTANA = `DATE(fecha_creacion) = '2026-06-13' AND TIME(fecha_creacion) BETWEEN '14:00' AND '15:00'`;

(async () => {
  const [filas] = await pool.query(`
    SELECT id, op_carta, fecha_creacion, fecha
      FROM cartas_aprobacion
     WHERE ${VENTANA} AND fecha IS NOT NULL
     ORDER BY fecha, id`);

  console.log(`Cartas de la migración a alinear: ${filas.length}`);
  const porMes = {};
  filas.forEach(f => { const d = new Date(f.fecha); const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; porMes[m] = (porMes[m] || 0) + 1; });
  console.log('Quedarán repartidas por mes de documento:', porMes);

  if (!APLICAR) { console.log('\nSIMULACIÓN. Para escribir: --aplicar'); process.exit(0); }

  const respaldo = path.join(__dirname, `respaldo-fecha-creacion-migracion-${Date.now()}.json`);
  fs.writeFileSync(respaldo, JSON.stringify(filas.map(f =>
    ({ id: f.id, op_carta: f.op_carta, antes: f.fecha_creacion, despues: f.fecha })), null, 2));
  console.log(`\nRespaldo: ${respaldo}`);

  let ok = 0, sinEfecto = 0;
  for (const f of filas) {
    const [r] = await pool.query(
      'UPDATE cartas_aprobacion SET fecha_creacion = ? WHERE id = ? AND fecha_creacion = ?',
      [f.fecha, f.id, f.fecha_creacion]);
    if (r.affectedRows === 1) ok++; else { sinEfecto++; console.log(`  ⚠ sin efecto: ${f.op_carta}`); }
  }
  console.log(`\nAlineadas: ${ok}${sinEfecto ? ` · sin efecto: ${sinEfecto}` : ''}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
