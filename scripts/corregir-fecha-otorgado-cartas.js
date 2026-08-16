'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Devuelve a su hora real la fecha_otorgado de las CARTAS de aprobación.

   OJO: es la fecha_otorgado de `cartas_aprobacion` — el instante en que se apretó
   Otorgado. NO se toca la de `creditos`, que es un dato de negocio (la fecha de
   curse que alimenta dashboard, comisiones y cierres de mes).

   El endpoint que otorga ya sellaba bien la hora (NOW() del servidor), pero el
   UPDATE de guardar la volvía a escribir con el valor del navegador y la corría
   4 horas: 42 cartas terminaron otorgadas ANTES de su propia aprobación. La causa
   quedó cerrada en cartas.controller.js.

   Fuente: auditoria_movimientos, acción OTORGAR, hora del servidor. Se corrige
   solo cuando el desfase es un múltiplo exacto de 4 horas y ningún registro de
   auditoría calza con lo que hay guardado.

   Uso:  node scripts/corregir-fecha-otorgado-cartas.js            (simula)
         node scripts/corregir-fecha-otorgado-cartas.js --aplicar
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
    SELECT ca.id, ca.op_carta, ca.cliente, ca.fecha_otorgado, a.fecha AS otorgo_at
      FROM cartas_aprobacion ca
      JOIN auditoria_movimientos a
        ON a.modulo = 'cartas' AND a.accion = 'OTORGAR' AND a.entidad_id = CAST(ca.id AS CHAR)
     WHERE ca.fecha_otorgado IS NOT NULL
     ORDER BY ca.id, a.fecha`);

  const porCarta = new Map();
  for (const r of rows) {
    if (!porCarta.has(r.id)) porCarta.set(r.id, { ...r, marcas: [] });
    porCarta.get(r.id).marcas.push(new Date(r.otorgo_at));
  }

  const plan = [], sanas = [], dudosas = [];
  for (const c of porCarta.values()) {
    const actual = new Date(c.fecha_otorgado).getTime();
    const difs = c.marcas.map(m => ({ m, d: (actual - m.getTime()) / 60000 }));
    if (difs.some(x => Math.abs(x.d) <= TOLERA)) { sanas.push(c); continue; }
    const mejor = difs.reduce((a, b) => (Math.abs(a.d) <= Math.abs(b.d) ? a : b));
    const saltos = Math.round(mejor.d / PASO_MIN);   // puede ser negativo: acá corría hacia atrás
    if (saltos === 0 || Math.abs(mejor.d - saltos * PASO_MIN) > TOLERA) { dudosas.push({ ...c, d: mejor.d }); continue; }
    plan.push({ ...c, real_at: mejor.m, desfase: mejor.d });
  }

  console.log(`Cartas con auditoría de otorgamiento: ${porCarta.size}`);
  console.log(`  → ya correctas: ${sanas.length}`);
  console.log(`  → a corregir:   ${plan.length}`);
  console.log(`  → sin explicación, se dejan: ${dudosas.length}`);
  dudosas.forEach(x => console.log(`      ${x.op_carta} (${Math.round(x.d / 60)} h)`));
  console.log('');
  plan.slice(0, 10).forEach(p =>
    console.log(`  ${String(p.op_carta).padEnd(16)} ${fmt(p.fecha_otorgado)} → ${fmt(p.real_at)}   (${p.desfase > 0 ? '−' : '+'}${Math.abs(Math.round(p.desfase / 60))} h)`));
  if (plan.length > 10) console.log(`  … y ${plan.length - 10} más`);

  if (!APLICAR) { console.log('\nSIMULACIÓN. Para escribir: --aplicar'); process.exit(0); }

  const respaldo = path.join(__dirname, `respaldo-fecha-otorgado-${Date.now()}.json`);
  fs.writeFileSync(respaldo, JSON.stringify(plan.map(p =>
    ({ id: p.id, op_carta: p.op_carta, antes: p.fecha_otorgado, despues: p.real_at })), null, 2));
  console.log(`\nRespaldo: ${respaldo}`);

  let ok = 0, sinEfecto = 0;
  for (const p of plan) {
    const [r] = await pool.query(
      'UPDATE cartas_aprobacion SET fecha_otorgado = ? WHERE id = ? AND fecha_otorgado = ?',
      [p.real_at, p.id, p.fecha_otorgado]);
    if (r.affectedRows === 1) ok++; else { sinEfecto++; console.log(`  ⚠ sin efecto: ${p.op_carta}`); }
  }
  console.log(`\nCorregidas: ${ok}${sinEfecto ? ` · sin efecto: ${sinEfecto}` : ''}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
