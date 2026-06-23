'use strict';
/**
 * Correlativo ÚNICO y global de Órdenes de Pago.
 *
 * Todas las órdenes del sistema —Saldo Precio (Post Venta), Comisión (Post Venta)
 * y las generales a proveedores— toman su número desde aquí, con el formato
 * `OP-AAAA-NNNNNN`. El correlativo NUNCA se reutiliza: si una orden se anula,
 * el número queda reservado, marcado como anulado, con quién la anuló y cuándo.
 *
 * Tabla central `op_correlativos` = libro único de correlativos.
 *   origen: SALDO | COMISION | GENERAL    origen_id: id de la orden en su módulo.
 *
 * El AUTO_INCREMENT arranca alto (100001) para no chocar con los números de
 * prueba antiguos de Post Venta (OP-/OC- de ≤5 dígitos).
 */
const pool = require('./config/database');

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS op_correlativos (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        numero         VARCHAR(30)  UNIQUE,
        origen         VARCHAR(20)  NOT NULL,
        origen_id      INT          NULL,
        concepto       VARCHAR(300) NULL,
        monto          BIGINT       NULL,
        id_usuario     INT          NULL,
        usuario_nombre VARCHAR(200) NULL,
        anulada        TINYINT(1)   NOT NULL DEFAULT 0,
        anulada_por    INT          NULL,
        anulada_nombre VARCHAR(200) NULL,
        fecha_anulada  DATETIME     NULL,
        created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_origen (origen, origen_id),
        INDEX idx_anulada (anulada)
      ) AUTO_INCREMENT=100001`);
  } catch (e) { if (e.errno !== 1050) console.error('[op_correlativos migration]', e.message); }
})();

const fmt = id => 'OP-' + new Date().getFullYear() + '-' + String(id).padStart(6, '0');

/**
 * Asigna el próximo correlativo global y lo registra. Devuelve { id, numero }.
 * @param {object} o
 * @param {'SALDO'|'COMISION'|'GENERAL'} o.origen
 * @param {number} [o.origen_id]  id de la orden en su tabla de módulo
 * @param {string} [o.concepto]
 * @param {number} [o.monto]
 * @param {number} [o.id_usuario]      quién la generó
 * @param {string} [o.usuario_nombre]  nombre de quién la generó
 */
async function emitirCorrelativo({ origen, origen_id = null, concepto = null, monto = null, id_usuario = null, usuario_nombre = null }) {
  const [ins] = await pool.query(
    `INSERT INTO op_correlativos (origen, origen_id, concepto, monto, id_usuario, usuario_nombre)
     VALUES (?,?,?,?,?,?)`,
    [origen, origen_id, concepto, monto != null ? Math.round(Number(monto) || 0) : null, id_usuario, usuario_nombre]);
  const numero = fmt(ins.insertId);
  await pool.query('UPDATE op_correlativos SET numero=? WHERE id=?', [numero, ins.insertId]);
  return { id: ins.insertId, numero };
}

/**
 * Marca un correlativo como ANULADO (el número no se libera). Por número o por origen+id.
 * Registra quién lo anuló y la fecha/hora. No-op si ya estaba anulado o no existe.
 * @returns {boolean} true si marcó la anulación.
 */
async function anularCorrelativo({ numero = null, origen = null, origen_id = null, id_usuario = null, usuario_nombre = null }) {
  try {
    let where, args;
    if (numero) { where = 'numero=? AND anulada=0'; args = [numero]; }
    else if (origen && origen_id) { where = 'origen=? AND origen_id=? AND anulada=0'; args = [origen, origen_id]; }
    else return false;
    const [r] = await pool.query(
      `UPDATE op_correlativos SET anulada=1, anulada_por=?, anulada_nombre=?, fecha_anulada=NOW() WHERE ${where}`,
      [id_usuario, usuario_nombre, ...args]);
    return r.affectedRows > 0;
  } catch (e) { console.error('[anularCorrelativo]', e.message); return false; }
}

module.exports = { emitirCorrelativo, anularCorrelativo };
