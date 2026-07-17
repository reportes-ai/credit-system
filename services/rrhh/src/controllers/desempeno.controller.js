'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   EVALUACIONES DE DESEMPEÑO (anti-Buk #5)
   Ciclos de evaluación (ej: "2026 Semestre 2") que generan una evaluación por
   colaborador activo con jefatura (usuarios.id_supervisor). Flujo:
     PENDIENTE → (colaborador autoevalúa) AUTOEVAL → (jefatura evalúa
     competencias 1-5 + objetivos con peso y % cumplimiento) EVALUADA →
     (colaborador toma conocimiento) CERRADA.
   Nota final = competencias (promedio jefe, escala 1-5) ponderada con los
   objetivos (% cumplimiento llevado a 1-5) según el peso del ciclo.
   PARAMÉTRICO: competencias y ciclos se mantienen sin código (RRHH).
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { tieneFunc } = require('../../../../shared/middleware/permisos');
const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });

/* ── Migración + seed ───────────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('rrhh-desempeno', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_des_competencias (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nombre VARCHAR(120) NOT NULL,
    descripcion VARCHAR(400) NULL,
    orden INT DEFAULT 0,
    activa TINYINT(1) DEFAULT 1
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_des_ciclos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nombre VARCHAR(120) NOT NULL,
    fecha_inicio DATE NOT NULL,
    fecha_cierre DATE NOT NULL,
    peso_competencias INT DEFAULT 70,
    estado VARCHAR(12) DEFAULT 'ABIERTO',
    creado_por INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_des_evaluaciones (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_ciclo INT NOT NULL,
    id_usuario INT NOT NULL,
    id_evaluador INT NULL,
    estado VARCHAR(12) DEFAULT 'PENDIENTE',
    nota_final DECIMAL(4,2) NULL,
    fortalezas TEXT NULL,
    oportunidades TEXT NULL,
    comentario_colaborador TEXT NULL,
    autoeval_at DATETIME NULL,
    evaluada_at DATETIME NULL,
    cerrada_at DATETIME NULL,
    UNIQUE KEY uq_ciclo_usuario (id_ciclo, id_usuario),
    INDEX idx_evaluador (id_evaluador)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_des_notas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_evaluacion INT NOT NULL,
    id_competencia INT NOT NULL,
    auto TINYINT NULL,
    jefe TINYINT NULL,
    comentario VARCHAR(400) NULL,
    UNIQUE KEY uq_eval_comp (id_evaluacion, id_competencia)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_des_objetivos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_evaluacion INT NOT NULL,
    objetivo VARCHAR(300) NOT NULL,
    peso INT DEFAULT 0,
    cumplimiento INT NULL,
    INDEX idx_eval (id_evaluacion)
  )`);

  // Funcionalidad: card en RRHH para todos (cada uno ve su evaluación)
  const [[modRRHH]] = await pool.query(`SELECT id_modulo FROM modulos WHERE ruta='/recursos-humanos/' LIMIT 1`);
  if (modRRHH) {
    const [[f]] = await pool.query(`SELECT id_funcionalidad FROM funcionalidades WHERE codigo='rh_desempeno' LIMIT 1`);
    if (!f) {
      const [r] = await pool.query(`INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
        VALUES (?, 'Evaluaciones de Desempeño', 'rh_desempeno', '/recursos-humanos/desempeno/', 'bi-graph-up-arrow')`, [modRRHH.id_modulo]);
      await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
                        SELECT p.id_perfil, ?, 1 FROM perfiles p`, [r.insertId]);
    }
  }

  // Seed de competencias (solo si está vacío) — editable después sin código
  const [[n]] = await pool.query(`SELECT COUNT(*) n FROM rh_des_competencias`);
  if (!n.n) {
    const SEED = [
      ['Orientación al cliente', 'Entiende y resuelve las necesidades de clientes y dealers con calidad y oportunidad.'],
      ['Trabajo en equipo', 'Colabora, comparte información y apoya a sus compañeros para lograr los objetivos comunes.'],
      ['Responsabilidad y cumplimiento', 'Cumple plazos, procesos y compromisos; su trabajo es confiable y no hay que revisarlo dos veces.'],
      ['Proactividad e iniciativa', 'Se anticipa a los problemas, propone mejoras y no espera que le pidan las cosas.'],
      ['Conocimiento del negocio', 'Domina los productos, procesos y herramientas del Suite que su cargo requiere.'],
      ['Comunicación', 'Se expresa con claridad y respeto, escucha y mantiene informados a quienes corresponde.'],
      ['Adaptabilidad', 'Se ajusta bien a los cambios de prioridades, procesos y herramientas.'],
      ['Apego a la cultura AutoFácil', 'Vive la buena convivencia: en equipo se trabaja mejor, en comunidad se vive aún mejor.'],
    ];
    let i = 0;
    for (const [nom, desc] of SEED)
      await pool.query(`INSERT INTO rh_des_competencias (nombre, descripcion, orden) VALUES (?,?,?)`, [nom, desc, i++]);
    console.log('✓ desempeño: 8 competencias sembradas');
  }
});

const esRRHH = req => tieneFunc(req.usuario.id_usuario, 'rh_colaboradores', 'rh_aprobar').catch(() => false);
const round2 = x => Math.round(x * 100) / 100;

/* Nota final = peso_competencias% promedio jefe + resto% objetivos (cumplimiento→escala 1-5) */
async function calcularNota(idEval, pesoComp) {
  const [notas] = await pool.query(`SELECT jefe FROM rh_des_notas WHERE id_evaluacion=? AND jefe IS NOT NULL`, [idEval]);
  const promComp = notas.length ? notas.reduce((s, x) => s + x.jefe, 0) / notas.length : null;
  const [objs] = await pool.query(`SELECT peso, cumplimiento FROM rh_des_objetivos WHERE id_evaluacion=? AND cumplimiento IS NOT NULL`, [idEval]);
  const pesoTot = objs.reduce((s, o) => s + (o.peso || 0), 0);
  const promObj = pesoTot > 0
    ? objs.reduce((s, o) => s + (Math.min(100, Math.max(0, o.cumplimiento)) / 100) * (o.peso || 0), 0) / pesoTot * 4 + 1
    : null;
  if (promComp === null && promObj === null) return null;
  if (promObj === null) return round2(promComp);
  if (promComp === null) return round2(promObj);
  const w = Math.min(100, Math.max(0, pesoComp ?? 70)) / 100;
  return round2(promComp * w + promObj * (1 - w));
}

