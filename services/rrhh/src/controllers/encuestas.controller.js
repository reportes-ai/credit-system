'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   ENCUESTAS DE CLIMA / PULSO / eNPS — anónimas de verdad.
   · Las respuestas se guardan SIN ningún vínculo con la persona; en una tabla
     aparte solo se marca quién ya respondió (para no duplicar y recordar).
   · Tipos de pregunta: ESCALA (1-5), ENPS (0-10, score = %promotores 9-10
     − %detractores 0-6), SI_NO y TEXTO (comentarios sin autor).
   · Plantillas seed (clima 10 preguntas, pulso 3, eNPS 1) — todo editable.
   · Resultados solo para RRHH (rh_colaboradores) y solo agregados; los
     resultados no se muestran si respondieron menos de 3 personas.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { tieneFunc } = require('../../../../shared/middleware/permisos');
const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');
const anthropic = require('../../../../shared/anthropic');
const ia = require('../../../../shared/ia');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });
const MIN_RESPUESTAS = 3; // bajo esto no se muestran resultados (protege el anonimato)

require('../../../../shared/migrate').enFila('rrhh-encuestas', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_enc_encuestas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    titulo VARCHAR(200) NOT NULL,
    descripcion VARCHAR(500) NULL,
    tipo VARCHAR(12) DEFAULT 'CLIMA',
    estado VARCHAR(12) DEFAULT 'BORRADOR',
    fecha_cierre DATE NULL,
    creado_por INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_enc_preguntas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_encuesta INT NOT NULL,
    orden INT DEFAULT 0,
    texto VARCHAR(400) NOT NULL,
    tipo VARCHAR(10) DEFAULT 'ESCALA',
    INDEX idx_enc (id_encuesta)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_enc_respuestas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_encuesta INT NOT NULL,
    id_pregunta INT NOT NULL,
    valor INT NULL,
    texto TEXT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_enc (id_encuesta), INDEX idx_preg (id_pregunta)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_enc_participaciones (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_encuesta INT NOT NULL,
    id_usuario INT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_enc_usuario (id_encuesta, id_usuario)
  )`);
  for (const col of ['informe_ia LONGTEXT NULL', 'informe_ia_fecha DATETIME NULL', 'informe_ia_modelo VARCHAR(60) NULL'])
    try { await pool.query('ALTER TABLE rh_enc_encuestas ADD COLUMN ' + col); } catch (e) { if (e.errno !== 1060) throw e; }
  await ia.registrarFuncionalidad({ codigo: 'enc_clima_informe', nombre: 'Informe Encuestas de Clima',
    descripcion: 'Redacta un informe ejecutivo de los resultados agregados de una encuesta de clima/pulso/eNPS (se guarda permanente en la encuesta)',
    modelo: 'claude-opus-4-8' });
  const [[modRRHH]] = await pool.query(`SELECT id_modulo FROM modulos WHERE ruta='/recursos-humanos/' LIMIT 1`);
  if (modRRHH) {
    const [[f]] = await pool.query(`SELECT id_funcionalidad FROM funcionalidades WHERE codigo='rh_encuestas' LIMIT 1`);
    if (!f) {
      const [r] = await pool.query(`INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
        VALUES (?, 'Encuestas de Clima', 'rh_encuestas', '/recursos-humanos/encuestas/', 'bi-emoji-smile')`, [modRRHH.id_modulo]);
      await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
                        SELECT p.id_perfil, ?, 1 FROM perfiles p`, [r.insertId]);
    }
  }
});

