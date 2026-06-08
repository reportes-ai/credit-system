'use strict';
const pool = require('../../../../shared/config/database');

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
        CREATE_TIME       AS fecha_creacion,
        UPDATE_TIME       AS ultima_modificacion,
        TABLE_COMMENT     AS comentario
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC
    `);

    // 2. Estadísticas del optimizador (último ANALYZE)
    let statsMap = {};
    try {
      const [stats] = await conn.query(`
        SELECT table_name, modify_count, count AS filas_stats,
               version AS version_stats
        FROM mysql.stats_meta
        WHERE db_name = DATABASE()
      `);
      stats.forEach(s => { statsMap[s.table_name] = s; });
    } catch (_) {
      // mysql.stats_meta puede no estar disponible en todos los tiers de TiDB
    }

    // 3. Variables globales relevantes
    const [vars] = await conn.query(`
      SHOW VARIABLES WHERE Variable_name IN (
        'innodb_stats_auto_recalc',
        'tidb_analyze_version',
        'version',
        'version_comment'
      )
    `);
    const varMap = {};
    vars.forEach(v => { varMap[v.Variable_name] = v.Value; });

    // 4. Calcular diagnóstico por tabla
    const diagnostico = tablas.map(t => {
      const totalBytes = (t.bytes_datos || 0) + (t.bytes_indices || 0);
      const libresBytes = t.bytes_libres || 0;
      const fragPct = totalBytes > 0 ? (libresBytes / totalBytes) * 100 : 0;
      const stats = statsMap[t.nombre] || null;

      // Nivel de alerta
      let nivel = 'ok';
      const motivos = [];

      if (fragPct > 30) {
        nivel = 'warning';
        motivos.push(`Fragmentación ${fragPct.toFixed(1)}% (>30%)`);
      }
      if (stats && stats.modify_count > 0) {
        const ratio = stats.filas_stats > 0
          ? (stats.modify_count / stats.filas_stats) * 100 : 100;
        if (ratio > 20) {
          nivel = 'warning';
          motivos.push(`${ratio.toFixed(0)}% de filas modificadas sin ANALYZE`);
        }
        if (ratio > 50) {
          nivel = 'critical';
        }
      }
      if (!stats && t.filas_aprox > 1000) {
        nivel = nivel === 'ok' ? 'warning' : nivel;
        motivos.push('Sin estadísticas recientes');
      }

      return {
        nombre: t.nombre,
        filas: t.filas_aprox || 0,
        tamano_mb: (totalBytes / 1048576).toFixed(2),
        indice_mb: ((t.bytes_indices || 0) / 1048576).toFixed(2),
        frag_pct: fragPct.toFixed(1),
        ultima_mod: t.ultima_modificacion,
        modify_count: stats ? stats.modify_count : null,
        tiene_stats: !!stats,
        nivel,
        motivos,
      };
    });

    // 5. Resumen global
    const total = diagnostico.length;
    const criticas = diagnostico.filter(t => t.nivel === 'critical').length;
    const advertencias = diagnostico.filter(t => t.nivel === 'warning').length;
    const ok = diagnostico.filter(t => t.nivel === 'ok').length;

    conn.release();

    return res.json({
      success: true,
      data: {
        tablas: diagnostico,
        resumen: { total, criticas, advertencias, ok },
        variables: varMap,
        timestamp: new Date().toISOString(),
      },
      error: null,
    });
  } catch (err) {
    console.error('[db-maintenance] getDiagnostico:', err.message);
    return res.status(500).json({ success: false, data: null, error: err.message });
  }
};

// ─── Ejecutar mantenimiento ──────────────────────────────────────────────────
exports.ejecutarMantenimiento = async (req, res) => {
  // tablas: array de nombres, o vacío = todas
  const { tablas: tablasParam = [], modo = 'analyze' } = req.body || {};

  try {
    const conn = await pool.getConnection();

    // Obtener lista de tablas a procesar
    let tablasTarget = tablasParam;
    if (!tablasTarget.length) {
      const [rows] = await conn.query(`
        SELECT TABLE_NAME FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
      `);
      tablasTarget = rows.map(r => r.TABLE_NAME);
    }

    const resultados = [];
    const inicio = Date.now();

    for (const tabla of tablasTarget) {
      const t0 = Date.now();
      try {
        if (modo === 'analyze' || modo === 'full') {
          await conn.query(`ANALYZE TABLE \`${tabla}\``);
        }
        resultados.push({
          tabla,
          operacion: modo,
          estado: 'ok',
          ms: Date.now() - t0,
        });
      } catch (err) {
        resultados.push({
          tabla,
          operacion: modo,
          estado: 'error',
          mensaje: err.message,
          ms: Date.now() - t0,
        });
      }
    }

    conn.release();

    const exitosas = resultados.filter(r => r.estado === 'ok').length;
    const fallidas = resultados.filter(r => r.estado === 'error').length;

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
