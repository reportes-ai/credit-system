const pool = require('../../../../shared/config/database');

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuario_config (
        id_usuario  INT          NOT NULL,
        clave       VARCHAR(100) NOT NULL,
        valor       TEXT         NOT NULL,
        updated_at  DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id_usuario, clave)
      )
    `);
  } catch (e) {
    console.error('[usuario_config migration]', e.message);
  }
})();

const getUiConfig = async (req, res) => {
  try {
    const { clave } = req.params;
    const { id_usuario } = req.usuario;
    const [rows] = await pool.query(
      'SELECT valor FROM usuario_config WHERE id_usuario = ? AND clave = ?',
      [id_usuario, clave]
    );
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
    const { id_usuario } = req.usuario;
    const { valor } = req.body;
    if (valor === undefined) return res.status(400).json({ success: false, data: null, error: 'Falta campo valor' });
    const valorStr = typeof valor === 'string' ? valor : JSON.stringify(valor);
    await pool.query(
      `INSERT INTO usuario_config (id_usuario, clave, valor)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE valor = VALUES(valor), updated_at = CURRENT_TIMESTAMP`,
      [id_usuario, clave, valorStr]
    );
    res.json({ success: true, data: null, error: null });
  } catch (e) {
    console.error('[putUiConfig]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

module.exports = { getUiConfig, putUiConfig };