const PLANTILLAS = {
  CLIMA: [
    ['Me siento orgulloso(a) de trabajar en AutoFácil', 'ESCALA'],
    ['Mi jefatura me trata con respeto y me da feedback útil', 'ESCALA'],
    ['Tengo claridad sobre lo que se espera de mi trabajo', 'ESCALA'],
    ['Cuento con las herramientas y sistemas para hacer bien mi trabajo', 'ESCALA'],
    ['Mi carga de trabajo es razonable y puedo equilibrar trabajo y vida personal', 'ESCALA'],
    ['En mi equipo nos apoyamos y trabajamos bien juntos', 'ESCALA'],
    ['Siento que mi trabajo es reconocido y valorado', 'ESCALA'],
    ['Veo oportunidades de aprender y crecer en la empresa', 'ESCALA'],
    ['La comunicación de la empresa es clara y oportuna', 'ESCALA'],
    ['Mi remuneración es justa para el trabajo que realizo', 'ESCALA'],
    ['¿Qué es lo mejor de trabajar aquí y qué mejorarías?', 'TEXTO'],
  ],
  PULSO: [
    ['¿Cómo te sentiste en el trabajo esta semana?', 'ESCALA'],
    ['¿Tuviste lo necesario para hacer bien tu trabajo?', 'ESCALA'],
    ['¿Algo que quieras comentar?', 'TEXTO'],
  ],
  ENPS: [
    ['En una escala de 0 a 10, ¿qué tan probable es que recomiendes AutoFácil como lugar para trabajar?', 'ENPS'],
    ['¿Por qué esa nota?', 'TEXTO'],
  ],
};

const esRRHH = req => tieneFunc(req.usuario.id_usuario, 'rh_colaboradores', 'rh_aprobar').catch(() => false);

/* ── Colaborador: pendientes y responder ────────────────────────────────────── */
exports.pendientes = async (req, res) => {
  try {
    const [encs] = await pool.query(
      `SELECT e.id, e.titulo, e.descripcion, e.tipo, DATE_FORMAT(e.fecha_cierre,'%Y-%m-%d') fecha_cierre,
              (SELECT COUNT(*) FROM rh_enc_participaciones p WHERE p.id_encuesta=e.id AND p.id_usuario=?) respondida
         FROM rh_enc_encuestas e WHERE e.estado='ABIERTA' ORDER BY e.id DESC`, [req.usuario.id_usuario]);
    const ids = encs.map(e => e.id);
    const [pregs] = ids.length ? await pool.query(`SELECT * FROM rh_enc_preguntas WHERE id_encuesta IN (?) ORDER BY orden`, [ids]) : [[]];
    ok(res, { encuestas: encs.map(e => ({ ...e, respondida: !!e.respondida, preguntas: pregs.filter(p => p.id_encuesta === e.id) })) });
  } catch (e) { fail(res, e.message); }
};

exports.responder = async (req, res) => {
  try {
    const b = req.body || {};
    const idEnc = parseInt(b.id_encuesta);
    const [[enc]] = await pool.query(`SELECT * FROM rh_enc_encuestas WHERE id=? AND estado='ABIERTA'`, [idEnc]);
    if (!enc) return fail(res, 'La encuesta no está abierta', 404);
    const [[ya]] = await pool.query(`SELECT 1 ok FROM rh_enc_participaciones WHERE id_encuesta=? AND id_usuario=?`, [idEnc, req.usuario.id_usuario]);
    if (ya) return fail(res, 'Ya respondiste esta encuesta', 409);
    const [pregs] = await pool.query(`SELECT * FROM rh_enc_preguntas WHERE id_encuesta=?`, [idEnc]);
    let alguna = false;
    for (const p of pregs) {
      const r = (b.respuestas || []).find(x => parseInt(x.id_pregunta) === p.id);
      if (!r) continue;
      if (p.tipo === 'TEXTO') {
        const t = String(r.texto || '').trim().slice(0, 3000);
        if (!t) continue;
        await pool.query(`INSERT INTO rh_enc_respuestas (id_encuesta, id_pregunta, texto) VALUES (?,?,?)`, [idEnc, p.id, t]);
      } else {
        const max = p.tipo === 'ENPS' ? 10 : (p.tipo === 'SI_NO' ? 1 : 5);
        const min = p.tipo === 'ENPS' || p.tipo === 'SI_NO' ? 0 : 1;
        const v = parseInt(r.valor);
        if (isNaN(v) || v < min || v > max) continue;
        await pool.query(`INSERT INTO rh_enc_respuestas (id_encuesta, id_pregunta, valor) VALUES (?,?,?)`, [idEnc, p.id, v]);
      }
      alguna = true;
    }
    if (!alguna) return fail(res, 'Responde al menos una pregunta', 400);
    // la participación se registra APARTE: las respuestas quedan sin vínculo con la persona
    await pool.query(`INSERT INTO rh_enc_participaciones (id_encuesta, id_usuario) VALUES (?,?)`, [idEnc, req.usuario.id_usuario]);
    ok(res, { ok: true });
  } catch (e) { fail(res, e.message); }
};

