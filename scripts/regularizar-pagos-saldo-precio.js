'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Regularización (13-08-2026): genera la CONTRAPARTIDA de los saldos precio ya
   pagados al dealer cuyo ingreso de fondos sí está contabilizado.

   POR QUÉ FALTABAN
   El asiento de pago solo se disparaba al marcar la etapa a mano en Seguimiento.
   Los dos caminos por los que realmente se paga —Tesorería → Saldos a Pagar y el
   botón Pagar de la Orden de Pago— marcaban la etapa con un INSERT directo y se
   saltaban la contabilización. La cuenta de paso 2102045 solo crecía. El agujero
   quedó tapado en v207.54; esto pone al día lo que ya había pasado.

   ALCANCE
   Solo las operaciones con su ingreso contabilizado (SP-<op>-IN) y ya marcadas
   SALDO PRECIO PAGADO. Las anteriores al módulo de contabilidad nunca generaron
   pasivo acá (venían de AVSOFT), así que no hay nada que rebajar por ellas.

   CÓMO
   Un asiento por operación, generado por el MOTOR ÚNICO (contabilizarSaldoPrecio)
   —los mismos que emitirá el sistema de ahora en adelante— con la FECHA REAL del
   pago. El motor es idempotente por ref (SP-<op>-OUT): correrlo dos veces no
   duplica. Respeta el candado de meses cerrados.

   En seco por defecto:  node scripts/regularizar-pagos-saldo-precio.js
   Para aplicar:         node scripts/regularizar-pagos-saldo-precio.js --aplicar
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const pool = require('../shared/config/database');
const pv = require('../services/postventa/src/controllers/postventa.controller');

const APLICAR = process.argv.includes('--aplicar');
const CLP = n => '$' + Math.round(n || 0).toLocaleString('es-CL');

(async () => {
  const [rows] = await pool.query(`
    SELECT s.id AS sid, s.num_op, cc.total AS monto_ingreso, po.num_orden,
           COALESCE(oc.fecha_pagada, pe.fecha) AS fecha_pago,
           COALESCE(NULLIF(dl.nombre_indexa,''), dl.nombre_razon, c.nombre_local, s.nombre_dealer) AS dealer
      FROM ctb_comprobantes cc
      JOIN postventa_seguimiento s ON cc.origen_ref = CONCAT('SP-', s.num_op, '-IN')
      JOIN postventa_etapas pe ON pe.id_seguimiento = s.id AND pe.track = 'SALDO' AND pe.etapa = 'SALDO PRECIO PAGADO'
      LEFT JOIN creditos c ON c.id = s.id_credito
      LEFT JOIN dealers  dl ON dl.id_dealer = c.id_dealer
      LEFT JOIN postventa_ordenes po ON po.id_seguimiento = s.id
      LEFT JOIN op_correlativos oc ON oc.origen = 'SALDO' AND oc.origen_id = po.id
     WHERE cc.estado = 'CONTABILIZADO' AND cc.origen = 'SALDO_FONDOS_RECIBIDOS'
       AND NOT EXISTS (SELECT 1 FROM ctb_comprobantes x
                        WHERE x.origen = 'SALDO_PRECIO_PAGADO'
                          AND x.origen_ref = CONCAT('SP-', s.num_op, '-OUT')
                          AND x.estado = 'CONTABILIZADO')
     ORDER BY fecha_pago, s.num_op`);

  const iso = d => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
  console.log(`Pagos sin contrapartida: ${rows.length}  ·  ${CLP(rows.reduce((s, r) => s + Number(r.monto_ingreso), 0))}`);
  const meses = {};
  rows.forEach(r => { const m = iso(r.fecha_pago).slice(0, 7); meses[m] = (meses[m] || 0) + 1; });
  console.log('por mes de pago:', JSON.stringify(meses));

  const [cerr] = await pool.query('SELECT mes FROM ctb_meses_cerrados');
  const cerrados = new Set(cerr.map(c => c.mes));
  if (cerrados.size) console.log('meses cerrados (se omiten):', [...cerrados].join(', '));

  if (!rows.length) { console.log('Nada que regularizar.'); process.exit(0); }
  if (!APLICAR) {
    rows.slice(0, 5).forEach(r => console.log(`  ${iso(r.fecha_pago)}  OP ${r.num_op}  ${CLP(r.monto_ingreso)}  ${r.num_orden || ''} · ${r.dealer || ''}`));
    console.log(`  … y ${Math.max(0, rows.length - 5)} más`);
    console.log('\n(SIMULACIÓN — vuelve a correr con --aplicar)');
    process.exit(0);
  }

  let ok = 0, sin = 0;
  for (const r of rows) {
    const fecha = iso(r.fecha_pago);
    if (cerrados.has(fecha.slice(0, 7))) { console.log(`  – OP ${r.num_op}: mes ${fecha.slice(0, 7)} cerrado, omitida`); sin++; continue; }
    await pv.contabilizarSaldoPrecio(r.sid, 'SALDO PRECIO PAGADO', fecha);
    const [[hecho]] = await pool.query(
      "SELECT id, total FROM ctb_comprobantes WHERE origen='SALDO_PRECIO_PAGADO' AND origen_ref=? AND estado='CONTABILIZADO'",
      [`SP-${r.num_op}-OUT`]);
    if (hecho) { ok++; console.log(`  ✓ ${fecha}  OP ${r.num_op}  ${CLP(hecho.total)}  ${r.num_orden || ''} · ${r.dealer || ''}`); }
    else { sin++; console.log(`  ✗ OP ${r.num_op}: no se generó — revisar ctb_eventos_log`); }
  }
  console.log(`\nGenerados ${ok} · sin generar ${sin}`);

  const [[c]] = await pool.query("SELECT SUM(debe) d, SUM(haber) h FROM ctb_movimientos WHERE cuenta='2102045'");
  console.log(`Cuenta de paso 2102045 → debe ${CLP(c.d)} · haber ${CLP(c.h)} · saldo pendiente de pago ${CLP(c.h - c.d)}`);
  process.exit(0);
})();
