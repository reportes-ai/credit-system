'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   FACILBOOK — la red social interna de AutoFácil 😄
   · Muro: publicaciones con fotos, me gusta y comentarios
   · Marketplace: compra-venta entre colaboradores (foto, precio, estado)
   Fotos de perfil: fuente única = /api/credenciales/fotos (no se duplican aquí).
   Solo el autor (o Admin) puede eliminar su contenido. Nada se borra físico:
   eliminado=1 (rastro en BD).
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });

/* ── Migración ──────────────────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('facilbook', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS fb_posts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_usuario INT NOT NULL,
    texto TEXT,
    eliminado TINYINT(1) DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_feed (eliminado, created_at)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fb_fotos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_post INT NOT NULL,
    foto MEDIUMBLOB,
    mime VARCHAR(40) DEFAULT 'image/jpeg',
    INDEX idx_post (id_post)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fb_likes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_post INT NOT NULL,
    id_usuario INT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_like (id_post, id_usuario)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fb_comentarios (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_post INT NOT NULL,
    id_usuario INT NOT NULL,
    texto TEXT,
    eliminado TINYINT(1) DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_post (id_post, eliminado)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fb_market_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_usuario INT NOT NULL,
    titulo VARCHAR(120) NOT NULL,
    descripcion TEXT,
    precio INT NOT NULL DEFAULT 0,
    estado VARCHAR(15) DEFAULT 'DISPONIBLE',
    eliminado TINYINT(1) DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_market (eliminado, estado, created_at)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fb_market_fotos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_item INT NOT NULL,
    foto MEDIUMBLOB,
    mime VARCHAR(40) DEFAULT 'image/jpeg',
    INDEX idx_item (id_item)
  )`);
});

/* ── Helpers ────────────────────────────────────────────────────────────────── */
const MAX_FOTO = 2 * 1024 * 1024;   // 2 MB por foto (el frontend comprime a 1280px)
const MAX_FOTOS_POST = 4;

function esAdmin(req) { return Number(req.usuario?.id_perfil) === 1; }

function b64aBuffer(dataUrl) {
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_FOTO) return null;
  return { buf, mime: m[1] };
}

// Regla negocio (memoria "nombres de empleados"): primer nombre + apellido paterno
function nombreCorto(nombre, apellido) {
  const n = String(nombre || '').trim().split(/\s+/)[0] || '';
  return (n + ' ' + String(apellido || '').trim()).trim() || '¿?';
}

/* ── MURO ───────────────────────────────────────────────────────────────────── */
exports.getFeed = async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 20, 50);
    const antes  = parseInt(req.query.antes_id) || 0;   // paginación por cursor
    const where  = antes ? 'p.eliminado=0 AND p.id < ?' : 'p.eliminado=0';
    const params = antes ? [antes, limit] : [limit];
    const [posts] = await pool.query(
      `SELECT p.id, p.id_usuario, p.texto, p.created_at, u.nombre AS autor_n, u.apellido AS autor_a
         FROM fb_posts p JOIN usuarios u ON u.id_usuario = p.id_usuario
        WHERE ${where} ORDER BY p.id DESC LIMIT ?`, params);
    if (!posts.length) return ok(res, { posts: [] });

    const ids = posts.map(p => p.id);
    const [fotos, likes, coms] = await Promise.all([
      pool.query(`SELECT id, id_post FROM fb_fotos WHERE id_post IN (?)`, [ids]).then(r => r[0]),
      pool.query(`SELECT id_post, id_usuario FROM fb_likes WHERE id_post IN (?)`, [ids]).then(r => r[0]),
      pool.query(`SELECT c.id, c.id_post, c.texto, c.created_at, c.id_usuario, u.nombre AS autor_n, u.apellido AS autor_a
                    FROM fb_comentarios c JOIN usuarios u ON u.id_usuario = c.id_usuario
                   WHERE c.id_post IN (?) AND c.eliminado=0 ORDER BY c.id`, [ids]).then(r => r[0]),
    ]);
    const yo = req.usuario.id_usuario;
    const data = posts.map(p => ({
      ...p,
      autor: nombreCorto(p.autor_n, p.autor_a), autor_n: undefined, autor_a: undefined,
      mio: p.id_usuario === yo,
      fotos: fotos.filter(f => f.id_post === p.id).map(f => f.id),
      likes: likes.filter(l => l.id_post === p.id).length,
      me_gusta: likes.some(l => l.id_post === p.id && l.id_usuario === yo),
      comentarios: coms.filter(c => c.id_post === p.id).map(c => ({
        id: c.id, texto: c.texto, created_at: c.created_at, id_usuario: c.id_usuario,
        autor: nombreCorto(c.autor_n, c.autor_a), mio: c.id_usuario === yo,
      })),
    }));
    ok(res, { posts: data });
  } catch (e) { fail(res, e.message); }
};

