'use strict';
// Asistencia (conector Workera): marcaciones del reloj control cruzadas con el
// universo de colaboradores, las ausencias aprobadas y las vacaciones aprobadas.
// Workera es la fuente única de marcas (no se re-almacenan); aquí solo se agrega
// al vuelo el resumen del mes: días con marca, atrasos no evaluados (fase 2) y
// posibles faltas = día hábil sin marca y sin ausencia/vacación que lo cubra.
const pool = require('../../../../shared/config/database');
const workera = require('../workera');
const feriados = require('../../../../shared/feriados');

// ── Migración: card Asistencia (permisos heredados de rh_remuneraciones: gestión RRHH) ──
require('../../../../shared/migrate').enFila('rrhh-asistencia-card', async () => {
  const [[modRRHH]] = await pool.query(`SELECT id_modulo FROM modulos WHERE ruta='/recursos-humanos/' LIMIT 1`);
  if (!modRRHH) return;
  const [[f]] = await pool.query(`SELECT id_funcionalidad FROM funcionalidades WHERE codigo='rh_asistencia' LIMIT 1`);
  if (f) return;
  const [r] = await pool.query(`INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
    VALUES (?, 'Asistencia (Workera)', 'rh_asistencia', '/recursos-humanos/asistencia/', 'bi-fingerprint')`, [modRRHH.id_modulo]);
  await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
    SELECT pp.id_perfil, ?, 1 FROM permisos_perfil pp JOIN funcionalidades f2 ON f2.id_funcionalidad=pp.id_funcionalidad
    WHERE f2.codigo='rh_remuneraciones' AND pp.habilitado=1`, [r.insertId]);
  await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1, ?, 1)`, [r.insertId]);
  console.log('[rrhh-asistencia] card creada');
});

const rutNorm = r => String(r || '').replace(/[.\s-]/g, '').toUpperCase().replace(/K$/, 'K'); // 18.088.259-6 → 180882596

/* ── GET /api/rrhh/asistencia/resumen?mes=YYYY-MM ───────────────────────────── */
exports.resumen = async (req, res) => {
  try {
    if (!workera.configurado())
      return res.status(503).json({ success: false, data: null, error: 'Workera no configurado: faltan WORKERA_API_USER / WORKERA_API_KEY en Render' });
    const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : new Date().toISOString().slice(0, 7);
    const desde = mes + '-01';
    const finMes = new Date(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0).toISOString().slice(0, 10);
    const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const hasta = finMes < ayer ? finMes : ayer; // solo días ya transcurridos
    if (hasta < desde) return res.json({ success: true, error: null, data: { mes, colaboradores: [], dias_habiles: [] } });

    // 1) Universo canónico + sus coberturas del mes (ausencias/vacaciones aprobadas)
    const { UNIVERSO_FROM: UNIV, UNIVERSO_WHERE: WU } = require('../universo');
    const [colabs, [ausencias], [vacaciones]] = await Promise.all([
      pool.query(`SELECT u.id_usuario, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) nombre, u.rut,
                         DATE_FORMAT(u.fecha_ingreso,'%Y-%m-%d') fecha_ingreso
                    FROM ${UNIV} WHERE ${WU} AND u.rut IS NOT NULL ORDER BY nombre`).then(r => r[0]),
      pool.query(`SELECT id_usuario, tipo, DATE_FORMAT(fecha_desde,'%Y-%m-%d') fd, DATE_FORMAT(fecha_hasta,'%Y-%m-%d') fh
                    FROM rh_ausencias WHERE estado='APROBADA' AND fecha_desde <= ? AND fecha_hasta >= ?`, [hasta, desde]),
      pool.query(`SELECT id_usuario, DATE_FORMAT(fecha_desde,'%Y-%m-%d') fd, DATE_FORMAT(fecha_hasta,'%Y-%m-%d') fh
                    FROM rh_vacaciones WHERE estado='APROBADA' AND fecha_desde <= ? AND fecha_hasta >= ?`, [hasta, desde]),
    ]);

    // 2) Marcaciones Workera del período, agrupadas por RUT y día (primera y última)
    const marcas = await workera.marcaciones(desde, hasta);
    const porRut = {};
    for (const m of marcas) {
      const rut = rutNorm(m.employee?.identification);
      const [dia, hora] = String(m.attendanceDate || '').split('T');
      if (!rut || !dia) continue;
      const d = (porRut[rut] = porRut[rut] || {});
      const reg = (d[dia] = d[dia] || { entrada: null, salida: null, n: 0 });
      reg.n++;
      if (!reg.entrada || hora < reg.entrada) reg.entrada = hora;
      if (!reg.salida || hora > reg.salida) reg.salida = hora;
    }

    // 3) Días hábiles transcurridos del mes (motor único shared/feriados)
    const habiles = [];
    for (let d = new Date(desde + 'T12:00:00'); d.toISOString().slice(0, 10) <= hasta; d.setDate(d.getDate() + 1)) {
      if (feriados.esHabil(d)) habiles.push(d.toISOString().slice(0, 10));
    }

    // 4) Cruce por colaborador
    const cubierto = (idU, dia, lista) => lista.some(a => a.id_usuario === idU && a.fd <= dia && a.fh >= dia);
    const colaboradores = colabs.map(c => {
      const dias = porRut[rutNorm(c.rut)] || {};
      const detalle = [], faltas = [];
      let marcados = 0, cubiertos = 0;
      for (const h of habiles) {
        if (c.fecha_ingreso && h < c.fecha_ingreso) continue;
        const reg = dias[h];
        if (reg) { marcados++; detalle.push({ dia: h, entrada: reg.entrada, salida: reg.salida, marcas: reg.n }); continue; }
        const aus = ausencias.find(a => a.id_usuario === c.id_usuario && a.fd <= h && a.fh >= h);
        if (aus) { cubiertos++; detalle.push({ dia: h, cubierto: aus.tipo }); continue; }
        if (cubierto(c.id_usuario, h, vacaciones)) { cubiertos++; detalle.push({ dia: h, cubierto: 'VACACIONES' }); continue; }
        faltas.push(h); detalle.push({ dia: h, falta: true });
      }
      const enWorkera = !!porRut[rutNorm(c.rut)];
      return { id_usuario: c.id_usuario, nombre: c.nombre, rut: c.rut, en_workera: enWorkera,
               dias_marcados: marcados, dias_cubiertos: cubiertos, faltas, detalle };
    });

    res.json({ success: true, error: null, data: { mes, desde, hasta, dias_habiles: habiles, colaboradores } });
  } catch (e) {
    console.error('[rrhh asistencia]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error consultando Workera: ' + e.message });
  }
};
