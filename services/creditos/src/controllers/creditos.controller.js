const pool  = require('../../../../shared/config/database');
const audit = require('../../../../shared/auditoria');

// ── Migración: agregar campos de gestión a operaciones_brokerage ──────────────
(async () => {
  try {
    const addCol = async (sql) => pool.query(sql).catch(e => { if (e.errno !== 1060) throw e; });
    // Campos de vehículo
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN tipo_vehiculo      VARCHAR(100) NULL`);
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN marca              VARCHAR(100) NULL`);
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN modelo             VARCHAR(100) NULL`);
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN anio               INT          NULL`);
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN patente            VARCHAR(20)  NULL`);
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN color              VARCHAR(50)  NULL`);
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN motor              VARCHAR(100) NULL`);
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN chasis             VARCHAR(100) NULL`);
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN transmision        VARCHAR(50)  NULL`);
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN combustible        VARCHAR(50)  NULL`);
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN tasacion           BIGINT       NULL`);
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN permiso_circulacion BIGINT      NULL`);
    // Campos de gestión
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN numero_credito     VARCHAR(20)  NULL`);
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN estado             VARCHAR(30)  NULL`);
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN cuota              BIGINT       NULL`);
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN tipo_ubicacion     VARCHAR(50)  NULL`);
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN nombre_parque_mgmt VARCHAR(100) NULL`);
    // Ampliar tipo_ubicacion si quedó como VARCHAR(10)
    await pool.query(`ALTER TABLE operaciones_brokerage MODIFY COLUMN tipo_ubicacion VARCHAR(50) NULL`).catch(() => {});
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN id_dealer          INT          NULL`);
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN id_cliente         INT          NULL`);
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN id_usuario         INT          NULL`);
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN id_cotizacion      INT          NULL`);
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN datos_json         JSON         NULL`);
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN observaciones      TEXT         NULL`);
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN gastos             BIGINT       NULL`);
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN seguros            BIGINT       NULL`);
    // Campos desde cartas de aprobación
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN rut_concesionario  VARCHAR(20)  NULL`);
    await addCol(`ALTER TABLE operaciones_brokerage ADD COLUMN vendedor           VARCHAR(150) NULL`);
    // comdea_real ya existe en la tabla original (comisión/participación del dealer)
    // Poblar estado correcto según tipo de financiera:
    // - AUTOFACIL (cartera propia) → VIGENTE (se puede trackear pagos)
    // - AUTOFIN / UNIDAD DE CREDITO (brokerage) → OTORGADO (somos broker, no podemos saber si está vigente)
    await pool.query(`
      UPDATE operaciones_brokerage
      SET estado = 'OTORGADO'
      WHERE estado_eval = 'OTORGADO'
        AND (estado IS NULL OR estado = '' OR estado = 'VIGENTE')
        AND financiera IN ('AUTOFIN', 'UNIDAD DE CREDITO')
    `);
    await pool.query(`
      UPDATE operaciones_brokerage
      SET estado = 'VIGENTE'
      WHERE estado_eval = 'OTORGADO'
        AND (estado IS NULL OR estado = '')
        AND (financiera IS NULL OR financiera NOT IN ('AUTOFIN', 'UNIDAD DE CREDITO'))
    `);

    // VIEW creditos → operaciones_brokerage
    // Todos los módulos (cobranza, tesorería, auditoría, pagos, CRM)
    // siguen usando "FROM creditos" sin cambios.
    await pool.query(`
      CREATE OR REPLACE VIEW creditos AS
      SELECT
        id                                                          AS id_credito,
        COALESCE(numero_credito, CONCAT('OP-', num_op))             AS numero_credito,
        rut_cliente,
        nombre_cliente,
        financiera,
        financiera                                                  AS empresa,
        COALESCE(estado,
          CASE
            WHEN financiera IN ('AUTOFIN','UNIDAD DE CREDITO') AND estado_eval = 'OTORGADO' THEN 'OTORGADO'
            WHEN estado_credito = 'OTORGADO' THEN 'VIGENTE'
            WHEN estado_eval    = 'OTORGADO' THEN 'VIGENTE'
            WHEN estado_eval IN ('RECHAZADO','ANULADO') THEN 'CANCELADO'
            ELSE COALESCE(estado_credito, estado_eval)
          END)                                                      AS estado,
        fecha_otorgado                                              AS fecha_otorgamiento,
        valor_vehiculo, pie, saldo_precio, monto_financiado,
        plazo, tascli_real AS tasa_mensual, cuota, fecha_primera_cuota,
        tipo_vehiculo, marca, modelo, anio,
        patente, color, motor, chasis, transmision, combustible,
        tasacion, permiso_circulacion,
        automotora                                                  AS dealer,
        ejecutivo,
        observaciones,
        datos_json,
        id_dealer, id_cliente, id_usuario, id_cotizacion,
        estado_eval,
        mes,
        created_at, updated_at
      FROM operaciones_brokerage
    `);
  } catch (e) {
    if (e.errno !== 1050) console.error('[creditos migration]', e.message);
  }
})();