/* Carga completa de una evaluación (notas + objetivos + nombres) */
async function cargarEvals(where, params) {
  const [evals] = await pool.query(
    `SELECT e.*, c.nombre ciclo, c.fecha_inicio, c.fecha_cierre, c.peso_competencias, c.estado estado_ciclo,
            TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) colaborador, u.cargo,
            TRIM(CONCAT_WS(' ', j.nombre, j.apellido)) evaluador
       FROM rh_des_evaluaciones e
       JOIN rh_des_ciclos c ON c.id=e.id_ciclo
       JOIN usuarios u ON u.id_usuario=e.id_usuario
       LEFT JOIN usuarios j ON j.id_usuario=e.id_evaluador
      WHERE ${where} ORDER BY c.fecha_inicio DESC, e.id`, params);
  if (!evals.length) return [];
  const ids = evals.map(e => e.id);
  const [notas] = await pool.query(
    `SELECT n.*, k.nombre competencia, k.descripcion FROM rh_des_notas n
       JOIN rh_des_competencias k ON k.id=n.id_competencia
      WHERE n.id_evaluacion IN (?) ORDER BY k.orden`, [ids]);
  const [objs] = await pool.query(`SELECT * FROM rh_des_objetivos WHERE id_evaluacion IN (?) ORDER BY id`, [ids]);
  const out = evals.map(e => ({ ...e,
    notas: notas.filter(x => x.id_evaluacion === e.id),
    objetivos: objs.filter(x => x.id_evaluacion === e.id) }));
  for (const e of out) e.r360 = await resumen360(e.id).catch(() => null);
  return out;
}

/* ── Colaborador: mi evaluación + historial ─────────────────────────────────── */
exports.mi = async (req, res) => {
  try {
    const evals = await cargarEvals('e.id_usuario=?', [req.usuario.id_usuario]);
    // en las abiertas sin evaluar, el colaborador no ve las notas de la jefatura ni el 360
    for (const e of evals) if (e.estado === 'PENDIENTE' || e.estado === 'AUTOEVAL') {
      e.notas = e.notas.map(x => ({ ...x, jefe: null }));
      e.r360 = null;
    }
    const [comps] = await pool.query(`SELECT * FROM rh_des_competencias WHERE activa=1 ORDER BY orden`);
    ok(res, { evaluaciones: evals, competencias: comps });
  } catch (e) { fail(res, e.message); }
};

