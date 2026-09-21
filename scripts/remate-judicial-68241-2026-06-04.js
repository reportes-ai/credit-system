/* Op 68241 (David Marcelo Meléndez Jara, cartera propia): prepagada por REMATE JUDICIAL el
 * 04-06-2026 por $18.519.042 (recaudación ya contabilizada en AVSOFT, comprobante T-60019:
 * HABER 1104010). Pato 21-09-2026: el saldo que no cubrió el remate se CASTIGA.
 *
 * 1. Liquida la deuda al 04-06-2026 con el motor único de prepago (calcularPrepago con fecha de
 *    corte), SIN comisión de prepago (no aplica a un remate).
 * 2. Imputa el remate en el orden legal (art. 1595 CC): gastos de cobranza → interés de mora →
 *    interés corriente (el de las cuotas vencidas + el corrido a la fecha) → capital.
 * 3. Registra el pago en pagos_credito (numero_cuota 0, sin caja) SIN asiento: ya está en AVSOFT.
 * 4. Crea la solicitud de CASTIGO por el saldo (castigos_contables, PENDIENTE): la aplican las dos
 *    firmas gerenciales en Tesorería › Castigos, que además dejan la op CASTIGADA y generan el
 *    asiento CASTIGO (DEBE 1104050 / HABER 1104020).
 *
 * Uso (MOTORES=off): node scripts/remate-judicial-68241-2026-06-04.js [--aplicar]
 */
const pool = require('../shared/config/database');
const { calcularPrepago } = require('../services/certificados/src/controllers/certificados.controller');
const NUM_OP = 68241, FECHA = '2026-06-04', REMATE = 18519042;
const r0 = v => Math.round(Number(v) || 0);
const $ = v => '$' + r0(v).toLocaleString('es-CL');

(async () => {
  const aplicar = process.argv.includes('--aplicar');
  const pp = await calcularPrepago(NUM_OP, FECHA);
  const d = pp.datos, idCred = pp.credito.id;
  const [cal] = await pool.query("SELECT numero_cuota, interes, amortizacion FROM cuotas_credito WHERE id_credito=? AND estado_cuota<>'PAGADA'", [idCred]);
  const calMap = new Map(cal.map(q => [Number(q.numero_cuota), q]));
  const enMora = (d.detalle || []).filter(q => q.en_mora);
  const intVencido = enMora.reduce((s, q) => s + r0(calMap.get(Number(q.numero_cuota))?.interes), 0);
  const capVencido = enMora.reduce((s, q) => s + r0(calMap.get(Number(q.numero_cuota))?.amortizacion), 0);
  const deuda = {
    gastos: r0(d.gastos_cobranza), mora: r0(d.interes_mora),
    interes: intVencido + r0(d.interes_corriente),
    capital: capVencido + r0(d.capital_vigente),
  };
  const total = deuda.gastos + deuda.mora + deuda.interes + deuda.capital;
  let resto = REMATE; const pagado = {}, saldo = {};
  for (const k of ['gastos', 'mora', 'interes', 'capital']) { pagado[k] = Math.min(resto, deuda[k]); resto -= pagado[k]; saldo[k] = deuda[k] - pagado[k]; }
  const castigo = total - REMATE + resto;   // resto > 0 sería remate mayor a la deuda
  console.log(`Deuda al ${FECHA} (sin comisión de prepago): ${$(total)}`);
  for (const k of ['gastos', 'mora', 'interes', 'capital']) console.log(`  ${k.padEnd(8)} deuda ${$(deuda[k]).padStart(13)} · remate ${$(pagado[k]).padStart(13)} · saldo ${$(saldo[k]).padStart(12)}`);
  console.log(`Remate ${$(REMATE)} → saldo a castigar ${$(castigo)}${resto > 0 ? ` (sobran ${$(resto)}: revisar)` : ''}`);
  console.log(`  (comisión de prepago ${$(d.comision_prepago)} excluida)`);
  if (!aplicar) { console.log('\nDRY-RUN. Agrega --aplicar.'); process.exit(0); }
  if (resto > 0) { console.log('El remate supera la deuda: no se castiga nada, revisar a mano.'); process.exit(1); }

  const [[ya]] = await pool.query("SELECT id FROM castigos_contables WHERE num_op=? AND estado IN ('PENDIENTE','APROBADO') LIMIT 1", [String(NUM_OP)]);
  if (ya) { console.log('Ya existe un castigo para la op', NUM_OP, '#', ya.id); process.exit(1); }
  const [[pato]] = await pool.query("SELECT id_usuario, TRIM(CONCAT_WS(' ',nombre,apellido)) n FROM usuarios WHERE email='patricio.escobar@autofacilchile.cl' LIMIT 1");
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [t1] = await conn.query('INSERT INTO correlativo_transacciones (created_at) VALUES (NOW())');
    const obs = `Remate judicial ${FECHA} — recaudación contabilizada en AVSOFT (T-60019). Imputación: gastos ${$(pagado.gastos)}, mora ${$(pagado.mora)}, interés ${$(pagado.interes)}, capital ${$(pagado.capital)}`;
    await conn.query(
      `INSERT INTO pagos_credito (id_credito, numero_cuota, fecha_vencimiento, monto_cuota, interes_mora, gastos_cobranza, total_pagado, fecha_pago, estado_pago, observacion, registrado_por, id_registrado_por, origen_fondos, numero_transaccion, interes_mora_total, gastos_cobranza_total)
       VALUES (?,0,NULL,?,?,?,?,?,'PAGADO',?,?,?,'REMATE JUDICIAL',?,?,?)`,
      [idCred, pagado.interes + pagado.capital, pagado.mora, pagado.gastos, REMATE, FECHA, obs.slice(0, 500), pato?.n || 'Script', pato?.id_usuario || null, t1.insertId, deuda.mora, deuda.gastos]);
    const [t2] = await conn.query('INSERT INTO correlativo_transacciones (created_at) VALUES (NOW())');
    const snap = { fecha_corte: FECHA, remate: REMATE, deuda, pagado, saldo, total, liquidacion: { ...d, proyeccion: undefined } };
    const [c] = await conn.query(
      `INSERT INTO castigos_contables (num_op, id_credito, motivo, comentario, saldo_castigado, snapshot, solicitado_por, solicitado_por_nombre, numero_transaccion)
       VALUES (?,?,'INCOBRABLE',?,?,?,?,?,?)`,
      [String(NUM_OP), idCred, `Saldo no cubierto por el remate judicial del ${FECHA} (${$(REMATE)}). Deuda al ${FECHA}: ${$(total)}; saldo: capital ${$(saldo.capital)}, interés ${$(saldo.interes)}, mora ${$(saldo.mora)}, gastos ${$(saldo.gastos)}. Pato 21-09-2026.`,
       castigo, JSON.stringify(snap), pato?.id_usuario || null, pato?.n || 'Script', t2.insertId]);
    await conn.commit();
    await require('../shared/auditoria').registrar({ id_credito: idCred, usuario: pato?.n || 'Script', accion: 'REMATE_JUDICIAL',
      detalle: `Remate judicial ${FECHA} por ${$(REMATE)} registrado (TRX-${String(t1.insertId).padStart(6, '0')}); castigo #${c.insertId} por ${$(castigo)} pendiente de las dos firmas` });   // registrar() no devuelve promesa
    // Aplicado el 21-09-2026: pago TRX-420001 (id_pago 450001) y castigo #1 por $4.324.258 PENDIENTE
    console.log(`Pago registrado TRX-${String(t1.insertId).padStart(6, '0')} · castigo #${c.insertId} por ${$(castigo)} PENDIENTE de firmas`);
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
