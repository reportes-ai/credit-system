'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   TERRENO (PWA móvil de ejecutivos) — API dedicada de la app instalable
   /terreno/: el ejecutivo ve SU ruta del día (misma agenda de visitas_dealers,
   mismo orden de ruta por cercanía), hace CHECK-IN con GPS al llegar al dealer
   (se guarda hora, coordenadas y distancia real al punto), adjunta FOTOS de la
   visita y registra el resultado (eso último reusa PUT /api/visitas/:id/gestion,
   el motor único de gestión de visitas — aquí no se duplica).
   Solo opera sobre las visitas PROPIAS del usuario logueado.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

const ok  = (res, data) => res.json({ success: true, data, error: null });
const err = (res, code, msg) => res.status(code).json({ success: false, data: null, error: msg });

/* ── Migración ──────────────────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('visitas-terreno', async () => {
  try {
    const [cols] = await pool.query('SHOW COLUMNS FROM visitas_dealers');
    const has = c => cols.some(x => x.Field === c);
    const alters = [];
    if (!has('checkin_at'))     alters.push('ADD COLUMN checkin_at DATETIME NULL');
    if (!has('checkin_lat'))    alters.push('ADD COLUMN checkin_lat DECIMAL(10,7) NULL');
    if (!has('checkin_lng'))    alters.push('ADD COLUMN checkin_lng DECIMAL(10,7) NULL');
    if (!has('checkin_dist_m')) alters.push('ADD COLUMN checkin_dist_m INT NULL');
    if (alters.length) await pool.query('ALTER TABLE visitas_dealers ' + alters.join(', '));
    await pool.query(`
      CREATE TABLE IF NOT EXISTS visitas_fotos (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        id_visita  INT NOT NULL,
        mime       VARCHAR(40) NOT NULL,
        datos      MEDIUMBLOB NOT NULL,
        subida_por INT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX ix_visita (id_visita)
      )`);
    console.log('[visitas-terreno] módulo listo');
  } catch (e) { console.error('[visitas-terreno migration]', e.message); }
});

/* Distancia haversine en metros */
function distM(lat1, lng1, lat2, lng2) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

async function visitaPropia(req, res, id) {
  const [[v]] = await pool.query('SELECT * FROM visitas_dealers WHERE id=? LIMIT 1', [id]);
  if (!v) { err(res, 404, 'Visita no encontrada.'); return null; }
  if (v.id_usuario !== req.usuario.id_usuario) { err(res, 403, 'Solo puedes operar tus propias visitas.'); return null; }
  return v;
}

/* ── GET /api/terreno/mi-dia?fecha=YYYY-MM-DD ───────────────────────────────
   La ruta del día del ejecutivo logueado (ORDER BY id = orden de ruta por
   cercanía, igual que la Ficha diaria) + strip semanal con conteos. */
const miDia = async (req, res) => {
  try {
    const uid = req.usuario.id_usuario;
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.fecha || '')) ? req.query.fecha : null;
    if (!fecha) return err(res, 400, 'Fecha requerida.');

    const [rows] = await pool.query(
      `SELECT v.id, v.id_dealer, v.rut_dealer, v.nombre_dealer, v.comuna, v.estado, v.resultado,
              v.comentarios, v.fecha_realizada, v.seguimiento_fecha, v.seguimiento_nota,
              v.checkin_at, v.checkin_dist_m,
              d.direccion, d.direccion_parque, d.geo_dir, d.contacto, d.telefono, d.correo,
              d.cf_nombre, d.cf_telefono, d.categoria_asignada, d.lat, d.lng, d.tipo_ficha,
              d.com_6_12, d.com_13_24, d.com_25_36, d.com_37,
              (SELECT COUNT(*) FROM visitas_fotos f WHERE f.id_visita = v.id) AS fotos
         FROM visitas_dealers v LEFT JOIN dealers d ON d.id_dealer = v.id_dealer
        WHERE v.fecha_programada=? AND v.id_usuario=? ORDER BY v.id`, [fecha, uid]);

    // Última venta por dealer (mismo criterio que la Ficha diaria)
    let ult = [];
    try {
      [ult] = await pool.query(
        `SELECT rut_dealer, MAX(fecha_otorgado) ultima, COUNT(*) n FROM creditos
          WHERE rut_dealer IS NOT NULL AND fecha_otorgado IS NOT NULL GROUP BY rut_dealer`);
    } catch (_) {}
    const norm = s => String(s || '').replace(/[.\-\s]/g, '').toUpperCase();
    const mU = new Map(ult.map(r => [norm(r.rut_dealer), r]));

    const visitas = rows.map(v => ({
      ...v,
      direccion_visita: (v.geo_dir || v.direccion || v.direccion_parque || '').trim(),
      ultima_venta: mU.get(norm(v.rut_dealer))?.ultima || null,
      creditos_total: mU.get(norm(v.rut_dealer))?.n || 0,
    }));

    // Strip semanal: ±15 días con programadas/realizadas por día
    const [semana] = await pool.query(
      `SELECT DATE_FORMAT(fecha_programada,'%Y-%m-%d') f, COUNT(*) n, SUM(estado='REALIZADA') r
         FROM visitas_dealers
        WHERE id_usuario=? AND fecha_programada BETWEEN DATE_SUB(?, INTERVAL 15 DAY) AND DATE_ADD(?, INTERVAL 15 DAY)
        GROUP BY fecha_programada ORDER BY fecha_programada`, [uid, fecha, fecha]);

    ok(res, { fecha, visitas, semana });
  } catch (e) { console.error('[terreno miDia]', e); err(res, 500, 'Error interno del servidor'); }
};

