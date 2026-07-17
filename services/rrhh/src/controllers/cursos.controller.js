'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   CURSOS Y CAPACITACIONES — bitácora de capacitación del equipo.
   Un curso tiene fecha, hora de inicio/término (las horas se calculan solas),
   relator, resumen del contenido y participantes seleccionados del equipo;
   puede ser solo asistencia o además con nota (1,0–7,0). Todo queda en la
   bitácora ordenada por fecha y en la ficha de cada colaborador.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });

require('../../../../shared/migrate').enFila('rrhh-cursos', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_cursos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nombre VARCHAR(200) NOT NULL,
    relator VARCHAR(160) NULL,
    fecha DATE NOT NULL,
    hora_inicio VARCHAR(5) NOT NULL,
    hora_termino VARCHAR(5) NOT NULL,
    horas DECIMAL(5,2) NOT NULL DEFAULT 0,
    contenido TEXT NULL,
    con_nota TINYINT(1) DEFAULT 0,
    creado_por INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_fecha (fecha)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_cursos_asistentes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_curso INT NOT NULL,
    id_usuario INT NOT NULL,
    asistio TINYINT(1) DEFAULT 1,
    nota DECIMAL(3,1) NULL,
    UNIQUE KEY uq_curso_usuario (id_curso, id_usuario)
  )`);
  // Card en RRHH (gestión: RRHH; cada uno ve sus cursos en Mi Ficha)
  const [[modRRHH]] = await pool.query(`SELECT id_modulo FROM modulos WHERE ruta='/recursos-humanos/' LIMIT 1`);
  if (modRRHH) {
    const [[f]] = await pool.query(`SELECT id_funcionalidad FROM funcionalidades WHERE codigo='rh_cursos' LIMIT 1`);
    if (!f) {
      const [r] = await pool.query(`INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
        VALUES (?, 'Cursos y Capacitaciones', 'rh_cursos', '/recursos-humanos/cursos/', 'bi-mortarboard')`, [modRRHH.id_modulo]);
      await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1, ?, 1)`, [r.insertId]);
    }
  }
});

/* Horas entre HH:MM y HH:MM (mismo día) */
const calcHoras = (hi, ht) => {
  const [h1, m1] = String(hi).split(':').map(Number), [h2, m2] = String(ht).split(':').map(Number);
  const min = (h2 * 60 + m2) - (h1 * 60 + m1);
  return min > 0 ? Math.round(min / 60 * 100) / 100 : 0;
};

/* Bitácora ordenada por fecha de realización */
exports.lista = async (req, res) => {
  try {
    const [cursos] = await pool.query(
      `SELECT c.*, COUNT(a.id) participantes, SUM(a.asistio) asistieron, ROUND(AVG(a.nota),1) promedio
         FROM rh_cursos c LEFT JOIN rh_cursos_asistentes a ON a.id_curso=c.id
        GROUP BY c.id ORDER BY c.fecha DESC, c.hora_inicio DESC LIMIT 500`);
    ok(res, { cursos });
  } catch (e) { fail(res, e.message); }
};

exports.detalle = async (req, res) => {
  try {
    const [[curso]] = await pool.query(`SELECT * FROM rh_cursos WHERE id=?`, [parseInt(req.params.id)]);
    if (!curso) return fail(res, 'Curso no encontrado', 404);
    const [asistentes] = await pool.query(
      `SELECT a.id, a.id_usuario, a.asistio, a.nota, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) nombre, u.cargo
         FROM rh_cursos_asistentes a JOIN usuarios u ON u.id_usuario=a.id_usuario
        WHERE a.id_curso=? ORDER BY nombre`, [curso.id]);
    ok(res, { curso, asistentes });
  } catch (e) { fail(res, e.message); }
};

