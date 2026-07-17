'use strict';
// Jornada laboral por colaborador: art. 22 CT (excluido de limitación de jornada,
// no está obligado a registrar asistencia) y jornada de 40 hrs (Ley 21.561).
// Fuente única: columnas en rh_fichas — las lee también Asistencia (Workera).
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

require('../../../../shared/migrate').enFila('rrhh-jornada-2', async () => {
  for (const col of ['jornada_especial_hrs DECIMAL(4,1) NULL', 'jornada_externo TINYINT(1) NOT NULL DEFAULT 0']) {
    try { await pool.query(`ALTER TABLE rh_fichas ADD COLUMN ${col}`); } catch (e) { if (e.errno !== 1060) throw e; }
  }
  console.log('[rrhh-jornada] columnas especial/externo listas');
});

require('../../../../shared/migrate').enFila('rrhh-turnos', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_turnos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nombre  VARCHAR(80) NOT NULL,
    semanas TEXT NOT NULL,            -- JSON: [ { L:["10:00","18:00"], ..., S:[...] }, ... ] una entrada por semana del ciclo
    activo  TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  for (const col of ['turno_id INT NULL', 'turno_semana_inicio DATE NULL']) {
    try { await pool.query(`ALTER TABLE rh_fichas ADD COLUMN ${col}`); } catch (e) { if (e.errno !== 1060) throw e; }
  }
  const [[ex]] = await pool.query('SELECT id FROM rh_turnos LIMIT 1');
  if (!ex) {
    const semanas = [
      { L: ['10:00', '18:00'], M: ['10:00', '18:00'], X: ['10:00', '18:00'], J: ['10:00', '18:00'], V: ['10:00', '18:00'] },
      { L: ['10:00', '17:30'], M: ['10:00', '17:30'], X: ['10:00', '17:30'], J: ['10:00', '17:30'], V: ['10:00', '17:30'], S: ['10:00', '19:00'] },
    ];
    await pool.query('INSERT INTO rh_turnos (nombre, semanas) VALUES (?,?)', ['Rotativo con sábado', JSON.stringify(semanas)]);
  }
  console.log('[rrhh-turnos] listo');
});

require('../../../../shared/migrate').enFila('rrhh-jornada-4', async () => {
  try { await pool.query(`ALTER TABLE rh_fichas ADD COLUMN horario_dias VARCHAR(10) NULL`); } catch (e) { if (e.errno !== 1060) throw e; }
  console.log('[rrhh-jornada] columna dias lista');
});

require('../../../../shared/migrate').enFila('rrhh-jornada-3', async () => {
  for (const col of ['horario_entrada TIME NULL', 'horario_salida TIME NULL', 'por_turnos TINYINT(1) NOT NULL DEFAULT 0']) {
    try { await pool.query(`ALTER TABLE rh_fichas ADD COLUMN ${col}`); } catch (e) { if (e.errno !== 1060) throw e; }
  }
  console.log('[rrhh-jornada] columnas horario/turnos listas');
});

require('../../../../shared/migrate').enFila('rrhh-jornada', async () => {
  for (const col of ['jornada_art22 TINYINT(1) NOT NULL DEFAULT 0', 'jornada_40h TINYINT(1) NOT NULL DEFAULT 0']) {
    try { await pool.query(`ALTER TABLE rh_fichas ADD COLUMN ${col}`); } catch (e) { if (e.errno !== 1060) throw e; }
  }
  const [[modRRHH]] = await pool.query(`SELECT id_modulo FROM modulos WHERE ruta='/recursos-humanos/' LIMIT 1`);
  if (!modRRHH) return;
  const [[f]] = await pool.query(`SELECT id_funcionalidad FROM funcionalidades WHERE codigo='rh_jornada' LIMIT 1`);
  if (f) return;
  const [r] = await pool.query(`INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
    VALUES (?, 'Jornada Laboral', 'rh_jornada', '/recursos-humanos/jornada/', 'bi-clock-history')`, [modRRHH.id_modulo]);
  await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
    SELECT pp.id_perfil, ?, 1 FROM permisos_perfil pp JOIN funcionalidades f2 ON f2.id_funcionalidad=pp.id_funcionalidad
    WHERE f2.codigo='rh_remuneraciones' AND pp.habilitado=1`, [r.insertId]);
  await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1, ?, 1)`, [r.insertId]);
  console.log('[rrhh-jornada] listo');
});