exports.autoeval = async (req, res) => {
  try {
    const b = req.body || {};
    const [[ev]] = await pool.query(`SELECT * FROM rh_des_evaluaciones WHERE id=?`, [parseInt(b.id_evaluacion)]);
    if (!ev || ev.id_usuario !== req.usuario.id_usuario) return fail(res, 'Evaluación no encontrada', 404);
    if (!['PENDIENTE', 'AUTOEVAL'].includes(ev.estado)) return fail(res, 'La evaluación ya fue evaluada por tu jefatura', 400);
    for (const nRaw of (b.notas || [])) {
      const auto = Math.min(5, Math.max(1, parseInt(nRaw.auto) || 0)) || null;
      if (!auto) continue;
      await pool.query(`INSERT INTO rh_des_notas (id_evaluacion, id_competencia, auto, comentario) VALUES (?,?,?,?)
                        ON DUPLICATE KEY UPDATE auto=VALUES(auto), comentario=VALUES(comentario)`,
        [ev.id, parseInt(nRaw.id_competencia), auto, String(nRaw.comentario || '').slice(0, 400) || null]);
    }
    await pool.query(`UPDATE rh_des_evaluaciones SET estado='AUTOEVAL', autoeval_at=NOW(), comentario_colaborador=? WHERE id=?`,
      [String(b.comentario || '').slice(0, 2000) || null, ev.id]);
    if (ev.id_evaluador) notificar([ev.id_evaluador], {
      tipo: 'RRHH', prioridad: 'media', titulo: 'Autoevaluación lista para revisar',
      mensaje: `${req.usuario.nombre || ''} ${req.usuario.apellido || ''} completó su autoevaluación — te toca evaluar`,
      href: '/recursos-humanos/desempeno/', clave: `des_auto_${ev.id}` });
    ok(res, { ok: true });
  } catch (e) { fail(res, e.message); }
};

exports.conocimiento = async (req, res) => {
  try {
    const [[ev]] = await pool.query(`SELECT * FROM rh_des_evaluaciones WHERE id=?`, [parseInt(req.body?.id_evaluacion)]);
    if (!ev || ev.id_usuario !== req.usuario.id_usuario) return fail(res, 'Evaluación no encontrada', 404);
    if (ev.estado !== 'EVALUADA') return fail(res, 'La evaluación aún no está evaluada', 400);
    await pool.query(`UPDATE rh_des_evaluaciones SET estado='CERRADA', cerrada_at=NOW(),
                      comentario_colaborador=COALESCE(?, comentario_colaborador) WHERE id=?`,
      [String(req.body?.comentario || '').slice(0, 2000) || null, ev.id]);
    ok(res, { ok: true });
  } catch (e) { fail(res, e.message); }
};

/* ── Jefatura: mi equipo (o todo, si es RRHH) ───────────────────────────────── */
exports.equipo = async (req, res) => {
  try {
    const rrhh = await esRRHH(req);
    const evals = rrhh && req.query.todos === '1'
      ? await cargarEvals('1=1', [])
      : await cargarEvals('e.id_evaluador=?', [req.usuario.id_usuario]);
    ok(res, { evaluaciones: evals, rrhh });
  } catch (e) { fail(res, e.message); }
};

exports.evaluar = async (req, res) => {
  try {
    const b = req.body || {};
    const [[ev]] = await pool.query(
      `SELECT e.*, c.peso_competencias FROM rh_des_evaluaciones e JOIN rh_des_ciclos c ON c.id=e.id_ciclo WHERE e.id=?`,
      [parseInt(b.id_evaluacion)]);
    if (!ev) return fail(res, 'Evaluación no encontrada', 404);
    const rrhh = await esRRHH(req);
    if (ev.id_evaluador !== req.usuario.id_usuario && !rrhh) return fail(res, 'Solo la jefatura directa o RRHH puede evaluar', 403);
    if (ev.estado === 'CERRADA') return fail(res, 'La evaluación ya está cerrada', 400);
    // La autoevaluación va PRIMERO: sin ella la jefatura puede guardar borrador, pero no finalizar
    if (b.finalizar !== false && ev.estado === 'PENDIENTE' && !(b.forzar_sin_autoeval && rrhh))
      return fail(res, 'La persona aún no completa su autoevaluación. Puedes guardar borrador y finalizar cuando la termine (el sistema te avisará por la campana).', 409);
    for (const nRaw of (b.notas || [])) {
      const jefe = Math.min(5, Math.max(1, parseInt(nRaw.jefe) || 0)) || null;
      if (!jefe) continue;
      await pool.query(`INSERT INTO rh_des_notas (id_evaluacion, id_competencia, jefe) VALUES (?,?,?)
                        ON DUPLICATE KEY UPDATE jefe=VALUES(jefe)`, [ev.id, parseInt(nRaw.id_competencia), jefe]);
    }
    await pool.query(`DELETE FROM rh_des_objetivos WHERE id_evaluacion=?`, [ev.id]);
    for (const o of (b.objetivos || [])) {
      if (!String(o.objetivo || '').trim()) continue;
      await pool.query(`INSERT INTO rh_des_objetivos (id_evaluacion, objetivo, peso, cumplimiento) VALUES (?,?,?,?)`,
        [ev.id, String(o.objetivo).slice(0, 300), Math.min(100, Math.max(0, parseInt(o.peso) || 0)),
         o.cumplimiento === null || o.cumplimiento === undefined || o.cumplimiento === '' ? null : Math.min(100, Math.max(0, parseInt(o.cumplimiento) || 0))]);
    }
    const nota = await calcularNota(ev.id, ev.peso_competencias);
    const cerrar = b.finalizar !== false;
    await pool.query(`UPDATE rh_des_evaluaciones SET fortalezas=?, oportunidades=?, nota_final=?,
                      estado=IF(?, 'EVALUADA', estado), evaluada_at=IF(?, NOW(), evaluada_at) WHERE id=?`,
      [String(b.fortalezas || '').slice(0, 2000) || null, String(b.oportunidades || '').slice(0, 2000) || null,
       nota, cerrar, cerrar, ev.id]);
    if (cerrar) notificar([ev.id_usuario], {
      tipo: 'RRHH', prioridad: 'media', titulo: 'Tu evaluación de desempeño está lista',
      mensaje: 'Tu jefatura completó tu evaluación — revísala y toma conocimiento',
      href: '/recursos-humanos/desempeno/', clave: `des_eval_${ev.id}` });
    ok(res, { ok: true, nota_final: nota });
  } catch (e) { fail(res, e.message); }
};

