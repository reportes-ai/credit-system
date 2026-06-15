const pool = require('../../../../shared/config/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { JWT_SECRET, JWT_EXPIRES } = require('../../../../shared/middleware/auth');
const { auditar } = require('../../../../shared/audit');

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
    // Registrar sesión para el informe de desempeño (no bloqueante)
    try { require('../../../desempeno/src/controllers/desempeno.controller').registrarLogin(usuario); } catch (e) {}
    auditar({ req, usuario, accion: 'LOGIN', modulo: 'auth', entidad: 'usuario', entidad_id: usuario.id_usuario, detalle: 'Ingreso al sistema' });

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
    // Permisos siempre frescos: nunca cachear (un cambio de permisos aplica al recargar)
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    const { id_usuario } = req.usuario;
    // Perfil SIEMPRE desde BD, no del token: si el admin cambia el perfil
    // (o se fusionan perfiles duplicados), aplica sin esperar re-login
    let id_perfil = req.usuario.id_perfil;
    try {
      const [[u]] = await pool.query('SELECT id_perfil FROM usuarios WHERE id_usuario = ?', [id_usuario]);
      if (u) id_perfil = u.id_perfil;
    } catch (_) { /* usa el del token como fallback */ }

    // Módulos accesibles (para el menú principal — compatible con versión anterior)
    // Nota: 'usuarios_contrasena' no otorga la card del módulo Usuarios —
    // cambiar la propia clave está disponible en el menú del usuario (topnav)
    const [modulos] = await pool.query(
      `SELECT DISTINCT m.id_modulo, m.nombre, m.descripcion, m.icono, m.ruta, m.orden
       FROM modulos m
       JOIN funcionalidades f ON f.id_modulo = m.id_modulo
       JOIN permisos_perfil pp ON pp.id_funcionalidad = f.id_funcionalidad
       WHERE pp.id_perfil = ? AND pp.habilitado = 1 AND m.estado = 'activo'
         AND f.codigo <> 'usuarios_contrasena'
       ORDER BY m.orden`,
      [id_perfil]
    );

    // Funcionalidades habilitadas con detalle (perfil base)
    const [perfilFuncs] = await pool.query(
      `SELECT f.codigo, f.nombre, f.href, f.icono, pp.habilitado
       FROM permisos_perfil pp
       JOIN funcionalidades f ON f.id_funcionalidad = pp.id_funcionalidad
       WHERE pp.id_perfil = ?`,
      [id_perfil]
    );
    const permisosMapa = {};
    perfilFuncs.forEach(p => {
      permisosMapa[p.codigo] = { habilitado: p.habilitado === 1, nombre: p.nombre, href: p.href, icono: p.icono };
    });

    // Aplicar overrides individuales del usuario (permisos_usuario)
    try {
      const [userFuncs] = await pool.query(
        `SELECT f.codigo, f.nombre, f.href, f.icono, pu.habilitado
         FROM permisos_usuario pu
         JOIN funcionalidades f ON f.id_funcionalidad = pu.id_funcionalidad
         WHERE pu.id_usuario = ?`,
        [id_usuario]
      );
      userFuncs.forEach(p => {
        permisosMapa[p.codigo] = { habilitado: p.habilitado === 1, nombre: p.nombre, href: p.href, icono: p.icono };
      });
    } catch (e) { /* tabla puede no existir aún */ }

    // funcionalidades → array de códigos (compatibilidad hacia atrás)
    // funcionalidadesInfo → array de objetos {codigo, nombre, href, icono} (nuevo)
    const funcionalidades = Object.entries(permisosMapa)
      .filter(([, v]) => v.habilitado)
      .map(([codigo]) => codigo);

    const funcionalidadesInfo = Object.entries(permisosMapa)
      .filter(([, v]) => v.habilitado)
      .map(([codigo, v]) => ({ codigo, nombre: v.nombre, href: v.href, icono: v.icono }));

    res.json({ success: true, data: modulos, funcionalidades, funcionalidadesInfo, error: null });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: errMsg(error) });
  }
};

module.exports = { login, cambiarClave, misPermisos };