/* ── GET /api/rrhh/jornada ──────────────────────────────────────────────────── */
exports.listar = async (req, res) => {
  try {
    const { UNIVERSO_FROM: UNIV, UNIVERSO_WHERE: WU } = require('../universo');
    const [rows] = await pool.query(
      `SELECT u.id_usuario, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) nombre, u.rut,
              COALESCE(u.cargo, '') cargo,
              COALESCE(unm.jornada_art22, 0) art22, COALESCE(unm.jornada_40h, 0) h40,
              unm.jornada_especial_hrs especial_hrs, COALESCE(unm.jornada_externo, 0) externo,
              TIME_FORMAT(unm.horario_entrada,'%H:%i') hora_entrada, TIME_FORMAT(unm.horario_salida,'%H:%i') hora_salida,
              COALESCE(unm.por_turnos, 0) por_turnos, unm.horario_dias dias,
              unm.turno_id, DATE_FORMAT(unm.turno_semana_inicio,'%Y-%m-%d') turno_semana_inicio
         FROM ${UNIV} WHERE ${WU} ORDER BY nombre`);
    res.json({ success: true, error: null, data: rows });
  } catch (e) { console.error('[rrhh jornada]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── PUT /api/rrhh/jornada/:id  { art22, h40 } ──────────────────────────────── */
exports.guardar = async (req, res) => {
  try {
    const idU = Number(req.params.id);
    const art22 = req.body.art22 ? 1 : 0, h40 = req.body.h40 ? 1 : 0, externo = req.body.externo ? 1 : 0;
    let esp = req.body.especial_hrs == null || req.body.especial_hrs === '' ? null : Number(req.body.especial_hrs);
    if (esp != null && (!(esp > 0) || esp > 45)) return res.status(400).json({ success: false, data: null, error: 'Horas de jornada especial inválidas (1 a 45)' });
    if (!idU) return res.status(400).json({ success: false, data: null, error: 'Colaborador inválido' });
    const porTurnos = req.body.por_turnos ? 1 : 0;
    const hora = v => (v == null || v === '') ? null : (/^\d{2}:\d{2}$/.test(String(v)) ? String(v) + ':00' : undefined);
    const hIn = hora(req.body.hora_entrada), hOut = hora(req.body.hora_salida);
    if (hIn === undefined || hOut === undefined) return res.status(400).json({ success: false, data: null, error: 'Horario inválido (formato HH:MM)' });
    let dias = req.body.dias == null || req.body.dias === '' ? null : String(req.body.dias).toUpperCase();
    if (dias != null && !/^[LMXJVSD]{0,7}$/.test(dias)) return res.status(400).json({ success: false, data: null, error: 'Días inválidos (letras LMXJVSD)' });
    const turnoId = req.body.turno_id ? Number(req.body.turno_id) : null;
    const turnoIni = /^\d{4}-\d{2}-\d{2}$/.test(req.body.turno_semana_inicio || '') ? req.body.turno_semana_inicio : null;
    const [r] = await pool.query('UPDATE rh_fichas SET jornada_art22=?, jornada_40h=?, jornada_especial_hrs=?, jornada_externo=?, horario_entrada=?, horario_salida=?, por_turnos=?, horario_dias=?, turno_id=?, turno_semana_inicio=? WHERE id_usuario=?',
      [art22, h40, esp, externo, hIn, hOut, porTurnos, dias, turnoId, turnoIni, idU]);
    if (!r.affectedRows) await pool.query('INSERT INTO rh_fichas (id_usuario, jornada_art22, jornada_40h, jornada_especial_hrs, jornada_externo, horario_entrada, horario_salida, por_turnos, horario_dias, turno_id, turno_semana_inicio) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [idU, art22, h40, esp, externo, hIn, hOut, porTurnos, dias, turnoId, turnoIni]);
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'jornada', entidad_id: idU,
      detalle: `Jornada: art.22=${art22 ? 'SÍ' : 'no'}, 40hrs=${h40 ? 'SÍ' : 'no'}, especial=${esp != null ? esp + ' hrs' : 'no'}, externo=${externo ? 'SÍ' : 'no'}, horario=${porTurnos ? 'POR TURNOS' : ((hIn || '—') + '-' + (hOut || '—'))}` });
    res.json({ success: true, error: null, data: { art22, h40, especial_hrs: esp, externo, hora_entrada: hIn && hIn.slice(0, 5), hora_salida: hOut && hOut.slice(0, 5), por_turnos: porTurnos, dias, turno_id: turnoId, turno_semana_inicio: turnoIni } });
  } catch (e) { console.error('[rrhh jornada guardar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Turnos rotativos: definición paramétrica (rh_turnos) ───────────────────── */
const HHMM = v => /^\d{2}:\d{2}$/.test(String(v || ''));
function validarSemanas(semanas) {
  if (!Array.isArray(semanas) || !semanas.length || semanas.length > 8) return 'El turno debe tener entre 1 y 8 semanas';
  for (const s of semanas) {
    if (!s || typeof s !== 'object') return 'Semana inválida';
    for (const [dia, par] of Object.entries(s)) {
      if (!'LMXJVSD'.includes(dia)) return `Día inválido: ${dia}`;
      if (!Array.isArray(par) || par.length !== 2 || !HHMM(par[0]) || !HHMM(par[1])) return `Horario inválido en ${dia} (HH:MM)`;
    }
  }
  return null;
}

require('../../../../shared/migrate').enFila('rrhh-turnos-2', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_turno_calendario (
    id_usuario INT NOT NULL,
    fecha      DATE NOT NULL,
    inicio     TIME NULL,               -- NULL = día libre
    fin        TIME NULL,
    turno_id   INT NOT NULL,
    generado_por VARCHAR(160) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id_usuario, fecha)
  )`);
  console.log('[rrhh-turnos] calendario listo');
});

/* Motor único: días de un rango según el turno rotativo y el lunes de inicio del ciclo */
const DSEM_JS = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];   // getDay() 0-6
function lunesDe(f) { const d = new Date(f + 'T12:00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; }
function diasDeTurno(semanas, semanaInicio, desde, hasta) {
  const out = [], ini = lunesDe(semanaInicio);
  for (let d = new Date(desde + 'T12:00:00'); d.toISOString().slice(0, 10) <= hasta; d.setDate(d.getDate() + 1)) {
    const fecha = d.toISOString().slice(0, 10);
    const idx = ((Math.round((lunesDe(fecha) - ini) / (7 * 86400000)) % semanas.length) + semanas.length) % semanas.length;
    const par = semanas[idx][DSEM_JS[d.getDay()]] || null;
    out.push({ fecha, semana: idx + 1, inicio: par ? par[0] : null, fin: par ? par[1] : null });
  }
  return out;
}

async function calendarioCalcular(desde, hasta) {
  const { UNIVERSO_FROM: UNIV, UNIVERSO_WHERE: WU } = require('../universo');
  const [rows] = await pool.query(
    `SELECT u.id_usuario, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) nombre, COALESCE(u.cargo,'') cargo,
            unm.turno_id, DATE_FORMAT(unm.turno_semana_inicio,'%Y-%m-%d') semana_inicio
       FROM ${UNIV} WHERE ${WU} AND COALESCE(unm.por_turnos,0)=1 AND unm.turno_id IS NOT NULL AND unm.turno_semana_inicio IS NOT NULL
      ORDER BY nombre`);
  const [turnos] = await pool.query('SELECT id, nombre, semanas FROM rh_turnos WHERE activo=1');
  const tMap = new Map(turnos.map(t => [t.id, { nombre: t.nombre, semanas: JSON.parse(t.semanas) }]));
  return rows.filter(r => tMap.has(r.turno_id)).map(r => {
    const t = tMap.get(r.turno_id);
    return { id_usuario: r.id_usuario, nombre: r.nombre, cargo: r.cargo, turno_id: r.turno_id,
             turno: t.nombre, dias: diasDeTurno(t.semanas, r.semana_inicio, desde, hasta) };
  });
}

const rangoMeses = q => {
  const m = /^\d{4}-\d{2}$/;
  if (!m.test(q.desde || '') || !m.test(q.hasta || '') || q.hasta < q.desde) return null;
  const fin = new Date(Number(q.hasta.slice(0, 4)), Number(q.hasta.slice(5, 7)), 0);
  return { desde: q.desde + '-01', hasta: fin.toISOString().slice(0, 10) };
};

/* GET /api/rrhh/turnos-calendario/preview?desde=YYYY-MM&hasta=YYYY-MM */
exports.calendarioPreview = async (req, res) => {
  try {
    const r = rangoMeses(req.query);
    if (!r) return res.status(400).json({ success: false, data: null, error: 'Rango de meses inválido' });
    res.json({ success: true, error: null, data: await calendarioCalcular(r.desde, r.hasta) });
  } catch (e) { console.error('[rrhh calendario]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* POST /api/rrhh/turnos-calendario  { desde:'YYYY-MM', hasta:'YYYY-MM' } — graba el calendario del rango */
exports.calendarioGrabar = async (req, res) => {
  try {
    const r = rangoMeses(req.body);
    if (!r) return res.status(400).json({ success: false, data: null, error: 'Rango de meses inválido' });
    const data = await calendarioCalcular(r.desde, r.hasta);
    if (!data.length) return res.status(400).json({ success: false, data: null, error: 'Nadie tiene turno y semana de inicio asignados' });
    const quien = req.usuario?.nombre || req.usuario?.email || '';
    let n = 0;
    for (const c of data) {
      await pool.query('DELETE FROM rh_turno_calendario WHERE id_usuario=? AND fecha BETWEEN ? AND ?', [c.id_usuario, r.desde, r.hasta]);
      const filas = c.dias.map(d => [c.id_usuario, d.fecha, d.inicio, d.fin, c.turno_id, quien]);
      if (filas.length) { await pool.query('INSERT INTO rh_turno_calendario (id_usuario, fecha, inicio, fin, turno_id, generado_por) VALUES ?', [filas]); n += filas.length; }
    }
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'turno_calendario', entidad_id: null,
      detalle: `Calendario de turnos ${req.body.desde} a ${req.body.hasta}: ${data.length} colaborador(es), ${n} día(s)` });
    res.json({ success: true, error: null, data: { colaboradores: data.length, dias: n } });
  } catch (e) { console.error('[rrhh calendario grabar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

exports.turnosListar = async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, nombre, semanas FROM rh_turnos WHERE activo=1 ORDER BY nombre');
    res.json({ success: true, error: null, data: rows.map(r => ({ id: r.id, nombre: r.nombre, semanas: JSON.parse(r.semanas) })) });
  } catch (e) { console.error('[rrhh turnos]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

exports.turnoGuardar = async (req, res) => {
  try {
    const nombre = String(req.body.nombre || '').trim();
    if (!nombre) return res.status(400).json({ success: false, data: null, error: 'Falta el nombre del turno' });
    const err = validarSemanas(req.body.semanas);
    if (err) return res.status(400).json({ success: false, data: null, error: err });
    const semanas = JSON.stringify(req.body.semanas);
    let id = Number(req.params.id) || null;
    const esNuevo = !id;
    if (id) await pool.query('UPDATE rh_turnos SET nombre=?, semanas=? WHERE id=?', [nombre, semanas, id]);
    else { const [r] = await pool.query('INSERT INTO rh_turnos (nombre, semanas) VALUES (?,?)', [nombre, semanas]); id = r.insertId; }
    auditar({ req, accion: esNuevo ? 'CREAR' : 'EDITAR', modulo: 'rrhh', entidad: 'turno', entidad_id: id, detalle: `Turno "${nombre}" (${req.body.semanas.length} semana(s))` });
    res.json({ success: true, error: null, data: { id } });
  } catch (e) { console.error('[rrhh turno guardar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

exports.turnoEliminar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, data: null, error: 'Turno inválido' });
    const [[uso]] = await pool.query('SELECT COUNT(*) n FROM rh_fichas WHERE turno_id=?', [id]);
    if (uso.n) return res.status(400).json({ success: false, data: null, error: `Hay ${uso.n} colaborador(es) asignado(s) a este turno — reasígnalos primero` });
    await pool.query('UPDATE rh_turnos SET activo=0 WHERE id=?', [id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'rrhh', entidad: 'turno', entidad_id: id, detalle: 'Turno desactivado' });
    res.json({ success: true, error: null, data: null });
  } catch (e) { console.error('[rrhh turno eliminar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
