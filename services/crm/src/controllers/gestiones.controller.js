'use strict';

const pool = require('../../../../shared/config/database');

// ─── Migración automática ─────────────────────────────────────────────────────
(async () => {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query(`
      CREATE TABLE IF NOT EXISTS crm_campanas (
        id_campana      INT AUTO_INCREMENT PRIMARY KEY,
        nombre          VARCHAR(200) NOT NULL,
        descripcion     TEXT NULL,
        fecha_inicio    DATE NULL,
        fecha_fin       DATE NULL,
        dias_semana     VARCHAR(20)  NULL,
        horario_desde   TIME         NULL,
        horario_hasta   TIME         NULL,
        campos_mapeo    JSON         NULL,
        respuestas_json JSON         NULL,
        usuarios_json   JSON         NULL,
        activa          TINYINT(1)   DEFAULT 1,
        id_usuario      INT          NULL,
        created_at      DATETIME     DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    // Columnas que pueden faltar en instancias antiguas
    const addC = async (sql) => conn.query(sql).catch(e => { if (e.errno !== 1060) throw e; });
    await addC(`ALTER TABLE crm_campanas ADD COLUMN dias_semana   VARCHAR(20) NULL`);
    await addC(`ALTER TABLE crm_campanas ADD COLUMN horario_desde TIME NULL`);
    await addC(`ALTER TABLE crm_campanas ADD COLUMN horario_hasta TIME NULL`);
    await addC(`ALTER TABLE crm_campanas ADD COLUMN campos_mapeo  JSON NULL`);
    await addC(`ALTER TABLE crm_campanas ADD COLUMN respuestas_json JSON NULL`);
    await addC(`ALTER TABLE crm_campanas ADD COLUMN usuarios_json JSON NULL`);
    await addC(`ALTER TABLE crm_campanas ADD COLUMN id_usuario    INT NULL`);
    await addC(`ALTER TABLE crm_campanas ADD COLUMN updated_at    DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS crm_gestiones (
        id_gestion       INT AUTO_INCREMENT PRIMARY KEY,
        tipo_cliente     ENUM('ACTIVO','EX_CLIENTE','PROSPECTO') NOT NULL,
        id_credito       INT NULL,
        rut_cliente      VARCHAR(20) NULL,
        nombre_cliente   VARCHAR(200) NULL,
        telefono         VARCHAR(20) NULL,
        email            VARCHAR(150) NULL,
        canal            ENUM('LLAMADA_ENTRANTE','LLAMADA_SALIENTE','WHATSAPP','EMAIL','PRESENCIAL','WEB','REFERIDO','OTRO') NOT NULL,
        tipo_solicitud   VARCHAR(100) NOT NULL,
        descripcion      TEXT NULL,
        resultado        VARCHAR(100) NULL,
        accion_siguiente TEXT NULL,
        fecha_seguimiento DATE NULL,
        prioridad        ENUM('ALTA','MEDIA','BAJA') DEFAULT 'MEDIA',
        id_campana       INT NULL,
        nombre_campana   VARCHAR(200) NULL,
        id_usuario       INT NOT NULL,
        nombre_usuario   VARCHAR(200) NULL,
        estado           ENUM('ABIERTO','CERRADO','PENDIENTE') DEFAULT 'ABIERTO',
        created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_rut (rut_cliente),
        INDEX idx_usuario (id_usuario),
        INDEX idx_created (created_at),
        INDEX idx_estado (estado)
      )
    `);
    console.log('✓ CRM: tablas crm_gestiones y crm_campanas verificadas');
  } catch (err) {
    console.error('✗ CRM migración:', err.message);
  } finally {
    if (conn) conn.release();
  }
})();

// ─── Helpers ─────────────────────────────────────────────────────────────────
function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, data, error: null });
}
function fail(res, error, status = 400) {
  return res.status(status).json({ success: false, data: null, error });
}

const { hoyChile } = require('../../../../shared/utils/fecha-futura');   // MOTOR ÚNICO fecha/hora Chile

// ─── list ─────────────────────────────────────────────────────────────────────
exports.list = async (req, res) => {
  try {
    const {
      q, tipo_cliente, canal, resultado, estado, prioridad,
      id_usuario, desde, hasta, id_campana,
      page = 1, limit = 30
    } = req.query;

    const offset = (Number(page) - 1) * Number(limit);
    const wheres = [];
    const params = [];

    if (q) {
      wheres.push('(g.rut_cliente LIKE ? OR g.nombre_cliente LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    if (tipo_cliente) { wheres.push('g.tipo_cliente = ?'); params.push(tipo_cliente); }
    if (canal)        { wheres.push('g.canal = ?');        params.push(canal); }
    if (resultado)    { wheres.push('g.resultado = ?');    params.push(resultado); }
    if (estado)       { wheres.push('g.estado = ?');       params.push(estado); }
    if (prioridad)    { wheres.push('g.prioridad = ?');    params.push(prioridad); }
    if (id_usuario)   { wheres.push('g.id_usuario = ?');   params.push(id_usuario); }
    if (id_campana)   { wheres.push('g.id_campana = ?');   params.push(id_campana); }
    if (desde)        { wheres.push('DATE(g.created_at) >= ?'); params.push(desde); }
    if (hasta)        { wheres.push('DATE(g.created_at) <= ?'); params.push(hasta); }

    const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM crm_gestiones g ${where}`,
      params
    );

    const [rows] = await pool.query(
      `SELECT * FROM crm_gestiones g ${where} ORDER BY g.created_at DESC LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    ok(res, {
      rows,
      total,
      page: Number(page),
      pages: Math.ceil(total / Number(limit))
    });
  } catch (err) {
    fail(res, err.message, 500);
  }
};

// ─── create ───────────────────────────────────────────────────────────────────
exports.create = async (req, res) => {
  try {
    const { tipo_cliente, canal, tipo_solicitud } = req.body;
    if (!tipo_cliente) return fail(res, 'tipo_cliente es requerido');
    if (!canal)        return fail(res, 'canal es requerido');
    if (!tipo_solicitud) return fail(res, 'tipo_solicitud es requerido');

    const u = req.usuario;
    const nombre_usuario = [u.nombre, u.apellido].filter(Boolean).join(' ');

    const {
      id_credito = null, rut_cliente = null, nombre_cliente = null,
      telefono = null, email = null, descripcion = null, resultado = null,
      accion_siguiente = null, fecha_seguimiento = null, prioridad = 'MEDIA',
      id_campana = null, nombre_campana = null, estado = 'ABIERTO'
    } = req.body;

    const [r] = await pool.query(
      `INSERT INTO crm_gestiones
        (tipo_cliente, id_credito, rut_cliente, nombre_cliente, telefono, email,
         canal, tipo_solicitud, descripcion, resultado, accion_siguiente,
         fecha_seguimiento, prioridad, id_campana, nombre_campana,
         id_usuario, nombre_usuario, estado)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [tipo_cliente, id_credito, rut_cliente, nombre_cliente, telefono, email,
       canal, tipo_solicitud, descripcion, resultado, accion_siguiente,
       fecha_seguimiento, prioridad, id_campana, nombre_campana,
       u.id_usuario, nombre_usuario, estado]
    );

    const [[gestion]] = await pool.query(
      'SELECT * FROM crm_gestiones WHERE id_gestion = ?', [r.insertId]
    );
    ok(res, gestion, 201);
  } catch (err) {
    fail(res, err.message, 500);
  }
};

