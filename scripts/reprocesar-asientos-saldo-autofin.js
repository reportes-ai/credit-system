'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Reproceso puntual (13-08-2026): asientos de SALDO PRECIO de AUTOFIN emitidos
   por el saldo pelado, cuando lo que entra y lo que se paga es el TOTAL de la
   orden (saldo + Limitación + Transferencia = $45.380). Ver v207.53.

   Con el monto corto, la cuenta de paso 2102045 arrastraba $45.380 por operación.

   CÓMO TRABAJA (regla de la casa: el patrón descubre, la lista verificada ejecuta)
   1. Descubre los comprobantes candidatos y calcula el monto correcto con el
      MOTOR ÚNICO (montoSaldoOrden), nunca con una fórmula copiada acá.
   2. Solo toca los que difieren EXACTAMENTE en los fijos de AutoFin. Cualquier
      otra diferencia se informa y se deja intacta: es otro problema.
   3. Respalda a JSON antes de escribir, y verifica el cuadre después.
   4. En seco por defecto. Para aplicar:  node scripts/reprocesar-asientos-saldo-autofin.js --aplicar
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../shared/config/database');
const pv = require('../services/postventa/src/controllers/postventa.controller');

const APLICAR = process.argv.includes('--aplicar');
const CLP = n => '$' + Math.round(n).toLocaleString('es-CL');

(async () => {
  const fijos = await pv.getFijosAutoFin();
  const ESPERADO = (fijos.autofin_inscripcion || 0) + (fijos.autofin_limitacion || 0);
  console.log(`Fijos AutoFin: ${CLP(ESPERADO)} (inscripción ${CLP(fijos.autofin_inscripcion)} + limitación ${CLP(fijos.autofin_limitacion)})`);

  const [cerr] = await pool.query('SELECT mes FROM ctb_meses_cerrados');
  const cerrados = new Set(cerr.map(c => c.mes));

  const [rows] = await pool.query(`
    SELECT cc.id, cc.fecha, cc.origen, cc.origen_ref, cc.total, s.id AS sid, s.num_op, s.financiera,
           s.saldo_precio, po.monto AS odp_monto, po.num_orden,
           COALESCE(NULLIF(dl.nombre_indexa,''), dl.nombre_razon, c.nombre_local, s.nombre_dealer) AS dealer,
           COALESCE(c.rut_dealer, dl.rut) AS rut_dealer
      FROM ctb_comprobantes cc
      JOIN postventa_seguimiento s
        ON cc.origen_ref IN (CONCAT('SP-', s.num_op, '-IN'), CONCAT('SP-', s.num_op, '-OUT'))
      LEFT JOIN creditos c ON c.id = s.id_credito
      LEFT JOIN dealers  dl ON dl.id_dealer = c.id_dealer
      LEFT JOIN postventa_ordenes po ON po.id_seguimiento = s.id
     WHERE cc.estado = 'CONTABILIZADO'
       AND cc.origen IN ('SALDO_FONDOS_RECIBIDOS', 'SALDO_PRECIO_PAGADO')
     ORDER BY cc.id`);

  const aplicar = [], omitidos = [];
  for (const r of rows) {
    const correcto = Math.round(r.odp_monto != null
      ? Number(r.odp_monto)
      : pv.montoSaldoOrden(r.financiera, r.saldo_precio, fijos));
    const actual = Math.round(Number(r.total));
    const delta = correcto - actual;
    if (delta === 0) continue;
    const mes = new Date(r.fecha).toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' }).slice(0, 7);
    if (delta !== ESPERADO) { omitidos.push({ ...r, actual, correcto, delta, motivo: `diferencia ${CLP(delta)} ≠ fijos AutoFin` }); continue; }
    if (cerrados.has(mes))  { omitidos.push({ ...r, actual, correcto, delta, motivo: `mes ${mes} cerrado con candado` }); continue; }
    aplicar.push({ id: r.id, ref: r.origen_ref, num_op: r.num_op, actual, correcto, delta,
                   detalle: [r.num_orden, r.dealer].filter(Boolean).join(' · '), rut: r.rut_dealer || null });
  }

  console.log(`\nA corregir: ${aplicar.length}   ·   Omitidos: ${omitidos.length}`);
  omitidos.forEach(o => console.log(`  OMITIDO ${o.origen_ref}: ${CLP(o.actual)} → ${CLP(o.correcto)} — ${o.motivo}`));
  if (!aplicar.length) { console.log('Nada que hacer.'); process.exit(0); }
  console.log(`Impacto en la cuenta de paso: ${CLP(aplicar.reduce((s, a) => s + a.delta, 0))}`);

  if (!APLICAR) { console.log('\n(SIMULACIÓN — vuelve a correr con --aplicar para escribir)'); process.exit(0); }

  // Respaldo antes de escribir
  const [movs] = await pool.query('SELECT * FROM ctb_movimientos WHERE id_comprobante IN (?)', [aplicar.map(a => a.id)]);
  const [comps] = await pool.query('SELECT * FROM ctb_comprobantes WHERE id IN (?)', [aplicar.map(a => a.id)]);
  const backup = path.join(process.env.SALIDA || '.', `respaldo-asientos-saldo-${Date.now()}.json`);
  fs.writeFileSync(backup, JSON.stringify({ comprobantes: comps, movimientos: movs }, null, 1));
  console.log('Respaldo:', backup);

  let ok = 0;
  for (const a of aplicar) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // El asiento tiene una línea al DEBE y una al HABER por el mismo monto.
      await conn.query('UPDATE ctb_movimientos SET debe = IF(debe > 0, ?, 0), haber = IF(haber > 0, ?, 0) WHERE id_comprobante = ?',
        [a.correcto, a.correcto, a.id]);
      // Trazabilidad que faltaba: N° de orden + dealer en la glosa, y RUT del tercero.
      if (a.detalle) await conn.query(
        `UPDATE ctb_movimientos SET glosa = LEFT(CONCAT(SUBSTRING_INDEX(glosa, ' · ', 1), ' · ', ?), 300), rut = COALESCE(rut, ?)
          WHERE id_comprobante = ?`, [a.detalle, a.rut, a.id]);
      await conn.query('UPDATE ctb_comprobantes SET total = ? WHERE id = ?', [a.correcto, a.id]);
      // Verificación dentro de la transacción: si no cuadra, se revierte.
      const [[chk]] = await conn.query('SELECT SUM(debe) d, SUM(haber) h FROM ctb_movimientos WHERE id_comprobante = ?', [a.id]);
      if (Math.round(chk.d) !== Math.round(chk.h) || Math.round(chk.d) !== a.correcto)
        throw new Error(`descuadre tras corregir: debe ${chk.d} / haber ${chk.h}`);
      await conn.commit();
      ok++;
      console.log(`  ✓ ${a.ref}  ${CLP(a.actual)} → ${CLP(a.correcto)}  (${a.detalle})`);
    } catch (e) {
      await conn.rollback();
      console.error(`  ✗ ${a.ref}: ${e.message} — sin cambios`);
    } finally { conn.release(); }
  }
  console.log(`\nCorregidos ${ok} de ${aplicar.length}.`);
  process.exit(0);
})();
