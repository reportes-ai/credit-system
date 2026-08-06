'use strict';
/**
 * Base de Parques Automotrices — la ficha del parque como contraparte comercial.
 *
 * QUÉ ES: los parques ya existen como parámetro de cálculo (parques_comisiones:
 * nombre + arriendo + comisión, mantenedor "Arriendos y Comisiones Parque y
 * Calle"). Pero a los parques, igual que a los dealers, se les emiten cartolas
 * y ellos nos facturan — y para eso falta su ficha: RUT, razón social,
 * representante legal, dirección, contactos y la cuenta donde depositar.
 *
 * UNA SOLA FUENTE (Máxima 2): esta ficha NO re-almacena el nombre ni la
 * comisión/arriendo. Se cuelga de parques_comisiones por id_parque (UNIQUE):
 * el nombre y los parámetros de cálculo siguen viviendo en su mantenedor;
 * aquí vive únicamente la identidad comercial del parque. Las futuras
 * cartolas de parque leerán ambas cosas de su fuente respectiva.
 */
const pool = require('../../../../shared/config/database');
const RUT = require('../../../../api-gateway/public/js/rut-core');
const { auditar } = require('../../../../shared/audit');

/* ── Migración: tabla + card en el módulo Creación/Mantenedor de Dealer ───── */
require('../../../../shared/migrate').enFila('parques-base', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS parques_ficha (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        id_parque     INT          NOT NULL,
        rut           VARCHAR(20)  NULL,
        razon_social  VARCHAR(200) NULL,
        direccion     VARCHAR(300) NULL,
        comuna        VARCHAR(120) NULL,
        rl_nombre     VARCHAR(150) NULL,
        rl_telefono   VARCHAR(40)  NULL,
        rl_email      VARCHAR(150) NULL,
        cc_nombre     VARCHAR(150) NULL,
        cc_telefono   VARCHAR(40)  NULL,
        cc_email      VARCHAR(150) NULL,
        cf_nombre     VARCHAR(150) NULL,
        cf_telefono   VARCHAR(40)  NULL,
        cf_email      VARCHAR(150) NULL,
        tipo_documento VARCHAR(10) NULL,
        banco         VARCHAR(80)  NULL,
        cuenta_tipo   VARCHAR(30)  NULL,
        rut_cuenta    VARCHAR(20)  NULL,
        nombre_cuenta VARCHAR(150) NULL,
        num_cuenta    VARCHAR(40)  NULL,
        correo_confirmacion VARCHAR(150) NULL,
        observaciones TEXT         NULL,
        created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_parque (id_parque)
      )`);
  } catch (e) { if (e.errno !== 1050) console.error('[parques_ficha migration]', e.message); }

  // Card en el landing del módulo 370001 + permiso (Admin y quienes mantienen dealers).
  try {
    const codigo = 'parque_ficha';
    const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [codigo]);
    let idf = ex?.id_funcionalidad;
    if (!idf) {
      const [r] = await pool.query(
        `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
         VALUES (370001, 'Creación de Parque', ?, '/dealers-incorporacion/parques.html', 'bi-p-square')`, [codigo]);
      idf = r.insertId;
    }
    for (const idp of [1, 6, 90008]) {   // Admin · Analista de Operaciones · Gte. Operaciones y Crédito
      const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=? AND id_funcionalidad=? LIMIT 1', [idp, idf]);
      if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
    }
  } catch (e) { console.error('[parques_ficha funcionalidad]', e.message); }
});

const norm = s => { const v = String(s ?? '').trim(); return v || null; };

/* Los campos editables de la ficha, en el orden del INSERT/UPDATE. */
const CAMPOS = ['rut','razon_social','direccion','comuna','rl_nombre','rl_telefono','rl_email',
  'cc_nombre','cc_telefono','cc_email','cf_nombre','cf_telefono','cf_email',
  'tipo_documento','banco','cuenta_tipo','rut_cuenta','nombre_cuenta','num_cuenta',
  'correo_confirmacion','observaciones'];

function limpiarFicha(body) {
  const f = {};
  for (const c of CAMPOS) f[c] = norm(body[c]);
  // RUTs al formato canónico; si el DV no cuadra se rechaza (mejor que guardarlo torcido).
  for (const c of ['rut', 'rut_cuenta']) {
    if (!f[c]) continue;
    const n = RUT.normalizar(f[c]);
    if (!n) return { error: `El ${c === 'rut' ? 'RUT del parque' : 'RUT de la cuenta'} no es válido` };
    f[c] = n;
  }
  if (f.razon_social) f.razon_social = f.razon_social.toUpperCase();
  return { f };
}

/* GET /parques-base — la base completa: parámetro de cálculo + ficha (si existe). */
exports.listar = async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.id, p.nombre, p.arriendo, p.comision_pct, p.activo, p.orden,
              f.id AS id_ficha, f.rut, f.razon_social, f.direccion, f.comuna,
              f.rl_nombre, f.rl_telefono, f.rl_email,
              f.cc_nombre, f.cc_telefono, f.cc_email,
              f.cf_nombre, f.cf_telefono, f.cf_email,
              f.tipo_documento, f.banco, f.cuenta_tipo, f.rut_cuenta, f.nombre_cuenta, f.num_cuenta,
              f.correo_confirmacion, f.observaciones, f.updated_at AS ficha_actualizada
         FROM parques_comisiones p
         LEFT JOIN parques_ficha f ON f.id_parque = p.id
        ORDER BY p.orden, p.nombre`);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { console.error('[parques-base listar]', e); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* POST /parques-base — crea el PARQUE (fila en parques_comisiones) + su ficha.
   El arriendo y la comisión nacen en 0: se fijan en su mantenedor, no aquí. */
exports.crear = async (req, res) => {
  try {
    const nombre = norm(req.body?.nombre)?.toUpperCase();
    if (!nombre) return res.status(400).json({ success: false, data: null, error: 'Nombre del parque requerido' });
    const { f, error } = limpiarFicha(req.body || {});
    if (error) return res.status(400).json({ success: false, data: null, error });

    const [[dup]] = await pool.query('SELECT id FROM parques_comisiones WHERE nombre=?', [nombre]);
    if (dup) return res.status(400).json({ success: false, data: null, error: 'Ya existe un parque con ese nombre' });

    const [r] = await pool.query(
      'INSERT INTO parques_comisiones (nombre, arriendo, comision_pct, activo, orden) VALUES (?,0,0,1,99)', [nombre]);
    await pool.query(
      `INSERT INTO parques_ficha (id_parque, ${CAMPOS.join(',')}) VALUES (?${',?'.repeat(CAMPOS.length)})`,
      [r.insertId, ...CAMPOS.map(c => f[c])]);

    auditar({ req, accion: 'CREAR', modulo: 'dealers-incorporacion', entidad: 'parque_ficha', entidad_id: r.insertId, detalle: `Creó el parque "${nombre}" con su ficha`, meta: req.body });
    res.status(201).json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) { console.error('[parques-base crear]', e); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* PUT /parques-base/:idParque — guarda/actualiza la ficha de un parque existente. */
exports.guardar = async (req, res) => {
  try {
    const idParque = Number(req.params.idParque);
    const [[p]] = await pool.query('SELECT id, nombre FROM parques_comisiones WHERE id=?', [idParque]);
    if (!p) return res.status(404).json({ success: false, data: null, error: 'Parque no encontrado' });
    const { f, error } = limpiarFicha(req.body || {});
    if (error) return res.status(400).json({ success: false, data: null, error });

    await pool.query(
      `INSERT INTO parques_ficha (id_parque, ${CAMPOS.join(',')}) VALUES (?${',?'.repeat(CAMPOS.length)})
       ON DUPLICATE KEY UPDATE ${CAMPOS.map(c => `${c}=VALUES(${c})`).join(',')}`,
      [idParque, ...CAMPOS.map(c => f[c])]);

    auditar({ req, accion: 'EDITAR', modulo: 'dealers-incorporacion', entidad: 'parque_ficha', entidad_id: idParque, detalle: `Editó la ficha del parque "${p.nombre}"`, meta: req.body });
    res.json({ success: true, data: null, error: null });
  } catch (e) { console.error('[parques-base guardar]', e); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
