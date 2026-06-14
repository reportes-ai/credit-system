const pool = require('../../../../shared/config/database');

/* ── Migración: tabla de impuestos paramétricos + seed + registro en el menú ── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS impuestos (
        codigo          VARCHAR(40)  PRIMARY KEY,
        nombre          VARCHAR(120) NOT NULL,
        porcentaje      DECIMAL(7,4) NOT NULL,
        descripcion     VARCHAR(300) DEFAULT NULL,
        actualizado_por VARCHAR(150) DEFAULT NULL,
        updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
    // Valores por defecto (solo si no existen)
    await pool.query(`INSERT IGNORE INTO impuestos (codigo, nombre, porcentaje, descripcion) VALUES
      ('IVA', 'IVA', 19.0000, 'Impuesto al Valor Agregado — facturas afectas (neto = bruto / (1 + IVA)).'),
      ('RETENCION_HONORARIOS', 'Retención de Honorarios', 15.2500, 'Retención sobre boletas de honorarios; se descuenta del monto a depositar.')`);
    // Registrar el mantenedor en el menú (funcionalidad) si no existe
    const [[ex]] = await pool.query("SELECT 1 ok FROM funcionalidades WHERE codigo='mantenedores_impuestos' LIMIT 1");
    if (!ex) await pool.query(
      `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
       VALUES (30001, 'Impuestos', 'mantenedores_impuestos', '/mantenedores/impuestos/', 'bi-percent')`);
  } catch (e) { console.error('[impuestos migration]', e.message); }
})();

/* Helper para leer un impuesto (% como número, ej. IVA → 19). Usar en cálculos del backend. */
async function getImpuestoPct(codigo) {
  try { const [[r]] = await pool.query('SELECT porcentaje FROM impuestos WHERE codigo = ?', [codigo]); return r ? Number(r.porcentaje) : null; }
  catch (e) { return null; }
}

const getAll = async (req, res) => {
  try { const [rows] = await pool.query('SELECT * FROM impuestos ORDER BY codigo'); res.json({ success: true, data: rows, error: null }); }
  catch (e) { console.error('[impuestos getAll]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* GET /api/impuestos/valores → { IVA: 19, RETENCION_HONORARIOS: 15.25 } para cálculos del frontend */
const getValores = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT codigo, porcentaje FROM impuestos');
    const map = {}; rows.forEach(r => map[r.codigo] = Number(r.porcentaje));
    res.json({ success: true, data: map, error: null });
  } catch (e) { console.error('[impuestos valores]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const update = async (req, res) => {
  try {
    const codigo = req.params.codigo;
    const pct = Number(req.body.porcentaje);
    if (req.body.porcentaje == null || isNaN(pct) || pct < 0 || pct > 100)
      return res.status(400).json({ success: false, data: null, error: 'Porcentaje inválido (0–100)' });
    const usuario = (req.usuario?.nombre ? (req.usuario.nombre + ' ' + (req.usuario.apellido || '')).trim() : req.usuario?.email) || 'Usuario';
    const [r] = await pool.query('UPDATE impuestos SET porcentaje = ?, actualizado_por = ? WHERE codigo = ?', [pct, usuario, codigo]);
    if (!r.affectedRows) return res.status(404).json({ success: false, data: null, error: 'Impuesto no encontrado' });
    res.json({ success: true, data: { codigo, porcentaje: pct }, error: null });
  } catch (e) { console.error('[impuestos update]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { getAll, getValores, update, getImpuestoPct };