// ─── getOne ───────────────────────────────────────────────────────────────────
exports.getOne = async (req, res) => {
  try {
    const [[gestion]] = await pool.query(
      'SELECT * FROM crm_gestiones WHERE id_gestion = ?', [req.params.id]
    );
    if (!gestion) return fail(res, 'Gestión no encontrada', 404);
    ok(res, gestion);
  } catch (err) {
    fail(res, err.message, 500);
  }
};

// ─── update ───────────────────────────────────────────────────────────────────
exports.update = async (req, res) => {
  try {
    const [[gestion]] = await pool.query(
      'SELECT * FROM crm_gestiones WHERE id_gestion = ?', [req.params.id]
    );
    if (!gestion) return fail(res, 'Gestión no encontrada', 404);

    const u = req.usuario;
    const esAdminOGerente = ['Administrador', 'Gerente'].includes(u.perfil);
    if (gestion.id_usuario !== u.id_usuario && !esAdminOGerente) {
      return fail(res, 'No puede editar gestiones de otros usuarios', 403);
    }

    const allowed = ['resultado', 'accion_siguiente', 'fecha_seguimiento', 'estado', 'descripcion'];
    const sets = [];
    const vals = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        sets.push(`${key} = ?`);
        vals.push(req.body[key]);
      }
    }
    if (!sets.length) return fail(res, 'Sin campos válidos para actualizar');

    vals.push(req.params.id);
    await pool.query(`UPDATE crm_gestiones SET ${sets.join(', ')} WHERE id_gestion = ?`, vals);

    const [[updated]] = await pool.query(
      'SELECT * FROM crm_gestiones WHERE id_gestion = ?', [req.params.id]
    );
    ok(res, updated);
  } catch (err) {
    fail(res, err.message, 500);
  }
};

