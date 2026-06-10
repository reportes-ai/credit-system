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
    // Migración individual por columna (un ADD por ALTER para evitar fallos silenciosos)
    const addCol = sql => pool.query(sql).catch(() => {});
    await addCol(`ALTER TABLE pagos_credito ADD COLUMN IF NOT EXISTS id_registrado_por    INT          NULL`);
    await addCol(`ALTER TABLE pagos_credito ADD COLUMN IF NOT EXISTS id_caja              INT          NULL`);
    await addCol(`ALTER TABLE pagos_credito ADD COLUMN IF NOT EXISTS origen_fondos        VARCHAR(200) NULL`);
    await addCol(`ALTER TABLE pagos_credito ADD COLUMN IF NOT EXISTS id_cuenta_bancaria   INT          NULL`);
    await addCol(`ALTER TABLE pagos_credito ADD COLUMN IF NOT EXISTS numero_transaccion   INT          NULL`);
    await addCol(`ALTER TABLE pagos_credito ADD COLUMN IF NOT EXISTS comentario_reverso  TEXT         NULL`);
    await addCol(`ALTER TABLE pagos_credito ADD COLUMN IF NOT EXISTS reversado_por       VARCHAR(200) NULL`);
    await addCol(`ALTER TABLE pagos_credito ADD COLUMN IF NOT EXISTS id_reversado_por    INT          NULL`);
    await addCol(`ALTER TABLE pagos_credito ADD COLUMN IF NOT EXISTS fecha_reverso       DATETIME     NULL`);

    // Tablas necesarias para el batch
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
    // Cartola de movimientos de cuentas transitorias (ABONO / CARGO)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transitorias_cartola (
        id_mov             INT AUTO_INCREMENT PRIMARY KEY,
        id_transitoria     INT            NOT NULL,
        id_credito         INT            NOT NULL,
        numero_transaccion INT            NULL,
        tipo               VARCHAR(10)    NOT NULL COMMENT 'ABONO o CARGO',
        monto              DECIMAL(14,2)  NOT NULL,
        concepto           VARCHAR(400)   NULL,
        created_at         DATETIME       DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_credito  (id_credito),
        INDEX idx_trans    (id_transitoria)
      )
    `);
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
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

/* ─── GET un pago por ID ─────────────────────────────────────────────────── */
const getById = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT pc.*, cj.nombre AS nombre_caja
       FROM pagos_credito pc
       LEFT JOIN cajas cj ON cj.id_caja = pc.id_caja
       WHERE pc.id_pago = ?`,
      [req.params.id_pago]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Pago no encontrado' });
    res.json({ success: true, data: rows[0], error: null });
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

/* ─── POST registrar pago ────────────────────────────────────────────────── */
const create = async (req, res) => {
  try {
    const {
      id_credito, numero_cuota, fecha_vencimiento,
      monto_cuota, interes_mora, gastos_cobranza,
      total_pagado, fecha_pago, estado_pago, observacion, id_caja,
      origen_fondos, id_cuenta_bancaria
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
          estado_pago, observacion, registrado_por, id_registrado_por, id_caja,
          origen_fondos, id_cuenta_bancaria)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id_credito, numero_cuota, fecha_vencimiento || null,
       parseFloat(monto_cuota)||0, parseFloat(interes_mora)||0,
       parseFloat(gastos_cobranza)||0, tp,
       fecha_pago || null, estado_pago || 'PAGADO',
       observacion || null, registrado_por, id_registrado_por,
       parseInt(id_caja) || null,
       origen_fondos || null, parseInt(id_cuenta_bancaria) || null]
    );
    audit.registrar({
      id_credito, req,
      accion: 'PAGO_REGISTRADO',
      detalle: `Cuota N°${numero_cuota} pagada — Total: $${Math.round(tp).toLocaleString('es-CL')}`,
      meta: { numero_cuota, monto_cuota: parseFloat(monto_cuota)||0, interes_mora: parseFloat(interes_mora)||0, gastos_cobranza: parseFloat(gastos_cobranza)||0, total_pagado: tp, fecha_pago: fecha_pago || null },
    });
    res.status(201).json({ success: true, data: { id_pago: r.insertId }, error: null });
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
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
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

