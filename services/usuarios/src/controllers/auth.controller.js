const pool = require('../../../../shared/config/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { JWT_SECRET, JWT_EXPIRES } = require('../../../../shared/middleware/auth');

const errMsg = (e) => e.message || e.code || String(e);

const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, data: null, error: 'Email y contraseña son requeridos' });
    }

    const [rows] = await pool.query(
      `SELECT u.*, p.nombre AS perfil_nombre
       FROM usuarios u
       JOIN perfiles p ON u.id_perfil = p.id_perfil
       WHERE u.email = ? AND u.estado = 'activo'`,
      [email]
    );

    if (rows.length === 0) {
      return res.status(401).json({ success: false, data: null, error: 'Credenciales inválidas' });
    }

    const usuario = rows[0];
    const valid = await bcrypt.compare(password, usuario.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, data: null, error: 'Credenciales inválidas' });
    }

    await pool.query('UPDATE usuarios SET ultimo_acceso = NOW() WHERE id_usuario = ?', [usuario.id_usuario]);

    const payload = {
      id_usuario: usuario.id_usuario,
      nombre: usuario.nombre,
      apellido: usuario.apellido,
      email: usuario.email,
      id_perfil: usuario.id_perfil,
      perfil_nombre: usuario.perfil_nombre,
      id_supervisor: usuario.id_supervisor
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });

    res.json({
      success: true,
      data: {
        token,
        usuario: {
          id_usuario: usuario.id_usuario,
          nombre: usuario.nombre,
          apellido: usuario.apellido,
          email: usuario.email,
          perfil: usuario.perfil_nombre
        }
      },
      error: null
    });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: errMsg(error) });
  }
};

const cambiarClave = async (req, res) => {
  try {
    const { password_actual, password_nuevo } = req.body;
    const { id_usuario } = req.usuario;

    if (!password_actual || !password_nuevo) {
      return res.status(400).json({ success: false, data: null, error: 'Contraseña actual y nueva son requeridas' });
    }
    if (password_nuevo.length < 6) {
      return res.status(400).json({ success: false, data: null, error: 'La nueva contraseña debe tener al menos 6 caracteres' });
    }

    const [rows] = await pool.query('SELECT password_hash FROM usuarios WHERE id_usuario = ?', [id_usuario]);
    const valid = await bcrypt.compare(password_actual, rows[0].password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, data: null, error: 'Contraseña actual incorrecta' });
    }

    const hash = await bcrypt.hash(password_nuevo, 10);
    await pool.query('UPDATE usuarios SET password_hash = ? WHERE id_usuario = ?', [hash, id_usuario]);

    res.json({ success: true, data: { mensaje: 'Contraseña actualizada correctamente' }, error: null });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: errMsg(error) });
  }
};

const misPermisos = async (req, res) => {
  try {
    const { id_perfil } = req.usuario;

    const [modulos] = await pool.query(
      `SELECT DISTINCT m.id_modulo, m.nombre, m.descripcion, m.icono, m.ruta, m.orden
       FROM modulos m
       JOIN funcionalidades f ON f.id_modulo = m.id_modulo
       JOIN permisos_perfil pp ON pp.id_funcionalidad = f.id_funcionalidad
       WHERE pp.id_perfil = ? AND pp.habilitado = 1 AND m.estado = 'activo'
       ORDER BY m.orden`,
      [id_perfil]
    );

    res.json({ success: true, data: modulos, error: null });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: errMsg(error) });
  }
};

module.exports = { login, cambiarClave, misPermisos };
