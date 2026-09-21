/* Reclasifica el interés corriente de los pagos de cuotas de cartera propia contabilizados ANTES
 * de v259.8: la regla PAGO_CAJA abonaba la cuota completa (capital + interés) a 1104010 Contratos
 * Propios y el interés corriente nunca llegaba a resultado.
 *
 * Por cada asiento PAGO_CAJA ya CONTABILIZADO se calcula el interés de las cuotas pagadas con el
 * mismo motor del pago (separarCapitalInteres: tabla de desarrollo, primero interés) y se registra
 * un asiento RECLASIF_INTERES_CARTERA (DEBE 1104010 / HABER 3001010) con la MISMA fecha del asiento
 * original, para que cada mes quede bien. Idempotente: la ref es RECL-TRX-xxxxxx y el motor no
 * repite una ref ya contabilizada.
 *
 * Uso (siempre con MOTORES=off):
 *   node scripts/reclasificar-interes-pago-caja-2026-09-21.js            (dry-run: solo muestra)
 *   node scripts/reclasificar-interes-pago-caja-2026-09-21.js --aplicar
 */
const pool = require('../shared/config/database');
const motor = require('../services/contabilidad/src/motor-asientos');
const { separarCapitalInteres } = require('../services/creditos/src/controllers/pagos-credito.controller');

(async () => {
  const aplicar = process.argv.includes('--aplicar');
  // La regla nace en la migración del motor (enFila): esperar a que exista
  for (let i = 0; i < 30; i++) {
    const [[r]] = await pool.query("SELECT evento FROM ctb_reglas WHERE evento='RECLASIF_INTERES_CARTERA'");
    if (r) break;
    if (i === 29) { console.log('La regla RECLASIF_INTERES_CARTERA no existe todavía'); process.exit(1); }
    await new Promise(r => setTimeout(r, 3000));
  }
  const [asientos] = await pool.query(
    `SELECT l.ref, c.id id_comprobante, DATE_FORMAT(c.fecha,'%Y-%m-%d') fecha
       FROM ctb_eventos_log l JOIN ctb_comprobantes c ON c.id = l.id_comprobante
      WHERE l.evento='PAGO_CAJA' AND l.estado='CONTABILIZADO' AND c.estado='CONTABILIZADO'
      ORDER BY c.fecha, c.id`);
  let total = 0;
  const plan = [];
  for (const a of asientos) {
    const trx = Number(String(a.ref).replace(/\D/g, ''));
    // ¿Este asiento ya separó el interés? (asientos hechos con la regla nueva tienen línea en 3001010)
    const [[yaSep]] = await pool.query(
      "SELECT COUNT(*) n FROM ctb_movimientos WHERE id_comprobante=? AND cuenta='3001010'", [a.id_comprobante]).catch(() => [[{ n: 0 }]]);
    if (yaSep.n) continue;
    const [pagos] = await pool.query(
      "SELECT id_credito, numero_cuota, monto_cuota FROM pagos_credito WHERE numero_transaccion=? AND estado_pago='PAGADO'", [trx]);
    if (!pagos.length) { console.log('  sin pagos vigentes para', a.ref, '(¿reversado?) — se omite'); continue; }
    const ci = await separarCapitalInteres(pagos[0].id_credito, pagos, trx);
    const [[cr]] = await pool.query('SELECT num_op FROM creditos WHERE id=?', [pagos[0].id_credito]);
    plan.push({ ...a, trx, interes: ci.interes, capital: ci.capital, num_op: cr && cr.num_op });
    total += ci.interes;
  }
  plan.forEach(p => console.log(`  ${p.fecha} ${p.ref} OP ${p.num_op}: interés $${p.interes.toLocaleString('es-CL')} (capital $${p.capital.toLocaleString('es-CL')})`));
  console.log(`Total a reclasificar 1104010 → 3001010: $${total.toLocaleString('es-CL')} en ${plan.length} asiento(s)`);
  if (!aplicar) { console.log('\nDRY-RUN. Agrega --aplicar para contabilizar.'); process.exit(0); }
  for (const p of plan) {
    if (!p.interes) continue;
    const id = await motor.contabilizar({
      evento: 'RECLASIF_INTERES_CARTERA', fecha: p.fecha, ref: `RECL-${p.ref}`, num_op: p.num_op,
      glosa: `Reclasificación interés corriente — ${p.ref} · OP ${p.num_op} (asiento #${p.id_comprobante})`,
      montos: { interes: p.interes }, detalle: `${p.ref} · OP ${p.num_op}`,
    });
    console.log(`  ${p.ref}: ${id ? 'comprobante #' + id : 'NO contabilizado (ver ctb_eventos_log)'}`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
