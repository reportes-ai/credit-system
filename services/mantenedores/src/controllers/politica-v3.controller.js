'use strict';
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const SEED = require('../politica-v3-seed.json');

/* ─────────────────────────────────────────────────────────────────────────
   Política de Crédito Automotriz V3.0 — cuadros paramétricos y fijos.
   Complemento operativo de la V2.0 (PC-02): scorecard 1000 pts en 4 bloques,
   reglas excluyentes (K1–K11), PD por segmento, quintiles, matriz de decisión,
   condiciones base, origen de marcas, reglas migratorias y parámetros generales.
   Cada tabla se siembra desde politica-v3-seed.json (extraído del Excel oficial).
   tipo: 'parametrico' (editable por el Administrador) | 'fijo' (referencia).
   ───────────────────────────────────────────────────────────────────────── */

require('../../../../shared/migrate').enFila('politica-v3', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS politica_v3_tablas (
        clave      VARCHAR(60) PRIMARY KEY,
        titulo     VARCHAR(200),
        tipo       VARCHAR(20),          -- parametrico | fijo
        seccion    VARCHAR(120),
        orden      INT DEFAULT 0,
        columnas   JSON,
        filas      JSON,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
    // Seed idempotente: no pisa lo que el Administrador haya editado (INSERT IGNORE).
    for (const t of SEED) {
      await pool.query(
        `INSERT IGNORE INTO politica_v3_tablas (clave, titulo, tipo, seccion, orden, columnas, filas)
         VALUES (?,?,?,?,?,?,?)`,
        [t.clave, t.titulo, t.tipo, t.seccion, t.orden,
         JSON.stringify(t.columnas || []), JSON.stringify(t.filas || [])]);
    }
    console.log(`[politica-v3] ${SEED.length} cuadros listos`);
  } catch (e) { console.error('[politica-v3 migration]', e.message); }
});

const parse = v => { if (v == null) return v; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return v; } };

/* GET /api/politica-v3/tablas — todos los cuadros (paramétricos y fijos) */
const getTablas = async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM politica_v3_tablas ORDER BY orden, clave');
    const data = rows.map(r => ({
      clave: r.clave, titulo: r.titulo, tipo: r.tipo, seccion: r.seccion, orden: r.orden,
      columnas: parse(r.columnas) || [], filas: parse(r.filas) || [], updated_at: r.updated_at,
    }));
    res.json({ success: true, data, error: null });
  } catch (e) {
    console.error('[politica-v3 getTablas]', e);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* PUT /api/politica-v3/tablas/:clave — actualiza las filas (solo paramétricas) */
const updateTabla = async (req, res) => {
  try {
    const { clave } = req.params;
    const filas = req.body?.filas;
    if (!Array.isArray(filas)) return res.status(400).json({ success: false, data: null, error: 'filas requerido (array)' });
    const [[t]] = await pool.query('SELECT tipo FROM politica_v3_tablas WHERE clave=?', [clave]);
    if (!t) return res.status(404).json({ success: false, data: null, error: 'Cuadro no encontrado' });
    if (t.tipo !== 'parametrico') return res.status(400).json({ success: false, data: null, error: 'Este cuadro es fijo (referencia), no editable' });
    await pool.query('UPDATE politica_v3_tablas SET filas=? WHERE clave=?', [JSON.stringify(filas), clave]);
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'politica_v3', entidad_id: clave,
      detalle: `Actualizó el cuadro V3.0 "${clave}" (${filas.length} fila/s)`, meta: { clave } });
    res.json({ success: true, data: { clave }, error: null });
  } catch (e) {
    console.error('[politica-v3 updateTabla]', e);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

module.exports = { getTablas, updateTabla };
