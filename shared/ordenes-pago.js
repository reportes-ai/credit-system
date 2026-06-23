'use strict';
/**
 * Correlativo ÚNICO y global de Órdenes de Pago.
 *
 * Todas las órdenes del sistema —Saldo Precio (Post Venta), Comisión (Post Venta)
 * y las generales a proveedores— toman su número desde aquí, con el formato
 * `ODPaannnn` → `ODP260001` (ODP = Orden De Pago; `26` = año; `0001` = correlativo
 * del año). NO confundir con el N° OP de Operación del crédito.
 * El correlativo NUNCA se reutiliza: si una orden se anula, el número queda
 * reservado, marcado como anulado, con quién la anuló y cuándo.
 *
 * Tablas:
 *   op_correlativos = libro único de correlativos (origen SALDO|COMISION|GENERAL,
 *                     origen_id = id de la orden en su módulo, quién generó/anuló).
 *   op_secuencia    = contador por año (reinicia en 0001 cada enero), atómico.
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
      )`);
  } catch (e) { if (e.errno !== 1050) console.error('[op_correlativos migration]', e.message); }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS op_secuencia (
        anio   INT NOT NULL PRIMARY KEY,
        ultimo INT NOT NULL DEFAULT 0
      )`);
  } catch (e) { if (e.errno !== 1050) console.error('[op_secuencia migration]', e.message); }
  // Registro de PAGO de la orden (egreso desde una caja) — incremental.
  try {
    await pool.query(`ALTER TABLE op_correlativos ADD COLUMN IF NOT EXISTS pagada TINYINT(1) NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE op_correlativos ADD COLUMN IF NOT EXISTS fecha_pagada DATETIME NULL`);
    await pool.query(`ALTER TABLE op_correlativos ADD COLUMN IF NOT EXISTS pagada_por INT NULL`);
    await pool.query(`ALTER TABLE op_correlativos ADD COLUMN IF NOT EXISTS pagada_nombre VARCHAR(200) NULL`);
    await pool.query(`ALTER TABLE op_correlativos ADD COLUMN IF NOT EXISTS id_caja INT NULL`);
    await pool.query(`ALTER TABLE op_correlativos ADD COLUMN IF NOT EXISTS metodo_pago VARCHAR(40) NULL`);
  } catch (e) { console.error('[op_correlativos pago cols]', e.message); }
  // Snapshot inmutable "en duro": al pagar se congela el documento completo (JSON) y deja
  // de recalcularse desde las tablas fuente. Garantiza que una orden pagada nunca cambie.
  try {
    await pool.query(`ALTER TABLE op_correlativos ADD COLUMN IF NOT EXISTS snapshot_json LONGTEXT NULL`);
    await pool.query(`ALTER TABLE op_correlativos ADD COLUMN IF NOT EXISTS snapshot_at DATETIME NULL`);
  } catch (e) { console.error('[op_correlativos snapshot col]', e.message); }
})();

// Próximo correlativo del año (atómico: lock de fila con FOR UPDATE).
async function nextSeq(anio) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('INSERT INTO op_secuencia (anio, ultimo) VALUES (?, 0) ON DUPLICATE KEY UPDATE anio=anio', [anio]);
    const [[row]] = await conn.query('SELECT ultimo FROM op_secuencia WHERE anio=? FOR UPDATE', [anio]);
    const next = (row.ultimo || 0) + 1;
    await conn.query('UPDATE op_secuencia SET ultimo=? WHERE anio=?', [next, anio]);
    await conn.commit();
    return next;
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    throw e;
  } finally {
    conn.release();
  }
}

const fmt = (anio, seq) => 'ODP' + String(anio).slice(-2) + String(seq).padStart(4, '0');

/**
 * Asigna el próximo correlativo único y lo registra. Devuelve { id, numero }.
 * @param {object} o
 * @param {'SALDO'|'COMISION'|'GENERAL'} o.origen
 * @param {number} [o.origen_id]  id de la orden en su tabla de módulo
 * @param {string} [o.concepto]
 * @param {number} [o.monto]
 * @param {number} [o.id_usuario]      quién la generó
 * @param {string} [o.usuario_nombre]  nombre de quién la generó
 */
async function emitirCorrelativo({ origen, origen_id = null, concepto = null, monto = null, id_usuario = null, usuario_nombre = null }) {
  const anio = new Date().getFullYear();
  const seq = await nextSeq(anio);
  const numero = fmt(anio, seq);
  const [ins] = await pool.query(
    `INSERT INTO op_correlativos (numero, origen, origen_id, concepto, monto, id_usuario, usuario_nombre)
     VALUES (?,?,?,?,?,?,?)`,
    [numero, origen, origen_id, concepto, monto != null ? Math.round(Number(monto) || 0) : null, id_usuario, usuario_nombre]);
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