/* Crear/editar curso con sus participantes */
exports.guardar = async (req, res) => {
  try {
    const b = req.body || {};
    if (!String(b.nombre || '').trim() || !b.fecha || !b.hora_inicio || !b.hora_termino)
      return fail(res, 'Faltan nombre, fecha u horas', 400);
    const horas = calcHoras(b.hora_inicio, b.hora_termino);
    if (!horas) return fail(res, 'La hora de término debe ser posterior a la de inicio', 400);
    const vals = [String(b.nombre).trim().slice(0, 200), String(b.relator || '').slice(0, 160) || null,
      b.fecha, String(b.hora_inicio).slice(0, 5), String(b.hora_termino).slice(0, 5), horas,
      String(b.contenido || '').slice(0, 5000) || null, b.con_nota ? 1 : 0];
    let id = parseInt(b.id) || 0;
    if (id) await pool.query(`UPDATE rh_cursos SET nombre=?, relator=?, fecha=?, hora_inicio=?, hora_termino=?, horas=?, contenido=?, con_nota=? WHERE id=?`, [...vals, id]);
    else { const [r] = await pool.query(`INSERT INTO rh_cursos (nombre, relator, fecha, hora_inicio, hora_termino, horas, contenido, con_nota, creado_por) VALUES (?,?,?,?,?,?,?,?,?)`, [...vals, req.usuario.id_usuario]); id = r.insertId; }
    if (Array.isArray(b.participantes)) {
      const ids = b.participantes.map(x => parseInt(x)).filter(Boolean);
      await pool.query(`DELETE FROM rh_cursos_asistentes WHERE id_curso=?${ids.length ? ' AND id_usuario NOT IN (?)' : ''}`, ids.length ? [id, ids] : [id]);
      for (const u of ids) await pool.query(`INSERT IGNORE INTO rh_cursos_asistentes (id_curso, id_usuario) VALUES (?,?)`, [id, u]);
    }
    ok(res, { id, horas });
  } catch (e) { fail(res, e.message); }
};

/* Marcar asistencia / nota de un asistente */
exports.marcarAsistente = async (req, res) => {
  try {
    const b = req.body || {};
    let nota = null;
    if (b.nota !== undefined && b.nota !== null && b.nota !== '') {
      nota = Math.round(parseFloat(String(b.nota).replace(',', '.')) * 10) / 10;
      if (isNaN(nota) || nota < 1 || nota > 7) return fail(res, 'La nota va de 1,0 a 7,0', 400);
    }
    await pool.query(`UPDATE rh_cursos_asistentes SET asistio=?, nota=? WHERE id=?`,
      [b.asistio === false || b.asistio === 0 ? 0 : 1, nota, parseInt(req.params.id)]);
    ok(res, { ok: true });
  } catch (e) { fail(res, e.message); }
};

exports.eliminar = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await pool.query(`DELETE FROM rh_cursos_asistentes WHERE id_curso=?`, [id]);
    await pool.query(`DELETE FROM rh_cursos WHERE id=?`, [id]);
    ok(res, { ok: true });
  } catch (e) { fail(res, e.message); }
};

/* Cursos de una persona — para la ficha (cada uno los propios; RRHH los de cualquiera) */
exports.deUsuario = async (req, res) => {
  try {
    let idU = parseInt(req.params.idUsuario) || req.usuario.id_usuario;
    if (idU !== req.usuario.id_usuario) {
      const { tieneFunc } = require('../../../../shared/middleware/permisos');
      const rrhh = await tieneFunc(req.usuario.id_usuario, 'rh_colaboradores', 'rh_aprobar').catch(() => false);
      if (!rrhh) idU = req.usuario.id_usuario;
    }
    const [cursos] = await pool.query(
      `SELECT c.id, c.nombre, c.relator, DATE_FORMAT(c.fecha,'%Y-%m-%d') fecha, c.horas, c.con_nota, a.asistio, a.nota
         FROM rh_cursos_asistentes a JOIN rh_cursos c ON c.id=a.id_curso
        WHERE a.id_usuario=? ORDER BY c.fecha DESC LIMIT 200`, [idU]);
    const total = cursos.filter(c => c.asistio).reduce((s, c) => s + Number(c.horas || 0), 0);
    ok(res, { cursos, horas_totales: Math.round(total * 100) / 100 });
  } catch (e) { fail(res, e.message); }
};
