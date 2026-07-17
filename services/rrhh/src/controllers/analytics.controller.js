'use strict';
// People Analytics (anti-Buk #5): indicadores de RRHH calculados SIEMPRE desde las
// fuentes únicas (usuarios, rh_fichas, rh_vac_movimientos, rh_ausencias, rh_liquidaciones,
// rh_finiquitos, rh_solicitudes) — nada se re-almacena, todo se agrega al vuelo.
const pool = require('../../../../shared/config/database');

// ── Migración: card Indicadores RRHH (permisos heredados de rh_colaboradores) ──
require('../../../../shared/migrate').enFila('rrhh-analytics-card', async () => {
  const [[modRRHH]] = await pool.query(`SELECT id_modulo FROM modulos WHERE ruta='/recursos-humanos/' LIMIT 1`);
  if (!modRRHH) return;
  const [[f]] = await pool.query(`SELECT id_funcionalidad FROM funcionalidades WHERE codigo='rh_analytics' LIMIT 1`);
  if (f) return;
  const [r] = await pool.query(`INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
    VALUES (?, 'Indicadores RRHH', 'rh_analytics', '/recursos-humanos/analytics/', 'bi-bar-chart-line')`, [modRRHH.id_modulo]);
  await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
    SELECT pp.id_perfil, ?, 1 FROM permisos_perfil pp JOIN funcionalidades f2 ON f2.id_funcionalidad=pp.id_funcionalidad
    WHERE f2.codigo='rh_colaboradores' AND pp.habilitado=1`, [r.insertId]);
  await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1, ?, 1)`, [r.insertId]);
  console.log('[rrhh-analytics] card creada');
});

// fecha_baja en usuarios: fuente única del evento "egresó" (se estampa al suspender,
// se limpia al reactivar; backfill desde los finiquitos existentes)
require('../../../../shared/migrate').enFila('usuarios-fecha-baja', async () => {
  try { await pool.query('ALTER TABLE usuarios ADD COLUMN fecha_baja DATE NULL'); } catch (e) { if (e.errno !== 1060) throw e; }
  await pool.query(`UPDATE usuarios u JOIN rh_finiquitos fq ON fq.id_usuario=u.id_usuario
    SET u.fecha_baja=fq.fecha_termino WHERE u.estado='inactivo' AND u.fecha_baja IS NULL`);
  console.log('[rrhh-analytics] fecha_baja lista');
});

