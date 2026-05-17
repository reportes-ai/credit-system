const pool = require('../../../../shared/config/database');

const ensureTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS parametros_credito (
      clave VARCHAR(50) PRIMARY KEY,
      valor DECIMAL(15,4) NOT NULL DEFAULT 0,
      descripcion VARCHAR(200),
      fecha_actualizacion DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  // Insert defaults if table is empty
  const defaults = [
    ['costo_fondo',            1.7800, 'Costo de fondo mensual (%)'],
    ['prenda',                 103610, 'Gasto de prenda ($)'],
    ['retiro_gestion',         0,      'Retiro gestión auto ($)'],
    ['limitacion_dominio',     5630,   'Limitación de dominio ($)'],
    ['gastos_admin',           0,      'Gastos de administración ($)'],
    ['inscripcion',            36030,  'Inscripción / transferencia ($)'],
    ['gps_24meses',            262255, 'GPS 24 meses ($)'],
    ['reparaciones_menores',   464796, 'Reparaciones menores ($)'],
    ['pct_ejecutivo',          2.72,   'Comisión ejecutivo (% del saldo precio)'],
  ];
  for (const [clave, valor, descripcion] of defaults) {
    await pool.query(
      'INSERT IGNORE INTO parametros_credito (clave, valor, descripcion) VALUES (?, ?, ?)',
      [clave, valor, descripcion]
    );
  }
};
ensureTable().catch(console.error);

const getAll = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT clave, valor, descripcion FROM parametros_credito ORDER BY clave');
    // Return as flat object {clave: valor} and also as array for the UI
    const obj = {};
    rows.forEach(r => { obj[r.clave] = parseFloat(r.valor); });
    res.json({ success: true, data: { lista: rows, obj }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

const updateAll = async (req, res) => {
  try {
    const params = req.body; // { clave: valor, ... }
    for (const [clave, valor] of Object.entries(params)) {
      await pool.query(
        'UPDATE parametros_credito SET valor = ? WHERE clave = ?',
        [parseFloat(valor), clave]
      );
    }
    res.json({ success: true, data: { mensaje: 'Parámetros actualizados' }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { getAll, updateAll };
