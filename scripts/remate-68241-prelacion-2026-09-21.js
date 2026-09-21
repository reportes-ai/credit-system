/* Op 68241 — rehace la imputación del remate judicial (04-06-2026, $18.519.042) con el ORDEN DE
 * PRELACIÓN del mantenedor (prelacion-core.js: capital antes que intereses), no con el art. 1595 que
 * usó scripts/remate-judicial-68241-2026-06-04.js. Pato 21-09-2026.
 *
 * Resultado: el remate cubre TODO el capital ($13.523.921) + $4.995.121 de interés corriente. Lo no
 * cubierto (interés corriente, mora y gastos) nunca se reconoció como ingreso (devengo suspendido):
 * es CONDONACIÓN, no castigo de cartera. Entonces:
 *   1. Anula el castigo #1 ($4.324.258 contra 1104020 habría sacado capital que ya se recuperó).
 *   2. Corrige la fila del pago (TRX-420001) con la imputación nueva.
 *   3. Cierra la op: cuotas PAGADA al 04-06-2026 y estado_cartera PREPAGADO.
 *   4. Asiento RECLASIF_INTERES_CARTERA al 04-06-2026: DEBE 1104010 / HABER 3001010 $4.995.121
 *      (AVSOFT abonó el remate completo a capital; esa parte era interés).
 * Uso (MOTORES=off): node scripts/remate-68241-prelacion-2026-09-21.js [--aplicar]
 * APLICADO 21-09-2026: castigo #1 anulado, 39 cuotas PAGADA, op PREPAGADO, asiento #2640008.
 */
const pool = require('../shared/config/database');
const PRELACION = require('../api-gateway/public/js/prelacion-core');
const { calcularPrepago } = require('../services/certificados/src/controllers/certificados.controller');
const NUM_OP = 68241, FECHA = '2026-06-04', REMATE = 18519042, ID_PAGO = 450001, ID_CASTIGO = 1;
const r0 = v => Math.round(Number(v) || 0), $ = v => '$' + r0(v).toLocaleString('es-CL');

