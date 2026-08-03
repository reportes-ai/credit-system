'use strict';
/* OP 87634 (ID Trinidad 5829877, mayo 2026): las primas entraron CORRIDAS una
   columna respecto de Trinidad — Reparación Menor quedó como Cesantía, RDH+E
   quedó como Reparación Menor y RDH+E quedó vacío.

   Fuente: pantalla de Trinidad (AutoFin) verificada por Pato el 03-08-2026:
     Seg. Cesantía 124.715 · Reparación Menor 347.214 · Seg. RDH+E 126.679

   El mes está CERRADO: se corrige el DATO (era una lectura errónea, no un cambio
   de negocio) pero NO se recalcula — las comisiones liquidadas quedan intactas.
   El total `seguros` sí se completa porque hoy está NULL. */
const pool = require('../shared/config/database');

const OP = 87634;
const CES = 124715, REP = 347214, RDH = 126679;

(async () => {
  const [[a]] = await pool.query(
    'SELECT id, seguro_rdh, seguro_cesantia, seguro_rep_menor, seguros FROM creditos WHERE num_op=? LIMIT 1', [OP]);
  if (!a) { console.log('No existe la operación'); process.exit(1); }
  console.log('ANTES :', a);

  await pool.query(
    `UPDATE creditos SET seguro_rdh=?, seguro_cesantia=?, seguro_rep_menor=?, seguros=?, updated_at=NOW() WHERE id=?`,
    [RDH, CES, REP, RDH + CES + REP, a.id]);

  const [[d]] = await pool.query(
    'SELECT seguro_rdh, seguro_cesantia, seguro_rep_menor, seguros FROM creditos WHERE id=?', [a.id]);
  console.log('DESPUÉS:', d);

  await pool.query(
    `INSERT INTO auditoria_credito (id_credito, usuario, accion, detalle)
     VALUES (?, 'Sistema (corrección)', 'CORRECCION_DATOS', ?)`,
    [a.id, `Primas corregidas contra la pantalla de Trinidad: habían entrado corridas una columna (Rep. Menor figuraba como Cesantía y RDH+E como Rep. Menor). Cesantía ${CES}, Rep. Menor ${REP}, RDH+E ${RDH}. Mes cerrado: sin recálculo de comisiones.`]
  ).catch(e => console.log('(auditoría no registrada:', e.message + ')'));

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
