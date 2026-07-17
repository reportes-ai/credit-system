'use strict';
// Regla "solo otorgas lo que tienes": un usuario que NO es Administrador solo puede
// conceder/quitar a otros las funcionalidades que él mismo tiene habilitadas
// (perfil + overrides individuales), y solo asignar perfiles cuyo set de permisos
// esté contenido en el suyo. Para Administrador no hay límite (devuelve null).
const pool = require('../../../shared/config/database');

async function funcsOtorgables(idUsuario) {
  const [[u]] = await pool.query(
    'SELECT u.id_perfil, p.nombre perfil FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil WHERE u.id_usuario=?', [idUsuario]);
  if (!u) return new Set();
  if (u.perfil === 'Administrador') return null;   // sin restricción
  const [fs] = await pool.query('SELECT id_funcionalidad FROM permisos_perfil WHERE id_perfil=? AND habilitado=1', [u.id_perfil]);
  const set = new Set(fs.map(x => x.id_funcionalidad));
  try {
    const [ov] = await pool.query('SELECT id_funcionalidad, habilitado FROM permisos_usuario WHERE id_usuario=?', [idUsuario]);
    ov.forEach(o => o.habilitado ? set.add(o.id_funcionalidad) : set.delete(o.id_funcionalidad));
  } catch (_) { /* tabla puede no existir */ }
  return set;
}

// ¿Puede este usuario asignar este perfil a alguien? (los permisos del perfil ⊆ los suyos)
async function perfilOtorgable(idUsuario, idPerfil) {
  const set = await funcsOtorgables(idUsuario);
  if (set === null) return true;
  const [fs] = await pool.query('SELECT id_funcionalidad FROM permisos_perfil WHERE id_perfil=? AND habilitado=1', [idPerfil]);
  return fs.every(f => set.has(f.id_funcionalidad));
}

module.exports = { funcsOtorgables, perfilOtorgable };
