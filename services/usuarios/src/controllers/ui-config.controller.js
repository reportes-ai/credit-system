const pool = require('../../../../shared/config/database');

/* Reutiliza config_seguridad (ya existe en producción) con prefijo "ui_" */

const getUiConfig = async (req, res) => {
  try {
    const clave = 'ui_' + req.params.clave;
    console.log('[getUiConfig] clave:', clave, '| usuario:', req.usuario?.id_usuario);
    const [rows] = await pool.query('SELECT valor FROM config_seguridad WHERE clave = ?', [clave]);
    console.log('[getUiConfig] rows encontradas:', rows.length);
    if (!rows.length) return res.json({ success: true, data: null, error: null });
    let data;
    try { data = JSON.parse(rows[0].valor); } catch { data = rows[0].valor; }
    console.log('[getUiConfig] data retornada:', Array.isArray(data) ? `array[${data.length}]` : typeof data);
    res.json({ success: true, data, error: null });
  } catch (e) {
    console.error('[getUiConfig ERROR]', e.message);
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

const putUiConfig = async (req, res) => {
  try {
    const clave = 'ui_' + req.params.clave;
    const { valor } = req.body;
    console.log('[putUiConfig] clave:', clave, '| usuario:', req.usuario?.id_usuario, '| perfil:', req.usuario?.perfil_nombre, '| valor tipo:', typeof valor, '| length:', Array.isArray(valor) ? valor.length : '?');
    if (valor === undefined) return res.status(400).json({ success: false, data: null, error: 'Falta campo valor' });
    const valorStr = typeof valor === 'string' ? valor : JSON.stringify(valor);
    await pool.query(
      `INSERT INTO config_seguridad (clave, valor) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE valor = VALUES(valor), updated_at = CURRENT_TIMESTAMP`,
      [clave, valorStr]
    );
    console.log('[putUiConfig] guardado OK:', clave);
    res.json({ success: true, data: null, error: null });
  } catch (e) {
    console.error('[putUiConfig ERROR]', e.message);
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { getUiConfig, putUiConfig };
