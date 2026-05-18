const pool = require('../../../../shared/config/database');
const bcrypt = require('bcryptjs');

/* ─── Migración: agregar columna telefono si no existe ─────────── */
(async () => {
  try {
    await pool.query(`ALTER TABLE usuarios ADD COLUMN telefono VARCHAR(20) NULL DEFAULT NULL`);
  } catch (e) { if (e.errno !== 1060) console.error('[usuarios migration telefono]', e.message); }
})();

const PERFILES_GLOBALES = ['Administrador', 'Gerente'];

const buildFiltroUsuario = (usuario) => {
  const { id_usuario, perfil_nombre } = usuario;
  if (PERFILES_GLOBALES.includes(perfil_nombre)) return { where: '', params: [] };
  if (perfil_nombre === 'Supervisor') {
    return { where: 'WHERE u.id_supervisor = ? OR u.id_usuario = ?', params: [id_usuario, id_usuario] };
  }
  return { where: 'WHERE u.id_usuario = ?', params: [id_usuario] };
};

const getAllUsuarios = async (req, res) => {
  try {
    const { where, params } = buildFiltroUsuario(req.usuario);
    const [usuarios] = await pool.query(
      `SELECT u.id_usuario, u.rut, u.nombre, u.apellido, u.email, u.telefono,
              u.id_perfil, p.nombre AS perfil, u.id_supervisor,
              CONCAT(s.nombre, ' ', s.apellido) AS supervisor_nombre,
              u.estado, u.ultimo_acceso, u.fecha_creacion
       FROM usuarios u
       JOIN perfiles p ON u.id_perfil = p.id_perfil
       LEFT JOIN usuarios s ON u.id_supervisor = s.id_usuario
       ${where}
       ORDER BY u.nombre, u.apellido`,
      params
    );
    res.json({ success: true, data: usuarios, error: null });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: error.message });
  }
};

const getUsuarioById = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id_usuario, u.rut, u.nombre, u.apellido, u.email, u.telefono,
              u.id_perfil, p.nombre AS perfil, u.id_supervisor,
              CONCAT(s.nombre, ' ', s.apellido) AS supervisor_nombre,
              u.estado, u.ultimo_acceso, u.fecha_creacion
       FROM usuarios u
       JOIN perfiles p ON u.id_perfil = p.id_perfil
       LEFT JOIN usuarios s ON u.id_supervisor = s.id_usuario
       WHERE u.id_usuario = ?`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, data: null, error: 'Usuario no encontrado' });
    }
    res.json({ success: true, data: rows[0], error: null });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: error.message });
  }
};

const createUsuario = async (req, res) => {
  try {
    const { rut, nombre, apellido, email, password, id_perfil, id_supervisor, telefono } = req.body;

    if (!rut || !nombre || !apellido || !email || !password || !id_perfil) {
      return res.status(400).json({ success: false, data: null, error: 'RUT, nombre, apellido, email, contraseña y perfil son requeridos' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, data: null, error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      'INSERT INTO usuarios (rut, nombre, apellido, email, password_hash, id_perfil, id_supervisor, telefono) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [rut, nombre, apellido, email, passwordHash, id_perfil, id_supervisor || null, telefono || null]
    );

    res.status(201).json({
      success: true,
      data: { id_usuario: result.insertId, rut, nombre, apellido, email, id_perfil, estado: 'activo' },
      error: null
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, data: null, error: 'El RUT o email ya están registrados' });
    }
    res.status(500).json({ success: false, data: null, error: error.message });
  }
};

const updateUsuario = async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, apellido, email, id_perfil, id_supervisor, estado, telefono } = req.body;

    if (!nombre || !apellido || !email || !id_perfil) {
      return res.status(400).json({ success: false, data: null, error: 'Nombre, apellido, email y perfil son requeridos' });
    }

    await pool.query(
      'UPDATE usuarios SET nombre = ?, apellido = ?, email = ?, id_perfil = ?, id_supervisor = ?, estado = ?, telefono = ? WHERE id_usuario = ?',
      [nombre, apellido, email, id_perfil, id_supervisor || null, estado || 'activo', telefono || null, id]
    );

    res.json({ success: true, data: { id_usuario: id, nombre, apellido, email, id_perfil, estado }, error: null });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: error.message });
  }
};

const deleteUsuario = async (req, res) => {
  try {
    const { id } = req.params;
    if (parseInt(id) === req.usuario.id_usuario) {
      return res.status(400).json({ success: false, data: null, error: 'No puedes eliminar tu propio usuario' });
    }
    await pool.query('UPDATE usuarios SET estado = ? WHERE id_usuario = ?', ['inactivo', id]);
    res.json({ success: true, data: { mensaje: 'Usuario desactivado correctamente' }, error: null });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: error.message });
  }
};

const resetClave = async (req, res) => {
  try {
    const { id } = req.params;
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#';
    let nuevaClave = '';
    for (let i = 0; i < 10; i++) nuevaClave += chars[Math.floor(Math.random() * chars.length)];

    const hash = await bcrypt.hash(nuevaClave, 10);
    await pool.query('UPDATE usuarios SET password_hash = ? WHERE id_usuario = ?', [hash, id]);

    res.json({ success: true, data: { nueva_clave: nuevaClave, mensaje: 'Contraseña reseteada. Comparte esta clave con el usuario.' }, error: null });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: error.message });
  }
};

module.exports = { getAllUsuarios, getUsuarioById, createUsuario, updateUsuario, deleteUsuario, resetClave };
