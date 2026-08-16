'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Última pasada del arreglo de fechas en cartas de aprobación: fecha_rechazo.

   Mismo origen que fecha_creacion / fecha_aprobacion / fecha_otorgado — el UPDATE
   de guardar la escribía con el valor del navegador y cada re-guardado la corría
   4 horas. De 16 rechazos, solo 3 tenían la hora correcta. Importa porque
   fecha_rechazo alimenta el KPI de productividad de los analistas, los días en
   cola de las alertas y la bitácora cronológica del crédito.

   Fuente: auditoria_movimientos, acción RECHAZAR, hora del servidor. Una carta
   puede tener varios RECHAZAR (rechazada, corregida, vuelta a rechazar): si
   alguno calza con lo guardado, el dato está sano; si no, se usa el más cercano
   y solo cuando el desfase es múltiplo exacto de 4 horas.

   Uso:  node scripts/corregir-fecha-rechazo-cartas.js            (simula)
         node scripts/corregir-fecha-rechazo-cartas.js --aplicar
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../shared/config/database');

const APLICAR  = process.argv.includes('--aplicar');
const TOLERA   = 5;
const PASO_MIN = 240;

const fmt = d => new Date(d).toLocaleString('es-CL');

(async () => {
  const [rows] = await pool.query(`
    SELECT ca.id, ca.op_carta, ca.cliente, ca.fecha_rechazo, a.fecha AS rechazo_at
      FROM cartas_aprobacion ca
      JOIN auditoria_movimientos a
        ON a.modulo = 'cartas' AND a.accion = 'RECHAZAR' AND a.entidad_id = CAST(ca.id AS CHAR)
     WHERE ca.fecha_rechazo IS NOT NULL
     ORDER BY ca.id, a.fecha`);

  const porCarta = new Map();
  for (const r of rows) {
    if (!porCarta.has(r.id)) porCarta.set(r.id, { ...r, marcas: [] });
    porCarta.get(r.id).marcas.push(new Date(r.rechazo_at));
  }

  const plan = [], sanas = [], dudosas = [];
  for (const c of porCarta.values()) {
    const actual = new Date(c.fecha_rechazo).getTime();
    const difs = c.marcas.map(m => ({ m, d: (actual - m.getTime()) / 60000 }));
    if (difs.some(x => Math.abs(x.d) <= TOLERA)) { sanas.push(c); continue; }
    const mejor = difs.reduce((a, b) => (Math.abs(a.d) <= Math.abs(b.d) ? a : b));
    const saltos = Math.round(mejor.d / PASO_MIN);
    if (saltos === 0 || Math.abs(mejor.d - saltos * PASO_MIN) > TOLERA) { dudosas.push({ ...c, d: mejor.d }); continue; }
    plan.push({ ...c, real_at: mejor.m, desfase: mejor.d });
  }

  console.log(`Rechazos contrastables contra auditoría: ${porCarta.size}`);
  console.log(`  → ya correctos: ${sanas.length}`);
  console.log(`  → a corregir:   ${plan.length}`);
  console.log(`  → sin explicación, se dejan: ${dudosas.length}`);
  dudosas.forEach(x => console.log(`      ${x.op_carta} (${Math.round(x.d)} min)`));
  console.log('');
  plan.forEach(p => console.log(`  ${String(p.op_carta).padEnd(16)} ${fmt(p.fecha_rechazo)} → ${fmt(p.real_at)}   (−${Math.round(p.desfase / 60)} h)`));

  if (!APLICAR) { console.log('\nSIMULACIÓN. Para escribir: --aplicar'); process.exit(0); }

  const respaldo = path.join(__dirname, `respaldo-fecha-rechazo-${Date.now()}.json`);
  fs.writeFileSync(respaldo, JSON.stringify(plan.map(p =>
    ({ id: p.id, op_carta: p.op_carta, antes: p.fecha_rechazo, despues: p.real_at })), null, 2));
  console.log(`\nRespaldo: ${respaldo}`);

  let ok = 0, sinEfecto = 0;
  for (const p of plan) {
    const [r] = await pool.query(
      'UPDATE cartas_aprobacion SET fecha_rechazo = ? WHERE id = ? AND fecha_rechazo = ?',
      [p.real_at, p.id, p.fecha_rechazo]);
    if (r.affectedRows === 1) ok++; else { sinEfecto++; console.log(`  ⚠ sin efecto: ${p.op_carta}`); }
  }
  console.log(`\nCorregidos: ${ok}${sinEfecto ? ` · sin efecto: ${sinEfecto}` : ''}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
