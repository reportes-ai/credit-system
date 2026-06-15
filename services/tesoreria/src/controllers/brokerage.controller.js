const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

/* ─── Migraciones ────────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS facturas_brokerage (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        id_credito       INT NOT NULL,
        numero_factura   VARCHAR(50),
        rut_emisor       VARCHAR(20),
        nombre_emisor    VARCHAR(200),
        monto            DECIMAL(15,0),
        fecha_factura    DATE,
        archivo_nombre   VARCHAR(300),
        mime_type        VARCHAR(100),
        archivo_data     LONGBLOB,
        estado           VARCHAR(30) DEFAULT 'RECIBIDA',
        observaciones    TEXT,
        registrado_por   VARCHAR(150),
        id_registrado_por INT,
        created_at       DATETIME DEFAULT NOW(),
        updated_at       DATETIME DEFAULT NOW() ON UPDATE NOW(),
        INDEX idx_op (id_credito)
      )
    `);
    const [[fa]] = await pool.query(`SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='facturas_brokerage' AND column_name='operacion_id'`);
    if (fa.c > 0) await pool.query(`ALTER TABLE facturas_brokerage CHANGE COLUMN operacion_id id_credito INT NOT NULL`);
    console.log('✓ facturas_brokerage: tabla lista');
  } catch (e) {
    console.error('[facturas_brokerage migration]', e.message);
  }
})();

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pagos_brokerage (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        id_credito       INT NOT NULL,
        tipo_pago        VARCHAR(50) DEFAULT 'SALDO_PRECIO',
        monto            DECIMAL(15,0),
        banco            VARCHAR(100),
        cuenta_destino   VARCHAR(100),
        num_transaccion  VARCHAR(100),
        fecha_pago       DATE,
        observaciones    TEXT,
        estado           VARCHAR(30) DEFAULT 'PROGRAMADO',
        registrado_por   VARCHAR(150),
        id_registrado_por INT,
        created_at       DATETIME DEFAULT NOW(),
        updated_at       DATETIME DEFAULT NOW() ON UPDATE NOW(),
        INDEX idx_op (id_credito)
      )
    `);
    const [[pa]] = await pool.query(`SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='pagos_brokerage' AND column_name='operacion_id'`);
    if (pa.c > 0) await pool.query(`ALTER TABLE pagos_brokerage CHANGE COLUMN operacion_id id_credito INT NOT NULL`);
    console.log('✓ pagos_brokerage: tabla lista');
  } catch (e) {
    console.error('[pagos_brokerage migration]', e.message);
  }
})();

/* ─── GET /api/brokerage/operaciones ─────────────────────────────────
   Panel de Tesorería: lista operaciones con toda la info relevante
   Filtros: mes, financiera, estado_pago (pendiente/pagado)
─────────────────────────────────────────────────────────────────────── */
const getOperaciones = async (req, res) => {
  try {
    const { mes, financiera, estado_pago, limit = 200, offset = 0 } = req.query;
    let where = [];
    const params = [];

    if (mes) { where.push("DATE_FORMAT(o.mes,'%Y-%m') = ?"); params.push(mes); }
    if (financiera) { where.push('o.financiera = ?'); params.push(financiera); }

    if (estado_pago === 'pendiente') {
      where.push("o.liberado_pago = 1 AND (o.estado_pago IS NULL OR o.estado_pago != 'PAGADO')");
    } else if (estado_pago === 'pagado') {
      where.push("o.estado_pago = 'PAGADO'");
    } else if (estado_pago === 'liberar') {
      // Fundantes aprobados pero aún no liberados
      where.push("o.estado_fundantes = 'APROBADOS' AND (o.liberado_pago IS NULL OR o.liberado_pago = 0)");
    }

    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const [rows] = await pool.query(
      `SELECT o.*,
         COALESCE(cl.rut,             '') AS rut_cliente,
         COALESCE(cl.nombre_completo, '') AS nombre_cliente,
         (SELECT COUNT(*) FROM facturas_brokerage f WHERE f.id_credito = o.id) AS cnt_facturas,
         (SELECT COUNT(*) FROM pagos_brokerage p WHERE p.id_credito = o.id) AS cnt_pagos,
         (SELECT SUM(p.monto) FROM pagos_brokerage p WHERE p.id_credito = o.id AND p.estado = 'PAGADO') AS monto_pagado
       FROM creditos o
       LEFT JOIN clientes cl ON cl.id_cliente = o.id_cliente
       ${w}
       ORDER BY o.mes DESC, o.id DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    );
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── GET /api/brokerage/operaciones/:id ─────────────────────────── */
const getOperacion = async (req, res) => {
  try {
    const [[op]] = await pool.query(
      `SELECT o.*,
              COALESCE(cl.rut,             '') AS rut_cliente,
              COALESCE(cl.nombre_completo, '') AS nombre_cliente
       FROM creditos o
       LEFT JOIN clientes cl ON cl.id_cliente = o.id_cliente
       WHERE o.id = ?`,
      [req.params.id]
    );
    if (!op) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });

    const [facturas] = await pool.query(
      'SELECT id, numero_factura, rut_emisor, nombre_emisor, monto, fecha_factura, archivo_nombre, estado, observaciones, registrado_por, created_at FROM facturas_brokerage WHERE id_credito = ? ORDER BY created_at DESC',
      [req.params.id]
    );
    const [pagos] = await pool.query(
      'SELECT *, id_credito AS operacion_id FROM pagos_brokerage WHERE id_credito = ? ORDER BY created_at DESC',
      [req.params.id]
    );
    const [fundantes] = await pool.query(
      'SELECT id, nombre_documento, tipo, archivo_nombre, estado, subido_por, validado_por, fecha_validacion, created_at FROM fundantes_brokerage WHERE id_credito = ? ORDER BY created_at DESC',
      [req.params.id]
    );

    res.json({ success: true, data: { operacion: op, facturas, pagos, fundantes }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── POST /api/brokerage/facturas ───────────────────────────────── */
const createFactura = async (req, res) => {
  try {
    const { operacion_id, numero_factura, rut_emisor, nombre_emisor, monto, fecha_factura, archivo_nombre, mime_type, archivo_data, observaciones } = req.body;
    if (!operacion_id) return res.status(400).json({ success: false, data: null, error: 'operacion_id requerido' });

    const [[op]] = await pool.query('SELECT id FROM creditos WHERE id = ?', [operacion_id]);
    if (!op) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });

    const buffer = archivo_data ? Buffer.from(archivo_data, 'base64') : null;
    const regPor = req.usuario ? `${req.usuario.nombre} ${req.usuario.apellido || ''}`.trim() : null;

    const [r] = await pool.query(
      `INSERT INTO facturas_brokerage
        (id_credito, numero_factura, rut_emisor, nombre_emisor, monto, fecha_factura,
         archivo_nombre, mime_type, archivo_data, observaciones, estado, registrado_por, id_registrado_por)
       VALUES (?,?,?,?,?,?,?,?,?,'RECIBIDA',?,?,?)`,
      [operacion_id, numero_factura || null, rut_emisor || null, nombre_emisor || null,
       monto || null, fecha_factura || null, archivo_nombre || null, mime_type || null,
       buffer, observaciones || null, regPor, req.usuario?.id_usuario || null]
    );
    const [[row]] = await pool.query(
      'SELECT id, id_credito AS operacion_id, numero_factura, rut_emisor, nombre_emisor, monto, fecha_factura, estado, registrado_por, created_at FROM facturas_brokerage WHERE id = ?',
      [r.insertId]
    );
    auditar({ req, accion: 'CREAR', modulo: 'tesoreria', entidad: 'factura_brokerage', entidad_id: r.insertId,
      detalle: `Registró factura ${numero_factura || ''} de operación ${operacion_id}${monto ? ` — $${Math.round(monto).toLocaleString('es-CL')}` : ''}`, rut: rut_emisor, meta: { operacion_id, numero_factura, monto } });
    res.status(201).json({ success: true, data: row, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── GET /api/brokerage/facturas/:id/download ───────────────────── */
const downloadFactura = async (req, res) => {
  try {
    const [[row]] = await pool.query(
      'SELECT archivo_nombre, mime_type, archivo_data FROM facturas_brokerage WHERE id = ?',
      [req.params.id]
    );
    if (!row || !row.archivo_data) return res.status(404).json({ success: false, data: null, error: 'Archivo no encontrado' });
    res.set('Content-Type', row.mime_type || 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${row.archivo_nombre || 'factura'}"`);
    res.send(row.archivo_data);
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── DELETE /api/brokerage/facturas/:id ─────────────────────────── */
const deleteFactura = async (req, res) => {
  try {
    await pool.query('DELETE FROM facturas_brokerage WHERE id = ?', [req.params.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'tesoreria', entidad: 'factura_brokerage', entidad_id: req.params.id, detalle: `Eliminó factura brokerage #${req.params.id}` });
    res.json({ success: true, data: { eliminado: req.params.id }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── POST /api/brokerage/pagos ──────────────────────────────────── */
const createPago = async (req, res) => {
  try {
    const { operacion_id, tipo_pago, monto, banco, cuenta_destino, num_transaccion, fecha_pago, observaciones } = req.body;
    if (!operacion_id || !monto) return res.status(400).json({ success: false, data: null, error: 'operacion_id y monto requeridos' });

    const [[op]] = await pool.query('SELECT id FROM creditos WHERE id = ?', [operacion_id]);
    if (!op) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });

    const regPor = req.usuario ? `${req.usuario.nombre} ${req.usuario.apellido || ''}`.trim() : null;
    const estado = num_transaccion ? 'PAGADO' : 'PROGRAMADO';

    const [r] = await pool.query(
      `INSERT INTO pagos_brokerage
        (id_credito, tipo_pago, monto, banco, cuenta_destino, num_transaccion, fecha_pago, observaciones, estado, registrado_por, id_registrado_por)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [operacion_id, tipo_pago || 'SALDO_PRECIO', monto, banco || null,
       cuenta_destino || null, num_transaccion || null, fecha_pago || null,
       observaciones || null, estado, regPor, req.usuario?.id_usuario || null]
    );

    // Si hay N° transacción → marcar operación como PAGADO
    if (num_transaccion) {
      await pool.query(
        "UPDATE creditos SET estado_pago='PAGADO', fecha_pago=?, num_transaccion=? WHERE id=?",
        [fecha_pago || null, num_transaccion, operacion_id]
      );
    }

    const [[row]] = await pool.query('SELECT *, id_credito AS operacion_id FROM pagos_brokerage WHERE id = ?', [r.insertId]);
    auditar({ req, accion: 'PAGAR', modulo: 'tesoreria', entidad: 'pago_brokerage', entidad_id: r.insertId,
      detalle: `Registró pago brokerage de operación ${operacion_id} — $${Math.round(monto).toLocaleString('es-CL')} (${estado})`, meta: { operacion_id, monto, tipo_pago: tipo_pago || 'SALDO_PRECIO', estado } });
    res.status(201).json({ success: true, data: row, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── PUT /api/brokerage/pagos/:id/transferencia ─────────────────── */
const registrarTransferencia = async (req, res) => {
  try {
    const { num_transaccion, banco, cuenta_destino, fecha_pago, observaciones } = req.body;
    if (!num_transaccion) return res.status(400).json({ success: false, data: null, error: 'num_transaccion requerido' });

    const [[pago]] = await pool.query('SELECT *, id_credito AS operacion_id FROM pagos_brokerage WHERE id = ?', [req.params.id]);
    if (!pago) return res.status(404).json({ success: false, data: null, error: 'Pago no encontrado' });

    await pool.query(
      `UPDATE pagos_brokerage SET num_transaccion=?, banco=COALESCE(?,banco),
       cuenta_destino=COALESCE(?,cuenta_destino), fecha_pago=COALESCE(?,fecha_pago),
       observaciones=COALESCE(?,observaciones), estado='PAGADO' WHERE id=?`,
      [num_transaccion, banco || null, cuenta_destino || null, fecha_pago || null, observaciones || null, req.params.id]
    );

    // Marcar operación como PAGADO
    await pool.query(
      "UPDATE creditos SET estado_pago='PAGADO', fecha_pago=COALESCE(?,fecha_pago), num_transaccion=? WHERE id=?",
      [fecha_pago || null, num_transaccion, pago.operacion_id]
    );

    const [[row]] = await pool.query('SELECT *, id_credito AS operacion_id FROM pagos_brokerage WHERE id = ?', [req.params.id]);
    auditar({ req, accion: 'EDITAR', modulo: 'tesoreria', entidad: 'pago_brokerage', entidad_id: req.params.id,
      detalle: `Registró transferencia del pago brokerage #${req.params.id} — TRX ${num_transaccion}`, meta: { num_transaccion, operacion_id: pago.operacion_id } });
    res.json({ success: true, data: row, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── DELETE /api/brokerage/pagos/:id ──────────────────────────── */
const deletePago = async (req, res) => {
  try {
    await pool.query('DELETE FROM pagos_brokerage WHERE id = ?', [req.params.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'tesoreria', entidad: 'pago_brokerage', entidad_id: req.params.id, detalle: `Eliminó pago brokerage #${req.params.id}` });
    res.json({ success: true, data: { eliminado: req.params.id }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

module.exports = {
  getOperaciones, getOperacion,
  createFactura, downloadFactura, deleteFactura,
  createPago, registrarTransferencia, deletePago
};
