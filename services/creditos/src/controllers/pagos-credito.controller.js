const pool  = require('../../../../shared/config/database');
const { hoyChile } = require('../../../../shared/utils/fecha-futura');   // MOTOR ÚNICO fecha/hora Chile
const audit = require('../../../../shared/auditoria');
const { auditar } = require('../../../../shared/audit');
const { _calc: COB } = require('../../../cobranza/src/controllers/cobranza.controller');

require('../../../../shared/migrate').enFila('pagos-credito', async () => {
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
    // Registro de condonación: montos FULL (antes de condonar). Condonado = total - cobrado.
    await addCol(`ALTER TABLE pagos_credito ADD COLUMN IF NOT EXISTS interes_mora_total    DECIMAL(14,2) NULL`);
    await addCol(`ALTER TABLE pagos_credito ADD COLUMN IF NOT EXISTS gastos_cobranza_total DECIMAL(14,2) NULL`);

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
});

/* ─── Condonación: validación server-side contra atribuciones de la caja ──────
 * Recalcula (canónico, igual que /api/cobranza/calcular-cobranza-lote) la mora y
 * los gastos FULL de cada cuota y verifica que lo COBRADO no condone más de lo
 * que el usuario puede en su caja (caja_usuarios). Blinda contra requests
 * manipulados. Fail-open si el cálculo de cobranza no está disponible. */
async function cobranzaFullMap(id_credito, pagos, fechaCalc) {
  const out = new Map();
  try {
    const cfg = await COB.getCobranzaConfig();
    const gastosDias = Number(cfg.gastos_dias) || 21;
    let tramosUF = []; try { tramosUF = JSON.parse(cfg.tramos_uf); } catch (_) {}
    const [tasas] = await pool.query(
      "SELECT DATE_FORMAT(fecha_desde,'%Y-%m-%d') fecha_desde, DATE_FORMAT(fecha_hasta,'%Y-%m-%d') fecha_hasta, tasa_mensual_menor, tasa_mensual_mayor FROM tasas");
    // Tramo del crédito (menor/mayor 200 UF) = saldo precio vs umbral × UF de otorgamiento
    let tramo = 'menor';
    const [[cr]] = await pool.query(
      "SELECT saldo_precio, monto_financiado, DATE_FORMAT(fecha_otorgado,'%Y-%m-%d') fecha_otorgado FROM creditos WHERE id=?", [id_credito]);
    if (cr) {
      const [[um]] = await pool.query("SELECT valor FROM parametros_credito WHERE clave='umbral_uf_tramo'");
      const umbral = um ? parseFloat(um.valor) || 200 : 200;
      const ufOt = await COB.getUFporFecha(cr.fecha_otorgado);
      const base = Number(cr.saldo_precio) || Number(cr.monto_financiado) || 0;
      if (ufOt > 0 && base > umbral * ufOt) tramo = 'mayor';
    }
    const ufCache = new Map();
    for (const q of pagos) {
      const cuota = parseFloat(q.monto_cuota) || 0;
      const fv = q.fecha_vencimiento ? String(q.fecha_vencimiento).slice(0, 10) : null;
      let gastos = 0;
      if (fv) {
        const diasMora = Math.max(0, Math.floor((new Date(fechaCalc + 'T00:00:00Z') - new Date(fv + 'T00:00:00Z')) / 86400000));
        if (diasMora >= gastosDias) {
          const key = COB.addDias(fv, gastosDias);
          let uf = ufCache.get(key); if (uf === undefined) { uf = await COB.getUFporFecha(key); ufCache.set(key, uf); }
          gastos = COB.calcularGastoCobranza(cuota, uf, tramosUF).gasto_pesos || 0;
        }
      }
      const mora = fv ? (COB.calcularInteresMora(cuota, fv, fechaCalc, tramo, tasas, COB.moraFechaFija(cfg, cr && cr.fecha_otorgado)).interes || 0) : 0;
      out.set(Number(q.numero_cuota), { mora: Math.round(mora), gastos: Math.round(gastos) });
    }
  } catch (e) { console.error('[cobranzaFullMap]', e.message); }
  return out;
}