// ─── historialCliente ─────────────────────────────────────────────────────────
exports.historialCliente = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM crm_gestiones WHERE rut_cliente = ? ORDER BY created_at DESC',
      [req.params.rut]
    );
    ok(res, rows);
  } catch (err) {
    fail(res, err.message, 500);
  }
};

// ─── stats ────────────────────────────────────────────────────────────────────
exports.stats = async (req, res) => {
  try {
    const { desde, hasta, id_usuario } = req.query;
    const hoy = hoyChile();

    const filtros = [];
    const fp = [];
    if (desde) { filtros.push('DATE(created_at) >= ?'); fp.push(desde); }
    if (hasta) { filtros.push('DATE(created_at) <= ?'); fp.push(hasta); }
    if (id_usuario) { filtros.push('id_usuario = ?'); fp.push(id_usuario); }
    const wh = filtros.length ? 'WHERE ' + filtros.join(' AND ') : '';

    // Resumen
    const [[total_row]] = await pool.query(`SELECT COUNT(*) AS total FROM crm_gestiones ${wh}`, fp);
    const [[hoy_row]] = await pool.query(
      `SELECT COUNT(*) AS hoy FROM crm_gestiones ${wh ? wh + ' AND' : 'WHERE'} DATE(created_at) = ?`,
      [...fp, hoy]
    );
    const [[pend_row]] = await pool.query(
      `SELECT COUNT(*) AS pendientes FROM crm_gestiones ${wh ? wh + ' AND' : 'WHERE'} estado = 'PENDIENTE'`,
      fp
    );
    const [[cerr_row]] = await pool.query(
      `SELECT COUNT(*) AS cerrados FROM crm_gestiones ${wh ? wh + ' AND' : 'WHERE'} estado = 'CERRADO'`,
      fp
    );
    const [[prosp_row]] = await pool.query(
      `SELECT COUNT(*) AS prospectos FROM crm_gestiones ${wh ? wh + ' AND' : 'WHERE'} tipo_cliente = 'PROSPECTO'`,
      fp
    );

    // Por canal
    const [por_canal] = await pool.query(
      `SELECT canal, COUNT(*) AS cantidad FROM crm_gestiones ${wh} GROUP BY canal ORDER BY cantidad DESC`, fp
    );

    // Por tipo_solicitud
    const [por_tipo_solicitud] = await pool.query(
      `SELECT tipo_solicitud, COUNT(*) AS cantidad FROM crm_gestiones ${wh} GROUP BY tipo_solicitud ORDER BY cantidad DESC LIMIT 15`, fp
    );

    // Por resultado
    const [por_resultado] = await pool.query(
      `SELECT resultado, COUNT(*) AS cantidad FROM crm_gestiones ${wh} GROUP BY resultado ORDER BY cantidad DESC`, fp
    );

    // Por usuario
    const [por_usuario] = await pool.query(
      `SELECT nombre_usuario,
        COUNT(*) AS cantidad,
        SUM(CASE WHEN estado='PENDIENTE' THEN 1 ELSE 0 END) AS pendientes,
        SUM(CASE WHEN estado='CERRADO' THEN 1 ELSE 0 END) AS cerrados
       FROM crm_gestiones ${wh} GROUP BY nombre_usuario ORDER BY cantidad DESC`, fp
    );

    // Por tipo_cliente
    const [por_tipo_cliente] = await pool.query(
      `SELECT tipo_cliente, COUNT(*) AS cantidad FROM crm_gestiones ${wh} GROUP BY tipo_cliente`, fp
    );

    // Tendencia 7 días
    const [tendencia_7dias] = await pool.query(
      `SELECT DATE(created_at) AS fecha, COUNT(*) AS cantidad
       FROM crm_gestiones
       WHERE DATE(created_at) >= DATE_SUB(?, INTERVAL 6 DAY)
       GROUP BY DATE(created_at) ORDER BY fecha ASC`,
      [hoy]
    );

    // Seguimientos hoy
    const [seguimientos_hoy] = await pool.query(
      `SELECT g.id_gestion, COALESCE(cl.nombre_completo, g.nombre_cliente) AS nombre_cliente,
              g.tipo_solicitud, g.nombre_usuario, g.telefono, g.estado
       FROM crm_gestiones g
       LEFT JOIN clientes cl ON cl.rut = g.rut_cliente
       WHERE g.fecha_seguimiento = ? AND g.estado != 'CERRADO'
       ORDER BY g.prioridad ASC`,
      [hoy]
    );

    ok(res, {
      resumen: {
        total: total_row.total,
        hoy: hoy_row.hoy,
        pendientes: pend_row.pendientes,
        cerrados: cerr_row.cerrados,
        prospectos: prosp_row.prospectos
      },
      por_canal,
      por_tipo_solicitud,
      por_resultado,
      por_usuario,
      por_tipo_cliente,
      tendencia_7dias,
      seguimientos_hoy
    });
  } catch (err) {
    fail(res, err.message, 500);
  }
};