exports.crearPost = async (req, res) => {
  try {
    const texto = String(req.body.texto || '').trim().slice(0, 5000);
    const fotos = Array.isArray(req.body.fotos) ? req.body.fotos.slice(0, MAX_FOTOS_POST) : [];
    if (!texto && !fotos.length) return fail(res, 'Escribe algo o sube una foto', 400);
    const [r] = await pool.query(`INSERT INTO fb_posts (id_usuario, texto) VALUES (?, ?)`,
      [req.usuario.id_usuario, texto]);
    for (const f of fotos) {
      const b = b64aBuffer(f);
      if (b) await pool.query(`INSERT INTO fb_fotos (id_post, foto, mime) VALUES (?,?,?)`, [r.insertId, b.buf, b.mime]);
    }
    ok(res, { id: r.insertId });
  } catch (e) { fail(res, e.message); }
};

exports.eliminarPost = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [[p]] = await pool.query(`SELECT id_usuario FROM fb_posts WHERE id=? AND eliminado=0`, [id]);
    if (!p) return fail(res, 'No existe', 404);
    if (p.id_usuario !== req.usuario.id_usuario && !esAdmin(req)) return fail(res, 'Solo el autor puede eliminar', 403);
    await pool.query(`UPDATE fb_posts SET eliminado=1 WHERE id=?`, [id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'facilbook', entidad: 'fb_post', entidad_id: id });
    ok(res, { id });
  } catch (e) { fail(res, e.message); }
};

exports.verFoto = async (req, res) => {
  try {
    const [[f]] = await pool.query(
      `SELECT f.foto, f.mime FROM fb_fotos f JOIN fb_posts p ON p.id=f.id_post
        WHERE f.id=? AND p.eliminado=0`, [parseInt(req.params.id)]);
    if (!f) return res.status(404).end();
    res.set('Content-Type', f.mime).set('Cache-Control', 'private, max-age=86400').send(f.foto);
  } catch (e) { fail(res, e.message); }
};

exports.toggleLike = async (req, res) => {
  try {
    const id = parseInt(req.params.id), yo = req.usuario.id_usuario;
    const [r] = await pool.query(`DELETE FROM fb_likes WHERE id_post=? AND id_usuario=?`, [id, yo]);
    if (!r.affectedRows) await pool.query(`INSERT IGNORE INTO fb_likes (id_post, id_usuario) VALUES (?,?)`, [id, yo]);
    const [[c]] = await pool.query(`SELECT COUNT(*) n FROM fb_likes WHERE id_post=?`, [id]);
    ok(res, { likes: c.n, me_gusta: !r.affectedRows });
  } catch (e) { fail(res, e.message); }
};

exports.comentar = async (req, res) => {
  try {
    const texto = String(req.body.texto || '').trim().slice(0, 1000);
    if (!texto) return fail(res, 'Comentario vacío', 400);
    const [r] = await pool.query(`INSERT INTO fb_comentarios (id_post, id_usuario, texto) VALUES (?,?,?)`,
      [parseInt(req.params.id), req.usuario.id_usuario, texto]);
    ok(res, { id: r.insertId });
  } catch (e) { fail(res, e.message); }
};