/* ── RRHH: gestión ──────────────────────────────────────────────────────────── */
exports.lista = async (req, res) => {
  try {
    if (!await esRRHH(req)) return fail(res, 'Solo RRHH', 403);
    const [[act]] = await pool.query(`SELECT COUNT(*) n FROM usuarios WHERE estado='activo' AND COALESCE(protegido,0)=0`);
    const [encs] = await pool.query(
      `SELECT e.*, (SELECT COUNT(*) FROM rh_enc_participaciones p WHERE p.id_encuesta=e.id) respuestas
         FROM rh_enc_encuestas e ORDER BY e.id DESC LIMIT 200`);
    ok(res, { encuestas: encs, activos: act.n, plantillas: PLANTILLAS });
  } catch (e) { fail(res, e.message); }
};

exports.guardar = async (req, res) => {
  try {
    if (!await esRRHH(req)) return fail(res, 'Solo RRHH', 403);
    const b = req.body || {};
    if (!String(b.titulo || '').trim()) return fail(res, 'Falta el título', 400);
    const preguntas = (b.preguntas || []).filter(p => String(p.texto || '').trim());
    if (!preguntas.length) return fail(res, 'Agrega al menos una pregunta', 400);
    const tipo = ['CLIMA', 'PULSO', 'ENPS', 'OTRA'].includes(b.tipo) ? b.tipo : 'CLIMA';
    let id = parseInt(b.id) || 0;
    if (id) {
      const [[enc]] = await pool.query(`SELECT estado FROM rh_enc_encuestas WHERE id=?`, [id]);
      if (!enc || enc.estado !== 'BORRADOR') return fail(res, 'Solo se editan encuestas en borrador', 400);
      await pool.query(`UPDATE rh_enc_encuestas SET titulo=?, descripcion=?, tipo=?, fecha_cierre=? WHERE id=?`,
        [String(b.titulo).trim().slice(0, 200), String(b.descripcion || '').slice(0, 500) || null, tipo, b.fecha_cierre || null, id]);
      await pool.query(`DELETE FROM rh_enc_preguntas WHERE id_encuesta=?`, [id]);
    } else {
      const [r] = await pool.query(`INSERT INTO rh_enc_encuestas (titulo, descripcion, tipo, fecha_cierre, creado_por) VALUES (?,?,?,?,?)`,
        [String(b.titulo).trim().slice(0, 200), String(b.descripcion || '').slice(0, 500) || null, tipo, b.fecha_cierre || null, req.usuario.id_usuario]);
      id = r.insertId;
    }
    let i = 0;
    for (const p of preguntas)
      await pool.query(`INSERT INTO rh_enc_preguntas (id_encuesta, orden, texto, tipo) VALUES (?,?,?,?)`,
        [id, i++, String(p.texto).slice(0, 400), ['ESCALA', 'ENPS', 'SI_NO', 'TEXTO'].includes(p.tipo) ? p.tipo : 'ESCALA']);
    ok(res, { id });
  } catch (e) { fail(res, e.message); }
};

exports.abrir = async (req, res) => {
  try {
    if (!await esRRHH(req)) return fail(res, 'Solo RRHH', 403);
    const id = parseInt(req.params.id);
    const [[enc]] = await pool.query(`SELECT * FROM rh_enc_encuestas WHERE id=?`, [id]);
    if (!enc) return fail(res, 'No encontrada', 404);
    await pool.query(`UPDATE rh_enc_encuestas SET estado='ABIERTA' WHERE id=?`, [id]);
    const [us] = await pool.query(`SELECT id_usuario FROM usuarios WHERE estado='activo' AND COALESCE(protegido,0)=0`);
    notificar(us.map(u => u.id_usuario), {
      tipo: 'RRHH', prioridad: 'media', titulo: `Encuesta: ${enc.titulo}`,
      mensaje: 'Tu opinión es anónima y ayuda a mejorar — respóndela en Encuestas de Clima',
      href: '/recursos-humanos/encuestas/', clave: `enc_abre_${id}` });
    ok(res, { ok: true, avisados: us.length });
  } catch (e) { fail(res, e.message); }
};