const meses12 = () => {
  const out = [];
  const d = new Date();
  for (let i = 11; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
};

exports.resumen = async (req, res) => {
  try {
    // Universo canónico de colaboradores (services/rrhh/src/universo.js) — el MISMO
    // de la cartola de Vacaciones, Colaboradores y selectores (activo + no_mostrar=0)
    const { UNIVERSO_FROM: UNIV, UNIVERSO_WHERE: WU } = require('../universo');
    const [
      [act], porSexo, porContrato, porCargo, porCC,
      ingresosMes, egresosMes, vacEquipo,
      ausMes, liqMes, solTipo, edadesAnt,
    ] = await Promise.all([
      pool.query(`SELECT COUNT(*) n FROM ${UNIV} WHERE ${WU}`).then(r => r[0]),
      pool.query(`SELECT COALESCE(NULLIF(u.sexo,''),'(sin dato)') k, COUNT(*) n FROM ${UNIV} WHERE ${WU} GROUP BY k`).then(r => r[0]),
      pool.query(`SELECT COALESCE(NULLIF(f.tipo_contrato,''),'(sin dato)') k, COUNT(*) n FROM ${UNIV} LEFT JOIN rh_fichas f ON f.id_usuario=u.id_usuario WHERE ${WU} GROUP BY k ORDER BY n DESC`).then(r => r[0]),
      pool.query(`SELECT COALESCE(NULLIF(u.cargo,''),'(sin cargo)') k, COUNT(*) n FROM ${UNIV} WHERE ${WU} GROUP BY k ORDER BY n DESC LIMIT 10`).then(r => r[0]),
      pool.query(`SELECT COALESCE(NULLIF(u.centro_costo,''),'(sin área)') k, COUNT(*) n FROM ${UNIV} WHERE ${WU} GROUP BY k ORDER BY n DESC`).then(r => r[0]),
      pool.query(`SELECT DATE_FORMAT(u.fecha_ingreso,'%Y-%m') m, COUNT(*) n FROM ${UNIV} WHERE ${WU} AND u.fecha_ingreso >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH) GROUP BY m`).then(r => r[0]),
      // Egresos = usuarios dados de baja (fecha_baja, la vigencia manda en usuarios);
      // fallback fecha_termino del finiquito para bajas antiguas sin estampa
      pool.query(`SELECT DATE_FORMAT(COALESCE(u.fecha_baja, fq.fecha_termino),'%Y-%m') m, COUNT(*) n
                    FROM usuarios u LEFT JOIN rh_finiquitos fq ON fq.id_usuario=u.id_usuario
                   WHERE u.estado='inactivo' AND COALESCE(u.fecha_baja, fq.fecha_termino) >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
                   GROUP BY m`).then(r => r[0]),
      // Máxima 1 (un solo motor): saldo disponible y provisión vienen del MISMO motor
      // de la cartola de Vacaciones (saldo períodos cumplidos + proporcional en curso;
      // provisión = días hábiles ×1,4 corridos × remuneración diaria, matemática del finiquito)
      require('./vac-cuenta.controller').calcularSaldosEquipo(),
      // Ausentismo SIEMPRE en días HÁBILES (dias_habiles se calcula al registrar con shared/feriados)
      pool.query(`SELECT DATE_FORMAT(fecha_desde,'%Y-%m') m, tipo, SUM(dias_habiles) d
                    FROM rh_ausencias WHERE estado IN ('APROBADA','REGISTRADA') AND fecha_desde >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
                   GROUP BY m, tipo`).then(r => r[0]),
      pool.query(`SELECT mes m, SUM(total_haberes) haberes, SUM(liquido) liquido, COUNT(*) n
                    FROM rh_liquidaciones WHERE estado='EMITIDA' GROUP BY mes ORDER BY mes DESC LIMIT 12`).then(r => r[0]),
      pool.query(`SELECT tipo k, estado, COUNT(*) n FROM rh_solicitudes WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH) GROUP BY tipo, estado`).then(r => r[0]),
      pool.query(`SELECT AVG(TIMESTAMPDIFF(YEAR, u.fecha_nacimiento, CURDATE())) edad,
                         AVG(TIMESTAMPDIFF(MONTH, u.fecha_ingreso, CURDATE())) ant_meses
                    FROM ${UNIV} WHERE ${WU}`).then(r => r[0][0]),
    ]);

    const mm = meses12();
    const serie = rows => mm.map(m => ({ m, n: Number((rows.find(r => r.m === m) || {}).n) || 0 }));
    const ingresos = serie(ingresosMes);
    const egresos = serie(egresosMes);
    const egresos12 = egresos.reduce((s, x) => s + x.n, 0);
    const dotacion = Number(act.n) || 0;
    // Stock de dotación al cierre de cada mes: se reconstruye hacia atrás desde la
    // dotación actual restando los ingresos y sumando los egresos posteriores al mes
    const stock = mm.map(() => 0);
    let s = dotacion;
    for (let i = mm.length - 1; i >= 0; i--) { stock[i] = s; s = s - ingresos[i].n + egresos[i].n; }
    // Rotación anual: egresos últimos 12m / dotación promedio aproximada
    const rotacion = dotacion ? Math.round((egresos12 / dotacion) * 1000) / 10 : 0;

    const ausentismo = mm.map(m => ({
      m,
      licencias: Number(ausMes.filter(r => r.m === m && /LICENCIA/i.test(r.tipo)).reduce((s, r) => s + Number(r.d || 0), 0)),
      otros: Number(ausMes.filter(r => r.m === m && !/LICENCIA/i.test(r.tipo)).reduce((s, r) => s + Number(r.d || 0), 0)),
    }));

    res.json({ success: true, error: null, data: {
      dotacion, porSexo, porContrato, porCargo, porCC,
      edad_promedio: edadesAnt?.edad != null ? Math.round(Number(edadesAnt.edad) * 10) / 10 : null,
      antiguedad_meses: edadesAnt?.ant_meses != null ? Math.round(Number(edadesAnt.ant_meses)) : null,
      ingresos, egresos, egresos12, rotacion, stock,
      vacaciones: {
        saldo_total: vacEquipo.total_dias,
        pasivo: vacEquipo.total_provision,
        top: vacEquipo.saldos.filter(s => s.disponibles > 0).sort((a, b) => b.disponibles - a.disponibles).slice(0, 5)
          .map(s => ({ nombre: s.nombre, dias: Math.round(s.disponibles * 10) / 10 })),
      },
      ausentismo,
      planilla: liqMes.reverse(),
      solicitudes: solTipo,
    }});
  } catch (e) {
    console.error('[rrhh analytics]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error calculando indicadores' });
  }
};
