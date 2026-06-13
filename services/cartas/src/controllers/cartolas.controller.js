'use strict';
const pool = require('../../../../shared/config/database');

/* ── Migración ───────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cartolas_movimientos (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        mes             VARCHAR(7)  NOT NULL,
        id_carta        INT         DEFAULT NULL,
        num_op          VARCHAR(30) DEFAULT NULL,
        movimiento      ENUM('COMISION','PREPAGO','ANULACION') NOT NULL DEFAULT 'COMISION',
        rut_conc        VARCHAR(20)  DEFAULT NULL,
        concesionario   VARCHAR(200) DEFAULT NULL,
        mail            VARCHAR(200) DEFAULT NULL,
        ejecutivo       VARCHAR(150) DEFAULT NULL,
        nombre_cliente  VARCHAR(200) DEFAULT NULL,
        rut_cliente     VARCHAR(20)  DEFAULT NULL,
        saldo           BIGINT DEFAULT NULL,
        comision        BIGINT DEFAULT NULL,
        estado_comision VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE',
        num_carta       VARCHAR(40)  DEFAULT NULL,
        vendedor        VARCHAR(150) DEFAULT NULL,
        acreedor        VARCHAR(100) DEFAULT NULL,
        observaciones   TEXT,
        created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_mes (mes),
        INDEX idx_carta (id_carta),
        INDEX idx_conc (rut_conc)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cartolas_enviadas (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        mes           VARCHAR(7)   NOT NULL,
        rut_conc      VARCHAR(20)  DEFAULT NULL,
        concesionario VARCHAR(200) NOT NULL,
        mail          VARCHAR(200) DEFAULT NULL,
        total_bruto   BIGINT DEFAULT NULL,
        enviado_por   VARCHAR(150) DEFAULT NULL,
        fecha_envio   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_mes (mes)
      )
    `);
    console.log('[cartolas] tablas OK');
  } catch (e) { console.error('[cartolas migration]', e.message); }
})();

/* ── POST /api/cartolas/sync ─────────────────────────────────────────
   1) Marca otorgado=1 en cartas cuya op_origen existe en creditos.
   2) Crea el movimiento COMISION del mes para cada carta otorgada
      aprobada que aún no lo tenga.                                    */
