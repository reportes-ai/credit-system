'use strict';
/* Corrección de N° OP: 3 operaciones cargadas el 30-07-2026 quedaron con un
   correlativo interno (2607056/2607058/2607062) en vez de su número real de
   INDEXA. Se corrige en TODAS las tablas que referencian num_op como llave de
   negocio. Las tablas bkp_* NO se tocan: son fotos históricas.
   Uso: node scripts/fix-numop-indexa-2026-07-31.js [--aplicar]              */
const pool = require('../shared/config/database');

const MAP = { 2607056: 89321, 2607058: 89324, 2607062: 89347 };
const TABLAS = ['aplicaciones_fondos', 'carga_cambios', 'carga_detalle', 'cartera_ventas',
  'cartola_incorporaciones', 'cartolas_movimientos', 'castigos_contables', 'certificados',
  'cierre_saldos_pagados', 'cobranza_judicial', 'creditos', 'creditos_edicion_log',
  'ctb_movimientos', 'cuotas_credito', 'digitacion_log', 'documentos_verificables',
  'facturacion_af_check', 'postventa_facturas_comision', 'postventa_ordenes',
  'postventa_ordenes_comision', 'postventa_seguimiento', 'provisiones_detalle'];

(async () => {
  const aplicar = process.argv.includes('--aplicar');
  const viejos = Object.keys(MAP);
  console.log(aplicar ? '=== APLICANDO ===' : '=== SIMULACIÓN (usar --aplicar) ===');
  for (const t of TABLAS) {
    for (const v of viejos) {
      let rows;
      try {
        [rows] = await pool.query('SELECT COUNT(*) n FROM `' + t + '` WHERE num_op = ?', [v]);
      } catch (e) { console.log(t, 'ERR', e.message); break; }
      const n = rows[0].n;
      if (!n) continue;
      console.log(`${t}: ${n} fila(s) ${v} → ${MAP[v]}`);
      if (aplicar) await pool.query('UPDATE `' + t + '` SET num_op = ? WHERE num_op = ?', [MAP[v], v]);
    }
  }
  process.exit(0);
})();
