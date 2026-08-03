'use strict';
/* Auditoría 03-08-2026 (C-2) — segunda pasada: elimina de producción las tablas de
   respaldo ya innecesarias. Autorizado por Pato el 03-08-2026.

   SE BORRAN (24):
     · 21 bkp_rutmig_*          → respaldo previo a migracion-rut-split.js (29-06).
                                  Esa migración solo agregó columnas VIRTUALES GENERADAS
                                  (la BD calcula rut_cuerpo/rut_dv desde el rut canónico):
                                  no transformó datos, así que no hay nada que revertir.
     · bkp_tascli_real_20260629 → verificado: 0 filas difieren de producción (copia idéntica).
     · bkp_cartas_horas_20260728→ fechas de cartas previas a un ajuste, sin referencias.
     · bkp_recalc_20260629      → foto de comisiones antes del recálculo del 29-06.
                                  Se conserva SOLO en el ZIP (decisión explícita de Pato).

   NO SE TOCAN (8):
     · bkp_del_*        (4) → única copia de créditos/cuotas/pagos borrados: 0 filas
                              siguen vivas en producción. Requieren decisión de negocio.
     · bkp_dealnom_*, bkp_iddealer_creditos, bkp_nombres_clientes (4) → respaldos de
                              reversa de scripts de operación; además esos scripts abortan
                              si la tabla existe (protección contra re-ejecución).

   RED DE SEGURIDAD: no borra ninguna tabla que no esté respaldada en el ZIP
   (C:\\Users\\patri\\Documents\\respaldos-bd\\bkp-tablas-2026-08-03).

   Uso:  node scripts/borrar-tablas-bkp-2026-08-03.js            (simulación)
         node scripts/borrar-tablas-bkp-2026-08-03.js --ejecutar (aplica)          */
const pool = require('../shared/config/database');
const fs   = require('fs');
const path = require('path');

const EJECUTAR = process.argv.includes('--ejecutar');
const RESPALDO = 'C:\\Users\\patri\\Documents\\respaldos-bd\\bkp-tablas-2026-08-03';

const CONSERVAR = new Set([
  'bkp_del_20260501_creditos', 'bkp_del_20260501_cuotas', 'bkp_del_20260501_pagos',
  'bkp_del_20260701_prueba_creditos',
  'bkp_dealnom_creditos', 'bkp_dealnom_dealers', 'bkp_iddealer_creditos', 'bkp_nombres_clientes',
]);

(async () => {
  const [tablas] = await pool.query(`
    SELECT table_name n FROM information_schema.tables
     WHERE table_schema = DATABASE() AND (table_name LIKE 'bkp%' OR table_name LIKE 'tmp%')
     ORDER BY table_name`);

  const candidatas = tablas.map(t => t.n).filter(n => !CONSERVAR.has(n));
  const sinRespaldo = [];
  let totalFilas = 0;

  console.log(`\n${tablas.length} tablas de respaldo · ${candidatas.length} candidatas a borrar\n`);
  for (const n of candidatas) {
    const [[c]] = await pool.query(`SELECT COUNT(*) n FROM \`${n}\``);
    const json = path.join(RESPALDO, `${n}.json`);
    const sql  = path.join(RESPALDO, `${n}.sql`);
    const ok   = fs.existsSync(json) && fs.existsSync(sql);
    if (!ok) sinRespaldo.push(n);
    totalFilas += Number(c.n);
    console.log(`  ${ok ? '✓' : '✗ SIN RESPALDO'} ${n.padEnd(42)} ${String(c.n).padStart(6)} filas`);
  }

  if (sinRespaldo.length) {
    console.log(`\n✗ ABORTA: ${sinRespaldo.length} tabla(s) sin respaldo en disco. No se borra nada.`);
    process.exit(1);
  }
  console.log(`\nTodas respaldadas en ${RESPALDO}`);
  console.log(`Se conservan ${CONSERVAR.size}: ${[...CONSERVAR].join(', ')}`);

  if (!EJECUTAR) { console.log('\n[SIMULACIÓN] Nada se borró. Corre con --ejecutar para aplicar.\n'); process.exit(0); }

  for (const n of candidatas) { await pool.query(`DROP TABLE \`${n}\``); console.log(`✓ Eliminada ${n}`); }

  const [[q]] = await pool.query(`SELECT COUNT(*) n FROM information_schema.tables
     WHERE table_schema = DATABASE() AND (table_name LIKE 'bkp%' OR table_name LIKE 'tmp%')`);
  console.log(`\n${candidatas.length} tablas eliminadas (${totalFilas.toLocaleString('es-CL')} filas). Quedan ${q.n} en producción.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
