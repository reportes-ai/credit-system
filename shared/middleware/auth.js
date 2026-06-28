const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET no está definido en las variables de entorno');
const JWT_EXPIRES = '8h';

const verifyToken = (req, res, next) => {
  // Acepta token en header Authorization o en query param ?token= (para descargas directas)
  const authHeader = req.headers.authorization;
  const rawToken   = (authHeader && authHeader.startsWith('Bearer '))
    ? authHeader.split(' ')[1]
    : req.query.token;
  if (!rawToken) {
    return res.status(401).json({ success: false, data: null, error: 'Token requerido' });
  }
  try {
    const payload = jwt.verify(rawToken, JWT_SECRET);
    // Blindaje de frontera: los tokens de DEALER (portal externo) están firmados
    // con el mismo JWT_SECRET, pero NO deben acceder a rutas internas del staff.
    // Las rutas del dealer usan verifyDealer/verifyAny (atención-remota), nunca este
    // middleware. Rechazar aquí cierra la puerta a endpoints internos sin requireFunc.
    if (payload && payload.tipo === 'dealer') {
      return res.status(403).json({ success: false, data: null, error: 'Token no válido para esta sección' });
    }
    req.usuario = payload;
    req.user    = req.usuario;   // alias para controllers que usan req.user
    next();
  } catch {
    return res.status(401).json({ success: false, data: null, error: 'Token inválido o expirado' });
  }
};

const requirePerfil = (...perfiles) => (req, res, next) => {
  if (!perfiles.includes(req.usuario.perfil_nombre)) {
    return res.status(403).json({ success: false, data: null, error: 'Sin permisos suficientes' });
  }
  next();
};

module.exports = { verifyToken, requirePerfil, JWT_SECRET, JWT_EXPIRES };