async function validarCondonacionTopes({ id_credito, id_caja, id_usuario, pagos, fecha_pago }) {
  const fechaCalc = (fecha_pago ? String(fecha_pago).slice(0, 10) : null)
    || hoyChile();
  const fullMap = await cobranzaFullMap(id_credito, pagos, fechaCalc);
  let perm = null;
  try {
    const [[row]] = await pool.query(
      `SELECT puede_condonar_intereses, tope_intereses, puede_condonar_gastos, tope_gastos,
              puede_condonar_capital, tope_capital
         FROM caja_usuarios WHERE id_caja=? AND id_usuario=? AND activo=1 LIMIT 1`, [id_caja, id_usuario]);
    perm = row || null;
  } catch (_) {}
  // Valor de cuota canónico: calendario congelado si existe (el cliente no define el full)
  const capMap = new Map();
  try {
    const [cc] = await pool.query('SELECT numero_cuota, valor_cuota FROM cuotas_credito WHERE id_credito=?', [id_credito]);
    cc.forEach(q => capMap.set(Number(q.numero_cuota), Math.round(parseFloat(q.valor_cuota) || 0)));
  } catch (_) {}
  const fmt = n => '$' + Math.round(n).toLocaleString('es-CL');
  for (const p of pagos) {
    const f = fullMap.get(Number(p.numero_cuota)); if (!f) continue;  // fail-open si no se pudo recalcular
    const moraMin   = perm?.puede_condonar_intereses ? Math.round(f.mora   * (1 - (parseFloat(perm.tope_intereses) || 0) / 100)) : f.mora;
    const gastosMin = perm?.puede_condonar_gastos    ? Math.round(f.gastos * (1 - (parseFloat(perm.tope_gastos)    || 0) / 100)) : f.gastos;
    const imCharged = Math.round(parseFloat(p.interes_mora) || 0);
    const gcCharged = Math.round(parseFloat(p.gastos_cobranza) || 0);
    if (imCharged < moraMin - 1)
      return { error: `Cuota N°${p.numero_cuota}: la condonación de intereses por mora supera tu atribución (mínimo a cobrar ${fmt(moraMin)}).`, fullMap };
    if (gcCharged < gastosMin - 1)
      return { error: `Cuota N°${p.numero_cuota}: la condonación de gastos de cobranza supera tu atribución (mínimo a cobrar ${fmt(gastosMin)}).`, fullMap };
    // Capital (último en el orden de condonación): cobrado = total_pagado − mora − gastos
    const capFull = capMap.get(Number(p.numero_cuota)) ?? Math.round(parseFloat(p.monto_cuota) || 0);
    const tp = parseFloat(p.total_pagado);
    const capCharged = Number.isFinite(tp) ? Math.round(tp) - imCharged - gcCharged : capFull;
    const capMin = perm?.puede_condonar_capital ? Math.round(capFull * (1 - (parseFloat(perm.tope_capital) || 0) / 100)) : capFull;
    if (capCharged < capMin - 1)
      return { error: `Cuota N°${p.numero_cuota}: la condonación de capital supera tu atribución (mínimo a cobrar ${fmt(capMin)}).`, fullMap };
  }
  return { error: null, fullMap };
}

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

/* ─── GET calendario congelado (tabla de desarrollo real en cuotas_credito) ──
   Créditos otorgados son inmutables: si el crédito tiene calendario congelado
   (migración INDEXA / cartera cargada por Excel), los consumidores deben usarlo
   en vez de recalcular la cuota francesa al vuelo. Devuelve [] si no hay. */