/* ─── POST /batch  — pago múltiple con correlativo global ────────────────── */
const createBatch = async (req, res) => {
  // Validaciones previas (sin conexión aún)
  const {
    id_credito, pagos, monto_recibido,
    fecha_pago, observacion, id_caja,
    origen_fondos, id_cuenta_bancaria
  } = req.body;

  if (!id_credito || !Array.isArray(pagos) || !pagos.length)
    return res.status(400).json({ success: false, data: null, error: 'id_credito y pagos[] son requeridos' });
  if (!id_caja)
    return res.status(400).json({ success: false, data: null, error: 'Se requiere una caja asignada para registrar pagos' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // ── 1. Generar correlativo global ──────────────────────────────────────
    const [corrRow] = await conn.query(
      'INSERT INTO correlativo_transacciones (created_at) VALUES (NOW())'
    );
    const numero_transaccion = corrRow.insertId;

    // ── 2. Totales ──────────────────────────────────────────────────────────
    const totalCobrado    = pagos.reduce((s, p) => s + (parseFloat(p.total_pagado)||0), 0);
    const mrec            = parseFloat(monto_recibido) || 0;

    // ── 3. Saldo a favor existente ─────────────────────────────────────────
    const [transRows] = await conn.query(`
      SELECT id_transitoria,
             ROUND(monto_original - monto_utilizado, 2) AS saldo
      FROM cuentas_transitorias
      WHERE id_credito = ? AND estado = 'ACTIVO'
        AND (monto_original - monto_utilizado) > 0
      ORDER BY created_at ASC
    `, [id_credito]);
    const saldoAFavor     = transRows.reduce((s, r) => s + parseFloat(r.saldo||0), 0);
    const totalDisponible = mrec + saldoAFavor;

    if (totalDisponible < totalCobrado - 1) {   // margen $1 por redondeo
      await conn.rollback();
      return res.status(400).json({
        success: false, data: null,
        error: `Monto insuficiente. A cobrar: $${Math.round(totalCobrado).toLocaleString('es-CL')}, disponible: $${Math.round(totalDisponible).toLocaleString('es-CL')}`
      });
    }

    // ── 4. Insertar pagos ──────────────────────────────────────────────────
    const u                 = req.usuario || {};
    const registrado_por    = [u.nombre, u.apellido].filter(Boolean).join(' ') || u.email || null;
    const id_registrado_por = u.id_usuario || null;
    const idCajaInt         = parseInt(id_caja) || null;
    const idCuentaInt       = parseInt(id_cuenta_bancaria) || null;

    for (const p of pagos) {
      const tp = parseFloat(p.total_pagado) ||
        (parseFloat(p.monto_cuota)||0) + (parseFloat(p.interes_mora)||0) + (parseFloat(p.gastos_cobranza)||0);
      await conn.query(
        `INSERT INTO pagos_credito
           (id_credito, numero_cuota, fecha_vencimiento, monto_cuota,
            interes_mora, gastos_cobranza, total_pagado, fecha_pago,
            estado_pago, observacion, registrado_por, id_registrado_por,
            id_caja, origen_fondos, id_cuenta_bancaria, numero_transaccion)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id_credito, p.numero_cuota, p.fecha_vencimiento || null,
          parseFloat(p.monto_cuota)||0, parseFloat(p.interes_mora)||0,
          parseFloat(p.gastos_cobranza)||0, tp,
          fecha_pago || null, 'PAGADO',
          observacion || null, registrado_por, id_registrado_por,
          idCajaInt, origen_fondos || null, idCuentaInt,
          numero_transaccion
        ]
      );
    }

    // ── 5. Consumir saldo a favor si se necesitó ───────────────────────────
    const saldoNecesario = Math.max(0, totalCobrado - mrec);
    if (saldoNecesario > 0) {
      let restante = saldoNecesario;
      for (const tr of transRows) {
        if (restante <= 0.01) break;
        const usar = Math.min(parseFloat(tr.saldo||0), restante);
        await conn.query(
          `UPDATE cuentas_transitorias
           SET monto_utilizado = monto_utilizado + ?,
               estado = IF((monto_original - monto_utilizado - ?) <= 0.01, 'CONSUMIDO', estado),
               updated_at = NOW()
           WHERE id_transitoria = ?`,
          [usar, usar, tr.id_transitoria]
        );
        // ── Registrar CARGO en la cartola ──────────────────────────────────
        await conn.query(
          `INSERT INTO transitorias_cartola
             (id_transitoria, id_credito, numero_transaccion, tipo, monto, concepto)
           VALUES (?, ?, ?, 'CARGO', ?,
             CONCAT('Aplicado al pago TRX-', LPAD(?, 6, '0'),
                    ' (', ?, ' cuota', IF(? > 1,'s',''), ')'))`,
          [tr.id_transitoria, id_credito, numero_transaccion, usar,
           numero_transaccion, pagos.length, pagos.length]
        );
        restante -= usar;
      }
    }

    // ── 6. Crear transitoria si hay exceso de efectivo recibido ────────────
    // Exceso = solo el sobrante del efectivo (mrec), NO el saldo a favor que
    // quedó sin usar — ese ya vive en sus propias transitorias y no debe
    // duplicarse al crear una nueva.
    const exceso = Math.round(Math.max(0, mrec - totalCobrado));
    let transitoria = null;
    if (exceso > 0) {
      const [[cred]] = await conn.query(
        `SELECT c.numero_credito, COALESCE(cl.rut,'') AS rut_cliente,
                COALESCE(cl.nombre_completo,'') AS nombre_cliente
         FROM creditos c LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
         WHERE c.id_credito = ?`,
        [id_credito]
      );
      const [trIns] = await conn.query(
        `INSERT INTO cuentas_transitorias
           (id_credito, rut_cliente, nombre_cliente, numero_transaccion, fecha, monto_original, glosa)
         VALUES (?,?,?,?,?,?,?)`,
        [
          id_credito,
          cred?.rut_cliente    || null,
          cred?.nombre_cliente || null,
          numero_transaccion,
          fecha_pago || null,
          exceso,
          'Saldo a Favor Pago en Exceso'
        ]
      );
      transitoria = { id_transitoria: trIns.insertId, monto: exceso };
      // ── Registrar ABONO en la cartola ───────────────────────────────────
      await conn.query(
        `INSERT INTO transitorias_cartola
           (id_transitoria, id_credito, numero_transaccion, tipo, monto, concepto)
         VALUES (?, ?, ?, 'ABONO', ?,
           CONCAT('Pago en exceso TRX-', LPAD(?, 6, '0')))`,
        [trIns.insertId, id_credito, numero_transaccion, exceso, numero_transaccion]
      );
    }

    await conn.commit();

    // Auditoría (fuera de la transacción, no crítica)
    try {
      audit.registrar({
        id_credito, req,
        accion: 'PAGO_BATCH_REGISTRADO',
        detalle: `${pagos.length} cuota(s) — Total: $${Math.round(totalCobrado).toLocaleString('es-CL')} — TRX #${numero_transaccion}`,
        meta: { numero_transaccion, cuotas: pagos.map(p => p.numero_cuota), totalCobrado, exceso: exceso || 0 },
      });
    } catch(_) {}

    res.status(201).json({ success: true, data: { numero_transaccion, totalCobrado, transitoria }, error: null });
  } catch(e) {
    console.error('[createBatch]', e.message);
    try { await conn.rollback(); } catch(_) {}
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  } finally {
    conn.release();
  }
};