/* ── RRHH: ciclos ───────────────────────────────────────────────────────────── */
exports.ciclos = async (req, res) => {
  try {
    const [ciclos] = await pool.query(
      `SELECT c.*, COUNT(e.id) total,
              SUM(e.estado='CERRADA') cerradas, SUM(e.estado='EVALUADA') evaluadas,
              SUM(e.estado='AUTOEVAL') autoeval, SUM(e.estado='PENDIENTE') pendientes,
              ROUND(AVG(e.nota_final), 2) promedio
         FROM rh_des_ciclos c LEFT JOIN rh_des_evaluaciones e ON e.id_ciclo=c.id
        GROUP BY c.id ORDER BY c.fecha_inicio DESC`);
    ok(res, { ciclos });
  } catch (e) { fail(res, e.message); }
};

exports.crearCiclo = async (req, res) => {
  try {
    const b = req.body || {};
    if (!String(b.nombre || '').trim() || !b.fecha_inicio || !b.fecha_cierre) return fail(res, 'Faltan nombre o fechas', 400);
    const [r] = await pool.query(`INSERT INTO rh_des_ciclos (nombre, fecha_inicio, fecha_cierre, peso_competencias, creado_por) VALUES (?,?,?,?,?)`,
      [String(b.nombre).trim().slice(0, 120), b.fecha_inicio, b.fecha_cierre,
       Math.min(100, Math.max(0, parseInt(b.peso_competencias) ?? 70)), req.usuario.id_usuario]);
    // Una evaluación por colaborador activo; evaluador = su jefatura directa
    const [usuarios] = await pool.query(
      `SELECT u.id_usuario, u.id_supervisor FROM usuarios u LEFT JOIN rh_fichas unm ON unm.id_usuario=u.id_usuario WHERE u.estado='activo' AND COALESCE(unm.no_mostrar,0)=0`);
    const sinJefe = [];
    let creadas = 0;
    for (const u of usuarios) {
      if (!u.id_supervisor || u.id_supervisor === u.id_usuario) { sinJefe.push(u.id_usuario); continue; }
      await pool.query(`INSERT IGNORE INTO rh_des_evaluaciones (id_ciclo, id_usuario, id_evaluador) VALUES (?,?,?)`,
        [r.insertId, u.id_usuario, u.id_supervisor]);
      creadas++;
    }
    const ids = usuarios.filter(u => u.id_supervisor && u.id_supervisor !== u.id_usuario).map(u => u.id_usuario);
    if (ids.length) notificar(ids, {
      tipo: 'RRHH', prioridad: 'media', titulo: `Evaluación de desempeño: ${String(b.nombre).trim()}`,
      mensaje: 'Se abrió el ciclo — completa tu autoevaluación en Desempeño',
      href: '/recursos-humanos/desempeno/', clave: `des_ciclo_${r.insertId}` });
    // Correo de apertura: cómo funciona, a quién evalúa cada uno y los plazos
    correoAperturaCiclo(r.insertId).catch(e => console.error('[desempeño correo apertura]', e.message));
    ok(res, { id: r.insertId, creadas, sin_jefatura: sinJefe.length });
  } catch (e) { fail(res, e.message); }
};

