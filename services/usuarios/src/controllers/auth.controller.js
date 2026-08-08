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

    // Cuenta bloqueada por intentos fallidos (break-glass exentas)
    if (usuario.bloqueado === 1 && !usuario.protegido) {
      return res.status(423).json({ success: false, data: null, error: 'Cuenta bloqueada por intentos fallidos. Contacta al administrador para desbloquearla.' });
    }

    const valid = await bcrypt.compare(password, usuario.password_hash);
    if (!valid) {
      // Contar el fallo y bloquear al llegar al máximo configurado (0 = sin bloqueo).
      // Las cuentas protegidas (break-glass) nunca se bloquean.
      let bloqueada = false, restantes = null;
      try {
        const [[cfg]] = await pool.query("SELECT valor FROM config_seguridad WHERE clave = 'max_intentos_login'");
        const maxIntentos = parseInt(cfg && cfg.valor) || 0;
        if (maxIntentos > 0 && !usuario.protegido) {
          const nuevos = (usuario.intentos_fallidos || 0) + 1;
          if (nuevos >= maxIntentos) {
            await pool.query('UPDATE usuarios SET intentos_fallidos = ?, bloqueado = 1 WHERE id_usuario = ?', [nuevos, usuario.id_usuario]);
            bloqueada = true;
            auditar({ req, usuario, accion: 'EDITAR', modulo: 'auth', entidad: 'usuario', entidad_id: usuario.id_usuario, detalle: `Cuenta bloqueada tras ${nuevos} intentos fallidos` });
          } else {
            await pool.query('UPDATE usuarios SET intentos_fallidos = ? WHERE id_usuario = ?', [nuevos, usuario.id_usuario]);
            restantes = maxIntentos - nuevos;
          }
        }
      } catch (_) { /* si falla el conteo, no bloquea */ }
      if (bloqueada)
        return res.status(423).json({ success: false, data: null, error: 'Cuenta bloqueada por intentos fallidos. Contacta al administrador para desbloquearla.' });
      const extra = restantes != null ? ` Te queda${restantes === 1 ? '' : 'n'} ${restantes} intento${restantes === 1 ? '' : 's'}.` : '';
      return res.status(401).json({ success: false, data: null, error: 'Credenciales inválidas.' + extra });
    }

    // Ingreso correcto: limpiar contador de fallos si venía con alguno
    if (usuario.intentos_fallidos > 0 || usuario.bloqueado) {
      await pool.query('UPDATE usuarios SET intentos_fallidos = 0, bloqueado = 0 WHERE id_usuario = ?', [usuario.id_usuario]);
    }

    // Vencimiento de clave: si la política exige cambio cada N días y ya venció, forzar cambio.
    let debeForzar = usuario.debe_cambiar_clave === 1;
    // Las cuentas protegidas (break-glass) quedan FUERA de las políticas de seguridad (vencimiento de clave, etc.).
    try {
      if (!debeForzar && !usuario.protegido && usuario.password_updated_at) {
        const [[cfg]] = await pool.query("SELECT valor FROM config_seguridad WHERE clave = 'dias_venc_clave'");
        const diasVenc = parseInt(cfg && cfg.valor) || 0;
        if (diasVenc > 0) {
          const diasDesde = Math.floor((Date.now() - new Date(usuario.password_updated_at).getTime()) / 86400000);
          if (diasDesde >= diasVenc) debeForzar = true;
        }
      }
    } catch (_) { /* si falla la consulta de política, no se fuerza */ }

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
      id_supervisor: usuario.id_supervisor,
      // Versión de sesión (A-7): si en la base sube, este token deja de valer.
      tv: Number(usuario.token_version || 0),
      /* Clave por cambiar (auditoría 05-08-2026, C-4). El forzado era SOLO del
         frontend: el login entregaba un token plenamente válido junto con la
         bandera, así que con curl se operaba el sistema entero sin cambiar
         nunca la clave — y eso dejaba sin efecto el primer ingreso, el reseteo
         por sospecha y el vencimiento por política. Ahora viaja en el token y
         `verifyToken` solo deja pasar el cambio de clave. */
      cc: debeForzar ? 1 : 0
    };

    // Cuentas de propósito fijo (ej. TV) pueden tener sesión más larga (usuarios.sesion_horas).
    const expira = (Number(usuario.sesion_horas) > 0) ? (Number(usuario.sesion_horas) + 'h') : JWT_EXPIRES;
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: expira });

    res.json({
      success: true,
      data: {
        token,
        usuario: {
          id_usuario: usuario.id_usuario,
          nombre: usuario.nombre,
          apellido: usuario.apellido,
          email: usuario.email,
          perfil: usuario.perfil_nombre,
          sexo: usuario.sexo || null,   // M/F — personaliza saludos (Bienvenido/Bienvenida)
          protegido: usuario.protegido === 1,
          // Página a la que entra directo tras el login (NULL = home). Ej: la cuenta
          // de la pantalla TV entra directo al Cuadro de Mando.
          pagina_inicio: usuario.pagina_inicio || null
        },
        // El frontend del login obliga a cambiar la clave antes de entrar
        // (primer ingreso, reset, o clave vencida según la política)
        debe_cambiar_clave: debeForzar
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
    const [rows] = await pool.query('SELECT password_hash, protegido FROM usuarios WHERE id_usuario = ?', [id_usuario]);

    const valid = await bcrypt.compare(password_actual, rows[0].password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, data: null, error: 'Contraseña actual incorrecta' });
    }

    /* Política del mantenedor Seguridad de Usuarios (motor único). Acá había un
       `length < 6` escrito a mano que ignoraba las ocho reglas configuradas: el
       Administrador exigía 8 caracteres con mayúscula, número y símbolo, y el
       sistema aceptaba `123456`. Las cuentas protegidas siguen exentas. */
    const politica = require('../../../../shared/politica-clave');
    const v = await politica.validarClave(password_nuevo, {
      id_usuario, protegido: !!(rows[0] && rows[0].protegido),
    });
    if (!v.ok) return res.status(400).json({ success: false, data: null, error: v.error });

    const hash = await bcrypt.hash(password_nuevo, 10);
    // La clave saliente entra al historial ANTES de reemplazarla (regla "no
    // repetir las últimas N" del mantenedor).
    await politica.registrarEnHistorial(id_usuario, rows[0].password_hash);
    // Al cambiar la clave se limpia la marca de "primer ingreso" y se reinicia el reloj de vencimiento
    await pool.query('UPDATE usuarios SET password_hash = ?, debe_cambiar_clave = 0, password_updated_at = NOW() WHERE id_usuario = ?', [hash, id_usuario]);

    /* Token nuevo sin la marca `cc` (C-4): el que trae en la mano quedó
       restringido al propio cambio de clave, así que sin reemitirlo el usuario
       terminaría de cambiarla y no podría entrar a nada. El frontend lo guarda
       si viene; si no lo usa, basta con volver a entrar. */
    const { cc, iat, exp, ...resto } = req.usuario || {};
    const token = jwt.sign(resto, JWT_SECRET, { expiresIn: JWT_EXPIRES });

    res.json({ success: true, data: { mensaje: 'Contraseña actualizada correctamente', token }, error: null });
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
    let _protegido = false;
    try {
      const [[u]] = await pool.query('SELECT id_perfil, protegido FROM usuarios WHERE id_usuario = ?', [id_usuario]);
      if (u) { id_perfil = u.id_perfil; _protegido = u.protegido === 1; }
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
      `SELECT f.codigo, f.nombre, f.href, f.icono, f.id_modulo, pp.habilitado
       FROM permisos_perfil pp
       JOIN funcionalidades f ON f.id_funcionalidad = pp.id_funcionalidad
       WHERE pp.id_perfil = ?`,
      [id_perfil]
    );
    const permisosMapa = {};
    perfilFuncs.forEach(p => {
      permisosMapa[p.codigo] = { habilitado: p.habilitado === 1, nombre: p.nombre, href: p.href, icono: p.icono, id_modulo: p.id_modulo };
    });

    // Aplicar overrides individuales del usuario (permisos_usuario)
    try {
      const [userFuncs] = await pool.query(
        `SELECT f.codigo, f.nombre, f.href, f.icono, f.id_modulo, pu.habilitado
         FROM permisos_usuario pu
         JOIN funcionalidades f ON f.id_funcionalidad = pu.id_funcionalidad
         WHERE pu.id_usuario = ?`,
        [id_usuario]
      );
      userFuncs.forEach(p => {
        permisosMapa[p.codigo] = { habilitado: p.habilitado === 1, nombre: p.nombre, href: p.href, icono: p.icono, id_modulo: p.id_modulo };
      });
    } catch (e) { /* tabla puede no existir aún */ }

    // funcionalidades → array de códigos (compatibilidad hacia atrás)
    // funcionalidadesInfo → array de objetos {codigo, nombre, href, icono} (nuevo)
    const funcionalidades = Object.entries(permisosMapa)
      .filter(([, v]) => v.habilitado)
      .map(([codigo]) => codigo);

    const funcionalidadesInfo = Object.entries(permisosMapa)
      .filter(([, v]) => v.habilitado)
      .map(([codigo, v]) => ({ codigo, nombre: v.nombre, href: v.href, icono: v.icono, id_modulo: v.id_modulo }));

    res.json({ success: true, data: modulos, funcionalidades, funcionalidadesInfo, protegido: _protegido, error: null });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: errMsg(error) });
  }
};

