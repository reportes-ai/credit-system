'use strict';
/* Mantenedor Datos de la Empresa — UI de shared/empresa.js (fuente única de razón social, RUT,
   giro, domicilio, representante, contacto, CCAF y mutual). */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { datosEmpresa, guardarEmpresa } = require('../../../../shared/empresa');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });

// Card + permiso: solo BD (regla anti-hardcode). Hereda los perfiles de Cuentas Bancarias (Administrador).
require('../../../../shared/migrate').enFila('mant-empresa', async () => {
  const [[ya]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mant_empresa' LIMIT 1");
  if (ya) return;
  const [[ref]] = await pool.query("SELECT id_modulo, id_funcionalidad FROM funcionalidades WHERE codigo='mantenedores_cuentas_bancarias' LIMIT 1");
  const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
    [ref ? ref.id_modulo : 30001, 'Datos de la Empresa', 'mant_empresa', '/mantenedores/empresa/', 'bi-building']);
  if (ref) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) SELECT id_perfil, ?, habilitado FROM permisos_perfil WHERE id_funcionalidad=?', [r.insertId, ref.id_funcionalidad]);
  console.log('[mant-empresa] card Datos de la Empresa creada');
});

exports.get = async (req, res) => {
  try { ok(res, await datosEmpresa()); } catch (e) { fail(res, e.message); }
};

exports.put = async (req, res) => {
  try {
    const u = req.usuario || {};
    const antes = await datosEmpresa();
    const d = await guardarEmpresa(req.body || {}, `${u.nombre || ''} ${u.apellido || ''}`.trim() || u.email);
    const cambios = Object.keys(req.body || {}).filter(k => String(antes[k] ?? '') !== String(d[k] ?? '')).map(k => `${k}: "${antes[k] ?? ''}" → "${d[k] ?? ''}"`);
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'empresa', entidad_id: 1, detalle: 'Datos de la Empresa: ' + (cambios.join(' · ') || 'sin cambios') });
    ok(res, d);
  } catch (e) { fail(res, e.message, 400); }
};
