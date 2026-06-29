#!/usr/bin/env node
/**
 * validar-ruts.js — Calidad de datos: lista todos los RUT con DV inválido.
 *
 * Recorre las columnas de RUT (formato BODY-DV) que tienen el split cuerpo+DV y valida
 * `calcDV(cuerpo) === dv` con el motor rut-core. Reporta cada valor con DV incorrecto.
 * Read-only. Excluye las tablas cuerpo-only de dealernet (rut sin DV).
 *
 * Uso: node scripts/validar-ruts.js
 */
'use strict';
const pool = require('../shared/config/database');
const R = require('../api-gateway/public/js/rut-core');
// UBER/YAPO: canales de venta con RUT placeholder (no son RUTs reales) — se ignoran.
const PLACEHOLDERS = new Set(['45840', '45901']);

const COLS = [
  ['clientes', 'rut'],
  ['dealers', 'rut'], ['dealers', 'rut_pago'],
  ['proveedores', 'rut'], ['usuarios', 'rut'],
  ['dealer_fichas', 'rut'], ['dealer_fichas', 'rut_cuenta'],
  ['antecedentes_laborales', 'rut_cliente'], ['antecedentes_laborales', 'rut_empresa'],
  ['auditoria_movimientos', 'rut'],
  ['cartas_aprobacion', 'rut_cliente'], ['cartas_aprobacion', 'rut_dealer'],
  ['cartolas_enviadas', 'rut_dealer'],
  ['cartolas_movimientos', 'rut_cliente'], ['cartolas_movimientos', 'rut_dealer'],
  ['certificados', 'rut'], ['cotizaciones', 'rut_cliente'],
  ['creditos', 'rut_dealer'], ['crm_gestiones', 'rut_cliente'],
  ['cuentas_bancarias', 'rut'], ['informacion_comercial', 'rut_cliente'],
  ['informes_dealernet', 'rut'], ['ordenes_pago', 'proveedor_rut'],
  ['postventa_facturas_comision', 'rut_dealer'],
];

(async () => {
  try {
    let totalMal = 0; const resumen = [];
    for (const [t, c] of COLS) {
      const cuerpo = `${c}_cuerpo`, dv = `${c}_dv`;
      const [rows] = await pool.query(
        `SELECT \`${c}\` rut, \`${cuerpo}\` cuerpo, \`${dv}\` dv, COUNT(*) n
           FROM \`${t}\` WHERE \`${cuerpo}\` IS NOT NULL
          GROUP BY \`${c}\`, \`${cuerpo}\`, \`${dv}\``);
      const malos = rows.filter(r => R.calcDV(String(r.cuerpo)) !== r.dv && !PLACEHOLDERS.has(String(r.cuerpo)));
      if (malos.length) {
        const filas = malos.reduce((s, r) => s + r.n, 0);
        totalMal += filas;
        resumen.push({ tc: `${t}.${c}`, distintos: malos.length, filas });
        console.log(`\n✗ ${t}.${c} — ${malos.length} RUT distintos / ${filas} fila(s):`);
        malos.sort((a, b) => b.n - a.n).slice(0, 20).forEach(r =>
          console.log(`   ${String(r.rut).padEnd(14)} (DV correcto: ${R.calcDV(String(r.cuerpo))})  ×${r.n}`));
        if (malos.length > 20) console.log(`   … y ${malos.length - 20} más`);
      }
    }
    console.log('\n══════════ RESUMEN ══════════');
    if (!resumen.length) console.log('✓ Todos los RUT tienen DV válido.');
    else { resumen.forEach(r => console.log(`  ${r.tc}: ${r.distintos} distintos / ${r.filas} filas`)); console.log(`  TOTAL filas con DV inválido: ${totalMal}`); }
  } catch (e) { console.error('ERR', e.message); } finally { await pool.end(); }
})();
