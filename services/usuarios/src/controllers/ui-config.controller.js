const pool = require('../../../../shared/config/database');

/* Reutiliza config_seguridad (ya existe en producción) con prefijo "ui_" */

const getUiConfig = async (req, res) => {
  try {
    const clave = 'ui_' + req.params.clave;
    const [rows] = await pool.query('SELECT valor FROM config_seguridad WHERE clave = ?', [clave]);
    if (!rows.length) return res.json({ success: true, data: null, error: null });
    let data;
    try { data = JSON.parse(rows[0].valor); } catch { data = rows[0].valor; }
    res.json({ success: true, data, error: null });
  } catch (e) {
    console.error('[getUiConfig]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

const putUiConfig = async (req, res) => {
  try {
    const clave = 'ui_' + req.params.clave;
    const { valor } = req.body;
    if (valor === undefined) return res.status(400).json({ success: false, data: null, error: 'Falta campo valor' });
    const valorStr = typeof valor === 'string' ? valor : JSON.stringify(valor);
    await pool.query(
      `INSERT INTO config_seguridad (clave, valor) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE valor = VALUES(valor), updated_at = CURRENT_TIMESTAMP`,
      [clave, valorStr]
    );
    res.json({ success: true, data: null, error: null });
  } catch (e) {
    console.error('[putUiConfig]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

module.exports = { getUiConfig, putUiConfig };
