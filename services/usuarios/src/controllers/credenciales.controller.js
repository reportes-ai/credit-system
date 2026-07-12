'use strict';
/* ───────────────────────────────────────────────────────────────────────────
 * CREDENCIALES CORPORATIVAS — generador interno de tarjetas imprimibles:
 * anverso (logo, foto, nombre, cargo, RUT, expiración) y reverso con QR vCard
 * ("escanea y guarda mi contacto": nombre, cargo, empresa, teléfono, email).
 * Los datos maestros salen de `usuarios` (una sola fuente); acá solo se guarda
 * lo propio de la credencial: foto y fecha de expiración.
 * ─────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');

require('../../../../shared/migrate').enFila('credenciales', async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS credenciales_usuario (
      id_usuario INT PRIMARY KEY,
      foto LONGTEXT NULL,                 -- dataURL (jpeg/png) de la foto carnet
      expira DATE NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS credenciales_empresa (
      id TINYINT PRIMARY KEY,
      organizacion VARCHAR(120) NULL,
      direccion VARCHAR(200) NULL,
      web VARCHAR(200) NULL,
      telefono VARCHAR(30) NULL,
      email VARCHAR(120) NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
    await pool.query(`INSERT IGNORE INTO credenciales_empresa (id, organizacion, web) VALUES (1, 'AutoFácil Crédito Automotriz', 'https://www.autofacilchile.cl')`);
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='credenciales' LIMIT 1");
    if (!ex) {
      await pool.query("INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (1,'Credenciales Corporativas','credenciales','/credenciales/','bi-person-badge')");
      const [[nf]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='credenciales' LIMIT 1");
      await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
                        SELECT id_perfil, ?, 1 FROM perfiles WHERE nombre='Administrador'`, [nf.id_funcionalidad]);
    }
  } catch (e) { console.error('[credenciales migration]', e.message); }
});

const errSrv = (res, e, tag) => { console.error(`[${tag}]`, e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); };

/* ── GET /api/credenciales — usuarios activos con sus datos de credencial ── */
exports.listar = async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.id_usuario, u.nombre, u.apellido, u.apellido_materno, u.rut, u.cargo, u.telefono, u.email,
             c.expira, (c.foto IS NOT NULL) tiene_foto
      FROM usuarios u LEFT JOIN credenciales_usuario c ON c.id_usuario = u.id_usuario
      WHERE u.estado='activo'
      ORDER BY u.nombre, u.apellido`);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { errSrv(res, e, 'credenciales listar'); }
};

/* ── Datos comunes de la empresa (van al vCard del QR, no impresos en la tarjeta) ── */
exports.empresaGet = async (_req, res) => {
  try {
    const [[e]] = await pool.query('SELECT organizacion, direccion, web, telefono, email FROM credenciales_empresa WHERE id=1');
    res.json({ success: true, data: e || {}, error: null });
  } catch (e) { errSrv(res, e, 'credenciales empresaGet'); }
};
exports.empresaPut = async (req, res) => {
  try {
    const b = req.body || {};
    const v = c => String(b[c] ?? '').trim().slice(0, 200) || null;
    await pool.query(`INSERT INTO credenciales_empresa (id, organizacion, direccion, web, telefono, email) VALUES (1,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE organizacion=VALUES(organizacion), direccion=VALUES(direccion), web=VALUES(web), telefono=VALUES(telefono), email=VALUES(email)`,
      [v('organizacion'), v('direccion'), v('web'), v('telefono'), v('email')]);
    res.json({ success: true, data: null, error: null });
  } catch (e) { errSrv(res, e, 'credenciales empresaPut'); }
};

/* ── GET /api/credenciales/:id — con foto (para el render) ───────────────── */
exports.una = async (req, res) => {
  try {
    const id = parseInt(req.params.id) || 0;
    const [[u]] = await pool.query(`
      SELECT u.id_usuario, u.nombre, u.apellido, u.apellido_materno, u.rut, u.cargo, u.telefono, u.email,
             c.expira, c.foto
      FROM usuarios u LEFT JOIN credenciales_usuario c ON c.id_usuario = u.id_usuario
      WHERE u.id_usuario=?`, [id]);
    if (!u) return res.status(404).json({ success: false, data: null, error: 'Usuario no encontrado' });
    res.json({ success: true, data: u, error: null });
  } catch (e) { errSrv(res, e, 'credenciales una'); }
};

/* ── PUT /api/credenciales/:id — guardar foto/expiración (y cargo en usuarios) ── */
exports.guardar = async (req, res) => {
  try {
    const id = parseInt(req.params.id) || 0;
    const b = req.body || {};
    if (b.foto !== undefined && b.foto && !/^data:image\/(png|jpe?g|webp);base64,/.test(String(b.foto)))
      return res.status(400).json({ success: false, data: null, error: 'Foto inválida (debe ser imagen)' });
    if (String(b.foto || '').length > 2_000_000)
      return res.status(400).json({ success: false, data: null, error: 'Foto muy pesada (máx ~1,5 MB)' });
    const expira = /^\d{4}-\d{2}-\d{2}$/.test(String(b.expira)) ? b.expira : null;
    await pool.query(`
      INSERT INTO credenciales_usuario (id_usuario, foto, expira) VALUES (?,?,?)
      ON DUPLICATE KEY UPDATE foto=COALESCE(VALUES(foto), foto), expira=COALESCE(VALUES(expira), expira)`,
      [id, b.foto || null, expira]);
    if (b.cargo !== undefined) await pool.query('UPDATE usuarios SET cargo=? WHERE id_usuario=?', [String(b.cargo || '').slice(0, 100) || null, id]);
    res.json({ success: true, data: null, error: null });
  } catch (e) { errSrv(res, e, 'credenciales guardar'); }
};
