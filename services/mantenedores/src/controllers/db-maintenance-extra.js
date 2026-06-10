'use strict';
// Módulos adicionales: slow queries, crecimiento, integridad, conexiones
const pool = require('../../../../shared/config/database');

// ─── 2. Consultas lentas ──────────────────────────────────────────────────────
exports.getSlowQueries = async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    let rows = [];
    try {
      const [r] = await conn.query(`
        SELECT Query_time AS duracion_seg, DB AS base_datos,
               Query AS consulta, Start_time AS inicio,
               Succ AS exitosa, User AS usuario
        FROM information_schema.SLOW_QUERY
        WHERE DB = DATABASE()
        ORDER BY Query_time DESC LIMIT 20
      `);
      rows = r;
    } catch (_) {
      try {
        const [r2] = await conn.query(`
          SELECT TIME AS duracion_seg, DB AS base_datos,
                 INFO AS consulta, STATE AS estado, USER AS usuario
          FROM information_schema.PROCESSLIST
          WHERE DB = DATABASE() AND TIME > 1 AND COMMAND != 'Sleep'
          ORDER BY TIME DESC LIMIT 20
        `);
        rows = r2;
      } catch (_2) { rows = []; }
    }
    return res.json({ success: true, data: { rows, total: rows.length }, error: null });
  } catch (err) {
    console.error('[db-maintenance] getSlowQueries:', err.message);
    return res.status(500).json({ success: false, data: null, error: err.message });
  } finally {
    if (conn) conn.release();
  }
};

// ─── 3. Control de crecimiento ────────────────────────────────────────────────
exports.getCrecimiento = async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [actuales] = await conn.query(`
      SELECT TABLE_NAME AS tabla,
             IFNULL(TABLE_ROWS,0) AS filas,
             ROUND(DATA_LENGTH/1048576,3) AS datos_mb,
             ROUND(INDEX_LENGTH/1048576,3) AS indices_mb,
             ROUND((DATA_LENGTH+INDEX_LENGTH)/1048576,3) AS total_mb
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
        AND TABLE_NAME NOT IN ('db_maintenance_log','db_index_baseline','db_size_history')
      ORDER BY (DATA_LENGTH+INDEX_LENGTH) DESC
    `);

    const hoy = new Date().toISOString().slice(0, 10);
    for (const t of actuales) {
      try {
        await conn.query(
          `DELETE FROM db_size_history WHERE tabla_nombre = ? AND registrado_at = ?`,
          [t.tabla, hoy]
        );
        await conn.query(
          `INSERT INTO db_size_history (tabla_nombre,filas,datos_mb,indices_mb,total_mb,registrado_at)
           VALUES (?,?,?,?,?,?)`,
          [t.tabla, t.filas, t.datos_mb, t.indices_mb, t.total_mb, hoy]
        );
      } catch (_) {}
    }

    const topTablas = actuales.slice(0, 10).map(t => t.tabla);
    let historico = [];
    if (topTablas.length) {
      const ph = topTablas.map(() => '?').join(',');
      const [hist] = await conn.query(
        `SELECT tabla_nombre, registrado_at, filas, total_mb
         FROM db_size_history
         WHERE tabla_nombre IN (${ph})
           AND registrado_at >= DATE_SUB(CURRENT_DATE, INTERVAL 60 DAY)
         ORDER BY tabla_nombre, registrado_at ASC`,
        topTablas
      );
      historico = hist;
    }

    const resumenCrecimiento = actuales.slice(0, 15).map(t => {
      const h = historico.filter(x => x.tabla_nombre === t.tabla);
      let crecimiento_filas = null, crecimiento_mb = null;
      if (h.length >= 2) {
        const dias = Math.max(1,
          (new Date(h[h.length-1].registrado_at) - new Date(h[0].registrado_at)) / 86400000);
        crecimiento_filas = Math.round(((h[h.length-1].filas - h[0].filas) / dias) * 7);
        crecimiento_mb = (((h[h.length-1].total_mb - h[0].total_mb) / dias) * 7).toFixed(3);
      }
      return { ...t, crecimiento_filas, crecimiento_mb, dias_historial: h.length };
    });

    return res.json({
      success: true,
      data: { actuales: resumenCrecimiento, historico, snapshot_date: hoy },
      error: null,
    });
  } catch (err) {
    console.error('[db-maintenance] getCrecimiento:', err.message);
    return res.status(500).json({ success: false, data: null, error: err.message });
  } finally {
    if (conn) conn.release();
  }
};