const sync = async (req, res) => {
  try {
    const [r1] = await pool.query(`
      UPDATE cartas_aprobacion ca
      JOIN creditos cr ON cr.num_op = ca.op_origen
      SET ca.otorgado = 1,
          ca.numero_credito_creado = cr.num_op,
          ca.id_credito_creado     = cr.id,
          ca.fecha_otorgado        = COALESCE(ca.fecha_otorgado, cr.fecha_otorgado, NOW())
      WHERE ca.otorgado = 0 AND ca.status = 'APROBADA'
    `);

    const [r2] = await pool.query(`
      INSERT INTO cartolas_movimientos
        (mes, id_carta, num_op, movimiento, rut_conc, concesionario,
         ejecutivo, nombre_cliente, rut_cliente, saldo, comision,
         estado_comision, num_carta, vendedor, acreedor)
      SELECT DATE_FORMAT(COALESCE(ca.fecha_otorgado, NOW()), '%Y-%m'),
             ca.id, ca.op_origen, 'COMISION', ca.rut_conc, ca.concesionario,
             ca.ejecutivo_nombre, ca.cliente, ca.rut_cliente, ca.saldo, ca.part_bruto,
             'PENDIENTE', ca.op_carta, ca.vendedor, ca.acreedor
      FROM cartas_aprobacion ca
      WHERE ca.otorgado = 1 AND ca.status = 'APROBADA'
        AND NOT EXISTS (
          SELECT 1 FROM cartolas_movimientos m
          WHERE m.id_carta = ca.id AND m.movimiento = 'COMISION'
        )
    `);

    res.json({ success: true, data: { otorgados_marcados: r1.affectedRows, comisiones_creadas: r2.affectedRows }, error: null });
  } catch (e) {
    console.error('[cartolas sync]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── GET /api/cartolas?mes=YYYY-MM ──────────────────────────────── */
const getMovimientos = async (req, res) => {
  try {
    const { mes } = req.query;
    const where = [], vals = [];
    if (mes) { where.push('m.mes = ?'); vals.push(mes); }
    // num_op guardado = op_origen (N° ID financiera). JOIN al crédito enlazado
    // para exponer NUESTRO N° de operación real (creditos.num_op).
    const [rows] = await pool.query(
      `SELECT m.*, cr.num_op AS nuestro_num_op
       FROM cartolas_movimientos m
       LEFT JOIN cartas_aprobacion ca ON ca.id = m.id_carta
       LEFT JOIN creditos cr ON cr.id = ca.id_credito_creado
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY m.mes DESC, m.concesionario, m.id`, vals
    );
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    console.error('[cartolas get]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── POST /api/cartolas — prepago o anulación manual ─────────────── */
const crearMovimiento = async (req, res) => {
  try {
    const m = req.body;
    if (!m.mes || !m.movimiento || !['PREPAGO','ANULACION'].includes(m.movimiento))
      return res.status(400).json({ success: false, data: null, error: 'mes y movimiento (PREPAGO|ANULACION) requeridos' });
    if (!m.num_op) return res.status(400).json({ success: false, data: null, error: 'num_op requerido' });

    // Si la op tiene cartola COMISION, copiar datos del concesionario
    const [[base]] = await pool.query(
      `SELECT * FROM cartolas_movimientos WHERE num_op = ? AND movimiento='COMISION' ORDER BY id DESC LIMIT 1`,
      [m.num_op]
    );
    const [r] = await pool.query(
      `INSERT INTO cartolas_movimientos
        (mes, id_carta, num_op, movimiento, rut_conc, concesionario, mail, ejecutivo,
         nombre_cliente, rut_cliente, saldo, comision, estado_comision, num_carta, vendedor, acreedor, observaciones)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [m.mes, base?.id_carta || null, m.num_op, m.movimiento,
       m.rut_conc || base?.rut_conc || null, m.concesionario || base?.concesionario || null,
       m.mail || base?.mail || null, m.ejecutivo || base?.ejecutivo || null,
       m.nombre_cliente || base?.nombre_cliente || null, m.rut_cliente || base?.rut_cliente || null,
       m.saldo ?? base?.saldo ?? null, m.comision ?? null,
       m.estado_comision || 'A DESCONTAR', m.num_carta || base?.num_carta || null,
       m.vendedor || base?.vendedor || null, m.acreedor || base?.acreedor || null,
       m.observaciones || null]
    );
    res.status(201).json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) {
    console.error('[cartolas crear]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── PUT /api/cartolas/:id ───────────────────────────────────────── */
const updateMovimiento = async (req, res) => {
  try {
    const CAMPOS = ['estado_comision','observaciones','comision','movimiento','mail','mes'];
    const sets = [], vals = [];
    for (const c of CAMPOS) {
      if (req.body[c] !== undefined) { sets.push(`\`${c}\` = ?`); vals.push(req.body[c]); }
    }
    if (!sets.length) return res.status(400).json({ success: false, data: null, error: 'Sin campos' });
    vals.push(req.params.id);
    await pool.query(`UPDATE cartolas_movimientos SET ${sets.join(', ')} WHERE id = ?`, vals);
    res.json({ success: true, data: { id: Number(req.params.id) }, error: null });
  } catch (e) {
    console.error('[cartolas update]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── DELETE /api/cartolas/:id ────────────────────────────────────── */
const deleteMovimiento = async (req, res) => {
  try {
    await pool.query('DELETE FROM cartolas_movimientos WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: { deleted: Number(req.params.id) }, error: null });
  } catch (e) {
    console.error('[cartolas delete]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── Enviadas ────────────────────────────────────────────────────── */
const getEnviadas = async (req, res) => {
  try {
    const { mes } = req.query;
    const where = mes ? 'WHERE mes = ?' : '';
    const [rows] = await pool.query(
      `SELECT * FROM cartolas_enviadas ${where} ORDER BY fecha_envio DESC LIMIT 500`,
      mes ? [mes] : []
    );
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    console.error('[cartolas enviadas]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

const registrarEnvio = async (req, res) => {
  try {
    const { mes, rut_conc, concesionario, mail, total_bruto } = req.body;
    if (!mes || !concesionario)
      return res.status(400).json({ success: false, data: null, error: 'mes y concesionario requeridos' });
    const enviadoPor = req.usuario?.email || String(req.usuario?.id_usuario || '');
    const [r] = await pool.query(
      `INSERT INTO cartolas_enviadas (mes, rut_conc, concesionario, mail, total_bruto, enviado_por)
       VALUES (?,?,?,?,?,?)`,
      [mes, rut_conc || null, concesionario, mail || null, total_bruto || null, enviadoPor]
    );
    res.status(201).json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) {
    console.error('[cartolas envio]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

module.exports = { sync, getMovimientos, crearMovimiento, updateMovimiento, deleteMovimiento, getEnviadas, registrarEnvio };
