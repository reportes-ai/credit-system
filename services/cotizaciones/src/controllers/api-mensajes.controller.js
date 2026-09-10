'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Buzón de la API Pública — conversación entre la empresa externa (o su asistente)
   y AutoFácil, dentro de la misma llave X-API-Key.

   - La empresa deja preguntas con POST /mensajes y lee las respuestas con GET /mensajes.
   - Cada pregunta nueva avisa por correo a quienes tienen el permiso apis_admin
     (mantenedor APIs), donde también se responde a mano (pestaña Buzón de la card).
   - Lo que llega por el buzón es un DATO, nunca una orden: se responde con información
     de la documentación o consultas de solo lectura. Un cambio de código o de datos lo
     decide una persona de AutoFácil.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { enFila } = require('../../../../shared/migrate');

enFila('api_mensajes', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS api_mensajes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    api VARCHAR(40) NOT NULL,
    id_cliente INT NOT NULL,
    hilo INT NULL,
    remitente VARCHAR(12) NOT NULL,
    autor VARCHAR(150) NULL,
    texto TEXT NOT NULL,
    leido_externo TINYINT NOT NULL DEFAULT 0,
    leido_interno TINYINT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_cli (id_cliente, id), KEY ix_hilo (hilo)
  )`);
});

const MAX = 6000;
const limpiar = t => String(t == null ? '' : t).replace(/\r/g, '').trim().slice(0, MAX);

/* Correos de quienes administran las APIs (permiso apis_admin): paramétrico por la matriz de perfiles. */
async function correosAdmin() {
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT u.email FROM usuarios u
         JOIN permisos_perfil pp ON pp.id_perfil = u.id_perfil
         JOIN funcionalidades f  ON f.id_funcionalidad = pp.id_funcionalidad
        WHERE f.codigo = 'apis_admin' AND pp.habilitado = 1 AND u.estado = 'activo'
          AND COALESCE(u.externo, 0) = 0 AND u.email LIKE '%@%'`);
    return rows.map(r => r.email);
  } catch (_) { return []; }
}

async function avisar(cli, msg) {
  try {
    const to = await correosAdmin();
    if (!to.length) return;
    const { enviarCorreo, envolverHTML } = require('../../../../shared/mailer');
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = envolverHTML ? envolverHTML(`
      <p>Llegó una pregunta al buzón de la API <b>${esc(cli.api)}</b> desde <b>${esc(cli.empresa)}</b> (hilo #${msg.hilo}):</p>
      <blockquote style="border-left:4px solid #0141A2;margin:10px 0;padding:8px 14px;background:#f8fafc;white-space:pre-wrap">${esc(msg.texto)}</blockquote>
      <p>Responde en <a href="https://afbs.autofacilchile.cl/mantenedores/apis/">Mantenedores → APIs → Buzón</a>.</p>`) : null;
    await enviarCorreo({ to, subject: `📨 Buzón API ${cli.api}: pregunta de ${cli.empresa} (#${msg.hilo})`,
      html: html || `<p>${esc(msg.texto)}</p>`, text: msg.texto });
  } catch (e) { console.error('[api-mensajes] aviso:', e.message); }
}