exports.cerrar = async (req, res) => {
  try {
    if (!await esRRHH(req)) return fail(res, 'Solo RRHH', 403);
    await pool.query(`UPDATE rh_enc_encuestas SET estado='CERRADA' WHERE id=?`, [parseInt(req.params.id)]);
    ok(res, { ok: true });
  } catch (e) { fail(res, e.message); }
};

exports.eliminar = async (req, res) => {
  try {
    if (!await esRRHH(req)) return fail(res, 'Solo RRHH', 403);
    const id = parseInt(req.params.id);
    const [[enc]] = await pool.query(`SELECT estado FROM rh_enc_encuestas WHERE id=?`, [id]);
    if (!enc || enc.estado !== 'BORRADOR') return fail(res, 'Solo se eliminan borradores', 400);
    await pool.query(`DELETE FROM rh_enc_preguntas WHERE id_encuesta=?`, [id]);
    await pool.query(`DELETE FROM rh_enc_encuestas WHERE id=?`, [id]);
    ok(res, { ok: true });
  } catch (e) { fail(res, e.message); }
};

/* ── Resultados agregados (RRHH; mínimo 3 respuestas) ───────────────────────── */
async function agregados(id) {
  const [[enc]] = await pool.query(`SELECT * FROM rh_enc_encuestas WHERE id=?`, [id]);
  if (!enc) return null;
  const [[part]] = await pool.query(`SELECT COUNT(*) n FROM rh_enc_participaciones WHERE id_encuesta=?`, [id]);
  if (part.n < MIN_RESPUESTAS) return { encuesta: enc, participantes: part.n, minimo: MIN_RESPUESTAS, preguntas: null };
  const [pregs] = await pool.query(`SELECT * FROM rh_enc_preguntas WHERE id_encuesta=? ORDER BY orden`, [id]);
  const [resp] = await pool.query(`SELECT id_pregunta, valor, texto FROM rh_enc_respuestas WHERE id_encuesta=?`, [id]);
  const out = pregs.map(p => {
      const rs = resp.filter(r => r.id_pregunta === p.id);
      if (p.tipo === 'TEXTO') return { ...p, n: rs.length, comentarios: rs.map(r => r.texto).filter(Boolean) };
      const vals = rs.map(r => r.valor).filter(v => v != null);
      const dist = {};
      vals.forEach(v => dist[v] = (dist[v] || 0) + 1);
      const base = { ...p, n: vals.length, promedio: vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length * 100) / 100 : null, dist };
      if (p.tipo === 'ENPS' && vals.length) {
        const prom = vals.filter(v => v >= 9).length, det = vals.filter(v => v <= 6).length;
        base.enps = Math.round((prom - det) / vals.length * 100);
        base.promotores = prom; base.detractores = det; base.pasivos = vals.length - prom - det;
      }
      if (p.tipo === 'SI_NO' && vals.length) base.pct_si = Math.round(vals.filter(v => v === 1).length / vals.length * 100);
      return base;
  });
  return { encuesta: enc, participantes: part.n, preguntas: out };
}

exports.resultados = async (req, res) => {
  try {
    if (!await esRRHH(req)) return fail(res, 'Solo RRHH', 403);
    const data = await agregados(parseInt(req.params.id));
    if (!data) return fail(res, 'No encontrada', 404);
    ok(res, data);
  } catch (e) { fail(res, e.message); }
};

/* ── Informe IA (Opus) — se redacta sobre los agregados anónimos y queda
      guardado PERMANENTE en la encuesta (informe_ia). Solo RRHH. ─────────────── */