/* ── POST /api/terreno/visitas/:id/checkin {lat,lng,precision} ─────────────── */
const checkin = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const v = await visitaPropia(req, res, id); if (!v) return;
    const lat = Number(req.body?.lat), lng = Number(req.body?.lng);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
      return err(res, 400, 'Coordenadas GPS inválidas.');

    // Distancia real al dealer (si el dealer está geocodificado)
    let dist = null;
    const [[d]] = await pool.query('SELECT lat, lng FROM dealers WHERE id_dealer=? LIMIT 1', [v.id_dealer]);
    if (d && d.lat != null && d.lng != null) dist = distM(lat, lng, Number(d.lat), Number(d.lng));

    await pool.query(
      'UPDATE visitas_dealers SET checkin_at=NOW(), checkin_lat=?, checkin_lng=?, checkin_dist_m=? WHERE id=?',
      [lat, lng, dist, id]);
    auditar({ req, accion: 'CHECKIN', modulo: 'visitas', entidad: 'visita', entidad_id: id,
      detalle: `Check-in en ${v.nombre_dealer}${dist != null ? ` (a ${dist} m del dealer)` : ''}`, rut: v.rut_dealer });
    ok(res, { checkin: true, dist_m: dist });
  } catch (e) { console.error('[terreno checkin]', e); err(res, 500, 'Error interno del servidor'); }
};

/* ── Fotos de la visita ─────────────────────────────────────────────────────── */
const MAX_FOTOS = 6;
const subirFoto = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const v = await visitaPropia(req, res, id); if (!v) return;
    if (!req.file) return err(res, 400, 'Adjunta la foto.');
    if (!/^image\//.test(req.file.mimetype)) return err(res, 400, 'Solo imágenes.');
    const [[c]] = await pool.query('SELECT COUNT(*) n FROM visitas_fotos WHERE id_visita=?', [id]);
    if (c.n >= MAX_FOTOS) return err(res, 409, `Máximo ${MAX_FOTOS} fotos por visita.`);
    const [r] = await pool.query(
      'INSERT INTO visitas_fotos (id_visita, mime, datos, subida_por) VALUES (?,?,?,?)',
      [id, req.file.mimetype, req.file.buffer, req.usuario.id_usuario]);
    auditar({ req, accion: 'ADJUNTAR', modulo: 'visitas', entidad: 'visita', entidad_id: id,
      detalle: `Foto de visita a ${v.nombre_dealer} (${Math.round(req.file.size / 1024)} KB)`, rut: v.rut_dealer });
    ok(res, { id_foto: r.insertId });
  } catch (e) { console.error('[terreno foto]', e); err(res, 500, 'Error interno del servidor'); }
};

const listarFotos = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const v = await visitaPropia(req, res, id); if (!v) return;
    const [rows] = await pool.query(
      'SELECT id, mime, created_at, OCTET_LENGTH(datos) bytes FROM visitas_fotos WHERE id_visita=? ORDER BY id', [id]);
    ok(res, rows);
  } catch (e) { err(res, 500, 'Error interno del servidor'); }
};

const verFoto = async (req, res) => {
  try {
    const [[f]] = await pool.query('SELECT f.*, v.id_usuario FROM visitas_fotos f JOIN visitas_dealers v ON v.id=f.id_visita WHERE f.id=? LIMIT 1',
      [parseInt(req.params.idFoto)]);
    if (!f) return err(res, 404, 'Foto no encontrada.');
    if (f.id_usuario !== req.usuario.id_usuario) return err(res, 403, 'Sin acceso.');
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.end(f.datos);
  } catch (e) { err(res, 500, 'Error interno del servidor'); }
};

const borrarFoto = async (req, res) => {
  try {
    const [[f]] = await pool.query('SELECT f.id, f.id_visita, v.id_usuario, v.nombre_dealer FROM visitas_fotos f JOIN visitas_dealers v ON v.id=f.id_visita WHERE f.id=? LIMIT 1',
      [parseInt(req.params.idFoto)]);
    if (!f) return err(res, 404, 'Foto no encontrada.');
    if (f.id_usuario !== req.usuario.id_usuario) return err(res, 403, 'Sin acceso.');
    await pool.query('DELETE FROM visitas_fotos WHERE id=?', [f.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'visitas', entidad: 'visita_foto', entidad_id: f.id,
      detalle: `Eliminó foto de visita a ${f.nombre_dealer}` });
    ok(res, { eliminada: true });
  } catch (e) { err(res, 500, 'Error interno del servidor'); }
};

module.exports = { miDia, checkin, subirFoto, listarFotos, verFoto, borrarFoto };
