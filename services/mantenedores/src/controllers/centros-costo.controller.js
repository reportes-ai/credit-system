'use strict';
/* Mantenedor CENTROS DE COSTO — a qué área de la empresa se imputa cada compra
   y gasto. Fuente única (Máxima 2): la lista vive acá; los consumidores son
   usuarios.centro_costo (el CC de cada persona, editable en Usuarios), las
   Órdenes de Pago de proveedores (campo centro_costo al emitir) y las compras
   de Soporte (el CC de la compra es el del usuario que pide). */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

require('../../../../shared/migrate').enFila('centros-costo', async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS centros_costo (
      codigo     VARCHAR(10)  NOT NULL PRIMARY KEY,
      nombre     VARCHAR(100) NOT NULL,
      responsable VARCHAR(120) NULL,
      orden      INT NOT NULL DEFAULT 99,
      activo     TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`).catch(e => { if (e.errno !== 1050) console.error('[centros_costo migration]', e.message); });
  // A qué área se imputa cada gasto de proveedores
  await pool.query("ALTER TABLE ordenes_pago ADD COLUMN IF NOT EXISTS centro_costo VARCHAR(60) NULL").catch(() => {});
});

/* Seed una vez (01-09-2026): el organigrama real de la empresa, tomado de los
   valores ya usados en usuarios.centro_costo. Además se HOMOLOGA lo existente:
   'FINANZAS' y 'Recursos Humanos' eran variantes del mismo dato. */
require('../../../../shared/migrate').migrar('centros-costo-seed-2026-09', async () => {
  const CCS = [
    ['CC-01', 'GERENCIA GENERAL', 1],
    ['CC-02', 'COMERCIAL', 2],
    ['CC-03', 'OPERACIONES', 3],
    ['CC-04', 'RIESGO', 4],
    ['CC-05', 'ADMINISTRACION Y FINANZAS', 5],
    ['CC-06', 'RECURSOS HUMANOS', 6],
  ];
  for (const [cod, nom, ord] of CCS)
    await pool.query('INSERT IGNORE INTO centros_costo (codigo, nombre, orden) VALUES (?,?,?)', [cod, nom, ord]);
  // Homologación de la columna libre de usuarios a los nombres oficiales
  await pool.query("UPDATE usuarios SET centro_costo='ADMINISTRACION Y FINANZAS' WHERE UPPER(TRIM(COALESCE(centro_costo,'')))='FINANZAS'");
  await pool.query("UPDATE usuarios SET centro_costo='RECURSOS HUMANOS' WHERE UPPER(TRIM(COALESCE(centro_costo,'')))='RECURSOS HUMANOS'");
  // Card en Mantenedores (funcionalidad + permiso del Administrador)
  const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mantenedores_centros_costo'");
  if (!ex) {
    const [[mx]] = await pool.query('SELECT COALESCE(MAX(id_funcionalidad),0)+1 id FROM funcionalidades');
    await pool.query(
      "INSERT INTO funcionalidades (id_funcionalidad, codigo, nombre, href, icono, id_modulo) VALUES (?,?,?,?,?,30001)",
      [mx.id, 'mantenedores_centros_costo', 'Centros de Costo', '/mantenedores/centros-costo/', 'bi-diagram-2']);
    const [perfs] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador'");
    for (const p of perfs)
      await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [p.id_perfil, mx.id]);
  }
});

/* Seed una vez (01-09-2026): centro de costo por cada PARQUE con oficina
   (los parques ACTIVOS del mantenedor Parques) — el arriendo, la comisión y
   los gastos de esas oficinas se imputan a su propio centro. */
require('../../../../shared/migrate').migrar('centros-costo-parques-2026-09', async () => {
  const [parques] = await pool.query('SELECT nombre FROM parques_comisiones WHERE activo=1 ORDER BY orden').catch(() => [[]]);
  let n = 10;
  for (const p of parques) {
    n++;
    await pool.query('INSERT IGNORE INTO centros_costo (codigo, nombre, orden) VALUES (?,?,?)',
      ['CC-P' + String(n - 10).padStart(2, '0'), String(p.nombre).toUpperCase(), n]);
  }
});

const ok  = (res, data) => res.json({ success: true, data, error: null });
const err = (res, e, s = 500) => res.status(s).json({ success: false, data: null, error: e?.message || e });

// GET /api/centros-costo  (?todos=1 incluye inactivos, con conteo de personas)
const list = async (req, res) => {
  try {
    const where = req.query.todos ? '' : 'WHERE cc.activo=1';
    const [rows] = await pool.query(`
      SELECT cc.*, (SELECT COUNT(*) FROM usuarios u
                     WHERE u.estado='activo' AND UPPER(TRIM(COALESCE(u.centro_costo,'')))=UPPER(cc.nombre)) AS personas
        FROM centros_costo cc ${where} ORDER BY cc.orden, cc.nombre`);
    ok(res, rows);
  } catch (e) { err(res, e); }
};

const create = async (req, res) => {
  try {
    const { codigo, nombre, responsable, orden, activo } = req.body || {};
    if (!String(codigo || '').trim() || !String(nombre || '').trim())
      return err(res, 'codigo y nombre son requeridos', 400);
    await pool.query(
      'INSERT INTO centros_costo (codigo, nombre, responsable, orden, activo) VALUES (?,?,?,?,?)',
      [String(codigo).trim().toUpperCase(), String(nombre).trim().toUpperCase(),
       String(responsable || '').trim() || null, parseInt(orden) || 99, activo === undefined ? 1 : (activo ? 1 : 0)]);
    auditar({ req, accion: 'CREAR', modulo: 'mantenedores', entidad: 'centro_costo', detalle: `Creó centro de costo ${codigo} — ${nombre}` });
    res.status(201).json({ success: true, data: null, error: null });
  } catch (e) { err(res, e.errno === 1062 ? 'Ya existe un centro de costo con ese código' : e, e.errno === 1062 ? 400 : 500); }
};

const update = async (req, res) => {
  try {
    const cod = String(req.params.codigo || '').trim();
    const { nombre, responsable, orden, activo } = req.body || {};
    if (!String(nombre || '').trim()) return err(res, 'nombre requerido', 400);
    const [[prev]] = await pool.query('SELECT * FROM centros_costo WHERE codigo=?', [cod]);
    if (!prev) return err(res, 'No encontrado', 404);
    const nuevoNombre = String(nombre).trim().toUpperCase();
    await pool.query('UPDATE centros_costo SET nombre=?, responsable=?, orden=?, activo=? WHERE codigo=?',
      [nuevoNombre, String(responsable || '').trim() || null, parseInt(orden) || 99, activo ? 1 : 0, cod]);
    // Renombrar arrastra a los consumidores (fuente única, no copias huérfanas)
    if (prev.nombre !== nuevoNombre) {
      await pool.query('UPDATE usuarios SET centro_costo=? WHERE UPPER(TRIM(COALESCE(centro_costo,\'\')))=UPPER(?)', [nuevoNombre, prev.nombre]);
      await pool.query('UPDATE ordenes_pago SET centro_costo=? WHERE UPPER(TRIM(COALESCE(centro_costo,\'\')))=UPPER(?)', [nuevoNombre, prev.nombre]);
    }
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'centro_costo', detalle: `Editó centro de costo ${cod}` + (prev.nombre !== nuevoNombre ? ` (renombrado "${prev.nombre}" → "${nuevoNombre}")` : '') });
    ok(res, null);
  } catch (e) { err(res, e); }
};

const remove = async (req, res) => {
  try {
    const cod = String(req.params.codigo || '').trim();
    const [[cc]] = await pool.query('SELECT nombre FROM centros_costo WHERE codigo=?', [cod]);
    if (!cc) return err(res, 'No encontrado', 404);
    // Con personas o gastos asociados no se elimina: se desactiva (la historia no se rompe)
    const [[u]] = await pool.query("SELECT COUNT(*) n FROM usuarios WHERE UPPER(TRIM(COALESCE(centro_costo,'')))=UPPER(?)", [cc.nombre]);
    const [[o]] = await pool.query("SELECT COUNT(*) n FROM ordenes_pago WHERE UPPER(TRIM(COALESCE(centro_costo,'')))=UPPER(?)", [cc.nombre]);
    if (u.n || o.n) {
      await pool.query('UPDATE centros_costo SET activo=0 WHERE codigo=?', [cod]);
      auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'centro_costo', detalle: `Desactivó centro de costo ${cod} (tiene ${u.n} persona(s) y ${o.n} orden(es) asociadas)` });
      return ok(res, { desactivado: true, motivo: `Tiene ${u.n} persona(s) y ${o.n} orden(es) de pago asociadas: se DESACTIVÓ en vez de eliminar.` });
    }
    await pool.query('DELETE FROM centros_costo WHERE codigo=?', [cod]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'mantenedores', entidad: 'centro_costo', detalle: `Eliminó centro de costo ${cod}` });
    ok(res, { eliminado: true });
  } catch (e) { err(res, e); }
};

module.exports = { list, create, update, remove };