/* Correo de apertura del ciclo: explica el proceso, a quién evalúa cada uno y los plazos */
async function correoAperturaCiclo(idCiclo) {
  const { enviarCorreo, envolverHTML } = require('../../../../shared/mailer');
  const [[ciclo]] = await pool.query(`SELECT * FROM rh_des_ciclos WHERE id=?`, [idCiclo]);
  if (!ciclo) return;
  const [evals] = await pool.query(
    `SELECT e.id_usuario, e.id_evaluador, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) colaborador,
            u.email, TRIM(CONCAT_WS(' ', j.nombre, j.apellido)) jefatura
       FROM rh_des_evaluaciones e JOIN usuarios u ON u.id_usuario=e.id_usuario
       LEFT JOIN usuarios j ON j.id_usuario=e.id_evaluador WHERE e.id_ciclo=?`, [idCiclo]);
  const fch = f => String(f instanceof Date ? f.toISOString() : f).slice(0, 10).split('-').reverse().join('-');
  const ini = fch(ciclo.fecha_inicio), fin = fch(ciclo.fecha_cierre);
  for (const e of evals) {
    if (!e.email) continue;
    const aCargo = evals.filter(x => x.id_evaluador === e.id_usuario).map(x => x.colaborador);
    const html = `
      <p>Hola ${e.colaborador.split(' ')[0]},</p>
      <p>Se abrió el ciclo de evaluación de desempeño <b>${ciclo.nombre}</b> (del ${ini} al ${fin}). Así funciona:</p>
      <ol>
        <li><b>Autoevaluación</b> (primer paso, hazla cuanto antes): entra a <a href="https://app.autofacilchile.cl/recursos-humanos/desempeno/">Desempeño → Mi Evaluación</a> y evalúate 1–5 en cada competencia. Queda guardada a la espera de tu jefatura.</li>
        <li><b>Evaluación de tu jefatura</b> (${e.jefatura || 'por asignar'}): con tu autoevaluación a la vista, evalúa las mismas competencias y tus objetivos del período.</li>
        <li><b>Feedback</b>: conversarán el resultado comparado cara a cara, y luego tomas conocimiento en el sistema.</li>
      </ol>
      ${aCargo.length ? `<p><b>Además, como jefatura te toca evaluar a:</b> ${aCargo.join(', ')} — pestaña <b>Mi Equipo</b>. Recuerda: cada evaluación se habilita cuando la persona termina su autoevaluación, y el resultado se conversa en una reunión de feedback antes de la toma de conocimiento.</p>` : ''}
      <p>Si te invitan como evaluador <b>360</b> (par, reporte o cliente interno) te avisará la campana: tu mirada es anónima y se agrega por dimensión.</p>
      <p><b>Plazo: todo el proceso debe estar cerrado el ${fin}.</b> La escala y las preguntas están en el botón "¿Cómo funciona?" de la página.</p>
      <p style="font-size:12px;color:#64748b">La nota final considera competencias (${ciclo.peso_competencias}%) y objetivos (${100 - ciclo.peso_competencias}%). La autoevaluación y el 360 no suman nota: son insumo de la conversación.</p>`;
    try {
      await enviarCorreo({ to: e.email, subject: `📊 Evaluación de Desempeño — ${ciclo.nombre} (hasta el ${fin})`, html: envolverHTML ? envolverHTML(html) : html });
    } catch (err) { console.error('[desempeño correo]', e.email, err.message); }
  }
}

exports.cerrarCiclo = async (req, res) => {
  try {
    await pool.query(`UPDATE rh_des_ciclos SET estado='CERRADO' WHERE id=?`, [parseInt(req.params.id)]);
    ok(res, { ok: true });
  } catch (e) { fail(res, e.message); }
};

exports.asignarEvaluador = async (req, res) => {
  try {
    const idEval = parseInt(req.params.id), idJefe = parseInt(req.body?.id_evaluador);
    if (!idJefe) return fail(res, 'Falta el evaluador', 400);
    await pool.query(`UPDATE rh_des_evaluaciones SET id_evaluador=? WHERE id=? AND estado!='CERRADA'`, [idJefe, idEval]);
    ok(res, { ok: true });
  } catch (e) { fail(res, e.message); }
};