/* ── VER COMO (impersonación de solo lectura) ────────────────────────────────
   El Administrador obtiene un token de 30 minutos con la identidad y permisos
   del usuario elegido, marcado `vc` (ver-como). verifyToken bloquea TODA
   escritura de esos tokens: sirve para validar qué VE cada perfil, no para
   operar a nombre de otro. Auditado siempre. */
const verCome_migracion = require('../../../../shared/migrate').enFila('ver-como-func', async () => {
  try {
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta LIKE '/usuarios%' LIMIT 1");
    if (!mod) return;
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='usuarios_ver_como' LIMIT 1");
    let idF = ex && ex.id_funcionalidad;
    if (!idF) {
      const [r] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?, 'Ver como (impersonación lectura)', 'usuarios_ver_como', NULL, 'bi-eye')", [mod.id_modulo]);
      idF = r.insertId;
    }
    await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idF]);
  } catch (e) { console.error('[ver-como migración]', e.message); }
});

const verComo = async (req, res) => {
  try {
    const idObjetivo = parseInt(req.body && req.body.id_usuario, 10);
    if (!idObjetivo) return res.status(400).json({ success: false, data: null, error: 'id_usuario es obligatorio' });
    if (idObjetivo === req.usuario.id_usuario) return res.status(400).json({ success: false, data: null, error: 'Ya estás viendo como tú mismo' });

    const [[u]] = await pool.query(
      `SELECT u.*, p.nombre AS perfil_nombre FROM usuarios u
       JOIN perfiles p ON p.id_perfil = u.id_perfil
       WHERE u.id_usuario = ? LIMIT 1`, [idObjetivo]);
    if (!u) return res.status(404).json({ success: false, data: null, error: 'Usuario no encontrado' });
    if (u.protegido === 1) return res.status(403).json({ success: false, data: null, error: 'Esa cuenta no admite Ver como' });

    const payload = {
      id_usuario: u.id_usuario, nombre: u.nombre, apellido: u.apellido, email: u.email,
      id_perfil: u.id_perfil, perfil_nombre: u.perfil_nombre, id_supervisor: u.id_supervisor,
      tv: Number(u.token_version || 0),
      vc: req.usuario.id_usuario,                       // quién impersona (marca de solo lectura)
      vc_nombre: `${req.usuario.nombre || ''} ${req.usuario.apellido || ''}`.trim(),
    };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '30m' });
    auditar({ req, accion: 'VER', modulo: 'usuarios', entidad: 'usuario', entidad_id: u.id_usuario,
      detalle: `VER COMO: sesión de solo lectura como ${u.nombre} ${u.apellido || ''} (${u.perfil_nombre}), 30 min` });
    res.json({
      success: true, error: null,
      data: {
        token,
        usuario: {
          id_usuario: u.id_usuario, nombre: u.nombre, apellido: u.apellido, email: u.email,
          perfil: u.perfil_nombre, pagina_inicio: u.pagina_inicio || null,
          ver_como: true, ver_como_por: payload.vc_nombre,
        },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: errMsg(error) });
  }
};

module.exports = { login, cambiarClave, misPermisos, verComo };