// ─── 4. Integridad referencial ────────────────────────────────────────────────
exports.getIntegridad = async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const checks = [];

    const check = async (nombre, tabla, descripcion, sql) => {
      try {
        const [rows] = await conn.query(sql);
        const total = rows[0] ? Number(rows[0].total || 0) : 0;
        checks.push({
          nombre, tabla, descripcion, total,
          estado: total === 0 ? 'ok' : total < 10 ? 'warning' : 'critical',
        });
      } catch (e) {
        checks.push({ nombre, tabla, descripcion, total: null, estado: 'error', error: e.message });
      }
    };

    await check('creditos_sin_cliente', 'creditos',
      'Operaciones cuyo RUT cliente no existe en la tabla clientes',
      `SELECT COUNT(*) AS total FROM creditos c
       LEFT JOIN clientes cl ON c.rut_cliente = cl.rut
       WHERE c.rut_cliente IS NOT NULL AND cl.rut IS NULL`);

    await check('antecedentes_sin_cliente', 'antecedentes_laborales',
      'Antecedentes laborales cuyo RUT no existe en clientes',
      `SELECT COUNT(*) AS total FROM antecedentes_laborales a
       LEFT JOIN clientes c ON a.rut_cliente = c.rut
       WHERE c.rut IS NULL`);

    await check('info_comercial_sin_cliente', 'informacion_comercial',
      'Información comercial cuyo RUT no existe en clientes',
      `SELECT COUNT(*) AS total FROM informacion_comercial ic
       LEFT JOIN clientes c ON ic.rut_cliente = c.rut
       WHERE c.rut IS NULL`);

    await check('cuentas_sin_credito', 'cuentas_transitorias',
      'Cuentas transitorias con id_credito que no existe',
      `SELECT COUNT(*) AS total FROM cuentas_transitorias ct
       LEFT JOIN creditos cr ON ct.id_credito = cr.id
       WHERE ct.id_credito IS NOT NULL AND cr.id IS NULL`);

    await check('comisiones_sin_usuario', 'comisiones_variables',
      'Parámetros de comisión cuyo ejecutivo no existe en usuarios',
      `SELECT COUNT(*) AS total FROM comisiones_variables cv
       LEFT JOIN usuarios u ON cv.id_usuario = u.id
       WHERE cv.id_usuario IS NOT NULL AND u.id IS NULL`);

    await check('creditos_sin_uf', 'creditos',
      'Créditos aprobados/cursados cuya fecha_otorgado no tiene UF registrada',
      `SELECT COUNT(*) AS total FROM creditos c
       LEFT JOIN uf u ON DATE(c.fecha_otorgado) = u.fecha
       WHERE c.estado IN ('aprobado','cursado','vigente')
         AND c.fecha_otorgado IS NOT NULL AND u.fecha IS NULL`);

    const criticos = checks.filter(c => c.estado === 'critical').length;
    const warnings  = checks.filter(c => c.estado === 'warning').length;
    const ok        = checks.filter(c => c.estado === 'ok').length;
    const total_problemas = checks.reduce((s, c) => s + (c.total || 0), 0);

    return res.json({
      success: true,
      data: { checks, resumen: { total_problemas, criticos, warnings, ok } },
      error: null,
    });
  } catch (err) {
    console.error('[db-maintenance] getIntegridad:', err.message);
    return res.status(500).json({ success: false, data: null, error: err.message });
  } finally {
    if (conn) conn.release();
  }
};

// ─── 7. Conexiones activas ────────────────────────────────────────────────────
exports.getConexiones = async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [procesos] = await conn.query(`
      SELECT ID AS id, USER AS usuario, HOST AS host, DB AS base_datos,
             COMMAND AS comando, TIME AS tiempo_seg,
             STATE AS estado, LEFT(IFNULL(INFO,''),120) AS consulta_activa
      FROM information_schema.PROCESSLIST
      ORDER BY TIME DESC LIMIT 50
    `);

    let vars = {}, status = {};
    try {
      const [v] = await conn.query(
        `SHOW VARIABLES WHERE Variable_name IN
         ('max_connections','wait_timeout','interactive_timeout','max_execution_time')`
      );
      v.forEach(r => { vars[r.Variable_name] = r.Value; });
    } catch (_) {}
    try {
      const [s] = await conn.query(
        `SHOW STATUS WHERE Variable_name IN
         ('Threads_connected','Threads_running','Connections','Max_used_connections','Aborted_connects')`
      );
      s.forEach(r => { status[r.Variable_name] = r.Value; });
    } catch (_) {}

    const dormidas = procesos.filter(p => p.comando === 'Sleep').length;
    const activas  = procesos.filter(p => p.comando !== 'Sleep').length;
    const lentas   = procesos.filter(p => Number(p.tiempo_seg) > 5).length;

    return res.json({
      success: true,
      data: {
        procesos,
        resumen: {
          total: procesos.length, activas, dormidas, lentas,
          max_connections:   vars.max_connections   || null,
          threads_connected: status.Threads_connected || null,
          threads_running:   status.Threads_running   || null,
        },
        vars, status,
      },
      error: null,
    });
  } catch (err) {
    console.error('[db-maintenance] getConexiones:', err.message);
    return res.status(500).json({ success: false, data: null, error: err.message });
  } finally {
    if (conn) conn.release();
  }
};
