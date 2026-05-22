const pool  = require('../../../../shared/config/database');
const audit = require('../../../../shared/auditoria');

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pagos_credito (
        id_pago              INT AUTO_INCREMENT PRIMARY KEY,
        id_credito           INT            NOT NULL,
        numero_cuota         INT            NOT NULL,
        fecha_vencimiento    DATE           NULL,
        monto_cuota          DECIMAL(14,2)  DEFAULT 0,
        interes_mora         DECIMAL(14,2)  DEFAULT 0,
        gastos_cobranza      DECIMAL(14,2)  DEFAULT 0,
        total_pagado         DECIMAL(14,2)  DEFAULT 0,
        fecha_pago           DATETIME       NULL,
        estado_pago          VARCHAR(30)    DEFAULT 'PAGADO',
        observacion          TEXT           NULL,
        registrado_por       VARCHAR(200)   NULL,
        id_registrado_por    INT            NULL,
        id_caja              INT            NULL,
        created_at           DATETIME       DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_credito    (id_credito),
        INDEX idx_cuota      (id_credito, numero_cuota),
        INDEX idx_registrado (id_registrado_por)
      )
    `);
    // Migración: agregar columna en tablas existentes sin ella
    await pool.query(`
      ALTER TABLE pagos_credito
      ADD COLUMN IF NOT EXISTS id_registrado_por INT NULL,
      ADD INDEX IF NOT EXISTS idx_registrado (id_registrado_por)
    `).catch(() => {});
    await pool.query(`
      ALTER TABLE pagos_credito
      ADD COLUMN IF NOT EXISTS id_caja INT NULL
    `).catch(() => {});
  } catch(e) { if (e.errno !== 1050) console.error('[pagos_credito migration]', e.message); }
})();

/* ─── GET historial por crédito ─────────────────────────────────────────── */
const getByCredito = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM pagos_credito
       WHERE id_credito = ?
       ORDER BY numero_cuota ASC, fecha_pago ASC`,
      [req.params.id_credito]
    );
    res.json({ success: true, data: rows, error: null });
  } catch(e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

/* ─── GET un pago por ID ─────────────────────────────────────────────────── */
const getById = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM pagos_credito WHERE id_pago = ?',
      [req.params.id_pago]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Pago no encontrado' });
    res.json({ success: true, data: rows[0], error: null });
  } catch(e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

/* ─── POST registrar pago ────────────────────────────────────────────────── */
const create = async (req, res) => {
  try {
    const {
      id_credito, numero_cuota, fecha_vencimiento,
      monto_cuota, interes_mora, gastos_cobranza,
      total_pagado, fecha_pago, estado_pago, observacion, id_caja
    } = req.body;
    if (!id_credito || !numero_cuota)
      return res.status(400).json({ success: false, error: 'id_credito y numero_cuota son requeridos' });
    if (!id_caja)
      return res.status(400).json({ success: false, error: 'Se requiere una caja asignada para registrar pagos' });

    const u = req.usuario || {};
    const registrado_por = [u.nombre, u.apellido].filter(Boolean).join(' ') || u.email || null;
    const id_registrado_por = u.id_usuario || null;
    const tp = parseFloat(total_pagado) ||
               (parseFloat(monto_cuota)||0) + (parseFloat(interes_mora)||0) + (parseFloat(gastos_cobranza)||0);

    const [r] = await pool.query(
      `INSERT INTO pagos_credito
         (id_credito, numero_cuota, fecha_vencimiento, monto_cuota,
          interes_mora, gastos_cobranza, total_pagado, fecha_pago,
          estado_pago, observacion, registrado_por, id_registrado_por, id_caja)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id_credito, numero_cuota, fecha_vencimiento || null,
       parseFloat(monto_cuota)||0, parseFloat(interes_mora)||0,
       parseFloat(gastos_cobranza)||0, tp,
       fecha_pago || null, estado_pago || 'PAGADO',
       observacion || null, registrado_por, id_registrado_por,
       parseInt(id_caja) || null]
    );
    audit.registrar({
      id_credito, req,
      accion: 'PAGO_REGISTRADO',
      detalle: `Cuota N°${numero_cuota} pagada — Total: $${Math.round(tp).toLocaleString('es-CL')}`,
      meta: { numero_cuota, monto_cuota: parseFloat(monto_cuota)||0, interes_mora: parseFloat(interes_mora)||0, gastos_cobranza: parseFloat(gastos_cobranza)||0, total_pagado: tp, fecha_pago: fecha_pago || null },
    });
    res.status(201).json({ success: true, data: { id_pago: r.insertId }, error: null });
  } catch(e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

/* ─── DELETE pago ────────────────────────────────────────────────────────── */
const remove = async (req, res) => {
  try {
    const [prev] = await pool.query(
      'SELECT id_credito, numero_cuota, total_pagado FROM pagos_credito WHERE id_pago=?',
      [req.params.id_pago]
    );
    await pool.query('DELETE FROM pagos_credito WHERE id_pago = ?', [req.params.id_pago]);
    if (prev.length) {
      audit.registrar({
        id_credito: prev[0].id_credito, req,
        accion: 'PAGO_ELIMINADO',
        detalle: `Pago cuota N°${prev[0].numero_cuota} eliminado (total era $${Math.round(prev[0].total_pagado||0).toLocaleString('es-CL')})`,
        meta: { numero_cuota: prev[0].numero_cuota, total_pagado: prev[0].total_pagado },
      });
    }
    res.json({ success: true, data: { mensaje: 'Pago eliminado' }, error: null });
  } catch(e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

module.exports = { getByCredito, getById, create, remove };