exports.eliminarComentario = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [[c]] = await pool.query(`SELECT id_usuario FROM fb_comentarios WHERE id=? AND eliminado=0`, [id]);
    if (!c) return fail(res, 'No existe', 404);
    if (c.id_usuario !== req.usuario.id_usuario && !esAdmin(req)) return fail(res, 'Solo el autor', 403);
    await pool.query(`UPDATE fb_comentarios SET eliminado=1 WHERE id=?`, [id]);
    ok(res, { id });
  } catch (e) { fail(res, e.message); }
};

/* ── MARKETPLACE ────────────────────────────────────────────────────────────── */
exports.getMarket = async (req, res) => {
  try {
    const soloDisp = String(req.query.todos || '') !== '1';
    const [items] = await pool.query(
      `SELECT m.id, m.id_usuario, m.titulo, m.descripcion, m.precio, m.estado, m.created_at, u.nombre AS vend_n, u.apellido AS vend_a
         FROM fb_market_items m JOIN usuarios u ON u.id_usuario = m.id_usuario
        WHERE m.eliminado=0 ${soloDisp ? "AND m.estado='DISPONIBLE'" : ''}
        ORDER BY m.id DESC LIMIT 200`);
    if (!items.length) return ok(res, { items: [] });
    const [fotos] = await pool.query(`SELECT id, id_item FROM fb_market_fotos WHERE id_item IN (?)`,
      [items.map(i => i.id)]);
    const yo = req.usuario.id_usuario;
    ok(res, { items: items.map(i => ({
      ...i, vendedor: nombreCorto(i.vend_n, i.vend_a), vend_n: undefined, vend_a: undefined, mio: i.id_usuario === yo,
      fotos: fotos.filter(f => f.id_item === i.id).map(f => f.id),
    })) });
  } catch (e) { fail(res, e.message); }
};

exports.crearItem = async (req, res) => {
  try {
    const titulo = String(req.body.titulo || '').trim().slice(0, 120);
    const precio = Math.max(0, parseInt(req.body.precio) || 0);
    if (!titulo) return fail(res, 'Falta el título', 400);
    const [r] = await pool.query(
      `INSERT INTO fb_market_items (id_usuario, titulo, descripcion, precio) VALUES (?,?,?,?)`,
      [req.usuario.id_usuario, titulo, String(req.body.descripcion || '').trim().slice(0, 2000), precio]);
    const fotos = Array.isArray(req.body.fotos) ? req.body.fotos.slice(0, MAX_FOTOS_POST) : [];
    for (const f of fotos) {
      const b = b64aBuffer(f);
      if (b) await pool.query(`INSERT INTO fb_market_fotos (id_item, foto, mime) VALUES (?,?,?)`, [r.insertId, b.buf, b.mime]);
    }
    ok(res, { id: r.insertId });
  } catch (e) { fail(res, e.message); }
};

exports.actualizarItem = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [[m]] = await pool.query(`SELECT id_usuario FROM fb_market_items WHERE id=? AND eliminado=0`, [id]);
    if (!m) return fail(res, 'No existe', 404);
    if (m.id_usuario !== req.usuario.id_usuario && !esAdmin(req)) return fail(res, 'Solo el vendedor', 403);
    if (req.body.estado && ['DISPONIBLE', 'VENDIDO'].includes(req.body.estado))
      await pool.query(`UPDATE fb_market_items SET estado=? WHERE id=?`, [req.body.estado, id]);
    if (req.body.eliminar === true) {
      await pool.query(`UPDATE fb_market_items SET eliminado=1 WHERE id=?`, [id]);
      auditar({ req, accion: 'ELIMINAR', modulo: 'facilbook', entidad: 'fb_market_item', entidad_id: id });
    }
    ok(res, { id });
  } catch (e) { fail(res, e.message); }
};

exports.verFotoMarket = async (req, res) => {
  try {
    const [[f]] = await pool.query(
      `SELECT f.foto, f.mime FROM fb_market_fotos f JOIN fb_market_items m ON m.id=f.id_item
        WHERE f.id=? AND m.eliminado=0`, [parseInt(req.params.id)]);
    if (!f) return res.status(404).end();
    res.set('Content-Type', f.mime).set('Cache-Control', 'private, max-age=86400').send(f.foto);
  } catch (e) { fail(res, e.message); }
};