// ─── listCampanas ─────────────────────────────────────────────────────────────
exports.listCampanas = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id_campana, nombre, descripcion, fecha_inicio, fecha_fin,
              dias_semana, horario_desde, horario_hasta,
              respuestas_json, usuarios_json, activa, created_at
       FROM crm_campanas ORDER BY created_at DESC`
    );
    ok(res, rows);
  } catch (err) {
    fail(res, err.message, 500);
  }
};

// ─── getCampana ───────────────────────────────────────────────────────────────
exports.getCampana = async (req, res) => {
  try {
    const [[row]] = await pool.query(
      'SELECT * FROM crm_campanas WHERE id_campana = ?', [req.params.id]
    );
    if (!row) return fail(res, 'Campaña no encontrada', 404);
    ok(res, row);
  } catch (err) {
    fail(res, err.message, 500);
  }
};

// ─── createCampana ────────────────────────────────────────────────────────────
exports.createCampana = async (req, res) => {
  try {
    const {
      nombre, descripcion = null,
      fecha_inicio = null, fecha_fin = null,
      dias_semana = null, horario_desde = null, horario_hasta = null,
      campos_mapeo = null, respuestas_json = null, usuarios_json = null,
    } = req.body;
    if (!nombre) return fail(res, 'nombre es requerido');

    const id_usuario = req.usuario?.id_usuario || null;
    const [r] = await pool.query(
      `INSERT INTO crm_campanas
         (nombre, descripcion, fecha_inicio, fecha_fin,
          dias_semana, horario_desde, horario_hasta,
          campos_mapeo, respuestas_json, usuarios_json, id_usuario)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        nombre, descripcion, fecha_inicio, fecha_fin,
        dias_semana, horario_desde, horario_hasta,
        JSON.stringify(campos_mapeo || []),
        JSON.stringify(respuestas_json || []),
        JSON.stringify(usuarios_json || []),
        id_usuario,
      ]
    );
    const [[campana]] = await pool.query(
      'SELECT * FROM crm_campanas WHERE id_campana = ?', [r.insertId]
    );
    ok(res, campana, 201);
  } catch (err) {
    fail(res, err.message, 500);
  }
};

