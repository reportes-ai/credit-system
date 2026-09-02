const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const { AsyncLocalStorage } = require('async_hooks');

/* Contexto por request: quién es el usuario autenticado. Lo consumen los motores
   compartidos (ej. el log de correos del mailer) sin que cada controller tenga
   que pasar el usuario a mano. Fuera de un request devuelve null (= Sistema). */
const alsUsuario = new AsyncLocalStorage();
function usuarioActual() { return alsUsuario.getStore() || null; }

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET no está definido en las variables de entorno');
const JWT_EXPIRES = '8h';

/* ─────────────────────────────────────────────────────────────────
   REVOCACIÓN DE SESIONES (hallazgo A-7 de la auditoría 2026-08-03)

   Un JWT dura 8 horas y, hasta ahora, nada podía acortarlo: al desactivar a
   una persona se le cerraban las rutas con `requireFunc` —que consulta el
   estado en BD— pero las ~450 que solo usan `verifyToken` seguían
   respondiendo hasta que el token expiraba solo. Alguien desvinculado a las
   9 conservaba acceso hasta las 5 de la tarde. Lo mismo tras un token robado.

   Ahora cada token lleva la `token_version` del usuario. Subir ese número en
   la base mata TODAS sus sesiones en el acto, sin listas de revocación ni
   almacenar tokens en ninguna parte.

   Se consulta con caché de 60s, igual que `requireFunc`, para no agregar una
   consulta por request a las 450 rutas — en TiDB cada consulta se paga.

   SI LA BASE FALLA, SE DEJA PASAR. Sin base no funciona ninguna pantalla
   igual; cerrar la sesión encima obligaría a todo el mundo a reingresar en
   medio de la caída, justo cuando el sistema vuelve.
   ───────────────────────────────────────────────────────────────── */
const CACHE_MS = 60 * 1000;
const cacheSesion = new Map();   // id_usuario → { exp, tv, activo }

async function estadoSesion(id_usuario) {
  const hit = cacheSesion.get(id_usuario);
  if (hit && hit.exp > Date.now()) return hit;
  const [[u]] = await pool.query(
    'SELECT estado, COALESCE(token_version, 0) AS tv FROM usuarios WHERE id_usuario = ?',
    [id_usuario]
  );
  const entry = {
    exp: Date.now() + CACHE_MS,
    tv: u ? Number(u.tv) : 0,
    activo: !!u && u.estado === 'activo',
  };
  cacheSesion.set(id_usuario, entry);
  return entry;
}

/* Se llama al subir la versión: sin esto el usuario seguiría entrando hasta
   60 segundos después, que es justo lo que no se quiere en una desvinculación. */
function olvidarSesion(id_usuario) { cacheSesion.delete(Number(id_usuario)); }

/* Cierra TODAS las sesiones abiertas de un usuario, ya mismo. */
async function cerrarSesiones(id_usuario) {
  await pool.query('UPDATE usuarios SET token_version = COALESCE(token_version, 0) + 1 WHERE id_usuario = ?', [id_usuario]);
  olvidarSesion(id_usuario);
}

