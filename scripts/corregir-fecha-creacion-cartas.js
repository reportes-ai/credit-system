'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Devuelve a su hora real la fecha_creacion de las cartas de aprobación.

   EL DAÑO: al editar una carta, el UPDATE reescribía fecha_creacion con el valor
   que mandaba el navegador. El servidor la guarda en hora de Chile, el navegador
   la recibe en UTC y la devolvía tal cual, así que CADA re-guardado la corría
   +4 horas exactas. Con dos re-guardados la carta se pasaba al día siguiente: el
   Centro de Control contaba cartas de ayer como emitidas hoy, y 504 de 532 cartas
   quedaron "creadas" después de su propia aprobación.
   La causa se cerró en cartas.controller.js (fecha_creacion ya no se reescribe).

   QUÉ CORRIGE ESTE SCRIPT: solo lo que se puede probar. El crédito asociado se
   crea en el mismo acto que la carta, así que su created_at es la hora real. Se
   corrige una carta cuando el desfase contra ese created_at es un múltiplo exacto
   de 4 horas (±5 min de tolerancia): esa es la firma del error y de nada más. Lo
   que no calza queda intacto y se informa — estimar una hora inventada sería peor
   que dejarla mal.

   Uso:  node scripts/corregir-fecha-creacion-cartas.js            (simula)
         node scripts/corregir-fecha-creacion-cartas.js --aplicar  (escribe)
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../shared/config/database');

const APLICAR   = process.argv.includes('--aplicar');
const PASO_MIN  = 240;   // 4 horas: el salto que daba cada re-guardado
const TOLERA    = 5;     // minutos de holgura entre crear el crédito y la carta
/* Tope de saltos: un desfase de días también es múltiplo de 4 h por casualidad, y ahí
   la explicación no es el bug sino una carta emitida mucho después sobre un crédito de
   carga masiva (266068811DI: crédito del 10-07, carta del 22-07 = 73 "saltos"). */
const MAX_SALTOS = 12;   // 48 horas de re-guardados; más que eso no se toca

const fmt = d => new Date(d).toLocaleString('es-CL');

(async () => {
  const [filas] = await pool.query(`
    SELECT ca.id, ca.op_carta, ca.status,
           ca.fecha_creacion, ca.fecha_aprobacion, c.created_at AS real_at,
           TIMESTAMPDIFF(MINUTE, c.created_at, ca.fecha_creacion) AS desfase
      FROM cartas_aprobacion ca
      JOIN creditos c ON c.id = ca.id_credito_creado
     WHERE TIMESTAMPDIFF(MINUTE, c.created_at, ca.fecha_creacion) > 60
     ORDER BY ca.id`);

  const corregir = [], dudosas = [];
  for (const f of filas) {
    const saltos = Math.round(f.desfase / PASO_MIN);
    const resto  = Math.abs(f.desfase - saltos * PASO_MIN);
    if (saltos < 1 || saltos > MAX_SALTOS || resto > TOLERA) { dudosas.push({ ...f, saltos, resto }); continue; }
    const nueva = new Date(new Date(f.fecha_creacion).getTime() - saltos * PASO_MIN * 60000);
    // Una carta no puede nacer después de que la aprobaron: si pasa, no la tocamos.
    if (f.fecha_aprobacion && nueva > new Date(f.fecha_aprobacion)) { dudosas.push({ ...f, saltos, resto, motivo: 'quedaría posterior a su aprobación' }); continue; }
    corregir.push({ ...f, saltos, nueva });
  }

  console.log(`Cartas con desfase mayor a 1 hora: ${filas.length}`);
  console.log(`  → corregibles (desfase = múltiplo exacto de 4 h): ${corregir.length}`);
  console.log(`  → sin evidencia suficiente, se dejan como están:  ${dudosas.length}\n`);
  corregir.slice(0, 12).forEach(c =>
    console.log(`  ${c.op_carta.padEnd(16)} ${fmt(c.fecha_creacion)} → ${fmt(c.nueva)}   (−${c.saltos * 4} h)`));
  if (corregir.length > 12) console.log(`  … y ${corregir.length - 12} más`);

  if (!APLICAR) { console.log('\nSIMULACIÓN. Para escribir: --aplicar'); process.exit(0); }

  const respaldo = path.join(__dirname, `respaldo-fecha-creacion-${Date.now()}.json`);
  fs.writeFileSync(respaldo, JSON.stringify(corregir.map(c =>
    ({ id: c.id, op_carta: c.op_carta, antes: c.fecha_creacion, despues: c.nueva })), null, 2));
  console.log(`\nRespaldo: ${respaldo}`);

  let ok = 0, sinEfecto = 0;
  for (const c of corregir) {
    // El WHERE repite el valor viejo: si otro proceso ya la movió, no se pisa.
    const [r] = await pool.query(
      'UPDATE cartas_aprobacion SET fecha_creacion = ? WHERE id = ? AND fecha_creacion = ?',
      [c.nueva, c.id, c.fecha_creacion]);
    if (r.affectedRows === 1) ok++; else { sinEfecto++; console.log(`  ⚠ sin efecto: ${c.op_carta}`); }
  }
  console.log(`\nCorregidas: ${ok}${sinEfecto ? ` · sin efecto: ${sinEfecto}` : ''}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