// ─── updateCampana ────────────────────────────────────────────────────────────
exports.updateCampana = async (req, res) => {
  try {
    const {
      nombre, descripcion,
      fecha_inicio, fecha_fin,
      dias_semana, horario_desde, horario_hasta,
      campos_mapeo, respuestas_json, usuarios_json, activa,
    } = req.body;
    await pool.query(
      `UPDATE crm_campanas SET
         nombre=?, descripcion=?, fecha_inicio=?, fecha_fin=?,
         dias_semana=?, horario_desde=?, horario_hasta=?,
         campos_mapeo=?, respuestas_json=?, usuarios_json=?, activa=?
       WHERE id_campana=?`,
      [
        nombre, descripcion ?? null, fecha_inicio ?? null, fecha_fin ?? null,
        dias_semana ?? null, horario_desde ?? null, horario_hasta ?? null,
        JSON.stringify(campos_mapeo || []),
        JSON.stringify(respuestas_json || []),
        JSON.stringify(usuarios_json || []),
        activa ?? 1,
        req.params.id,
      ]
    );
    const [[campana]] = await pool.query(
      'SELECT * FROM crm_campanas WHERE id_campana = ?', [req.params.id]
    );
    ok(res, campana);
  } catch (err) {
    fail(res, err.message, 500);
  }
};

// ─── resultadosCampana ────────────────────────────────────────────────────────
exports.resultadosCampana = async (req, res) => {
  try {
    const { id } = req.params;
    const [[campana]] = await pool.query(
      'SELECT * FROM crm_campanas WHERE id_campana = ?', [id]
    );
    if (!campana) return fail(res, 'Campaña no encontrada', 404);

    // Gestiones de la campaña
    const [gestiones] = await pool.query(
      `SELECT g.id_gestion, g.rut_cliente, COALESCE(cl.nombre_completo, g.nombre_cliente) AS nombre_cliente,
              g.telefono, g.email,
              g.canal, g.tipo_solicitud, g.resultado, g.descripcion,
              g.accion_siguiente, g.fecha_seguimiento, g.estado,
              g.nombre_usuario, g.created_at, g.updated_at
       FROM crm_gestiones g
       LEFT JOIN clientes cl ON cl.rut = g.rut_cliente
       WHERE g.id_campana = ?
       ORDER BY g.created_at DESC`,
      [id]
    );

    // Resumen por resultado
    const resumenMap = {};
    gestiones.forEach(g => {
      const key = g.resultado || 'Sin resultado';
      if (!resumenMap[key]) resumenMap[key] = { resultado: key, total: 0, casos: [] };
      resumenMap[key].total++;
      resumenMap[key].casos.push(g);
    });
    const resumen = Object.values(resumenMap).sort((a, b) => b.total - a.total);

    ok(res, { campana, gestiones, resumen, total: gestiones.length });
  } catch (err) {
    fail(res, err.message, 500);
  }
};