const getCalendario = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT numero_cuota, DATE_FORMAT(fecha_vencimiento,'%Y-%m-%d') fecha_vencimiento,
              interes, amortizacion, valor_cuota, saldo_insoluto, estado_cuota,
              DATE_FORMAT(fecha_pago,'%Y-%m-%d') fecha_pago
         FROM cuotas_credito WHERE id_credito = ? ORDER BY numero_cuota ASC`,
      [req.params.id_credito]);
    res.json({ success: true, data: rows, error: null });
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

/* ─── GET un pago por ID ─────────────────────────────────────────────────── */
const getById = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT pc.*, cj.nombre AS nombre_caja,
              DATE_FORMAT(pc.created_at,'%H:%i:%s') AS hora_pago_fmt
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
      origen_fondos, id_cuenta_bancaria,
      interes_mora_total, gastos_cobranza_total
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
    // Blindaje: condonación dentro de las atribuciones de la caja (full canónico del servidor)
    const { error: condErr, fullMap } = await validarCondonacionTopes({
      id_credito, id_caja: parseInt(id_caja) || null, id_usuario: u.id_usuario,
      pagos: [{ numero_cuota, fecha_vencimiento, monto_cuota, interes_mora, gastos_cobranza }], fecha_pago });
    if (condErr) return res.status(403).json({ success: false, data: null, error: condErr });
    const f = fullMap.get(Number(numero_cuota));
    const imTot = (f && f.mora   != null) ? f.mora   : ((interes_mora_total    != null) ? parseFloat(interes_mora_total)    || 0 : parseFloat(interes_mora)    || 0);
    const gcTot = (f && f.gastos != null) ? f.gastos : ((gastos_cobranza_total != null) ? parseFloat(gastos_cobranza_total) || 0 : parseFloat(gastos_cobranza) || 0);

    const [r] = await pool.query(
      `INSERT INTO pagos_credito
         (id_credito, numero_cuota, fecha_vencimiento, monto_cuota,
          interes_mora, gastos_cobranza, total_pagado, fecha_pago,
          estado_pago, observacion, registrado_por, id_registrado_por, id_caja,
          origen_fondos, id_cuenta_bancaria, interes_mora_total, gastos_cobranza_total)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id_credito, numero_cuota, fecha_vencimiento || null,
       parseFloat(monto_cuota)||0, parseFloat(interes_mora)||0,
       parseFloat(gastos_cobranza)||0, tp,
       fecha_pago || null, estado_pago || 'PAGADO',
       observacion || null, registrado_por, id_registrado_por,
       parseInt(id_caja) || null,
       origen_fondos || null, parseInt(id_cuenta_bancaria) || null,
       imTot, gcTot]
    );
    audit.registrar({
      id_credito, req,
      accion: 'PAGO_REGISTRADO',
      detalle: `Cuota N°${numero_cuota} pagada — Total: $${Math.round(tp).toLocaleString('es-CL')}`,
      meta: { numero_cuota, monto_cuota: parseFloat(monto_cuota)||0, interes_mora: parseFloat(interes_mora)||0, gastos_cobranza: parseFloat(gastos_cobranza)||0, total_pagado: tp, fecha_pago: fecha_pago || null },
    });
    auditar({ req, accion: 'PAGAR', modulo: 'pagos', entidad: 'pago', entidad_id: r.insertId,
      detalle: `Registró pago de cuota N°${numero_cuota} (crédito ${id_credito}) — $${Math.round(tp).toLocaleString('es-CL')}`,
      meta: { id_credito, numero_cuota, total_pagado: tp } });
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
      auditar({ req, accion: 'ELIMINAR', modulo: 'pagos', entidad: 'pago', entidad_id: req.params.id_pago,
        detalle: `Eliminó el pago de cuota N°${prev[0].numero_cuota} (crédito ${prev[0].id_credito})`,
        meta: { id_credito: prev[0].id_credito, numero_cuota: prev[0].numero_cuota, total_pagado: prev[0].total_pagado } });
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

    // ── Blindaje: condonación dentro de las atribuciones de la caja ─────────
    const { error: condErr, fullMap } = await validarCondonacionTopes({
      id_credito, id_caja: idCajaInt, id_usuario: u.id_usuario, pagos, fecha_pago });
    if (condErr) {
      await conn.rollback();
      return res.status(403).json({ success: false, data: null, error: condErr });
    }

    for (const p of pagos) {
      const tp = parseFloat(p.total_pagado) ||
        (parseFloat(p.monto_cuota)||0) + (parseFloat(p.interes_mora)||0) + (parseFloat(p.gastos_cobranza)||0);
      // Montos full (antes de condonar) = canónico del servidor; fallback al cliente
      const f = fullMap.get(Number(p.numero_cuota));
      const imTot = (f && f.mora   != null) ? f.mora   : ((p.interes_mora_total    != null) ? parseFloat(p.interes_mora_total)    || 0 : parseFloat(p.interes_mora)    || 0);
      const gcTot = (f && f.gastos != null) ? f.gastos : ((p.gastos_cobranza_total != null) ? parseFloat(p.gastos_cobranza_total) || 0 : parseFloat(p.gastos_cobranza) || 0);
      await conn.query(
        `INSERT INTO pagos_credito
           (id_credito, numero_cuota, fecha_vencimiento, monto_cuota,
            interes_mora, gastos_cobranza, total_pagado, fecha_pago,
            estado_pago, observacion, registrado_por, id_registrado_por,
            id_caja, origen_fondos, id_cuenta_bancaria, numero_transaccion,
            interes_mora_total, gastos_cobranza_total)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id_credito, p.numero_cuota, p.fecha_vencimiento || null,
          parseFloat(p.monto_cuota)||0, parseFloat(p.interes_mora)||0,
          parseFloat(p.gastos_cobranza)||0, tp,
          fecha_pago || null, 'PAGADO',
          observacion || null, registrado_por, id_registrado_por,
          idCajaInt, origen_fondos || null, idCuentaInt,
          numero_transaccion,
          imTot, gcTot
        ]
      );
    }

    // Calendario congelado (cuotas_credito): marcar las cuotas pagadas también ahí,
    // para que la tabla de desarrollo real y los pagos en app siempre conversen.
    if (pagos.length) {
      await conn.query(
        `UPDATE cuotas_credito SET estado_cuota='PAGADA', fecha_pago=?
          WHERE id_credito=? AND numero_cuota IN (?) AND estado_cuota<>'PAGADA'`,
        [fecha_pago || new Date(), id_credito, pagos.map(p => p.numero_cuota)]
      ).catch(() => {});
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

    // Centralización contable: un asiento por transacción de caja (nunca bloquea el pago)
    try {
      const sum = k => pagos.reduce((s, p) => s + (parseFloat(p[k]) || 0), 0);
      const mCuota = sum('monto_cuota'), mMora = sum('interes_mora'), mGastos = sum('gastos_cobranza');
      require('../../../contabilidad/src/motor-asientos').contabilizar({
        evento: 'PAGO_CAJA', fecha: fecha_pago || undefined,
        glosa: `Pago en caja ${pagos.length} cuota(s) crédito ${id_credito}`,
        ref: `TRX-${String(numero_transaccion).padStart(6, '0')}`,
        montos: { total: mCuota + mMora + mGastos, cuota: mCuota, mora: mMora, gastos: mGastos },
      }).catch(() => {});
    } catch (_) {}

    // Auditoría (fuera de la transacción, no crítica)
    try {
      audit.registrar({
        id_credito, req,
        accion: 'PAGO_BATCH_REGISTRADO',
        detalle: `${pagos.length} cuota(s) — Total: $${Math.round(totalCobrado).toLocaleString('es-CL')} — TRX #${numero_transaccion}`,
        meta: { numero_transaccion, cuotas: pagos.map(p => p.numero_cuota), totalCobrado, exceso: exceso || 0 },
      });
    } catch(_) {}
    auditar({ req, accion: 'PAGAR', modulo: 'pagos', entidad: 'pago', entidad_id: numero_transaccion,
      detalle: `Registró pago múltiple — ${pagos.length} cuota(s), total $${Math.round(totalCobrado).toLocaleString('es-CL')} (crédito ${id_credito}, TRX #${numero_transaccion})`,
      meta: { id_credito, numero_transaccion, cuotas: pagos.length, totalCobrado } });

    res.status(201).json({ success: true, data: { numero_transaccion, totalCobrado, transitoria }, error: null });
  } catch(e) {
    console.error('[createBatch]', e.message);
    try { await conn.rollback(); } catch(_) {}
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  } finally {
    conn.release();
  }
};