// ── Generar número de crédito (YYMMXXX) ──────────────────────────────────────
async function generarNumero() {
  const hoy = new Date();
  const yy   = String(hoy.getFullYear()).slice(-2);
  const mm   = String(hoy.getMonth() + 1).padStart(2, '0');
  const prefix = `${yy}${mm}`;
  const [rows] = await pool.query(
    `SELECT numero_credito FROM operaciones_brokerage
     WHERE numero_credito LIKE ? ORDER BY id DESC LIMIT 1`,
    [prefix + '%']
  );
  const seq = rows.length ? parseInt(rows[0].numero_credito.slice(4)) + 1 : 1;
  return prefix + String(seq).padStart(3, '0');
}

// ── SELECT base para gestión ──────────────────────────────────────────────────
// Muestra OTORGADOS de AUTOFIN y UNIDAD + cualquier crédito digitado manualmente
const SELECT_GESTION = `
  SELECT
    ob.id                                                      AS id_credito,
    COALESCE(ob.numero_credito, CONCAT('OP-',ob.num_op))       AS numero_credito,
    ob.rut_cliente,
    ob.nombre_cliente,
    COALESCE(ob.financiera, 'AUTOFACIL')                       AS financiera,
    COALESCE(ob.estado,
      CASE
        WHEN ob.financiera IN ('AUTOFIN','UNIDAD DE CREDITO') AND ob.estado_eval = 'OTORGADO' THEN 'OTORGADO'
        WHEN ob.estado_credito = 'OTORGADO' THEN 'VIGENTE'
        WHEN ob.estado_eval    = 'OTORGADO' THEN 'VIGENTE'
        WHEN ob.estado_eval IN ('RECHAZADO','ANULADO') THEN 'CANCELADO'
        ELSE COALESCE(ob.estado_credito, ob.estado_eval)
      END)                                                     AS estado,
    ob.fecha_otorgado                                          AS fecha_otorgamiento,
    ob.valor_vehiculo,
    ob.pie,
    ob.monto_financiado,
    ob.plazo,
    ob.tascli_real                                             AS tasa_mensual,
    ob.cuota,
    ob.fecha_primera_cuota,
    ob.tipo_vehiculo,
    ob.marca,
    ob.modelo,
    ob.anio,
    ob.patente,
    ob.automotora                                              AS dealer,
    ob.rut_concesionario,
    ob.vendedor,
    ob.comdea_real                                             AS comision_dealer,
    ob.ejecutivo,
    ob.mes,
    ob.id_financiera,
    ob.created_at,
    -- cuotas_pagadas solo para créditos digitados manualmente (numero_credito propio)
    -- Los importados desde Excel (brokerage) no se trackean en pagos: NULL evita falsos EN MORA
    IF(ob.numero_credito IS NOT NULL, COALESCE(pp.cnt, 0), NULL) AS cuotas_pagadas
  FROM operaciones_brokerage ob
  LEFT JOIN (
    SELECT id_credito, COUNT(DISTINCT numero_cuota) AS cnt
    FROM pagos_credito WHERE estado_pago = 'PAGADO'
    GROUP BY id_credito
  ) pp ON pp.id_credito = ob.id
`;

