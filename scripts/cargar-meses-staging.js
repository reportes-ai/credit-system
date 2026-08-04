'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   LÍNEA BASE DE REGRESIÓN — carga meses completos de cartera en staging.

   Para qué: poder correr el MISMO informe en staging y en producción y exigir
   que las cifras den idénticas. Sin esto, staging sirve para ver que una pantalla
   no reviente, pero no para responder la pregunta que importa antes de un
   cambio: *¿siguen cuadrando los números?*

   Cómo se elige qué traer: el ancla son los `creditos` cuyo `mes` cae en los
   meses pedidos. De ahí cuelga TODO lo demás — sus clientes, sus cuotas, sus
   pagos, sus cartas, sus cartolas, su post venta, sus fundantes y su
   contabilidad. Traer media operación sería peor que no traerla: cuadraría mal
   y nadie sabría si es el cambio o la carga.

   Los datos son REALES (nombres y RUT). Lo que no viaja es la posibilidad de
   contactar a alguien: correos y teléfonos se enmascaran en la copia (motor
   único en scripts/lib/copiar-filas.js), y en staging `ENTORNO=staging` ya
   fuerza el Modo Desarrollo y apaga los motores que envían.

   Uso:  node scripts/cargar-meses-staging.js                      (simulación)
         node scripts/cargar-meses-staging.js --ejecutar
         node scripts/cargar-meses-staging.js --ejecutar --meses=2026-05,2026-06
         node scripts/cargar-meses-staging.js --ejecutar --limpiar  (borra antes)
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../shared/config/database');
const { copiarTabla } = require('./lib/copiar-filas');

const EJECUTAR = process.argv.includes('--ejecutar');
const LIMPIAR  = process.argv.includes('--limpiar');
const DESTINO  = process.env.DB_NAME_STAGING || 'credit_system_staging';