/* ─── PREPAGO (saldar el crédito completo en caja) ──────────────────────────
 * Usa el MOTOR ÚNICO de prepago (certificados.calcularPrepago), el mismo del
 * Certificado de Deuda para Prepago. Solo cartera propia AutoFácil. */
const _r2 = n => Math.round(Number(n) || 0);

// GET /prepago/:num_op — desglose para mostrar en el modal (read-only).
const prepagoInfo = async (req, res) => {
  try {
    const { calcularPrepago } = require('../../../certificados/src/controllers/certificados.controller');
    const pp = await calcularPrepago(req.params.num_op);
    res.json({ success: true, data: { rut: pp.rut, nombre: pp.nombre, num_op: pp.num_op, financiera: pp.credito.financiera, ...pp.datos }, error: null });
  } catch (e) { res.status(e.code || 500).json({ success: false, data: null, error: e.msg || 'Error calculando el prepago' }); }
};

// POST /prepagar — registra el prepago: paga todas las cuotas pendientes + 1 fila
// sentinela (comisión de prepago + interés corriente) y deja el crédito PREPAGADO.
// Condonación de intereses/gastos dentro de las atribuciones de la caja (proporcional).
const prepagar = async (req, res) => {
  const b = req.body || {};
  const num_op = b.num_op;
  const id_caja = b.id_caja;
  if (!num_op) return res.status(400).json({ success: false, data: null, error: 'Falta el N° de operación' });
  if (!id_caja) return res.status(400).json({ success: false, data: null, error: 'Se requiere una caja activa para registrar el prepago' });
  const u = req.usuario || {};

  // Atribuciones de la caja del usuario
  const [[ca]] = await pool.query(
    `SELECT cu.* FROM caja_usuarios cu JOIN cajas cj ON cj.id_caja=cu.id_caja
      WHERE cu.id_caja=? AND cu.id_usuario=? AND cu.activo=1 AND cj.activo=1 LIMIT 1`, [id_caja, u.id_usuario]);
  if (!ca) return res.status(403).json({ success: false, data: null, error: 'No tienes esta caja activa' });

  // Motor único
  let pp;
  try { const { calcularPrepago } = require('../../../certificados/src/controllers/certificados.controller'); pp = await calcularPrepago(num_op); }
  catch (e) { return res.status(e.code || 500).json({ success: false, data: null, error: e.msg || 'Error calculando el prepago' }); }
  const c = pp.credito, d = pp.datos;
  if (String(c.financiera || '').toUpperCase() !== 'AUTOFACIL')
    return res.status(400).json({ success: false, data: null, error: 'El prepago en caja es solo para créditos AutoFácil (cartera propia)' });
  const id_credito = c.id;

  // Condonación dentro de atribuciones (orden de negocio: gastos → interés mora →
  // interés corriente → capital; el capital tiene atribución propia y nace en 0)
  const Gfull = _r2(d.gastos_cobranza);
  const moraTot = _r2(d.interes_mora);
  const corrComTot = _r2(d.interes_corriente) + _r2(d.comision_prepago);
  const Ifull = moraTot + corrComTot;
  const Cfull = _r2(d.capital_vigente) + _r2(d.mora_cuotas);   // capital = cuotas (vigentes + en mora)
  const maxG = ca.puede_condonar_gastos ? Math.floor(Gfull * (Number(ca.tope_gastos) || 0) / 100) : 0;
  const maxI = ca.puede_condonar_intereses ? Math.floor(Ifull * (Number(ca.tope_intereses) || 0) / 100) : 0;
  const maxC = ca.puede_condonar_capital ? Math.floor(Cfull * (Number(ca.tope_capital) || 0) / 100) : 0;
  let condG = Math.max(0, _r2(b.condona_gastos_monto));
  // Nuevo (ficha): mora y corriente separados. Legado (caja): un solo monto de intereses.
  const separado = b.condona_mora_monto != null || b.condona_corriente_monto != null;
  let condI_mora, condI_corr, condI;
  if (separado) {
    condI_mora = Math.min(Math.max(0, _r2(b.condona_mora_monto)), moraTot);
    condI_corr = Math.min(Math.max(0, _r2(b.condona_corriente_monto)), corrComTot);
    condI = condI_mora + condI_corr;
  } else {
    condI = Math.max(0, _r2(b.condona_intereses_monto));
    condI_mora = Ifull > 0 ? Math.round(Math.min(condI, Ifull) * (moraTot / Ifull)) : 0;
    condI_corr = Math.min(condI, Ifull) - condI_mora;
  }
  let condC = Math.max(0, _r2(b.condona_capital_monto));
  if (condG > maxG) return res.status(403).json({ success: false, data: null, error: `La condonación de gastos excede tu atribución (máx $${maxG.toLocaleString('es-CL')})` });
  if (condI > maxI) return res.status(403).json({ success: false, data: null, error: `La condonación de intereses excede tu atribución (máx $${maxI.toLocaleString('es-CL')})` });
  if (condC > maxC) return res.status(403).json({ success: false, data: null, error: `La condonación de capital excede tu atribución (máx $${maxC.toLocaleString('es-CL')})` });
  condG = Math.min(condG, Gfull); condI = Math.min(condI, Ifull); condC = Math.min(condC, Cfull);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [corr] = await conn.query('INSERT INTO correlativo_transacciones (created_at) VALUES (NOW())');
    const trx = corr.insertId;
    const reg = [u.nombre, u.apellido].filter(Boolean).join(' ') || u.email || null;
    const idCajaInt = parseInt(id_caja) || null;
    const idCtaInt = parseInt(b.id_cuenta_bancaria) || null;
    const fp = b.fecha_pago || hoyChile();
    const obs = b.observacion || 'Prepago';

    const detalle = d.detalle || [];
    const gSum = detalle.reduce((s, q) => s + _r2(q.gastos_cobranza), 0);
    const mSum = detalle.reduce((s, q) => s + _r2(q.interes_mora), 0);
    const cSum = detalle.reduce((s, q) => s + _r2(q.valor_cuota), 0);
    let totalCobrado = 0;
    const ins = `INSERT INTO pagos_credito
       (id_credito, numero_cuota, fecha_vencimiento, monto_cuota, interes_mora, gastos_cobranza,
        total_pagado, fecha_pago, estado_pago, observacion, registrado_por, id_registrado_por,
        id_caja, origen_fondos, id_cuenta_bancaria, numero_transaccion, interes_mora_total, gastos_cobranza_total)
       VALUES (?,?,?,?,?,?,?,?,'PAGADO',?,?,?,?,?,?,?,?,?)`;

    for (const q of detalle) {
      const gFull = _r2(q.gastos_cobranza), mFull = _r2(q.interes_mora), cFull = _r2(q.valor_cuota);
      const gCond = gSum > 0 ? Math.round(condG * (gFull / gSum)) : 0;
      const mCond = mSum > 0 ? Math.round(condI_mora * (mFull / mSum)) : 0;
      const cCond = cSum > 0 ? Math.round(condC * (cFull / cSum)) : 0;
      const gCol = Math.max(0, gFull - gCond), mCol = Math.max(0, mFull - mCond), cCol = Math.max(0, cFull - cCond);
      const tp = cCol + mCol + gCol;
      totalCobrado += tp;
      await conn.query(ins, [id_credito, q.numero_cuota, q.fecha_vencimiento || null, _r2(q.valor_cuota),
        mCol, gCol, tp, fp, obs, reg, u.id_usuario || null, idCajaInt, b.origen_fondos || null, idCtaInt, trx, mFull, gFull]);
    }
    // Fila sentinela (numero_cuota = 0): comisión de prepago + interés corriente
    const corrComCol = Math.max(0, corrComTot - condI_corr);
    totalCobrado += corrComCol;
    await conn.query(ins, [id_credito, 0, null, 0, corrComCol, 0, corrComCol, fp,
      'Comisión de prepago + interés corriente', reg, u.id_usuario || null, idCajaInt, b.origen_fondos || null, idCtaInt, trx, corrComTot, 0]);

    // Calendario real → marcar cuotas PAGADA; y estado terminal PREPAGADO (creditos + brokerage)
    await conn.query("UPDATE cuotas_credito SET estado_cuota='PAGADA', fecha_pago=? WHERE id_credito=? AND estado_cuota<>'PAGADA'", [fp, id_credito]).catch(() => {});
    await conn.query("UPDATE creditos SET estado_cartera='PREPAGADO' WHERE id=?", [id_credito]);
    await conn.query("UPDATE operaciones_brokerage SET estado_cartera='PREPAGADO' WHERE num_op=?", [num_op]).catch(() => {});

    await conn.commit();

    // Centralización contable: asiento del prepago con lo efectivamente cobrado (nunca bloquea)
    try {
      const [[sm]] = await pool.query(
        `SELECT COALESCE(SUM(monto_cuota),0) c, COALESCE(SUM(interes_mora),0) m, COALESCE(SUM(gastos_cobranza),0) g, COALESCE(SUM(total_pagado),0) t
           FROM pagos_credito WHERE numero_transaccion=? AND estado_pago='PAGADO'`, [trx]);
      await require('../../../contabilidad/src/motor-asientos').contabilizar({
        evento: 'PREPAGO', fecha: fp,
        glosa: `Prepago crédito ${num_op} — ${pp.nombre || ''}`.trim().slice(0, 300),
        ref: `TRX-${String(trx).padStart(6, '0')}`, num_op, rut: pp.rut || null,
        montos: { total: Number(sm.t), cuota: Number(sm.c), mora: Number(sm.m), gastos: Number(sm.g) },
      });
    } catch (_) {}
    auditar({ req, accion: 'PAGAR', modulo: 'pagos', entidad: 'prepago', entidad_id: trx,
      detalle: `Prepago crédito ${num_op} — cobrado $${_r2(totalCobrado).toLocaleString('es-CL')} (condonado gastos $${condG.toLocaleString('es-CL')} / intereses $${condI.toLocaleString('es-CL')} / capital $${condC.toLocaleString('es-CL')}) — TRX #${trx}`,
      meta: { id_credito, num_op, numero_transaccion: trx, total_cobrado: _r2(totalCobrado), condona_gastos: condG, condona_intereses: condI, condona_capital: condC } });
    try { audit.registrar({ id_credito, req, accion: 'PREPAGO', detalle: `Prepago — TRX #${trx}, total $${_r2(totalCobrado).toLocaleString('es-CL')}`, meta: { numero_transaccion: trx, total_cobrado: _r2(totalCobrado) } }); } catch (_) {}
    res.status(201).json({ success: true, data: { numero_transaccion: trx, total_cobrado: _r2(totalCobrado), condonado_gastos: condG, condonado_intereses: condI, condonado_capital: condC, cliente: pp.nombre, rut: pp.rut, num_op, desglose: d }, error: null });
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    console.error('[prepagar]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  } finally { conn.release(); }
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

    // 3b. Calendario congelado: si esta cuota ya no tiene ningún pago vigente,
    //     volverla a su estado impago (solo aplica si fue el pago en app el que la marcó)
    const [[quedan]] = await conn.query(
      `SELECT COUNT(*) n FROM pagos_credito WHERE id_credito=? AND numero_cuota=? AND estado_pago='PAGADO'`,
      [pago.id_credito, pago.numero_cuota]);
    if (!quedan.n) {
      await conn.query(
        `UPDATE cuotas_credito SET estado_cuota='VIGENTE', fecha_pago=NULL
          WHERE id_credito=? AND numero_cuota=? AND estado_cuota='PAGADA'`,
        [pago.id_credito, pago.numero_cuota]).catch(() => {});
    }

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
    auditar({ req, accion: 'REVERSAR', modulo: 'pagos', entidad: 'pago', entidad_id: id_pago,
      detalle: `Reversó pago de cuota N°${pago.numero_cuota} (crédito ${pago.id_credito}) — $${Math.round(pago.total_pagado||0).toLocaleString('es-CL')} · "${comentario.trim()}"`,
      meta: { id_credito: pago.id_credito, numero_cuota: pago.numero_cuota, total_pagado: pago.total_pagado, comentario: comentario.trim() } });

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

// cobranzaFullMap exportado: motor único de mora+gastos por cuota (lo usa también el Portal del Cliente)
module.exports = { getByCredito, getCalendario, getById, create, createBatch, remove, reversar, prepagoInfo, prepagar, cobranzaFullMap };