const WHERE_GESTION = `
  WHERE (
    ob.financiera IN ('AUTOFIN','UNIDAD DE CREDITO')
    OR ob.numero_credito IS NOT NULL
  )
  AND ob.estado_eval  != 'ANULADO'
  AND (ob.estado_credito IS NULL OR ob.estado_credito != 'ANULADO')
`;

/* ─── CREATE ─────────────────────────────────────────────────────────────── */
const create = async (req, res) => {
  try {
    const {
      rut_cliente, nombre_cliente, financiera, id_cotizacion, estado,
      fecha_otorgamiento, valor_vehiculo, pie, saldo_precio, monto_financiado,
      plazo, tasa_mensual, cuota, fecha_primera_cuota,
      gastos_operativos, seguros,
      tipo_vehiculo, marca, modelo, anio, patente, color, motor, chasis,
      transmision, combustible, tasacion, permiso_circulacion,
      dealer, id_dealer, tipo_ubicacion, nombre_parque,
      ejecutivo, observaciones, datos_json,
      id_financiera, rut_concesionario, vendedor, comision_dealer,
    } = req.body;

    if (!rut_cliente || !nombre_cliente)
      return res.status(400).json({ success: false, data: null, error: 'rut_cliente y nombre_cliente son requeridos' });

    const numero_credito = await generarNumero();
    const id_usuario = req.usuario?.id_usuario || null;
    const fin = financiera || 'AUTOFACIL';

    // saldo_precio calculado si no viene
    const saldo = saldo_precio || (valor_vehiculo && pie ? (valor_vehiculo - pie) : null);
    const pct   = (valor_vehiculo && saldo) ? saldo / valor_vehiculo : null;

    const [r] = await pool.query(`
      INSERT INTO operaciones_brokerage
        (numero_credito, rut_cliente, nombre_cliente, financiera,
         estado_eval, estado,
         id_cotizacion, id_usuario,
         fecha_otorgado, mes,
         valor_vehiculo, pie, saldo_precio, pct_financiado, monto_financiado,
         plazo, tascli_real, cuota, fecha_primera_cuota,
         gastos, seguros, tipo_vehiculo, marca, modelo, anio,
         patente, color, motor, chasis,
         transmision, combustible, tasacion, permiso_circulacion,
         automotora, id_dealer, tipo_ubicacion, nombre_parque_mgmt,
         ejecutivo, observaciones, datos_json, id_financiera,
         rut_concesionario, vendedor, comdea_real,
         created_at, updated_at)
      VALUES (?,?,?,?,
              'OTORGADO',?,
              ?,?,
              ?,DATE_FORMAT(COALESCE(?, NOW()), '%Y-%m-01'),
              ?,?,?,?,?,
              ?,?,?,?,
              ?,?,?,?,?,?,
              ?,?,?,?,
              ?,?,?,?,
              ?,?,?,?,
              ?,?,?,?,
              ?,?,?,
              NOW(), NOW())
    `, [
      numero_credito, rut_cliente.toUpperCase().trim(), nombre_cliente.trim(), fin,
      estado || 'INGRESO',
      id_cotizacion || null, id_usuario,
      fecha_otorgamiento || null, fecha_otorgamiento || null,
      valor_vehiculo || null, pie || null, saldo || null, pct || null, monto_financiado || null,
      plazo || null, tasa_mensual || null, cuota || null, fecha_primera_cuota || null,
      gastos_operativos || null, seguros || null, tipo_vehiculo || null,
      marca || null, modelo || null, anio || null,
      patente ? patente.toUpperCase().trim() : null, color || null,
      motor || null, chasis || null,
      transmision || null, combustible || null, tasacion || null, permiso_circulacion || null,
      dealer || null, id_dealer || null, tipo_ubicacion || null, nombre_parque || null,
      ejecutivo || null, observaciones || null,
      datos_json ? JSON.stringify(datos_json) : null,
      id_financiera || null,
      rut_concesionario || null,
      vendedor || null,
      comision_dealer != null ? Math.round(parseFloat(comision_dealer)) : null,
    ]);

    audit.registrar({
      id_credito: r.insertId, req,
      accion: 'CREDITO_CREADO',
      detalle: `Crédito N°${numero_credito} creado para ${nombre_cliente}`,
      meta: { numero_credito, cliente: nombre_cliente, rut: rut_cliente, financiera: fin, monto_financiado: monto_financiado || null },
    });

    res.status(201).json({ success: true, data: { id_credito: r.insertId, numero_credito }, error: null });
  } catch (e) {
    console.error('[creditos create]', e);
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ─── GET ALL ────────────────────────────────────────────────────────────── */
const getAll = async (req, res) => {
  try {
    const { q } = req.query;
    let sql = SELECT_GESTION + WHERE_GESTION;
    const params = [];

    if (q && q.trim()) {
      // Normalizar: quitar puntos para comparar RUTs con/sin formato (77.267.903-3 = 77267903-3)
      const qNorm = q.trim().toUpperCase().replace(/\./g, '');
      const like  = `%${qNorm}%`;
      sql += ` AND (
        UPPER(REPLACE(ob.rut_cliente,'.',''))       LIKE ? OR
        UPPER(ob.nombre_cliente)                    LIKE ? OR
        UPPER(COALESCE(ob.numero_credito, CONCAT('OP-',ob.num_op))) LIKE ?
      )`;
      params.push(like, like, like);
    }
    sql += ` ORDER BY ob.mes DESC, ob.id DESC LIMIT 5000`;

    const [rows] = await pool.query(sql, params);
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    console.error('[creditos getAll]', e);
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ─── GET BY ID ──────────────────────────────────────────────────────────── */
const getById = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT ob.*,
              ob.id                                                AS id_credito,
              COALESCE(ob.numero_credito, CONCAT('OP-',ob.num_op)) AS numero_credito_fmt,
              ob.automotora                                         AS dealer,
              ob.tascli_real                                        AS tasa_mensual,
              ob.fecha_otorgado                                     AS fecha_otorgamiento
       FROM operaciones_brokerage ob WHERE ob.id = ?`,
      [req.params.id]
    );
    if (!rows.length)
      return res.status(404).json({ success: false, data: null, error: 'Crédito no encontrado' });
    res.json({ success: true, data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ─── UPDATE ─────────────────────────────────────────────────────────────── */
const update = async (req, res) => {
  try {
    const {
      estado, observaciones, ejecutivo, dealer, patente, color, motor, chasis,
      // Campos de edición completa
      rut_cliente, nombre_cliente, financiera,
      fecha_otorgamiento, fecha_primera_cuota,
      valor_vehiculo, pie, saldo_precio, monto_financiado,
      plazo, tasa_mensual, cuota,
      gastos_operativos, seguros,
      tipo_vehiculo, marca, modelo, anio,
      transmision, combustible, tasacion, permiso_circulacion,
      id_dealer, tipo_ubicacion, nombre_parque,
      datos_json,
    } = req.body;

    const [prev] = await pool.query(
      'SELECT estado, numero_credito, nombre_cliente FROM operaciones_brokerage WHERE id = ?',
      [req.params.id]
    );
    if (!prev.length) return res.status(404).json({ success: false, data: null, error: 'Crédito no encontrado' });
    const estadoAntes = prev[0]?.estado || null;

    // Detectar si es una edición completa (vienen campos financieros)
    const esEdicionCompleta = monto_financiado !== undefined || valor_vehiculo !== undefined;

    if (esEdicionCompleta) {
      // ── Edición completa: actualiza todos los campos del formulario de ingreso
      const saldo = saldo_precio || (valor_vehiculo && pie ? (valor_vehiculo - pie) : null);
      const pct   = (valor_vehiculo && saldo) ? saldo / valor_vehiculo : null;

      await pool.query(`
        UPDATE operaciones_brokerage
        SET estado               = ?,
            observaciones        = ?,
            ejecutivo            = ?,
            automotora           = ?,
            patente              = ?,
            color                = ?,
            motor                = ?,
            chasis               = ?,
            nombre_cliente       = ?,
            financiera           = ?,
            fecha_otorgado       = ?,
            fecha_primera_cuota  = ?,
            valor_vehiculo       = ?,
            pie                  = ?,
            saldo_precio         = ?,
            pct_financiado       = ?,
            monto_financiado     = ?,
            plazo                = ?,
            tascli_real          = ?,
            cuota                = ?,
            gastos               = ?,
            seguros              = ?,
            tipo_vehiculo        = ?,
            marca                = ?,
            modelo               = ?,
            anio                 = ?,
            transmision          = ?,
            combustible          = ?,
            tasacion             = ?,
            permiso_circulacion  = ?,
            id_dealer            = ?,
            tipo_ubicacion       = ?,
            nombre_parque_mgmt   = ?,
            datos_json           = ?,
            updated_at           = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [
        estado || estadoAntes, observaciones || null,
        ejecutivo || null, dealer || null,
        patente ? patente.toUpperCase().trim() : null,
        color || null, motor || null, chasis || null,
        nombre_cliente ? nombre_cliente.trim() : prev[0].nombre_cliente,
        financiera || 'AUTOFACIL',
        fecha_otorgamiento || null,
        fecha_primera_cuota || null,
        valor_vehiculo || null, pie || null, saldo || null, pct || null, monto_financiado || null,
        plazo || null, tasa_mensual || null, cuota || null,
        gastos_operativos || null, seguros || null,
        tipo_vehiculo || null, marca || null, modelo || null, anio || null,
        transmision || null, combustible || null, tasacion || null, permiso_circulacion || null,
        id_dealer || null, tipo_ubicacion || null, nombre_parque || null,
        datos_json ? JSON.stringify(datos_json) : null,
        req.params.id,
      ]);

      audit.registrar({
        id_credito: req.params.id, req,
        accion: 'CREDITO_EDITADO',
        detalle: `Crédito N°${prev[0].numero_credito} editado por ${req.usuario?.nombre || 'usuario'}`,
        meta: { monto_financiado, plazo, tasa_mensual, valor_vehiculo },
      });
    } else {
      // ── Actualización parcial: solo estado/observaciones/campos de gestión
      await pool.query(`
        UPDATE operaciones_brokerage
        SET estado        = ?,
            observaciones = ?,
            ejecutivo     = ?,
            automotora    = ?,
            patente       = ?,
            color         = ?,
            motor         = ?,
            chasis        = ?,
            updated_at    = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [
        estado, observaciones || null, ejecutivo || null, dealer || null,
        patente ? patente.toUpperCase().trim() : null,
        color || null, motor || null, chasis || null, req.params.id
      ]);
    }

    if (estado && estadoAntes && estado !== estadoAntes) {
      audit.registrar({
        id_credito: req.params.id, req,
        accion: 'ESTADO_CAMBIADO',
        detalle: `Estado: ${estadoAntes} → ${estado}`,
        meta: { estado_antes: estadoAntes, estado_despues: estado },
      });
    }
    res.json({ success: true, data: { id_credito: req.params.id }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { create, getAll, getById, update };