/* ─── POST /reversar/:id_pago ───────────────────────────────────────────────
 * Reversa un pago registrado. Requiere comentario obligatorio y que el usuario
 * tenga puede_reversar_pagos = 1 en su asignación de caja.
 * El pago queda con estado_pago = 'REVERSADO' y la cuota vuelve a su estado
 * original (pendiente/mora) con todos sus intereses y gastos correspondientes.
 */
const reversar = async (req, res) => {
  const { id_pago } = req.params;
  const { comentario } = req.body;

  if (!comentario?.trim())
    return res.status(400).json({ success: false, data: null,
      error: 'El comentario es obligatorio para reversar un pago.' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Verificar que el pago existe y está PAGADO
    const [[pago]] = await conn.query(
      'SELECT * FROM pagos_credito WHERE id_pago = ?', [id_pago]
    );
    if (!pago) {
      await conn.rollback();
      return res.status(404).json({ success: false, data: null, error: 'Pago no encontrado.' });
    }
    if (pago.estado_pago !== 'PAGADO') {
      await conn.rollback();
      return res.status(400).json({ success: false, data: null,
        error: `Este pago ya tiene estado "${pago.estado_pago}" y no puede reversarse.` });
    }

    // 1b. Verificar que sea la última cuota pagada del crédito
    const [[ultimaPagada]] = await conn.query(
      `SELECT MAX(numero_cuota) AS ultima
       FROM pagos_credito
       WHERE id_credito = ? AND estado_pago = 'PAGADO'`,
      [pago.id_credito]
    );
    if (ultimaPagada?.ultima !== pago.numero_cuota) {
      await conn.rollback();
      return res.status(400).json({ success: false, data: null,
        error: `Solo se puede reversar la última cuota pagada (N°${ultimaPagada?.ultima}). Reversa primero las cuotas posteriores.` });
    }

    // 2. Verificar permiso de reverso en la caja donde se registró el pago
    const u = req.usuario || {};
    if (pago.id_caja) {
      const [[permCaja]] = await conn.query(
        `SELECT puede_reversar_pagos FROM caja_usuarios
         WHERE id_caja = ? AND id_usuario = ? AND activo = 1`,
        [pago.id_caja, u.id_usuario]
      );
      if (!permCaja?.puede_reversar_pagos) {
        await conn.rollback();
        return res.status(403).json({ success: false, data: null,
          error: 'No tienes permiso para reversar pagos en esta caja.' });
      }
    }

    // 3. Marcar como REVERSADO
    const reversado_por = [u.nombre, u.apellido].filter(Boolean).join(' ') || u.email || null;
    await conn.query(
      `UPDATE pagos_credito
       SET estado_pago       = 'REVERSADO',
           comentario_reverso = ?,
           reversado_por      = ?,
           id_reversado_por   = ?,
           fecha_reverso      = NOW()
       WHERE id_pago = ?`,
      [comentario.trim(), reversado_por, u.id_usuario || null, id_pago]
    );

    // 4. Si se usó saldo a favor para pagar esta cuota (via transitoria),
    //    restituir el monto reversado como nuevo abono en cuentas_transitorias
    if (pago.numero_transaccion) {
      const totalReversado = parseFloat(pago.total_pagado) || 0;
      if (totalReversado > 0) {
        const [[cred]] = await conn.query(
          `SELECT COALESCE(cl.rut,'') AS rut_cliente, COALESCE(cl.nombre_completo,'') AS nombre_cliente
           FROM creditos c LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
           WHERE c.id_credito = ?`,
          [pago.id_credito]
        );
        const [trIns] = await conn.query(
          `INSERT INTO cuentas_transitorias
             (id_credito, rut_cliente, nombre_cliente, numero_transaccion,
              fecha, monto_original, glosa)
           VALUES (?,?,?,?,CURDATE(),?,?)`,
          [
            pago.id_credito,
            cred?.rut_cliente    || null,
            cred?.nombre_cliente || null,
            pago.numero_transaccion,
            totalReversado,
            `Reverso cuota N°${pago.numero_cuota} — ${comentario.trim()}`
          ]
        );
        await conn.query(
          `INSERT INTO transitorias_cartola
             (id_transitoria, id_credito, numero_transaccion, tipo, monto, concepto)
           VALUES (?,?,?,'ABONO',?,?)`,
          [
            trIns.insertId, pago.id_credito, pago.numero_transaccion,
            totalReversado,
            `REVERSO cuota N°${pago.numero_cuota} — ${comentario.trim()}`
          ]
        );
      }
    }

    await conn.commit();

    // Auditoría
    try {
      audit.registrar({
        id_credito: pago.id_credito, req,
        accion: 'PAGO_REVERSADO',
        detalle: `Cuota N°${pago.numero_cuota} reversada. Total: $${Math.round(pago.total_pagado||0).toLocaleString('es-CL')}. Motivo: ${comentario.trim()}`,
        meta: { numero_cuota: pago.numero_cuota, total_pagado: pago.total_pagado, comentario: comentario.trim() },
      });
    } catch(_) {}

    res.json({ success: true,
      data: { id_pago: Number(id_pago), numero_cuota: pago.numero_cuota, estado_pago: 'REVERSADO' },
      error: null });
  } catch(e) {
    try { await conn.rollback(); } catch(_) {}
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  } finally {
    conn.release();
  }
};

module.exports = { getByCredito, getById, create, createBatch, remove, reversar };