exports.informeIA = async (req, res) => {
  try {
    if (!await esRRHH(req)) return fail(res, 'Solo RRHH', 403);
    const id = parseInt(req.params.id);
    const data = await agregados(id);
    if (!data) return fail(res, 'No encontrada', 404);
    if (!data.preguntas) return fail(res, `Se necesitan al menos ${MIN_RESPUESTAS} respuestas para analizar`, 400);
    // Solo agregados anónimos van a la IA: promedios, distribuciones y comentarios sin autor
    const cuerpo = data.preguntas.map(p => {
      if (p.tipo === 'TEXTO') return `PREGUNTA (texto libre): ${p.texto}\nComentarios (${p.n}):\n` + (p.comentarios || []).map(c => `- ${c}`).join('\n');
      let l = `PREGUNTA (${p.tipo}): ${p.texto}\n  n=${p.n}, promedio=${p.promedio}, distribución=${JSON.stringify(p.dist)}`;
      if (p.enps != null) l += `, eNPS=${p.enps} (promotores ${p.promotores}, pasivos ${p.pasivos}, detractores ${p.detractores})`;
      if (p.pct_si != null) l += `, %Sí=${p.pct_si}%`;
      return l;
    }).join('\n\n');
    const { texto, modelo } = await anthropic.analizar({
      codigo: 'enc_clima_informe', id_usuario: req.usuario.id_usuario, max_tokens: 3000,
      system: 'Eres un consultor senior de clima organizacional. Redactas informes ejecutivos en español de Chile, claros y accionables, para la gerencia de una financiera automotriz chilena (AutoFácil). Formato: títulos en **negrita**, sin tablas. Estructura: 1) Resumen ejecutivo (3-4 líneas), 2) Fortalezas, 3) Focos de atención (lo más bajo/crítico), 4) Lectura de los comentarios (temas recurrentes, sin citar textual identificable), 5) Recomendaciones concretas priorizadas. Sé honesto: si hay señales de alerta, dilo.',
      prompt: `Encuesta "${data.encuesta.titulo}" (tipo ${data.encuesta.tipo}), ${data.participantes} participantes. Resultados agregados:\n\n${cuerpo}` });
    if (!texto) return fail(res, 'La IA no devolvió informe', 502);
    await pool.query(`UPDATE rh_enc_encuestas SET informe_ia=?, informe_ia_fecha=NOW(), informe_ia_modelo=? WHERE id=?`, [texto, modelo, id]);
    ok(res, { informe: texto, modelo });
  } catch (e) {
    if (e.code === 'IA_OFF') return fail(res, 'La IA para informes de encuestas está desactivada — actívala en el mantenedor Subsistema IA', 400);
    if (e.code === 'NO_KEY') return fail(res, 'IA no configurada en el servidor (falta ANTHROPIC_API_KEY)', 400);
    fail(res, e.message);
  }
};

/* Recordatorio semanal a quienes no han respondido encuestas abiertas */
const _w = d => { const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const dn = x.getUTCDay() || 7; x.setUTCDate(x.getUTCDate() + 4 - dn); const y1 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1)); return x.getUTCFullYear() + '_' + Math.ceil((((x - y1) / 86400000) + 1) / 7); };
async function recordarPendientes() {
  try {
    const [encs] = await pool.query(`SELECT id, titulo FROM rh_enc_encuestas WHERE estado='ABIERTA'`);
    if (!encs.length) return;
    const clave = 'enc_rec_' + _w(new Date());
    const [[ya]] = await pool.query('SELECT 1 ok FROM notificaciones WHERE clave=? LIMIT 1', [clave]);
    if (ya) return;
    const [pend] = await pool.query(
      `SELECT DISTINCT u.id_usuario FROM usuarios u
        WHERE u.estado='activo' AND COALESCE(u.protegido,0)=0
          AND EXISTS (SELECT 1 FROM rh_enc_encuestas e WHERE e.estado='ABIERTA'
                       AND NOT EXISTS (SELECT 1 FROM rh_enc_participaciones p WHERE p.id_encuesta=e.id AND p.id_usuario=u.id_usuario))`);
    if (!pend.length) return;
    notificar(pend.map(x => x.id_usuario), {
      tipo: 'RRHH', prioridad: 'media', titulo: 'Tienes encuestas por responder',
      mensaje: `Hay ${encs.length} encuesta(s) abiertas esperando tu opinión anónima`,
      href: '/recursos-humanos/encuestas/', clave });
  } catch (e) { console.error('[recordatorio encuestas]', e.message); }
}
setTimeout(recordarPendientes, 240 * 1000);
setInterval(recordarPendientes, 24 * 60 * 60 * 1000);