(async () => {
  const aplicar = process.argv.includes('--aplicar');
  const pp = await calcularPrepago(NUM_OP, FECHA);
  const d = pp.datos, idCred = pp.credito.id;
  const [cal] = await pool.query("SELECT numero_cuota, interes, amortizacion FROM cuotas_credito WHERE id_credito=? AND estado_cuota<>'PAGADA'", [idCred]);
  const cm = new Map(cal.map(q => [Number(q.numero_cuota), q]));
  const mora = (d.detalle || []).filter(q => q.en_mora);
  // Mismos ítems que Aplicación de Fondos (capital = vigente + cuotas en mora completas, como deudaOp).
  // El interés vencido dentro de las cuotas en mora se separa del capital para el asiento.
  const intVenc = mora.reduce((s, q) => s + r0(cm.get(Number(q.numero_cuota))?.interes), 0);
  const items = {
    capital: r0(d.capital_vigente) + mora.reduce((s, q) => s + r0(cm.get(Number(q.numero_cuota))?.amortizacion), 0),
    int_corriente: intVenc + r0(d.interes_corriente), int_mora: r0(d.interes_mora), gastos_cobranza: r0(d.gastos_cobranza),
    costo_prepago: 0, honorarios: 0, gastos_procesales: 0,   // sin comisión de prepago en un remate
  };
  const [ordRows] = await pool.query('SELECT concepto FROM prelacion_pagos ORDER BY orden');
  const orden = ordRows.length ? ordRows.map(r => r.concepto) : PRELACION.ORDEN_DEFAULT;
  const r = PRELACION.aplicar(items, orden, REMATE);
  console.log('Orden:', r.orden.join(' → '));
  for (const k of r.orden) if (items[k]) console.log(`  ${k.padEnd(16)} deuda ${$(items[k]).padStart(12)} · aplicado ${$(r.items[k].aplicado).padStart(12)} · condonado ${$(r.items[k].descuento).padStart(11)}`);
  const cond = Object.values(r.items).reduce((s, x) => s + x.descuento, 0);
  const intCobrado = r.items.int_corriente.aplicado;
  console.log(`Condonado ${$(cond)} · interés corriente cobrado (a reclasificar 1104010 → 3001010) ${$(intCobrado)} · devolución ${$(r.devolucion)}`);
  if (!aplicar) { console.log('\nDRY-RUN. Agrega --aplicar.'); process.exit(0); }

  const [[cas]] = await pool.query('SELECT estado FROM castigos_contables WHERE id=?', [ID_CASTIGO]);
  if (!cas || cas.estado !== 'PENDIENTE') { console.log('El castigo #1 no está PENDIENTE:', cas && cas.estado); process.exit(1); }
  const obs = `Remate judicial ${FECHA} — contabilizado en AVSOFT (T-60019). Imputación por orden de prelación: capital ${$(r.items.capital.aplicado)}, interés corriente ${$(intCobrado)}. Condonado ${$(cond)} (int. corriente ${$(r.items.int_corriente.descuento)}, mora ${$(r.items.int_mora.descuento)}, gastos ${$(r.items.gastos_cobranza.descuento)}).`;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [a] = await conn.query("UPDATE castigos_contables SET estado='ANULADO', comentario=CONCAT(COALESCE(comentario,''), ' | ANULADO 21-09-2026: con el orden de prelación el remate cubrió todo el capital; el saldo son intereses no reconocidos → condonación, no castigo.') WHERE id=? AND estado='PENDIENTE'", [ID_CASTIGO]);
    const [p] = await conn.query('UPDATE pagos_credito SET monto_cuota=?, interes_mora=0, gastos_cobranza=0, observacion=? WHERE id_pago=?', [r.items.capital.aplicado + intCobrado, obs.slice(0, 500), ID_PAGO]);
    const [q] = await conn.query("UPDATE cuotas_credito SET estado_cuota='PAGADA', fecha_pago=? WHERE id_credito=? AND estado_cuota<>'PAGADA'", [FECHA, idCred]);
    const [c] = await conn.query("UPDATE creditos SET estado_cartera='PREPAGADO' WHERE id=?", [idCred]);
    if (a.affectedRows !== 1 || p.affectedRows !== 1 || c.affectedRows !== 1) throw new Error(`affectedRows inesperado: castigo ${a.affectedRows}, pago ${p.affectedRows}, credito ${c.affectedRows}`);
    await conn.commit();
    console.log(`Castigo #1 ANULADO · pago corregido · ${q.affectedRows} cuotas PAGADA · op PREPAGADO`);
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  const id = await require('../services/contabilidad/src/motor-asientos').contabilizar({
    evento: 'RECLASIF_INTERES_CARTERA', fecha: FECHA, ref: 'RECL-REMATE-68241', num_op: String(NUM_OP),
    glosa: `Reclasificación interés corriente cobrado en remate judicial op ${NUM_OP} (AVSOFT lo abonó a capital)`,
    montos: { interes: intCobrado }, detalle: `Remate ${FECHA} · OP ${NUM_OP}`,
  });
  console.log('Asiento de reclasificación:', id ? '#' + id : 'NO contabilizado (ver ctb_eventos_log)');
  require('../shared/auditoria').registrar({ id_credito: idCred, usuario: 'Patricio Escobar', accion: 'REMATE_JUDICIAL',
    detalle: `Remate re-imputado por orden de prelación: capital ${$(r.items.capital.aplicado)} + interés ${$(intCobrado)}; condonado ${$(cond)}; castigo #1 anulado; op PREPAGADO; reclasificación asiento #${id || '—'}` });
  setTimeout(() => process.exit(0), 1500);
})().catch(e => { console.error(e); process.exit(1); });
