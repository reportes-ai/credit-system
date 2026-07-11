'use strict';
const pool = require('../../../../shared/config/database');

// ─── Migraciones ─────────────────────────────────────────────────────────────
require('../../../../shared/migrate').enFila('db-maintenance', async () => {
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS db_index_baseline (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        tabla_nombre   VARCHAR(128) NOT NULL,
        index_nombre   VARCHAR(128) NOT NULL,
        columnas       TEXT         NOT NULL,   -- JSON array de columnas en orden
        es_unico       TINYINT(1)   NOT NULL DEFAULT 0,
        es_pk          TINYINT(1)   NOT NULL DEFAULT 0,
        index_type     VARCHAR(32)  NOT NULL DEFAULT 'BTREE',
        ddl_restaurar  TEXT         DEFAULT NULL, -- CREATE INDEX listo para ejecutar
        capturado_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        capturado_por  VARCHAR(64)  DEFAULT NULL,
        UNIQUE KEY uq_tabla_idx (tabla_nombre, index_nombre)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS db_size_history (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        tabla_nombre VARCHAR(128) NOT NULL,
        filas        BIGINT       DEFAULT 0,
        datos_mb     DECIMAL(10,3) DEFAULT 0,
        indices_mb   DECIMAL(10,3) DEFAULT 0,
        total_mb     DECIMAL(10,3) DEFAULT 0,
        registrado_at DATE         NOT NULL DEFAULT (CURRENT_DATE),
        INDEX idx_tabla_fecha (tabla_nombre, registrado_at)
      )
    `);
  } catch (e) {
    console.error('[db-maintenance] migraciones:', e.message);
  }
});

// ─── Diagnóstico ────────────────────────────────────────────────────────────
exports.getDiagnostico = async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();

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
  } finally {
    if (conn) conn.release();
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

  let conn;
  try {
    conn = await pool.getConnection();

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
  } finally {
    if (conn) conn.release();
  }
};

// ─── Helper: leer índices actuales de information_schema ────────────────────
async function leerIndicesActuales(conn) {
  const [rows] = await conn.query(`
    SELECT
      TABLE_NAME     AS tabla,
      INDEX_NAME     AS nombre,
      SEQ_IN_INDEX   AS seq,
      COLUMN_NAME    AS columna,
      NON_UNIQUE     AS no_unico,
      INDEX_TYPE     AS tipo
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME NOT IN ('db_maintenance_log','db_index_baseline')
    ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
  `);
  const mapa = {};
  rows.forEach(r => {
    const key = r.tabla + '||' + r.nombre;
    if (!mapa[key]) {
      mapa[key] = {
        tabla:    r.tabla,
        nombre:   r.nombre,
        columnas: [],
        es_unico: r.no_unico === 0 ? 1 : 0,
        es_pk:    r.nombre === 'PRIMARY' ? 1 : 0,
        tipo:     r.tipo,
      };
    }
    mapa[key].columnas.push(r.columna);
  });
  return Object.values(mapa);
}

// ─── Capturar baseline de índices ────────────────────────────────────────────
exports.capturarBaseline = async (req, res) => {
  const usuario = req.user ? (req.user.email || req.user.nombre || String(req.user.id)) : 'sistema';
  let conn;
  try {
    conn = await pool.getConnection();
    const indices = await leerIndicesActuales(conn);
    await conn.query('DELETE FROM db_index_baseline');
    for (const idx of indices) {
      let ddl = null;
      if (!idx.es_pk) {
        const unico = idx.es_unico ? 'UNIQUE ' : '';
        const cols  = idx.columnas.map(c => `\`${c}\``).join(', ');
        ddl = `CREATE ${unico}INDEX \`${idx.nombre}\` ON \`${idx.tabla}\` (${cols})`;
      }
      await conn.query(
        `INSERT INTO db_index_baseline
           (tabla_nombre, index_nombre, columnas, es_unico, es_pk, index_type, ddl_restaurar, capturado_por)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [idx.tabla, idx.nombre, JSON.stringify(idx.columnas),
         idx.es_unico, idx.es_pk, idx.tipo, ddl, usuario]
      );
    }
    return res.json({
      success: true,
      data: { total_indices: indices.length, capturado_at: new Date().toISOString() },
      error: null,
    });
  } catch (err) {
    console.error('[db-maintenance] capturarBaseline:', err.message);
    return res.status(500).json({ success: false, data: null, error: err.message });
  } finally {
    if (conn) conn.release();
  }
};

// ─── Verificar índices vs baseline ───────────────────────────────────────────
exports.verificarIndices = async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const actuales = await leerIndicesActuales(conn);
    const actualMap = {};
    actuales.forEach(i => { actualMap[i.tabla + '||' + i.nombre] = i; });

    const [baseline] = await conn.query(
      'SELECT * FROM db_index_baseline ORDER BY tabla_nombre, index_nombre'
    );
    const [capInfo] = await conn.query(`
      SELECT capturado_at AS fecha, capturado_por
      FROM db_index_baseline
      ORDER BY capturado_at ASC
      LIMIT 1
    `);

    if (!baseline.length) {
      return res.json({
        success: true,
        data: { sin_baseline: true, faltantes: [], extras: [], ok: [], resumen: {} },
        error: null,
      });
    }

    const faltantes = [];
    const ok = [];
    baseline.forEach(b => {
      const key = b.tabla_nombre + '||' + b.index_nombre;
      if (actualMap[key]) {
        ok.push({ tabla: b.tabla_nombre, nombre: b.index_nombre, es_pk: b.es_pk,
                  columnas: JSON.parse(b.columnas || '[]') });
      } else {
        faltantes.push({
          tabla: b.tabla_nombre, nombre: b.index_nombre,
          columnas: JSON.parse(b.columnas || '[]'),
          es_unico: b.es_unico, es_pk: b.es_pk, tipo: b.index_type, ddl: b.ddl_restaurar,
        });
      }
    });
    const extras = actuales
      .filter(i => !baseline.find(b => b.tabla_nombre === i.tabla && b.index_nombre === i.nombre))
      .map(i => ({ tabla: i.tabla, nombre: i.nombre, columnas: i.columnas, es_pk: i.es_pk }));

    return res.json({
      success: true,
      data: {
        sin_baseline: false, faltantes, extras, ok,
        resumen: {
          total_baseline: baseline.length,
          ok: ok.length, faltantes: faltantes.length, extras: extras.length,
        },
        captura: capInfo[0] || null,
      },
      error: null,
    });
  } catch (err) {
    console.error('[db-maintenance] verificarIndices:', err.message);
    return res.status(500).json({ success: false, data: null, error: err.message });
  } finally {
    if (conn) conn.release();
  }
};

// ─── Restaurar índices faltantes ─────────────────────────────────────────────
exports.restaurarIndices = async (req, res) => {
  const { indices: param = [] } = req.body || {};
  const usuario = req.user ? (req.user.email || req.user.nombre || String(req.user.id)) : 'sistema';
  let conn;
  try {
    conn = await pool.getConnection();
    let query = 'SELECT * FROM db_index_baseline WHERE ddl_restaurar IS NOT NULL AND es_pk = 0';
    const args = [];
    if (param.length) {
      const pares = param.map(() => '(tabla_nombre = ? AND index_nombre = ?)').join(' OR ');
      query += ` AND (${pares})`;
      param.forEach(p => args.push(p.tabla, p.nombre));
    }
    const [targets] = await conn.query(query, args);
    const actuales  = await leerIndicesActuales(conn);
    const actualKeys = new Set(actuales.map(i => i.tabla + '||' + i.nombre));

    const resultados = [];
    for (const t of targets) {
      const key = t.tabla_nombre + '||' + t.index_nombre;
      if (actualKeys.has(key)) {
        resultados.push({ tabla: t.tabla_nombre, nombre: t.index_nombre, estado: 'ya_existe' });
        continue;
      }
      const t0 = Date.now();
      try {
        await conn.query(t.ddl_restaurar);
        const ms = Date.now() - t0;
        resultados.push({ tabla: t.tabla_nombre, nombre: t.index_nombre, estado: 'restaurado', ms });
        await conn.query(
          `INSERT INTO db_maintenance_log (tabla_nombre, operacion, estado, duracion_ms, ejecutado_por)
           VALUES (?, ?, ?, ?, ?)`,
          [t.tabla_nombre, 'restore_index:' + t.index_nombre, 'ok', ms, usuario]
        );
      } catch (err) {
        resultados.push({ tabla: t.tabla_nombre, nombre: t.index_nombre,
                          estado: 'error', mensaje: err.message });
      }
    }
    const restaurados = resultados.filter(r => r.estado === 'restaurado').length;
    const errores     = resultados.filter(r => r.estado === 'error').length;
    return res.json({
      success: true,
      data: { resultados, resumen: { restaurados, errores,
        ya_existian: resultados.length - restaurados - errores } },
      error: null,
    });
  } catch (err) {
    console.error('[db-maintenance] restaurarIndices:', err.message);
    return res.status(500).json({ success: false, data: null, error: err.message });
  } finally {
    if (conn) conn.release();
  }
};
