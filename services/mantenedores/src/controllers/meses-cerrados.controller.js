'use strict';
const pool = require('../../../../shared/config/database');

/* ── Migración ─────────────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS meses_cerrados (
        mes         VARCHAR(7) PRIMARY KEY COMMENT 'YYYY-MM',
        cerrado     TINYINT(1) NOT NULL DEFAULT 0,
        cerrado_at  DATETIME,
        cerrado_por INT,
        notas       VARCHAR(255)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS config_meses (
        clave   VARCHAR(60) PRIMARY KEY,
        valor   VARCHAR(255) NOT NULL,
        label   VARCHAR(120)
      )
    `);
    await pool.query(`
      INSERT IGNORE INTO config_meses (clave, valor, label)
      VALUES ('dias_cierre', '35', 'Días tras fin de mes para cierre automático')
    `);
  } catch (e) {
    console.error('[meses-cerrados migration]', e.message);
  }
})();

/* ── Helpers ─────────────────────────────────────────────────────────── */
function generarMeses(n = 18) {
  const meses = [];
  const hoy = new Date();
  for (let i = 1; i <= n; i++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
    const mes = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    meses.push(mes);
  }
  return meses;
}

/* ── GET /api/meses-cerrados ─────────────────────────────────────────── */
const getAll = async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM meses_cerrados');
    const [cfg]  = await pool.query('SELECT valor FROM config_meses WHERE clave = ?', ['dias_cierre']);
    const diasCierre = cfg.length ? parseInt(cfg[0].valor) : 35;

    const cerradosMap = {};
    rows.forEach(r => { cerradosMap[r.mes] = r; });

    const meses = generarMeses(24).map(mes => {
      const [anio, m] = mes.split('-').map(Number);
      const ultimoDia = new Date(anio, m, 0); // último día del mes
      const diasTranscurridos = Math.floor((Date.now() - ultimoDia.getTime()) / 86400000);
      const row = cerradosMap[mes] || {};
      return {
        mes,
        cerrado:    row.cerrado    ? true : false,
        cerrado_at: row.cerrado_at || null,
        dias_transcurridos: diasTranscurridos,
        sugerido_cerrar: diasTranscurridos >= diasCierre && !row.cerrado,
      };
    });

    res.json({ success: true, data: { meses, dias_cierre: diasCierre }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── PUT /api/meses-cerrados/:mes ────────────────────────────────────── */
const toggle = async (req, res) => {
  try {
    const { mes } = req.params;
    if (!/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ success: false, data: null, error: 'Formato mes inválido (YYYY-MM)' });
    const { cerrado } = req.body;
    const cerradoPor = req.usuario?.id_usuario || null;

    await pool.query(`
      INSERT INTO meses_cerrados (mes, cerrado, cerrado_at, cerrado_por)
      VALUES (?, ?, IF(?, NOW(), NULL), ?)
      ON DUPLICATE KEY UPDATE
        cerrado = VALUES(cerrado),
        cerrado_at = IF(VALUES(cerrado)=1, NOW(), NULL),
        cerrado_por = VALUES(cerrado_por)
    `, [mes, cerrado ? 1 : 0, cerrado ? 1 : 0, cerradoPor]);

    res.json({ success: true, data: { mes, cerrado }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── PUT /api/meses-cerrados/config/dias-cierre ─────────────────────── */
const setDiasCierre = async (req, res) => {
  try {
    const { dias } = req.body;
    const v = parseInt(dias);
    if (!v || v < 1 || v > 365) return res.status(400).json({ success: false, data: null, error: 'Valor inválido (1-365)' });
    await pool.query('UPDATE config_meses SET valor = ? WHERE clave = ?', [String(v), 'dias_cierre']);
    res.json({ success: true, data: { dias_cierre: v }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── GET /api/meses-cerrados/check/:mes  (uso interno: ¿está cerrado?) */
const checkMes = async (req, res) => {
  try {
    const { mes } = req.params;
    const [rows] = await pool.query('SELECT cerrado FROM meses_cerrados WHERE mes = ? LIMIT 1', [mes]);
    const cerrado = rows.length ? !!rows[0].cerrado : false;
    res.json({ success: true, data: { mes, cerrado }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { getAll, toggle, setDiasCierre, checkMes };