/* ── EVALUACIÓN 360 ─────────────────────────────────────────────────────────────
   Además de la evaluación formal de la jefatura, cada evaluación puede tener
   evaluadores 360 por DIMENSIÓN (PAR, REPORTE DIRECTO, CLIENTE INTERNO, OTRA).
   Quién evalúa a quién lo define la jefatura o RRHH. El resultado se agrega
   ANÓNIMO por dimensión (promedio por competencia); es feedback: NO entra en
   la nota final (que sigue siendo jefatura + objetivos).
   ───────────────────────────────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('rrhh-desempeno-360', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_des_360 (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_evaluacion INT NOT NULL,
    id_evaluador INT NOT NULL,
    dimension VARCHAR(20) NOT NULL,
    estado VARCHAR(12) DEFAULT 'PENDIENTE',
    comentario TEXT NULL,
    respondida_at DATETIME NULL,
    UNIQUE KEY uq_eval_evaluador (id_evaluacion, id_evaluador),
    INDEX idx_evaluador (id_evaluador)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_des_360_notas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_360 INT NOT NULL,
    id_competencia INT NOT NULL,
    nota TINYINT NOT NULL,
    UNIQUE KEY uq_360_comp (id_360, id_competencia)
  )`);
});

const DIMENSIONES = ['PAR', 'REPORTE', 'CLIENTE_INTERNO', 'OTRA'];

/* Resumen anónimo por dimensión: promedio por competencia + comentarios sin autor */
async function resumen360(idEval) {
  const [regs] = await pool.query(`SELECT id, dimension, estado, comentario FROM rh_des_360 WHERE id_evaluacion=?`, [idEval]);
  if (!regs.length) return null;
  const listas = regs.filter(r => r.estado === 'LISTA');
  const [notas] = listas.length
    ? await pool.query(`SELECT n.id_360, n.id_competencia, n.nota, k.nombre competencia
                          FROM rh_des_360_notas n JOIN rh_des_competencias k ON k.id=n.id_competencia
                         WHERE n.id_360 IN (?)`, [listas.map(r => r.id)])
    : [[]];
  const dims = {};
  for (const r of listas) {
    const d = dims[r.dimension] = dims[r.dimension] || { dimension: r.dimension, respondidas: 0, comentarios: [], comps: {} };
    d.respondidas++;
    if (r.comentario) d.comentarios.push(r.comentario);
    for (const n of notas.filter(x => x.id_360 === r.id)) {
      const c = d.comps[n.id_competencia] = d.comps[n.id_competencia] || { competencia: n.competencia, suma: 0, n: 0 };
      c.suma += n.nota; c.n++;
    }
  }
  return {
    invitados: regs.length, respondidas: listas.length,
    dimensiones: Object.values(dims).map(d => ({
      dimension: d.dimension, respondidas: d.respondidas, comentarios: d.comentarios,
      competencias: Object.values(d.comps).map(c => ({ competencia: c.competencia, promedio: round2(c.suma / c.n) })),
    })),
  };
}
exports._resumen360 = resumen360;

/* Asignación (jefatura de la evaluación o RRHH): quién evalúa a quién y en qué dimensión */
exports.get360 = async (req, res) => {
  try {
    const idEval = parseInt(req.params.id);
    const [[ev]] = await pool.query(`SELECT * FROM rh_des_evaluaciones WHERE id=?`, [idEval]);
    if (!ev) return fail(res, 'Evaluación no encontrada', 404);
    const rrhh = await esRRHH(req);
    if (ev.id_evaluador !== req.usuario.id_usuario && !rrhh) return fail(res, 'Solo la jefatura o RRHH', 403);
    const [regs] = await pool.query(
      `SELECT r.id, r.id_evaluador, r.dimension, r.estado, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) evaluador, u.cargo
         FROM rh_des_360 r JOIN usuarios u ON u.id_usuario=r.id_evaluador WHERE r.id_evaluacion=? ORDER BY r.dimension, evaluador`, [idEval]);
    ok(res, { evaluadores: regs, resumen: await resumen360(idEval) });
  } catch (e) { fail(res, e.message); }
};

exports.asignar360 = async (req, res) => {
  try {
    const idEval = parseInt(req.params.id);
    const b = req.body || {};
    const [[ev]] = await pool.query(
      `SELECT e.*, c.nombre ciclo FROM rh_des_evaluaciones e JOIN rh_des_ciclos c ON c.id=e.id_ciclo WHERE e.id=?`, [idEval]);
    if (!ev) return fail(res, 'Evaluación no encontrada', 404);
    const rrhh = await esRRHH(req);
    if (ev.id_evaluador !== req.usuario.id_usuario && !rrhh) return fail(res, 'Solo la jefatura o RRHH puede asignar el 360', 403);
    if (b.quitar) { // quitar un evaluador (solo si no respondió)
      await pool.query(`DELETE FROM rh_des_360 WHERE id=? AND id_evaluacion=? AND estado='PENDIENTE'`, [parseInt(b.quitar), idEval]);
      return ok(res, { ok: true });
    }
    const idEvaluador = parseInt(b.id_evaluador);
    const dim = DIMENSIONES.includes(b.dimension) ? b.dimension : 'PAR';
    if (!idEvaluador) return fail(res, 'Falta el evaluador', 400);
    if (idEvaluador === ev.id_usuario) return fail(res, 'La persona no puede ser su propio evaluador 360 (para eso está la autoevaluación)', 400);
    await pool.query(`INSERT INTO rh_des_360 (id_evaluacion, id_evaluador, dimension) VALUES (?,?,?)
                      ON DUPLICATE KEY UPDATE dimension=VALUES(dimension)`, [idEval, idEvaluador, dim]);
    notificar([idEvaluador], {
      tipo: 'RRHH', prioridad: 'media', titulo: 'Te invitaron a una evaluación 360',
      mensaje: `Evalúa a un compañero en el ciclo ${ev.ciclo} — pestaña 360 en Desempeño`,
      href: '/recursos-humanos/desempeno/', clave: `des360_${idEval}_${idEvaluador}` });
    ok(res, { ok: true });
  } catch (e) { fail(res, e.message); }
};