/** Los dos últimos meses COMPLETOS (el mes en curso no lo está). */
function ultimosDosMeses() {
  const hoy = new Date();
  const out = [];
  for (const atras of [2, 1]) {
    const d = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - atras, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
const argMeses = (process.argv.find(a => a.startsWith('--meses=')) || '').split('=')[1];
const MESES = argMeses ? argMeses.split(',').map(s => s.trim()) : ultimosDosMeses();

/* ── Qué se copia y cómo se ata al ancla ─────────────────────────────────────
   `por` define el vínculo:
     ancla       → las filas de `creditos` de esos meses
     id_credito  → columna que apunta a creditos.id
     num_op      → columna que apunta a creditos.num_op
     id_cliente / rut_cliente → los clientes de esas operaciones
     mes / sql   → filtro propio de la tabla (contabilidad, cierres)
   El ORDEN importa: primero los padres, después los hijos. */
const GRUPOS = [
  ['Clientes de esas operaciones', [
    { tabla: 'clientes',               por: 'id_cliente',  col: 'id_cliente' },
    { tabla: 'antecedentes_laborales', por: 'rut_cliente', col: 'rut_cliente' },
    { tabla: 'informacion_comercial',  por: 'rut_cliente', col: 'rut_cliente' },
  ]],
  ['Las operaciones', [
    { tabla: 'creditos', por: 'ancla' },
  ]],
  ['Calendario y pagos', [
    { tabla: 'cuotas_credito',  por: 'id_credito', col: 'id_credito' },
    { tabla: 'pagos_credito',   por: 'id_credito', col: 'id_credito' },
    { tabla: 'provisiones_detalle', por: 'id_credito', col: 'id_credito' },
    { tabla: 'cobranza_judicial',   por: 'num_op',     col: 'num_op' },
    { tabla: 'cobranza_gestiones',  por: 'id_credito', col: 'id_credito' },
  ]],
  ['Cartas y cartolas (la comisión del dealer)', [
    { tabla: 'cartas_aprobacion',      por: 'rut_cliente', col: 'rut_cliente' },
    { tabla: 'cartolas_movimientos',   por: 'num_op',      col: 'num_op' },
    { tabla: 'cartola_incorporaciones', por: 'num_op',     col: 'num_op' },
    { tabla: 'cartolas_enviadas',      por: 'mes',         col: 'mes' },
  ]],
  ['Post venta y fundantes', [
    { tabla: 'postventa_seguimiento',        por: 'id_credito', col: 'id_credito' },
    { tabla: 'postventa_etapas',             por: 'sql',
      sql: 'id_seguimiento IN (SELECT id FROM `@ORIGEN`.postventa_seguimiento WHERE id_credito IN (@IDS))' },
    { tabla: 'postventa_ordenes',            por: 'num_op', col: 'num_op' },
    { tabla: 'postventa_ordenes_comision',   por: 'num_op', col: 'num_op' },
    { tabla: 'postventa_facturas_comision',  por: 'num_op', col: 'num_op' },
    { tabla: 'fundantes_seg',                por: 'id_credito', col: 'id_credito' },
    { tabla: 'fundantes_seg_docs',           por: 'id_credito', col: 'id_credito' },
    { tabla: 'fundantes_bitacora',           por: 'id_credito', col: 'id_credito' },
  ]],
  ['Comisiones y cierres del mes', [
    { tabla: 'comisiones_aprobaciones', por: 'mes', col: 'mes' },
    { tabla: 'meses_cerrados',          por: 'mes', col: 'mes' },
    { tabla: 'parques_pagos_mes',       por: 'mes', col: 'mes' },
    { tabla: 'cierre_saldos_pagados',   por: 'num_op', col: 'num_op' },
    { tabla: 'anulaciones_operacion',   por: 'id_credito', col: 'id_credito' },
  ]],
  ['Contabilidad de esos meses (comprobante completo, no partido)', [
    { tabla: 'ctb_comprobantes', por: 'sql', sql: 'fecha >= ? AND fecha < ?', fechas: true },
    { tabla: 'ctb_movimientos',  por: 'sql',
      sql: 'id_comprobante IN (SELECT id FROM `@ORIGEN`.ctb_comprobantes WHERE fecha >= ? AND fecha < ?)', fechas: true },
    { tabla: 'contab_saldos_mensuales', por: 'mes', col: 'mes' },
  ]],
];

const lista = arr => arr.map(v => typeof v === 'number' ? v : `'${String(v).replace(/'/g, "''")}'`).join(',');

(async () => {
  const [[{ d: ORIGEN }]] = await pool.query('SELECT DATABASE() d');
  if (ORIGEN === DESTINO) throw new Error('El origen y el destino son la misma base. Aborta.');

  const primero = MESES[0] + '-01';
  const fin = (() => { const [y, m] = MESES[MESES.length - 1].split('-').map(Number);
    const d = new Date(Date.UTC(y, m, 1)); return d.toISOString().slice(0, 10); })();
  const mesesSQL = MESES.map(m => m + '-01');

  const [anclas] = await pool.query(
    `SELECT id, num_op, id_cliente FROM \`${ORIGEN}\`.creditos WHERE DATE(mes) IN (?)`, [mesesSQL]);

  console.log(`\nMeses: ${MESES.join(', ')}   (${primero} → ${fin})`);
  console.log(`Operaciones ancla: ${anclas.length.toLocaleString('es-CL')}`);
  if (!anclas.length) { console.log('No hay operaciones en esos meses. Nada que hacer.\n'); process.exit(0); }

  const ids   = anclas.map(a => a.id);
  const ops   = [...new Set(anclas.map(a => a.num_op).filter(v => v != null))];
  const idCli = [...new Set(anclas.map(a => a.id_cliente).filter(v => v != null))];

  const [ruts] = idCli.length
    ? await pool.query(`SELECT DISTINCT rut FROM \`${ORIGEN}\`.clientes WHERE id_cliente IN (?)`, [idCli])
    : [[]];
  const rutList = ruts.map(r => r.rut).filter(Boolean);

  console.log(`  · clientes: ${idCli.length}   · RUT distintos: ${rutList.length}   · num_op: ${ops.length}\n`);

  if (!EJECUTAR) {
    console.log('Se copiarían estas tablas (filtradas al ancla):');
    for (const [grupo, tablas] of GRUPOS) console.log(`\n${grupo}:\n   ${tablas.map(t => t.tabla).join(', ')}`);
    console.log('\n[SIMULACIÓN] No se copió nada. Corre con --ejecutar para aplicar.\n');
    process.exit(0);
  }

  const cx = await pool.getConnection();
  await cx.query('SET FOREIGN_KEY_CHECKS = 0');

  const todas = GRUPOS.flatMap(([, t]) => t);
  if (LIMPIAR) {
    for (const t of [...todas].reverse()) {
      try { await cx.query(`DELETE FROM \`${DESTINO}\`.\`${t.tabla}\``); } catch (_) { /* no existe */ }
    }
    console.log(`✓ ${todas.length} tablas vaciadas en ${DESTINO} antes de cargar\n`);
  }

  const hechas = [], vacias = [], errores = [];
  for (const [grupo, tablas] of GRUPOS) {
    console.log(grupo + ':');
    for (const t of tablas) {
      let where = '', params = [];
      if (t.por === 'ancla')            { where = `id IN (${lista(ids)})`; }
      else if (t.por === 'id_credito')  { where = `\`${t.col}\` IN (${lista(ids)})`; }
      else if (t.por === 'num_op')      { where = ops.length   ? `\`${t.col}\` IN (${lista(ops)})`   : '1=0'; }
      else if (t.por === 'id_cliente')  { where = idCli.length ? `\`${t.col}\` IN (${lista(idCli)})` : '1=0'; }
      else if (t.por === 'rut_cliente') { where = rutList.length ? `\`${t.col}\` IN (${lista(rutList)})` : '1=0'; }
      else if (t.por === 'mes')         { where = `DATE(\`${t.col}\`) IN (${lista(mesesSQL)}) OR \`${t.col}\` IN (${lista(MESES)})`; }
      else if (t.por === 'sql') {
        where = t.sql.replace('@ORIGEN', ORIGEN).replace('@IDS', lista(ids));
        if (t.fechas) params = [primero, fin];
      }

      try {
        const r = await copiarTabla(cx, { origen: ORIGEN, destino: DESTINO, tabla: t.tabla, where, params });
        if (!r.filas) { vacias.push(t.tabla); console.log(`   · ${t.tabla.padEnd(30)} —`); continue; }
        const [[chk]] = await cx.query(`SELECT COUNT(*) n FROM \`${DESTINO}\`.\`${t.tabla}\``);
        console.log(`   ✓ ${t.tabla.padEnd(30)} ${String(r.filas).padStart(6)} filas` +
                    (r.mascaras.length ? `  · enmascarado: ${r.mascaras.join(', ')}` : ''));
        hechas.push(r);
        if (Number(chk.n) < r.filas) errores.push(`${t.tabla}: se copiaron ${r.filas} pero hay ${chk.n}`);
      } catch (e) {
        if (t.opcional && /no existe|doesn't exist/i.test(e.message)) continue;
        errores.push(`${t.tabla}: ${e.message}`);
        console.log(`   ✗ ${t.tabla.padEnd(30)} ${e.message}`);
      }
    }
  }

  await cx.query('SET FOREIGN_KEY_CHECKS = 1');
  cx.release();

  const total = hechas.reduce((s, r) => s + r.filas, 0);
  console.log(`\n✓ ${hechas.length} tablas cargadas · ${total.toLocaleString('es-CL')} filas.`);
  if (vacias.length) console.log(`(${vacias.length} sin filas para estos meses: ${vacias.join(', ')})`);
  if (errores.length) { console.log('\n✗ Errores:'); errores.forEach(e => console.log('   ' + e)); }
  console.log('\nPara cuadrar: corre el MISMO informe en los dos ambientes y compara.');
  console.log('Si un número difiere y no tocaste nada, el problema es la carga, no el sistema.\n');
  process.exit(errores.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
