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
  return evals.map(e => ({ ...e,
    notas: notas.filter(x => x.id_evaluacion === e.id),
    objetivos: objs.filter(x => x.id_evaluacion === e.id) }));
}

/* ── Colaborador: mi evaluación + historial ─────────────────────────────────── */
exports.mi = async (req, res) => {
  try {
    const evals = await cargarEvals('e.id_usuario=?', [req.usuario.id_usuario]);
    // en las abiertas sin evaluar, el colaborador no ve las notas de la jefatura
    for (const e of evals) if (e.estado === 'PENDIENTE' || e.estado === 'AUTOEVAL')
      e.notas = e.notas.map(x => ({ ...x, jefe: null }));
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
      `SELECT id_usuario, id_supervisor FROM usuarios WHERE estado='activo' AND COALESCE(protegido,0)=0`);
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
    ok(res, { id: r.insertId, creadas, sin_jefatura: sinJefe.length });
  } catch (e) { fail(res, e.message); }
};

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
