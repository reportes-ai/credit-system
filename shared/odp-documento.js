/* ─────────────────────────────────────────────────────────────────────────────
   ¿Esta orden de pago tiene su documento tributario en el auxiliar de compras?

   Motor ÚNICO de ese match (Máxima 1). Lo usan:
   · el pago de la ODP  → para reemplazar la CxP genérica 2102010 por la cuenta
     donde de verdad quedó devengada la factura (services/ordenes-pago);
   · la provisión de otros gastos → una ODP SIN documento es gasto no reconocido,
     y hay que devengarlo al cierre (services/contabilidad/src/provisiones.js).

   La regla del match, en orden: primero por RUT + folio si la orden trae el número
   de documento; si no, por RUT + total exacto, la más reciente. Es la misma que se
   venía usando al pagar desde el 27-08-2026 — acá solo quedó en un solo lugar.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('./config/database');

const limpiarRut = r => String(r || '').replace(/[.\s]/g, '').toUpperCase();

/* Busca el documento del auxiliar que corresponde a la orden.
   `op` necesita: proveedor_rut, numero_documento (opcional) y monto.
   Devuelve la fila del auxiliar (id, num_doc, fecha_doc, cuenta_cxp, cuenta_gasto,
   neto, exento, iva, total) o null si no hay documento registrado. */
async function buscar(op, opts = {}) {
  const rut = limpiarRut(op && op.proveedor_rut);
  if (!rut) return null;
  const COLS = 'id, mes, tipo_doc, num_doc, fecha_doc, rut, cuenta_cxp, cuenta_gasto, neto, exento, iva, total';
  // `conCxp` lo usa el pago: ahí solo sirve el documento que trae cuenta por pagar,
  // porque justamente se busca con qué cuenta reemplazar la 2102010 genérica.
  const filtro = opts.conCxp ? ' AND cuenta_cxp IS NOT NULL' : '';
  try {
    if (op.numero_documento) {
      const [[porFolio]] = await pool.query(
        `SELECT ${COLS} FROM ctb_compras_aux WHERE REPLACE(rut,'.','')=? AND num_doc=?${filtro} ORDER BY id DESC LIMIT 1`,
        [rut, String(op.numero_documento)]);
      if (porFolio) return porFolio;
    }
    const monto = Math.round(Number(op.monto) || 0);
    if (!monto) return null;
    const [[porMonto]] = await pool.query(
      `SELECT ${COLS} FROM ctb_compras_aux WHERE REPLACE(rut,'.','')=? AND total=?${filtro} ORDER BY fecha_doc DESC, id DESC LIMIT 1`,
      [rut, monto]);
    return porMonto || null;
  } catch (e) { console.error('[odp-documento]', e.message); return null; }
}

/* true si la orden ya tiene su documento en el auxiliar. */
const tiene = async op => !!(await buscar(op));

module.exports = { buscar, tiene, limpiarRut };
