'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Devuelve a su hora real la fecha_aprobacion de las cartas de aprobación.

   Mismo origen que el desfase de fecha_creacion: el UPDATE aceptaba el valor que
   mandaba el navegador (en UTC), así que cada re-guardado la corría +4 horas. El
   resultado visible eran cartas "aprobadas" después de estar otorgadas.

   LA FUENTE ES LA AUDITORÍA: auditoria_movimientos registra la acción APROBAR con
   la hora del SERVIDOR (columna `fecha`, DEFAULT CURRENT_TIMESTAMP) — el cliente
   no puede tocarla.

   OJO con las cartas aprobadas MÁS DE UNA VEZ (rechazada y vuelta a aprobar, o
   re-aprobada por otra persona): hay varios APROBAR y quedarse con el primero
   pisaría un dato correcto. La 26622065FC lo demostró — aprobada a las 09:50 y
   re-aprobada a las 11:05, y su fecha apuntaba bien a la segunda. Por eso se
   compara contra TODOS los APROBAR: si alguno calza, la fecha está sana y no se
   toca; si ninguno calza, se corrige al más cercano y solo cuando el desfase es
   un múltiplo exacto de 4 horas, que es la firma del bug.

   Las cartas sin registro de auditoría (las de la migración, y las anteriores a
   que se auditara el módulo) no se tocan: no hay contra qué contrastarlas.

   Uso:  node scripts/corregir-fecha-aprobacion-cartas.js            (simula)
         node scripts/corregir-fecha-aprobacion-cartas.js --aplicar
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../shared/config/database');

const APLICAR  = process.argv.includes('--aplicar');
const TOLERA   = 5;     // minutos: el asiento de auditoría se escribe junto al UPDATE
const PASO_MIN = 240;   // 4 horas: el salto que daba cada re-guardado

const fmt = d => new Date(d).toLocaleString('es-CL');

(async () => {
  const [cartas] = await pool.query(`
    SELECT ca.id, ca.op_carta, ca.cliente, ca.fecha_aprobacion, a.fecha AS aprobo_at
      FROM cartas_aprobacion ca
      JOIN auditoria_movimientos a
        ON a.modulo = 'cartas' AND a.accion = 'APROBAR' AND a.entidad_id = CAST(ca.id AS CHAR)
     WHERE ca.fecha_aprobacion IS NOT NULL
     ORDER BY ca.id, a.fecha`);

  // Agrupar por carta: una carta puede tener varios APROBAR
  const porCarta = new Map();
  for (const r of cartas) {
    if (!porCarta.has(r.id)) porCarta.set(r.id, { ...r, marcas: [] });
    porCarta.get(r.id).marcas.push(new Date(r.aprobo_at));
  }

  const filas = [], sanas = [], dudosas = [];
  for (const c of porCarta.values()) {
    const actual = new Date(c.fecha_aprobacion).getTime();
    const difs = c.marcas.map(m => ({ m, d: (actual - m.getTime()) / 60000 }));
    if (difs.some(x => Math.abs(x.d) <= TOLERA)) { sanas.push(c); continue; }
    // La más cercana en el tiempo, y solo si el desfase es múltiplo exacto de 4 h
    const mejor = difs.reduce((a, b) => (Math.abs(a.d) <= Math.abs(b.d) ? a : b));
    const saltos = Math.round(mejor.d / PASO_MIN);
    if (saltos < 1 || Math.abs(mejor.d - saltos * PASO_MIN) > TOLERA) { dudosas.push({ ...c, d: mejor.d }); continue; }
    filas.push({ ...c, real_at: mejor.m, desfase: mejor.d });
  }

  console.log(`Cartas con registro de auditoría: ${porCarta.size}`);
  console.log(`  → ya correctas: ${sanas.length}`);
  console.log(`  → a corregir (desfase múltiplo exacto de 4 h): ${filas.length}`);
  console.log(`  → sin explicación, se dejan: ${dudosas.length}`);
  dudosas.forEach(x => console.log(`      ${x.op_carta} (${Math.round(x.d)} min)`));
  console.log('');
  filas.slice(0, 10).forEach(f =>
    console.log(`  ${String(f.op_carta).padEnd(16)} ${fmt(f.fecha_aprobacion)} → ${fmt(f.real_at)}   (−${Math.round(f.desfase / 60)} h)`));
  if (filas.length > 10) console.log(`  … y ${filas.length - 10} más`);

  if (!APLICAR) { console.log('\nSIMULACIÓN. Para escribir: --aplicar'); process.exit(0); }

  const respaldo = path.join(__dirname, `respaldo-fecha-aprobacion-${Date.now()}.json`);
  fs.writeFileSync(respaldo, JSON.stringify(filas.map(f =>
    ({ id: f.id, op_carta: f.op_carta, antes: f.fecha_aprobacion, despues: f.real_at })), null, 2));
  console.log(`\nRespaldo: ${respaldo}`);

  let ok = 0, sinEfecto = 0;
  for (const f of filas) {
    const [r] = await pool.query(
      'UPDATE cartas_aprobacion SET fecha_aprobacion = ? WHERE id = ? AND fecha_aprobacion = ?',
      [f.real_at, f.id, f.fecha_aprobacion]);
    if (r.affectedRows === 1) ok++; else { sinEfecto++; console.log(`  ⚠ sin efecto: ${f.op_carta}`); }
  }
  console.log(`\nCorregidas: ${ok}${sinEfecto ? ` · sin efecto: ${sinEfecto}` : ''}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