const verifyToken = async (req, res, next) => {
  // Acepta token en header Authorization o en query param ?token= (para descargas directas)
  const authHeader = req.headers.authorization;
  const rawToken   = (authHeader && authHeader.startsWith('Bearer '))
    ? authHeader.split(' ')[1]
    : req.query.token;
  if (!rawToken) {
    return res.status(401).json({ success: false, data: null, error: 'Token requerido' });
  }
  let payload;
  try {
    payload = jwt.verify(rawToken, JWT_SECRET);
  } catch {
    return res.status(401).json({ success: false, data: null, error: 'Token inválido o expirado' });
  }
  // Blindaje de frontera: los tokens de DEALER (portal externo) están firmados
  // con el mismo JWT_SECRET, pero NO deben acceder a rutas internas del staff.
  // Las rutas del dealer usan verifyDealer/verifyAny (atención-remota), nunca este
  // middleware. Rechazar aquí cierra la puerta a endpoints internos sin requireFunc.
  if (payload && payload.tipo === 'dealer') {
    return res.status(403).json({ success: false, data: null, error: 'Token no válido para esta sección' });
  }

  // Sesiones del staff: se comprueba que sigan vigentes. Los tokens sin
  // id_usuario (portal del cliente) no pasan por acá y quedan como estaban.
  if (payload && payload.id_usuario) {
    try {
      const s = await estadoSesion(payload.id_usuario);
      if (!s.activo) {
        return res.status(401).json({ success: false, data: null, error: 'Tu cuenta fue desactivada. Contacta al administrador.' });
      }
      // Un token emitido antes de esta mejora no trae `tv`: vale 0, igual que
      // el valor por omisión en la base. Así nadie queda deslogueado por el
      // solo hecho de instalar esto.
      if (Number(payload.tv || 0) !== s.tv) {
        return res.status(401).json({ success: false, data: null, error: 'Tu sesión fue cerrada. Ingresa de nuevo.' });
      }
    } catch (e) {
      console.error('[auth] no se pudo verificar la sesión (se deja pasar):', e.message);
    }

    /* Clave por cambiar (C-4): el token nace marcado y acá se hace valer. Se
       deja pasar SOLO el cambio de clave y la lectura de permisos (que la
       pantalla necesita para dibujarse); todo lo demás espera. Sin esto, la
       obligación de cambiar la clave vivía únicamente en el navegador. */
    if (Number(payload.cc || 0) === 1) {
      const rutaCruda = req.originalUrl || req.url || '';
      const ruta = rutaCruda.split('?')[0];
      const PERMITIDAS = ['/api/auth/cambiar-clave', '/api/auth/mis-permisos', '/api/health'];
      if (!PERMITIDAS.some(p => ruta === p || ruta.endsWith(p))) {
        return res.status(403).json({ success: false, data: null,
          error: 'Debes cambiar tu contraseña antes de usar el sistema.' });
      }
    }
  }

  /* VER COMO (impersonación del Administrador): token marcado `vc`. Sirve para
     validar qué VE cada perfil — NUNCA para operar a su nombre. Se bloquea toda
     escritura a nivel de middleware, así ninguna ruta depende de acordarse. */
  if (payload && payload.vc && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return res.status(403).json({ success: false, data: null,
      error: 'Modo "Ver como": solo lectura. Para operar, ingresa con tu propia cuenta.' });
  }

  /* PERFIL DE SOLO LECTURA (perfiles.solo_lectura=1, ej. "Demo" o Director): mismo
     candado que "Ver como" — datos reales a la vista, cero escrituras. Se hace valer
     acá en el middleware para que ninguna ruta dependa de acordarse.
     Excepción: cambiar SU PROPIA contraseña — es seguridad de la cuenta, no un dato
     de negocio (Diego, perfil Director, no podía cambiar la clave — 02-09-2026). */
  if (payload && payload.sl && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const rutaSL = String(req.originalUrl || req.url || '').split('?')[0];
    if (rutaSL !== '/api/auth/cambiar-clave' && !rutaSL.endsWith('/api/auth/cambiar-clave')) {
      return res.status(403).json({ success: false, data: null,
        error: 'Perfil de solo lectura: puedes navegar y ver, no operar.' });
    }
  }

  req.usuario = payload;
  req.user    = req.usuario;   // alias para controllers que usan req.user
  alsUsuario.run({
    id_usuario: payload.id_usuario || null,
    nombre: [payload.nombre, payload.apellido].filter(Boolean).join(' ').trim() || null,
  }, next);
};

const requirePerfil = (...perfiles) => (req, res, next) => {
  if (!perfiles.includes(req.usuario.perfil_nombre)) {
    return res.status(403).json({ success: false, data: null, error: 'Sin permisos suficientes' });
  }
  next();
};

module.exports = { verifyToken, requirePerfil, cerrarSesiones, olvidarSesion, usuarioActual, JWT_SECRET, JWT_EXPIRES };
