'use strict';
/**
 * Mantenedor de Actividades Económicas (códigos SII).
 * Catálogo paramétrico: código, descripción, afecto a IVA y categoría tributaria.
 * Se siembra una sola vez desde data/actividades-economicas.json (lista oficial SII).
 * Alimenta el giro/actividad de proveedores y clientes (código + glosa).
 */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
let SEED = [];
try { SEED = require('../data/actividades-economicas.json'); } catch (e) { console.error('[actividades seed file]', e.message); }

/* ── Migración: tabla + seed + registro en el menú (idempotente) ───────────── */
require('../../../../shared/migrate').enFila('actividades-economicas', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS actividades_economicas (
        codigo               VARCHAR(20)  PRIMARY KEY,
        descripcion          VARCHAR(300) NOT NULL,
        afecto_iva           TINYINT(1)   NOT NULL DEFAULT 1,
        categoria_tributaria TINYINT      NULL,
        activo               TINYINT(1)   NOT NULL DEFAULT 1,
        created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_desc (descripcion), INDEX idx_activo (activo)
      )`);

    // Seed inicial: solo si la tabla está vacía (no pisa ediciones del Admin).
    const [[c]] = await pool.query('SELECT COUNT(*) n FROM actividades_economicas');
    if (c.n === 0 && SEED.length) {
      const vals = SEED.map(x => [String(x.codigo), x.descripcion, x.afecto_iva ? 1 : 0, x.categoria_tributaria || null]);
      // Inserta en lotes de 200 para no exceder el tamaño del paquete.
      for (let i = 0; i < vals.length; i += 200) {
        await pool.query(
          'INSERT IGNORE INTO actividades_economicas (codigo, descripcion, afecto_iva, categoria_tributaria) VALUES ?',
          [vals.slice(i, i + 200)]);
      }
      console.log(`[actividades-economicas] sembradas ${vals.length} actividades SII`);
    }

    // Registrar el mantenedor en el menú (funcionalidad bajo módulo Mantenedores 30001).
    const [[ex]] = await pool.query("SELECT 1 ok FROM funcionalidades WHERE codigo='mantenedores_actividades_economicas' LIMIT 1");
    if (!ex) await pool.query(
      `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
       VALUES (30001, 'Actividades Económicas', 'mantenedores_actividades_economicas', '/mantenedores/actividades-economicas/', 'bi-briefcase')`);
  } catch (e) { console.error('[actividades-economicas migration]', e.message); }
});

const norm = s => String(s ?? '').trim();

/* GET /api/actividades-economicas?q=&afecto_iva=&categoria=&incluir_inactivas=1 */
const getAll = async (req, res) => {
  try {
    const where = [], args = [];
    if (req.query.incluir_inactivas !== '1') where.push('activo = 1');
    const q = norm(req.query.q);
    if (q) { where.push('(descripcion LIKE ? OR codigo LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    if (req.query.afecto_iva === '0' || req.query.afecto_iva === '1') { where.push('afecto_iva = ?'); args.push(Number(req.query.afecto_iva)); }
    const cat = parseInt(req.query.categoria);
    if (cat === 1 || cat === 2) { where.push('categoria_tributaria = ?'); args.push(cat); }
    const [rows] = await pool.query(
      `SELECT * FROM actividades_economicas ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY codigo`, args);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { console.error('[actividades getAll]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* POST /api/actividades-economicas — agregar una actividad propia */
const crear = async (req, res) => {
  try {
    const b = req.body || {};
    const codigo = norm(b.codigo), descripcion = norm(b.descripcion);
    if (!codigo) return res.status(400).json({ success: false, data: null, error: 'El código es obligatorio' });
    if (!descripcion) return res.status(400).json({ success: false, data: null, error: 'La descripción es obligatoria' });
    const [[dup]] = await pool.query('SELECT 1 ok FROM actividades_economicas WHERE codigo=?', [codigo]);
    if (dup) return res.status(409).json({ success: false, data: null, error: 'Ya existe ese código' });
    const cat = parseInt(b.categoria_tributaria);
    await pool.query(
      'INSERT INTO actividades_economicas (codigo, descripcion, afecto_iva, categoria_tributaria) VALUES (?,?,?,?)',
      [codigo, descripcion, b.afecto_iva ? 1 : 0, (cat === 1 || cat === 2) ? cat : null]);
    auditar({ req, accion: 'CREAR', modulo: 'mantenedores', entidad: 'actividad_economica', entidad_id: codigo, detalle: `Creó actividad ${codigo} — ${descripcion}` });
    res.json({ success: true, data: { codigo }, error: null });
  } catch (e) { console.error('[actividades crear]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* PUT /api/actividades-economicas/:codigo */
const update = async (req, res) => {
  try {
    const codigo = req.params.codigo;
    const b = req.body || {};
    const descripcion = norm(b.descripcion);
    if (!descripcion) return res.status(400).json({ success: false, data: null, error: 'La descripción es obligatoria' });
    const cat = parseInt(b.categoria_tributaria);
    const [r] = await pool.query(
      'UPDATE actividades_economicas SET descripcion=?, afecto_iva=?, categoria_tributaria=?, activo=? WHERE codigo=?',
      [descripcion, b.afecto_iva ? 1 : 0, (cat === 1 || cat === 2) ? cat : null, b.activo === 0 || b.activo === false ? 0 : 1, codigo]);
    if (!r.affectedRows) return res.status(404).json({ success: false, data: null, error: 'Actividad no encontrada' });
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'actividad_economica', entidad_id: codigo, detalle: `Editó actividad ${codigo}` });
    res.json({ success: true, data: { codigo }, error: null });
  } catch (e) { console.error('[actividades update]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* DELETE /api/actividades-economicas/:codigo — baja/alta lógica (toggle activo) */
const remove = async (req, res) => {
  try {
    const codigo = req.params.codigo;
    const [[a]] = await pool.query('SELECT activo, descripcion FROM actividades_economicas WHERE codigo=?', [codigo]);
    if (!a) return res.status(404).json({ success: false, data: null, error: 'Actividad no encontrada' });
    const nuevo = a.activo ? 0 : 1;
    await pool.query('UPDATE actividades_economicas SET activo=? WHERE codigo=?', [nuevo, codigo]);
    auditar({ req, accion: nuevo ? 'REACTIVAR' : 'DESACTIVAR', modulo: 'mantenedores', entidad: 'actividad_economica', entidad_id: codigo, detalle: `${nuevo ? 'Reactivó' : 'Desactivó'} actividad ${codigo}` });
    res.json({ success: true, data: { codigo, activo: nuevo }, error: null });
  } catch (e) { console.error('[actividades remove]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { getAll, crear, update, remove };