/* Lo que me toca responder como evaluador 360 (y lo ya respondido) */
exports.mis360 = async (req, res) => {
  try {
    const [regs] = await pool.query(
      `SELECT r.id, r.dimension, r.estado, r.comentario, e.id id_evaluacion, c.nombre ciclo, c.estado estado_ciclo,
              TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) colaborador, u.cargo
         FROM rh_des_360 r
         JOIN rh_des_evaluaciones e ON e.id=r.id_evaluacion
         JOIN rh_des_ciclos c ON c.id=e.id_ciclo
         JOIN usuarios u ON u.id_usuario=e.id_usuario
        WHERE r.id_evaluador=? ORDER BY r.estado='PENDIENTE' DESC, r.id DESC LIMIT 100`, [req.usuario.id_usuario]);
    const ids = regs.filter(r => r.estado === 'LISTA').map(r => r.id);
    const [notas] = ids.length ? await pool.query(`SELECT id_360, id_competencia, nota FROM rh_des_360_notas WHERE id_360 IN (?)`, [ids]) : [[]];
    ok(res, { pendientes: regs.map(r => ({ ...r, notas: notas.filter(n => n.id_360 === r.id) })) });
  } catch (e) { fail(res, e.message); }
};

exports.responder360 = async (req, res) => {
  try {
    const b = req.body || {};
    const [[reg]] = await pool.query(`SELECT r.*, c.estado estado_ciclo FROM rh_des_360 r
      JOIN rh_des_evaluaciones e ON e.id=r.id_evaluacion JOIN rh_des_ciclos c ON c.id=e.id_ciclo WHERE r.id=?`, [parseInt(b.id_360)]);
    if (!reg || reg.id_evaluador !== req.usuario.id_usuario) return fail(res, 'Invitación no encontrada', 404);
    if (reg.estado_ciclo !== 'ABIERTO') return fail(res, 'El ciclo ya está cerrado', 400);
    let alguna = false;
    for (const nRaw of (b.notas || [])) {
      const nota = Math.min(5, Math.max(1, parseInt(nRaw.nota) || 0)) || null;
      if (!nota) continue;
      alguna = true;
      await pool.query(`INSERT INTO rh_des_360_notas (id_360, id_competencia, nota) VALUES (?,?,?)
                        ON DUPLICATE KEY UPDATE nota=VALUES(nota)`, [reg.id, parseInt(nRaw.id_competencia), nota]);
    }
    if (!alguna) return fail(res, 'Evalúa al menos una competencia', 400);
    await pool.query(`UPDATE rh_des_360 SET estado='LISTA', respondida_at=NOW(), comentario=? WHERE id=?`,
      [String(b.comentario || '').slice(0, 2000) || null, reg.id]);
    ok(res, { ok: true });
  } catch (e) { fail(res, e.message); }
};

/* ── Armado 360 del ciclo completo (RRHH) ───────────────────────────────────── */
/* Vista: todas las evaluaciones del ciclo con sus invitados 360 */
exports.get360Ciclo = async (req, res) => {
  try {
    const idCiclo = parseInt(req.params.id);
    const [evals] = await pool.query(
      `SELECT e.id, e.id_usuario, e.id_evaluador, e.estado,
              TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) colaborador, u.cargo,
              TRIM(CONCAT_WS(' ', j.nombre, j.apellido)) jefatura
         FROM rh_des_evaluaciones e JOIN usuarios u ON u.id_usuario=e.id_usuario
         LEFT JOIN usuarios j ON j.id_usuario=e.id_evaluador
        WHERE e.id_ciclo=? ORDER BY colaborador`, [idCiclo]);
    const ids = evals.map(e => e.id);
    const [regs] = ids.length ? await pool.query(
      `SELECT r.id, r.id_evaluacion, r.id_evaluador, r.dimension, r.estado,
              TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) evaluador
         FROM rh_des_360 r JOIN usuarios u ON u.id_usuario=r.id_evaluador
        WHERE r.id_evaluacion IN (?) ORDER BY r.dimension`, [ids]) : [[]];
    ok(res, { evaluaciones: evals.map(e => ({ ...e, invitados: regs.filter(r => r.id_evaluacion === e.id) })) });
  } catch (e) { fail(res, e.message); }
};

