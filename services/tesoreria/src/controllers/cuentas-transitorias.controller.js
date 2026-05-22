const pool = require('../../../../shared/config/database');

/* ── Migración ── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS correlativo_transacciones (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cuentas_transitorias (
        id_transitoria     INT AUTO_INCREMENT PRIMARY KEY,
        id_credito         INT            NOT NULL,
        rut_cliente        VARCHAR(20)    NULL,
        nombre_cliente     VARCHAR(300)   NULL,
        numero_transaccion INT            NULL,
        fecha              DATE           NULL,
        monto_original     DECIMAL(14,2)  DEFAULT 0,
        monto_utilizado    DECIMAL(14,2)  DEFAULT 0,
        glosa              VARCHAR(300)   NULL,
        estado             VARCHAR(30)    DEFAULT 'ACTIVO',
        created_at         DATETIME       DEFAULT CURRENT_TIMESTAMP,
        updated_at         DATETIME       DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_credito  (id_credito),
        INDEX idx_rut      (rut_cliente)
      )
    `);
  } catch(e) { if (e.errno !== 1050) console.error('[cuentas_transitorias migration]', e.message); }
})();

const ok  = (res, data)    => res.json({ success: true, data, error: null });
const err = (res, e, s=500)=> res.status(s).json({ success: false, data: null, error: e?.message||e });

/* ── GET /  ─ lista con filtros ── */
const list = async (req, res) => {
  try {
    const { q, solo_saldo } = req.query;
    let sql = `
      SELECT
        ct.*,
        c.numero_credito,
        ROUND(ct.monto_original - ct.monto_utilizado, 2) AS saldo
      FROM cuentas_transitorias ct
      LEFT JOIN creditos c ON ct.id_credito = c.id_credito
      WHERE 1=1
    `;
    const params = [];

    if (q) {
      const like = `%${q.trim().toUpperCase()}%`;
      sql += ` AND (UPPER(ct.rut_cliente) LIKE ? OR UPPER(ct.nombre_cliente) LIKE ? OR UPPER(c.numero_credito) LIKE ?)`;
      params.push(like, like, like);
    }
    if (solo_saldo === '1') {
      sql += ` AND (ct.monto_original - ct.monto_utilizado) > 0`;
    }

    sql += ` ORDER BY ct.created_at DESC`;

    const [rows] = await pool.query(sql, params);

    // Totales
    const conSaldo  = rows.filter(r => parseFloat(r.saldo||0) > 0);
    const totalDinero = conSaldo.reduce((s, r) => s + parseFloat(r.saldo||0), 0);

    ok(res, { rows, resumen: { cantidad: conSaldo.length, total: Math.round(totalDinero) } });
  } catch(e) { err(res, e); }
};

/* ── GET /por-credito/:id_credito  ─ saldo disponible del crédito ── */
const porCredito = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        id_transitoria, numero_transaccion, fecha,
        monto_original, monto_utilizado,
        ROUND(monto_original - monto_utilizado, 2) AS saldo,
        glosa, estado
      FROM cuentas_transitorias
      WHERE id_credito = ?
        AND estado = 'ACTIVO'
        AND (monto_original - monto_utilizado) > 0
      ORDER BY created_at ASC
    `, [req.params.id_credito]);

    const saldo_total = rows.reduce((s, r) => s + parseFloat(r.saldo||0), 0);
    ok(res, { rows, saldo_total: Math.round(saldo_total) });
  } catch(e) { err(res, e); }
};

module.exports = { list, porCredito };
