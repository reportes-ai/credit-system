const pool = require('../../../../shared/config/database');

const ensureTable = () => pool.query(`CREATE TABLE IF NOT EXISTS config_sistema (
  clave   VARCHAR(100) PRIMARY KEY,
  valor   TEXT
)`);

ensureTable().catch(e => console.error('config_sistema init:', e.message));

const getConfig = async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT valor FROM config_sistema WHERE clave=?', [req.params.clave]);
    res.json({ success: true, data: row ? JSON.parse(row.valor) : null, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

const setConfig = async (req, res) => {
  try {
    const { valor } = req.body;
    await pool.query(
      'INSERT INTO config_sistema (clave, valor) VALUES (?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)',
      [req.params.clave, JSON.stringify(valor)]
    );
    res.json({ success: true, data: { mensaje: 'Guardado' }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

module.exports = { getConfig, setConfig };
