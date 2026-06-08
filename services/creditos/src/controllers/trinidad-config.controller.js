'use strict';
const pool = require('../../../../shared/config/database');

/* ── Migraciones ─────────────────────────────────────────────────── */
(async () => {
  const sqls = [
    `CREATE TABLE IF NOT EXISTS trinidad_estados (
       id               INT AUTO_INCREMENT PRIMARY KEY,
       estado_trinidad  VARCHAR(100) NOT NULL,
       estado_autofacil VARCHAR(100) NOT NULL,
       created_at       DATETIME DEFAULT NOW(),
       updated_at       DATETIME DEFAULT NOW(),
       UNIQUE KEY uq_est_tri (estado_trinidad)
     )`,
    `CREATE TABLE IF NOT EXISTS trinidad_ejecutivos (
       id                  INT AUTO_INCREMENT PRIMARY KEY,
       nombre_trinidad     VARCHAR(200) NOT NULL,
       nombre_autofacil    VARCHAR(200) NOT NULL,
       created_at          DATETIME DEFAULT NOW(),
       updated_at          DATETIME DEFAULT NOW(),
       UNIQUE KEY uq_ej_tri (nombre_trinidad)
     )`,
  ];
  for (const sql of sqls) {
    try { await pool.query(sql); } catch (e) { console.error('[trinidad-config migration]', e.message); }
  }

  // Seed inicial de estados si la tabla está vacía
  const [cnt] = await pool.query('SELECT COUNT(*) AS n FROM trinidad_estados');
  if (cnt[0].n === 0) {
    const defaults = [
      ['Aprobada',     'Digitado'],
      ['Condicionado', 'Digitado'],
      ['Cotización',   'Digitado'],
      ['Cursado',      'Otorgado'],
      ['Otorgada',     'Digitado'],
      ['Rechazado',    'Digitado'],
      ['Solicitud',    'Digitado'],
    ];
    for (const [tri, af] of defaults) {
      try {
        await pool.query(
          'INSERT IGNORE INTO trinidad_estados (estado_trinidad, estado_autofacil) VALUES (?,?)',
          [tri, af]
        );
      } catch (e) { /* ignorar duplicado */ }
    }
    console.log('[trinidad-config] seed estados insertado');
  }
})();

/* ══════════════════ ESTADOS ══════════════════ */

exports.getEstados = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM trinidad_estados ORDER BY estado_trinidad');
    return res.json({ success: true, data: rows });
  } catch (e) {
    return res.json({ success: false, error: e.message });
  }
};

exports.createEstado = async (req, res) => {
  const { estado_trinidad, estado_autofacil } = req.body;
  if (!estado_trinidad?.trim() || !estado_autofacil?.trim())
    return res.json({ success: false, error: 'estado_trinidad y estado_autofacil son requeridos' });
  try {
    const [r] = await pool.query(
      'INSERT INTO trinidad_estados (estado_trinidad, estado_autofacil) VALUES (?,?)',
      [estado_trinidad.trim(), estado_autofacil.trim()]
    );
    return res.json({ success: true, data: { id: r.insertId } });
  } catch (e) {
    if (e.errno === 1062) return res.json({ success: false, error: 'Ya existe ese estado Trinidad' });
    return res.json({ success: false, error: e.message });
  }
};

exports.updateEstado = async (req, res) => {
  const { id } = req.params;
  const { estado_trinidad, estado_autofacil } = req.body;
  if (!estado_trinidad?.trim() || !estado_autofacil?.trim())
    return res.json({ success: false, error: 'Campos requeridos' });
  try {
    await pool.query(
      'UPDATE trinidad_estados SET estado_trinidad=?, estado_autofacil=?, updated_at=NOW() WHERE id=?',
      [estado_trinidad.trim(), estado_autofacil.trim(), id]
    );
    return res.json({ success: true });
  } catch (e) {
    if (e.errno === 1062) return res.json({ success: false, error: 'Ya existe ese estado Trinidad' });
    return res.json({ success: false, error: e.message });
  }
};

exports.deleteEstado = async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM trinidad_estados WHERE id=?', [id]);
    return res.json({ success: true });
  } catch (e) {
    return res.json({ success: false, error: e.message });
  }
};

/* ══════════════════ EJECUTIVOS ══════════════════ */

// Devuelve lista de ejecutivos distintos de la tabla creditos (para el dropdown)
exports.getEjecutivosAF = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT ejecutivo FROM creditos
       WHERE ejecutivo IS NOT NULL AND ejecutivo <> ''
       ORDER BY ejecutivo`
    );
    return res.json({ success: true, data: rows.map(r => r.ejecutivo) });
  } catch (e) {
    return res.json({ success: false, error: e.message });
  }
};

exports.getEjecutivos = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM trinidad_ejecutivos ORDER BY nombre_trinidad');
    return res.json({ success: true, data: rows });
  } catch (e) {
    return res.json({ success: false, error: e.message });
  }
};

exports.createEjecutivo = async (req, res) => {
  const { nombre_trinidad, nombre_autofacil } = req.body;
  if (!nombre_trinidad?.trim() || !nombre_autofacil?.trim())
    return res.json({ success: false, error: 'nombre_trinidad y nombre_autofacil son requeridos' });
  try {
    const [r] = await pool.query(
      'INSERT INTO trinidad_ejecutivos (nombre_trinidad, nombre_autofacil) VALUES (?,?)',
      [nombre_trinidad.trim(), nombre_autofacil.trim()]
    );
    return res.json({ success: true, data: { id: r.insertId } });
  } catch (e) {
    if (e.errno === 1062) return res.json({ success: false, error: 'Ya existe ese ejecutivo Trinidad' });
    return res.json({ success: false, error: e.message });
  }
};

exports.updateEjecutivo = async (req, res) => {
  const { id } = req.params;
  const { nombre_trinidad, nombre_autofacil } = req.body;
  if (!nombre_trinidad?.trim() || !nombre_autofacil?.trim())
    return res.json({ success: false, error: 'Campos requeridos' });
  try {
    await pool.query(
      'UPDATE trinidad_ejecutivos SET nombre_trinidad=?, nombre_autofacil=?, updated_at=NOW() WHERE id=?',
      [nombre_trinidad.trim(), nombre_autofacil.trim(), id]
    );
    return res.json({ success: true });
  } catch (e) {
    if (e.errno === 1062) return res.json({ success: false, error: 'Ya existe ese ejecutivo Trinidad' });
    return res.json({ success: false, error: e.message });
  }
};

exports.deleteEjecutivo = async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM trinidad_ejecutivos WHERE id=?', [id]);
    return res.json({ success: true });
  } catch (e) {
    return res.json({ success: false, error: e.message });
  }
};
