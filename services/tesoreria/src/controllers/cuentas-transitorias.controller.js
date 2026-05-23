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

/* ── GET /cartola/:id_credito  ─ extracto bancario por crédito ── */
const cartola = async (req, res) => {
  try {
    const id_credito = req.params.id_credito;

    // Info del crédito y cliente
    const [[cred]] = await pool.query(
      `SELECT numero_credito, nombre_cliente, rut_cliente FROM creditos WHERE id_credito = ?`,
      [id_credito]
    ).catch(() => [[null]]);

    // ── Movimientos: UNION de transitorias (ABONOs base) + cartola (ABONOs y CARGOs registrados)
    // Preferimos la cartola cuando existe; para registros históricos sin cartola,
    // mostramos el ABONO desde cuentas_transitorias y anotamos el cargo histórico al final.
    const [movs] = await pool.query(`
      (
        -- ABONOs base (registros sin cartola, fallback histórico)
        SELECT
          ct.created_at              AS fecha,
          ct.numero_transaccion,
          'ABONO'                    AS tipo,
          ct.monto_original          AS monto,
          ct.glosa                   AS concepto,
          ct.id_transitoria,
          0                          AS es_cartola
        FROM cuentas_transitorias ct
        WHERE ct.id_credito = ?
          AND NOT EXISTS (
            SELECT 1 FROM transitorias_cartola tc
            WHERE tc.id_transitoria = ct.id_transitoria AND tc.tipo = 'ABONO'
          )
      )
      UNION ALL
      (
        -- Movimientos registrados en la cartola (ABONOs y CARGOs con detalle)
        SELECT
          tc.created_at              AS fecha,
          tc.numero_transaccion,
          tc.tipo,
          tc.monto,
          tc.concepto,
          tc.id_transitoria,
          1                          AS es_cartola
        FROM transitorias_cartola tc
        WHERE tc.id_credito = ?
      )
      ORDER BY fecha ASC, tipo DESC
    `, [id_credito, id_credito]);

    // Saldo actual real (desde la tabla de transitorias)
    const [[{ saldo_real }]] = await pool.query(
      `SELECT ROUND(SUM(monto_original - monto_utilizado), 2) AS saldo_real
       FROM cuentas_transitorias WHERE id_credito = ?`,
      [id_credito]
    );

    // Calcular saldo corriente acumulado
    let saldo = 0;
    const movimientos = movs.map(m => {
      const monto = parseFloat(m.monto) || 0;
      saldo = m.tipo === 'ABONO' ? saldo + monto : saldo - monto;
      return { ...m, monto, saldo_corriente: Math.round(saldo * 100) / 100 };
    });

    // Si hay diferencia entre el saldo calculado y el real (registros históricos sin cargo detallado),
    // agregar un movimiento sintético para cuadrar
    const diff = Math.round((parseFloat(saldo_real)||0) - saldo);
    if (Math.abs(diff) > 1 && movimientos.length > 0) {
      movimientos.push({
        fecha:              null,
        numero_transaccion: null,
        tipo:               diff < 0 ? 'CARGO' : 'ABONO',
        monto:              Math.abs(diff),
        concepto:           'Movimientos históricos sin detalle de TRX',
        id_transitoria:     null,
        es_cartola:         0,
        saldo_corriente:    parseFloat(saldo_real) || 0,
        es_historico:       true,
      });
    }

    ok(res, {
      credito:   cred || { id_credito, numero_credito: id_credito, nombre_cliente: '—', rut_cliente: '—' },
      saldo_actual: parseFloat(saldo_real) || 0,
      movimientos,
    });
  } catch(e) { err(res, e); }
};

module.exports = { list, porCredito, cartola };
