/* Vendedores por Dealer — base única de vendedores de cada concesionario.
   La consume el Generador de Cartas (selector de vendedor por dealer) y la
   mantiene la card "Vendedores por Dealer". Si el vendedor no está, el
   ejecutivo lo agrega desde la misma carta (nombre + RUT + mail). */
const pool = require('../../../../shared/config/database');
const RUT  = require('../../../../api-gateway/public/js/rut-core');

require('../../../../shared/migrate').enFila('vendedores-dealer', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS vendedores_dealer (
    id INT AUTO_INCREMENT PRIMARY KEY,
    rut_dealer VARCHAR(15) NOT NULL,
    nombre VARCHAR(120) NOT NULL,
    rut VARCHAR(12) NULL,
    mail VARCHAR(150) NULL,
    origen VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
    activo TINYINT NOT NULL DEFAULT 1,
    creado_por VARCHAR(100) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_dealer_rut (rut_dealer, rut),
    KEY idx_dealer (rut_dealer)
  )`);
});

const normRut = r => RUT.normalizar(r);   // canónico BODY-DV (motor único rut-core)

// GET /api/vendedores-dealer?rut_dealer=XX  (sin rut_dealer → todos, para el mantenedor)
exports.listar = async (req, res) => {
  try {
    const { rut_dealer, incluir_inactivos } = req.query;
    const where = [], params = [];
    if (rut_dealer) { where.push('v.rut_dealer = ?'); params.push(normRut(rut_dealer) || rut_dealer); }
    if (!incluir_inactivos) where.push('v.activo = 1');
    const [rows] = await pool.query(
      `SELECT v.*, COALESCE(d.nombre_indexa, d.nombre_razon) AS dealer_nombre, d.ccs_parque
         FROM vendedores_dealer v
         LEFT JOIN dealers d ON d.rut = v.rut_dealer
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY v.nombre LIMIT 2000`, params);
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    console.error('[vendedores-dealer listar]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error al listar vendedores' });
  }
};

// POST /api/vendedores-dealer  { rut_dealer, nombre, rut, mail }
exports.crear = async (req, res) => {
  try {
    let { rut_dealer, nombre, rut, mail } = req.body || {};
    rut_dealer = normRut(rut_dealer);
    nombre = String(nombre || '').trim().toUpperCase();
    rut = normRut(rut);
    mail = String(mail || '').trim().toLowerCase() || null;
    if (!rut_dealer) return res.status(400).json({ success: false, data: null, error: 'Falta el RUT del dealer' });
    if (!nombre) return res.status(400).json({ success: false, data: null, error: 'Falta el nombre del vendedor' });
    if (!rut || !RUT.validar(rut)) return res.status(400).json({ success: false, data: null, error: 'RUT del vendedor inválido' });
    if (mail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return res.status(400).json({ success: false, data: null, error: 'Correo inválido' });
    // si existía inactivo para el mismo dealer, se reactiva y actualiza
    const [r] = await pool.query(
      `INSERT INTO vendedores_dealer (rut_dealer, nombre, rut, mail, origen, creado_por)
       VALUES (?,?,?,?,'MANUAL',?)
       ON DUPLICATE KEY UPDATE nombre=VALUES(nombre), mail=COALESCE(VALUES(mail), mail), activo=1, updated_at=NOW()`,
      [rut_dealer, nombre, rut, mail, req.user?.nombre || req.user?.email || null]);
    res.json({ success: true, data: { id: r.insertId || null, rut_dealer, nombre, rut, mail }, error: null });
  } catch (e) {
    console.error('[vendedores-dealer crear]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error al guardar el vendedor' });
  }
};

// PUT /api/vendedores-dealer/:id  { nombre, rut, mail, rut_dealer, activo }
exports.editar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, data: null, error: 'ID inválido' });
    const b = req.body || {};
    const sets = [], params = [];
    if (b.nombre !== undefined) { sets.push('nombre=?'); params.push(String(b.nombre).trim().toUpperCase()); }
    if (b.rut !== undefined) {
      const r = normRut(b.rut);
      if (!r || !RUT.validar(r)) return res.status(400).json({ success: false, data: null, error: 'RUT inválido' });
      sets.push('rut=?'); params.push(r);
    }
    if (b.mail !== undefined) { sets.push('mail=?'); params.push(String(b.mail).trim().toLowerCase() || null); }
    if (b.rut_dealer !== undefined) { sets.push('rut_dealer=?'); params.push(normRut(b.rut_dealer)); }
    if (b.activo !== undefined) { sets.push('activo=?'); params.push(b.activo ? 1 : 0); }
    if (!sets.length) return res.status(400).json({ success: false, data: null, error: 'Nada que actualizar' });
    params.push(id);
    await pool.query(`UPDATE vendedores_dealer SET ${sets.join(', ')} WHERE id=?`, params);
    res.json({ success: true, data: { id }, error: null });
  } catch (e) {
    console.error('[vendedores-dealer editar]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error al actualizar el vendedor' });
  }
};
