/* Deshace la regularización de migración SOLO para julio 2026.

   Por qué: la regularización del 13-08-2026 marcó como pagadas las comisiones de
   parque de 2025 y de enero a julio 2026. Pero JULIO no estaba pagado — es
   justamente el mes que se está por cobrar: su cartola ni siquiera se ha
   emitido. Marcarlo saltó todo el circuito (emitir → aprobar → enviar → factura
   → ODP → pagar) y dejó las cartolas de julio como si el parque ya hubiera
   cobrado.

   Deja las operaciones de julio como estaban antes: con su etapa inicial
   COMISION A PAGAR y nada más, para que la cartola se emita de verdad.

   NO toca:
   · Los meses anteriores (2025 y enero-junio 2026), que sí se pagaron por planilla.
   · Los parques cuya cartola de julio avanzó por PANTALLA y no por la migración
     (se reconocen porque su parques_pagos_mes no dice 'Migración').

   Uso:  node scripts/revertir-regularizacion-parques-julio.js            → simula
         node scripts/revertir-regularizacion-parques-julio.js --aplicar  → escribe
*/
const pool = require('../shared/config/database');

const APLICAR = process.argv.includes('--aplicar');
const MES = '2026-07';
// La etapa inicial la pone el sistema a toda operación viva: esa se conserva.
const ETAPAS_MIGRACION = ['CARTOLA EMITIDA', 'CARTOLA APROBADA', 'CARTOLA ENVIADA',
  'FACTURA RECIBIDA', 'ORDEN DE PAGO EMITIDA', 'ENVIADO A PAGO', 'COMISION PAGADA'];

(async () => {
  /* Solo lo que marcó la migración. Si alguien emitió o aprobó la cartola desde
     la pantalla, ese avance es legítimo y no se toca. */
  const [filas] = await pool.query(
    `SELECT parque, etapa, ops, comision_creditos, arriendo, aprobada_por, pagada_por
       FROM parques_pagos_mes
      WHERE DATE_FORMAT(mes,'%Y-%m') = ?
        AND (aprobada_por = 'Migración' OR pagada_por = 'Migración' OR emitida_por = 'Migración')`, [MES]);

  if (!filas.length) { console.log('No hay nada de julio marcado por la migración.'); process.exit(0); }

  console.log(APLICAR ? '=== APLICANDO ===' : '=== SIMULACIÓN (usa --aplicar para escribir) ===');
  for (const f of filas) {
    console.log(`${f.parque.padEnd(30)} ${String(f.etapa).padEnd(16)} ${f.ops} ops · ` +
      `comisión $${Number(f.comision_creditos).toLocaleString('es-CL')} + arriendo $${Number(f.arriendo).toLocaleString('es-CL')}`);
    if (!APLICAR) continue;

    // 1) Quitar las etapas que puso la migración (por la FOTO, que es lo que las ató)
    for (const etapa of ETAPAS_MIGRACION) {
      const [r] = await pool.query(`
        DELETE pe FROM postventa_etapas pe
        JOIN postventa_seguimiento s ON s.id = pe.id_seguimiento
        JOIN creditos c ON c.id = s.id_credito
        JOIN parques_pagos_ops po ON po.num_op = c.num_op
        WHERE pe.track='PARQUE' AND pe.etapa=?
          AND po.parque=? AND DATE_FORMAT(po.mes,'%Y-%m')=?`, [etapa, f.parque, MES]);
      if (r.affectedRows) console.log(`   − ${etapa}: ${r.affectedRows}`);
    }
    // 2) Borrar la foto: sin ella el motor vuelve a calcular la cartola en vivo
    await pool.query("DELETE FROM parques_pagos_ops WHERE parque=? AND DATE_FORMAT(mes,'%Y-%m')=?", [f.parque, MES]);
    // 3) El parque-mes vuelve a no existir: la cartola está por emitirse
    await pool.query("DELETE FROM parques_pagos_mes WHERE parque=? AND DATE_FORMAT(mes,'%Y-%m')=?", [f.parque, MES]);
    console.log('   ✓ vuelve a "por emitir"');
  }

  if (APLICAR) {
    try {
      await require('../shared/audit').auditar({
        usuario: 'Sistema', accion: 'REVERSAR', modulo: 'postventa', entidad: 'parque_pago',
        detalle: `Revertida la regularización de migración de ${MES} en ${filas.length} parque(s): ` +
                 filas.map(f => f.parque).join(', ') + '. Julio no estaba pagado: su cartola aún no se emite.',
      });
    } catch (e) { console.error('[auditoría]', e.message); }
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