/* Propuesta automática: PARES = mismos que reportan a la misma jefatura;
   REPORTE = quienes reportan al evaluado. Máx 3 por dimensión; INSERT IGNORE
   respeta lo ya armado a mano. */
exports.auto360 = async (req, res) => {
  try {
    const idCiclo = parseInt(req.params.id);
    const [evals] = await pool.query(
      `SELECT e.id, e.id_usuario, u.id_supervisor
         FROM rh_des_evaluaciones e JOIN usuarios u ON u.id_usuario=e.id_usuario
        WHERE e.id_ciclo=?`, [idCiclo]);
    const [activos] = await pool.query(
      `SELECT u.id_usuario, u.id_supervisor FROM usuarios u LEFT JOIN rh_fichas unm ON unm.id_usuario=u.id_usuario WHERE u.estado='activo' AND COALESCE(unm.no_mostrar,0)=0`);
    const [[ciclo]] = await pool.query(`SELECT nombre FROM rh_des_ciclos WHERE id=?`, [idCiclo]);
    let creadas = 0; const avisar = new Set();
    for (const e of evals) {
      const pares = activos.filter(a => a.id_supervisor && a.id_supervisor === e.id_supervisor && a.id_usuario !== e.id_usuario).slice(0, 3);
      const reportes = activos.filter(a => a.id_supervisor === e.id_usuario).slice(0, 3);
      for (const [lista, dim] of [[pares, 'PAR'], [reportes, 'REPORTE']])
        for (const p of lista) {
          const [r] = await pool.query(`INSERT IGNORE INTO rh_des_360 (id_evaluacion, id_evaluador, dimension) VALUES (?,?,?)`,
            [e.id, p.id_usuario, dim]);
          if (r.affectedRows) { creadas++; avisar.add(p.id_usuario); }
        }
    }
    if (avisar.size) notificar([...avisar], {
      tipo: 'RRHH', prioridad: 'media', titulo: 'Te invitaron a evaluaciones 360',
      mensaje: `Ciclo ${ciclo?.nombre || ''}: tienes compañeros por evaluar — pestaña 360 en Desempeño`,
      href: '/recursos-humanos/desempeno/', clave: `des360auto_${idCiclo}` });
    ok(res, { creadas, personas_avisadas: avisar.size });
  } catch (e) { fail(res, e.message); }
};

/* Usuarios activos para el selector de evaluadores (solo datos de directorio) */
exports.usuarios360 = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id_usuario, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) nombre, u.cargo
         FROM usuarios u LEFT JOIN rh_fichas unm ON unm.id_usuario=u.id_usuario WHERE u.estado='activo' AND COALESCE(unm.no_mostrar,0)=0 ORDER BY nombre LIMIT 500`);
    ok(res, { usuarios: rows });
  } catch (e) { fail(res, e.message); }
};

/* ── RRHH: competencias ─────────────────────────────────────────────────────── */
exports.competencias = async (req, res) => {
  try {
    const [comps] = await pool.query(`SELECT * FROM rh_des_competencias WHERE activa=1 ORDER BY orden`);
    ok(res, { competencias: comps });
  } catch (e) { fail(res, e.message); }
};

exports.guardarCompetencia = async (req, res) => {
  try {
    const b = req.body || {};
    if (parseInt(b.id)) {
      if (b.eliminar) await pool.query(`UPDATE rh_des_competencias SET activa=0 WHERE id=?`, [parseInt(b.id)]);
      else await pool.query(`UPDATE rh_des_competencias SET nombre=?, descripcion=?, orden=? WHERE id=?`,
        [String(b.nombre || '').slice(0, 120), String(b.descripcion || '').slice(0, 400) || null, parseInt(b.orden) || 0, parseInt(b.id)]);
    } else {
      if (!String(b.nombre || '').trim()) return fail(res, 'Falta el nombre', 400);
      await pool.query(`INSERT INTO rh_des_competencias (nombre, descripcion, orden) VALUES (?,?,?)`,
        [String(b.nombre).trim().slice(0, 120), String(b.descripcion || '').slice(0, 400) || null, parseInt(b.orden) || 99]);
    }
    ok(res, { ok: true });
  } catch (e) { fail(res, e.message); }
};
