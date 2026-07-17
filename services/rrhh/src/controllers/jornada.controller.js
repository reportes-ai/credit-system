'use strict';
// Jornada laboral por colaborador: art. 22 CT (excluido de limitación de jornada,
// no está obligado a registrar asistencia) y jornada de 40 hrs (Ley 21.561).
// Fuente única: columnas en rh_fichas — las lee también Asistencia (Workera).
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

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
              COALESCE(unm.jornada_art22, 0) art22, COALESCE(unm.jornada_40h, 0) h40
         FROM ${UNIV} WHERE ${WU} ORDER BY nombre`);
    res.json({ success: true, error: null, data: rows });
  } catch (e) { console.error('[rrhh jornada]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── PUT /api/rrhh/jornada/:id  { art22, h40 } ──────────────────────────────── */
exports.guardar = async (req, res) => {
  try {
    const idU = Number(req.params.id);
    const art22 = req.body.art22 ? 1 : 0, h40 = req.body.h40 ? 1 : 0;
    if (!idU) return res.status(400).json({ success: false, data: null, error: 'Colaborador inválido' });
    const [r] = await pool.query('UPDATE rh_fichas SET jornada_art22=?, jornada_40h=? WHERE id_usuario=?', [art22, h40, idU]);
    if (!r.affectedRows) await pool.query('INSERT INTO rh_fichas (id_usuario, jornada_art22, jornada_40h) VALUES (?,?,?)', [idU, art22, h40]);
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'jornada', entidad_id: idU,
      detalle: `Jornada: art.22=${art22 ? 'SÍ' : 'no'}, 40hrs=${h40 ? 'SÍ' : 'no'}` });
    res.json({ success: true, error: null, data: { art22, h40 } });
  } catch (e) { console.error('[rrhh jornada guardar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
