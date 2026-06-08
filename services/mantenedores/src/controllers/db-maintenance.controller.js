'use strict';
const pool = require('../../../../shared/config/database');

// ─── Migración: crear tabla de log si no existe ──────────────────────────────
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS db_maintenance_log (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        tabla_nombre VARCHAR(128) NOT NULL,
        operacion    VARCHAR(32)  NOT NULL DEFAULT 'analyze',
        estado       VARCHAR(16)  NOT NULL DEFAULT 'ok',
        duracion_ms  INT          DEFAULT 0,
        filas_aprox  BIGINT       DEFAULT 0,
        ejecutado_por VARCHAR(64) DEFAULT NULL,
        ejecutado_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_tabla (tabla_nombre),
        INDEX idx_fecha (ejecutado_at)
      )
    `);
  } catch (e) {
    console.error('[db-maintenance] migración log:', e.message);
  }
})();

// ─── Diagnóstico ────────────────────────────────────────────────────────────
exports.getDiagnostico = async (req, res) => {
  try {
    const conn = await pool.getConnection();

    // 1. Información de tablas desde information_schema
    const [tablas] = await conn.query(`
      SELECT
        TABLE_NAME        AS nombre,
        TABLE_ROWS        AS filas_aprox,
        DATA_LENGTH       AS bytes_datos,
        INDEX_LENGTH      AS bytes_indices,
        DATA_FREE         AS bytes_libres,
        UPDATE_TIME       AS ultima_modificacion
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_TYPE = 'BASE TABLE'
        AND TABLE_NAME != 'db_maintenance_log'
      ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC
    `);

    // 2. Último ANALYZE exitoso por tabla desde nuestro propio log
    const [logs] = await conn.query(`
      SELECT tabla_nombre, MAX(ejecutado_at) AS ultimo_analyze,
             SUM(CASE WHEN estado = 'ok' THEN 1 ELSE 0 END) AS veces_ok,
             COUNT(*) AS veces_total
      FROM db_maintenance_log
      WHERE estado = 'ok'
      GROUP BY tabla_nombre
    `);
    const logMap = {};
    logs.forEach(l => { logMap[l.tabla_nombre] = l; });

    // 3. Calcular diagnóstico por tabla
    const UMBRAL_DIAS_ANALYZE = 30; // advertir si no se analiza en 30 días
    const ahora = new Date();

    const diagnostico = tablas.map(t => {
      const totalBytes = (t.bytes_datos || 0) + (t.bytes_indices || 0);
      const libresBytes = t.bytes_libres || 0;
      const fragPct = totalBytes > 0 ? (libresBytes / totalBytes) * 100 : 0;
      const logEntry = logMap[t.nombre] || null;

      let nivel = 'ok';
      const motivos = [];

      // Fragmentación
      if (fragPct > 30) {
        nivel = 'warning';
        motivos.push(`Fragmentación ${fragPct.toFixed(1)}% (>30%)`);
      }

      // Antigüedad del último ANALYZE
      if (!logEntry) {
        if (t.filas_aprox > 500) {
          nivel = nivel === 'ok' ? 'warning' : nivel;
          motivos.push('Sin mantenimiento previo');
        }
      } else {
        const diasDesde = (ahora - new Date(logEntry.ultimo_analyze)) / 86400000;
        if (diasDesde > UMBRAL_DIAS_ANALYZE) {
          nivel = nivel === 'ok' ? 'warning' : nivel;
          motivos.push(`Último ANALYZE hace ${Math.floor(diasDesde)} días`);
        }
      }

      return {
        nombre: t.nombre,
        filas: t.filas_aprox || 0,
        tamano_mb: (totalBytes / 1048576).toFixed(2),
        indice_mb: ((t.bytes_indices || 0) / 1048576).toFixed(2),
        frag_pct: fragPct.toFixed(1),
        ultima_mod: t.ultima_modificacion,
        ultimo_analyze: logEntry ? logEntry.ultimo_analyze : null,
        veces_analizada: logEntry ? logEntry.veces_ok : 0,
        tiene_stats: !!logEntry,
        nivel,
        motivos,
      };
    });

    // 4. Resumen global
    const total = diagnostico.length;
    const criticas    = diagnostico.filter(t => t.nivel === 'critical').length;
    const advertencias = diagnostico.filter(t => t.nivel === 'warning').length;
    const ok          = diagnostico.filter(t => t.nivel === 'ok').length;

    conn.release();

    return res.json({
      success: true,
      data: {
        tablas: diagnostico,
        resumen: { total, criticas, advertencias, ok },
        timestamp: new Date().toISOString(),
      },
      error: null,
    });
  } catch (err) {
    console.error('[db-maintenance] getDiagnostico:', err.message);
    return res.status(500).json({ success: false, data: null, error: err.message });
  }
};

// ─── Historial de mantenciones ──────────────────────────────────────────────
exports.getHistorial = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const [rows] = await pool.query(`
      SELECT id, tabla_nombre, operacion, estado, duracion_ms,
             filas_aprox, ejecutado_por, ejecutado_at
      FROM db_maintenance_log
      ORDER BY ejecutado_at DESC
      LIMIT ?
    `, [limit]);

    // Agrupar por sesión: registros con ejecutado_at dentro del mismo minuto
    // de la misma ejecución (para mostrar "sesiones")
    const sesiones = [];
    let sesionActual = null;
    rows.forEach(r => {
      const key = r.ejecutado_por + '_' + r.ejecutado_at.toString().substring(0, 16);
      if (!sesionActual || sesionActual.key !== key) {
        sesionActual = {
          key,
          fecha: r.ejecutado_at,
          ejecutado_por: r.ejecutado_por || 'sistema',
          tablas: [],
          exitosas: 0,
          fallidas: 0,
          duracion_total_ms: 0,
        };
        sesiones.push(sesionActual);
      }
      sesionActual.tablas.push(r);
      if (r.estado === 'ok') sesionActual.exitosas++;
      else sesionActual.fallidas++;
      sesionActual.duracion_total_ms += r.duracion_ms || 0;
    });

    return res.json({ success: true, data: { rows, sesiones }, error: null });
  } catch (err) {
    return res.status(500).json({ success: false, data: null, error: err.message });
  }
};

// ─── Ejecutar mantenimiento ──────────────────────────────────────────────────
exports.ejecutarMantenimiento = async (req, res) => {
  const { tablas: tablasParam = [], modo = 'analyze' } = req.body || {};
  const usuario = req.user ? (req.user.email || req.user.nombre || String(req.user.id)) : 'sistema';

  try {
    const conn = await pool.getConnection();

    // Obtener lista de tablas a procesar
    let tablasTarget = tablasParam;
    if (!tablasTarget.length) {
      const [rows] = await conn.query(`
        SELECT TABLE_NAME FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_TYPE = 'BASE TABLE'
          AND TABLE_NAME != 'db_maintenance_log'
      `);
      tablasTarget = rows.map(r => r.TABLE_NAME);
    }

    // Obtener filas actuales por tabla para el log
    const [infoTablas] = await conn.query(`
      SELECT TABLE_NAME, TABLE_ROWS
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
    `);
    const filasMap = {};
    infoTablas.forEach(r => { filasMap[r.TABLE_NAME] = r.TABLE_ROWS || 0; });

    const resultados = [];
    const inicio = Date.now();

    for (const tabla of tablasTarget) {
      const t0 = Date.now();
      let estado = 'ok';
      let errMsg = null;
      try {
        await conn.query(`ANALYZE TABLE \`${tabla}\``);
      } catch (err) {
        estado = 'error';
        errMsg = err.message;
      }
      const ms = Date.now() - t0;

      // Registrar en nuestro log
      try {
        await conn.query(
          `INSERT INTO db_maintenance_log
             (tabla_nombre, operacion, estado, duracion_ms, filas_aprox, ejecutado_por)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [tabla, modo, estado, ms, filasMap[tabla] || 0, usuario]
        );
      } catch (_) { /* log no crítico */ }

      resultados.push({ tabla, operacion: modo, estado, mensaje: errMsg, ms });
    }

    conn.release();

    const exitosas = resultados.filter(r => r.estado === 'ok').length;
    const fallidas  = resultados.filter(r => r.estado === 'error').length;

    return res.json({
      success: true,
      data: {
        resultados,
        resumen: {
          total: tablasTarget.length,
          exitosas,
          fallidas,
          duracion_ms: Date.now() - inicio,
        },
        timestamp: new Date().toISOString(),
      },
      error: null,
    });
  } catch (err) {
    console.error('[db-maintenance] ejecutarMantenimiento:', err.message);
    return res.status(500).json({ success: false, data: null, error: err.message });
  }
};
