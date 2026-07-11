const pool = require('../../../../shared/config/database');
const { feriadosDeAnio, cargarFeriados } = require('../../../../shared/feriados');
const { auditar } = require('../../../../shared/audit');

/* ── Registro del mantenedor en el menú (la tabla la crea shared/feriados.js) ── */
require('../../../../shared/migrate').enFila('feriados', async () => {
  try {
    const [[ex]] = await pool.query("SELECT 1 ok FROM funcionalidades WHERE codigo='mantenedores_feriados' LIMIT 1");
    if (!ex) await pool.query(
      `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
       VALUES (30001, 'Feriados', 'mantenedores_feriados', '/mantenedores/feriados/', 'bi-calendar-event')`);
  } catch (e) { console.error('[feriados migration]', e.message); }
});

const getAll = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT DATE_FORMAT(fecha, "%Y-%m-%d") AS fecha, nombre FROM feriados ORDER BY fecha');
    res.json({ success: true, data: rows, error: null });
  } catch (e) { console.error('[feriados getAll]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const crear = async (req, res) => {
  try {
    const { fecha, nombre } = req.body || {};
    if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ success: false, data: null, error: 'Fecha inválida (YYYY-MM-DD)' });
    if (!nombre || !nombre.trim()) return res.status(400).json({ success: false, data: null, error: 'Nombre requerido' });
    await pool.query('INSERT INTO feriados (fecha, nombre) VALUES (?,?) ON DUPLICATE KEY UPDATE nombre=VALUES(nombre)', [fecha, nombre.trim()]);
    await cargarFeriados();
    auditar({ req, accion: 'CREAR', modulo: 'mantenedores', entidad: 'feriado', entidad_id: fecha, detalle: `Agregó feriado ${fecha} — ${nombre.trim()}` });
    res.json({ success: true, data: { fecha }, error: null });
  } catch (e) { console.error('[feriados crear]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const eliminar = async (req, res) => {
  try {
    await pool.query('DELETE FROM feriados WHERE fecha = ?', [req.params.fecha]);
    await cargarFeriados();
    auditar({ req, accion: 'ELIMINAR', modulo: 'mantenedores', entidad: 'feriado', entidad_id: req.params.fecha, detalle: `Eliminó feriado ${req.params.fecha}` });
    res.json({ success: true, data: { fecha: req.params.fecha }, error: null });
  } catch (e) { console.error('[feriados eliminar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* POST /api/feriados/cargar { desde, hasta } — alimenta desde la fuente computada
   (algoritmo de Pascua + feriados legales de Chile). Idempotente (INSERT IGNORE). */
const cargarAuto = async (req, res) => {
  try {
    const hoy = new Date().getFullYear();
    let desde = parseInt(req.body?.desde) || hoy;
    let hasta = parseInt(req.body?.hasta) || (hoy + 1);
    if (hasta < desde) [desde, hasta] = [hasta, desde];
    if (hasta - desde > 10) hasta = desde + 10;            // tope de seguridad
    let nuevos = 0;
    for (let y = desde; y <= hasta; y++) {
      for (const [fecha, nombre] of feriadosDeAnio(y)) {
        const [r] = await pool.query('INSERT IGNORE INTO feriados (fecha, nombre) VALUES (?,?)', [fecha, nombre]);
        nuevos += r.affectedRows;
      }
    }
    await cargarFeriados();
    auditar({ req, accion: 'CARGA_MASIVA', modulo: 'mantenedores', entidad: 'feriado', detalle: `Cargó feriados chilenos ${desde}–${hasta}: ${nuevos} nuevo(s)`, meta: { desde, hasta, nuevos } });
    res.json({ success: true, data: { desde, hasta, nuevos }, error: null });
  } catch (e) { console.error('[feriados cargarAuto]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { getAll, crear, eliminar, cargarAuto };
