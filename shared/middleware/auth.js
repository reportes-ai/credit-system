const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET no está definido en las variables de entorno');
const JWT_EXPIRES = '8h';

const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, data: null, error: 'Token requerido' });
  }
  try {
    req.usuario = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
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
