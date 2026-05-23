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

/* ── GET /  ─ lista consolidada por crédito ── */
const list = async (req, res) => {
  try {
    const { q, solo_saldo } = req.query;

    // Una fila por crédito, saldo = suma de todas las transitorias activas
    let where = `1=1`;
    const params = [];

    if (q) {
      const like = `%${q.trim().toUpperCase()}%`;
      where += ` AND (UPPER(ct.rut_cliente) LIKE ? OR UPPER(ct.nombre_cliente) LIKE ? OR UPPER(c.numero_credito) LIKE ?)`;
      params.push(like, like, like);
    }

    const [rows] = await pool.query(`
      SELECT
        ct.id_credito,
        ct.rut_cliente,
        ct.nombre_cliente,
        c.numero_credito,
        ROUND(SUM(ct.monto_original), 2)                        AS monto_original,
        ROUND(SUM(ct.monto_utilizado), 2)                       AS monto_utilizado,
        ROUND(SUM(ct.monto_original - ct.monto_utilizado), 2)   AS saldo,
        MAX(ct.numero_transaccion)                               AS ultimo_trx,
        MAX(ct.updated_at)                                       AS ultima_actualizacion,
        COUNT(*)                                                  AS num_registros
      FROM cuentas_transitorias ct
      LEFT JOIN creditos c ON ct.id_credito = c.id_credito
      WHERE ${where}
      GROUP BY ct.id_credito, ct.rut_cliente, ct.nombre_cliente, c.numero_credito
      ORDER BY ultima_actualizacion DESC
    `, params);

    // Filtrar por saldo > 0 después del GROUP BY
    const filtered = (solo_saldo === '1') ? rows.filter(r => parseFloat(r.saldo||0) > 0) : rows;

    const conSaldo    = filtered.filter(r => parseFloat(r.saldo||0) > 0);
    const totalDinero = conSaldo.reduce((s, r) => s + parseFloat(r.saldo||0), 0);

    ok(res, { rows: filtered, resumen: { cantidad: conSaldo.length, total: Math.round(totalDinero) } });
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
