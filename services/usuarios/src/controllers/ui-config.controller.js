const pool = require('../../../../shared/config/database');

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS config_ui (
        clave      VARCHAR(100) PRIMARY KEY,
        valor      TEXT         NOT NULL,
        updated_at DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
  } catch (e) {
    console.error('[config_ui migration]', e.message);
  }
})();

const getUiConfig = async (req, res) => {
  try {
    const { clave } = req.params;
    const [rows] = await pool.query('SELECT valor FROM config_ui WHERE clave = ?', [clave]);
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
    const { clave } = req.params;
    const { valor } = req.body;
    if (valor === undefined) return res.status(400).json({ success: false, data: null, error: 'Falta campo valor' });
    const valorStr = typeof valor === 'string' ? valor : JSON.stringify(valor);
    await pool.query(
      `INSERT INTO config_ui (clave, valor) VALUES (?, ?)
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