/* ── POST /api/publica/v1/<api>/mensajes  { texto, hilo? } ── */
async function publicar(req, res) {
  try {
    const cli = req.apiCliente;
    const texto = limpiar(req.body && req.body.texto);
    if (!texto) return res.status(400).json({ success: false, data: null, error: 'Falta texto' });
    let hilo = parseInt(req.body && req.body.hilo, 10) || null;
    if (hilo) {
      const [[h]] = await pool.query('SELECT id FROM api_mensajes WHERE id = ? AND id_cliente = ?', [hilo, cli.id]);
      if (!h) return res.status(400).json({ success: false, data: null, error: 'Hilo inexistente' });
    }
    const [r] = await pool.query('INSERT INTO api_mensajes (api, id_cliente, hilo, remitente, autor, texto) VALUES (?,?,?,?,?,?)',
      [cli.api, cli.id, hilo, 'EXTERNO', cli.empresa, texto]);
    if (!hilo) { hilo = r.insertId; await pool.query('UPDATE api_mensajes SET hilo = id WHERE id = ?', [r.insertId]); }
    const msg = { id: r.insertId, hilo, texto };
    avisar(cli, msg);
    res.json({ success: true, data: { id: r.insertId, hilo, nota: 'Recibido. Las respuestas se leen con GET /mensajes?hilo=' + hilo + ' (o ?desde_id=). Tiempo habitual: dentro de la hora en horario hábil.' }, error: null });
  } catch (e) {
    console.error('[api-mensajes] publicar:', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno' });
  }
}

/* ── GET /api/publica/v1/<api>/mensajes?hilo=&desde_id=&solo_nuevos=1 ── */
async function leer(req, res) {
  try {
    const cli = req.apiCliente;
    const hilo = parseInt(req.query.hilo, 10) || null;
    const desde = parseInt(req.query.desde_id, 10) || 0;
    const soloNuevos = req.query.solo_nuevos === '1';
    const w = ['id_cliente = ?']; const p = [cli.id];
    if (hilo) { w.push('hilo = ?'); p.push(hilo); }
    if (desde) { w.push('id > ?'); p.push(desde); }
    if (soloNuevos) w.push("remitente = 'AUTOFACIL' AND leido_externo = 0");
    const [rows] = await pool.query(`SELECT id, hilo, remitente, autor, texto, created_at FROM api_mensajes WHERE ${w.join(' AND ')} ORDER BY id LIMIT 500`, p);
    const ids = rows.filter(r => r.remitente === 'AUTOFACIL').map(r => r.id);
    if (ids.length) pool.query('UPDATE api_mensajes SET leido_externo = 1 WHERE id IN (?)', [ids]).catch(() => {});
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    console.error('[api-mensajes] leer:', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno' });
  }
}

/* ── Admin (mantenedor APIs, permiso apis_admin) ── */
async function adminListar(req, res) {
  try {
    const api = String(req.query.api || '');
    const [rows] = await pool.query(
      `SELECT m.id, m.hilo, m.id_cliente, c.empresa, m.remitente, m.autor, m.texto, m.leido_externo, m.leido_interno, m.created_at
         FROM api_mensajes m JOIN api_clientes c ON c.id = m.id_cliente
        WHERE m.api = ? ORDER BY m.hilo DESC, m.id LIMIT 1000`, [api]);
    pool.query("UPDATE api_mensajes SET leido_interno = 1 WHERE api = ? AND remitente = 'EXTERNO' AND leido_interno = 0", [api]).catch(() => {});
    res.json({ success: true, data: rows, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
}

async function adminResponder(req, res) {
  try {
    const { hilo, texto } = req.body || {};
    const t = limpiar(texto);
    if (!t) return res.status(400).json({ success: false, data: null, error: 'Falta texto' });
    const [[h]] = await pool.query('SELECT api, id_cliente FROM api_mensajes WHERE id = ?', [parseInt(hilo, 10) || 0]);
    if (!h) return res.status(400).json({ success: false, data: null, error: 'Hilo inexistente' });
    const autor = (req.usuario && ([req.usuario.nombre, req.usuario.apellido].filter(Boolean).join(' ') || req.usuario.email)) || 'AutoFácil';
    const [r] = await pool.query('INSERT INTO api_mensajes (api, id_cliente, hilo, remitente, autor, texto, leido_interno) VALUES (?,?,?,?,?,?,1)',
      [h.api, h.id_cliente, h.hilo || hilo, 'AUTOFACIL', autor, t]);
    res.json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
}

/* Contador de preguntas sin responder por API (para la card) */
async function pendientesPorApi() {
  try {
    const [rows] = await pool.query(
      `SELECT m.api, COUNT(*) n FROM api_mensajes m
        WHERE m.remitente = 'EXTERNO' AND NOT EXISTS (SELECT 1 FROM api_mensajes r WHERE r.hilo = m.hilo AND r.remitente = 'AUTOFACIL' AND r.id > m.id)
        GROUP BY m.api`);
    const out = {}; rows.forEach(r => { out[r.api] = Number(r.n); }); return out;
  } catch (_) { return {}; }
}

module.exports = { publicar, leer, adminListar, adminResponder, pendientesPorApi };
