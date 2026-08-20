'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   CUENTA CORRIENTE DE VACACIONES (estilo AVSOFT "Consulta Vacaciones")
   · ABONOS automáticos: 15 días legales al cumplir cada aniversario (período
     desde/hasta) + FERIADO PROGRESIVO (art. 68 CT): con más de 10 años
     trabajados (previos declarados + antigüedad en la empresa), 1 día extra
     por cada 3 nuevos años — depositado por período, como AVSOFT.
   · CARGOS: cada solicitud de vacaciones APROBADA descuenta sus días hábiles.
   · AJUSTES: RRHH cuadra el saldo histórico contra AVSOFT una sola vez.
   Saldo disponible = movimientos + devengo proporcional del período en curso
   (1,25/mes). ESTE es el motor único: lo usan el formulario de vacaciones,
   el módulo Ausencias y el finiquito.
   ───────────────────────────────────────────────────────────────────────────── */
const { programar } = require('../../../../shared/scheduler.js');
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });
const isoF = f => f == null ? null
  : (f instanceof Date ? new Date(f.getTime() - f.getTimezoneOffset() * 60000).toISOString() : String(f)).slice(0, 10);

require('../../../../shared/migrate').enFila('rrhh-vac-cuenta', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_vac_movimientos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_usuario INT NOT NULL,
    tipo VARCHAR(12) NOT NULL,               -- DEVENGO | PROGRESIVO | TOMADO | AJUSTE
    dias DECIMAL(6,1) NOT NULL,              -- + abono / − cargo
    periodo_desde DATE NULL, periodo_hasta DATE NULL,
    glosa VARCHAR(300) NULL,
    id_ref INT NULL,                         -- id de rh_vacaciones cuando es TOMADO
    creado_por INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_u (id_usuario), INDEX idx_ref (tipo, id_ref)
  )`);
  await pool.query(`ALTER TABLE rh_fichas ADD COLUMN IF NOT EXISTS anos_trabajados_previos TINYINT NOT NULL DEFAULT 0`).catch(() => {});
  // tipo nuevo de ausencia (causal art. 160 N°3)
  const [[t]] = await pool.query("SELECT valor FROM rh_config WHERE clave='ausencia_tipos'");
  if (t && !t.valor.includes('AUSENCIA INJUSTIFICADA'))
    await pool.query("UPDATE rh_config SET valor=CONCAT(valor, ',AUSENCIA INJUSTIFICADA') WHERE clave='ausencia_tipos'");
  // tipo de documento para respaldar los años previos (feriado progresivo)
  const [[dt]] = await pool.query("SELECT valor FROM rh_config WHERE clave='doc_tipos'");
  if (dt && !dt.valor.includes('CERTIFICADO AFP'))
    await pool.query("UPDATE rh_config SET valor=CONCAT(valor, ',CERTIFICADO AFP (AÑOS COTIZADOS)') WHERE clave='doc_tipos'");
  /* Ajustes de saldo: los propone RRHH y NO tocan la cuenta hasta que los
     firman la jefatura del colaborador y la gerencia (mismo espíritu que las
     Solicitudes). Recién ahí nace el movimiento AJUSTE. */
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_vac_ajustes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_usuario INT NOT NULL,
    dias DECIMAL(6,1) NOT NULL,
    glosa VARCHAR(300) NOT NULL,
    estado VARCHAR(12) DEFAULT 'PENDIENTE',   -- PENDIENTE | APROBADO | RECHAZADO
    paso INT DEFAULT 0,                        -- 0 = JEFATURA · 1 = GERENCIA
    creado_por INT NULL,
    resuelto_motivo VARCHAR(300) NULL,
    id_movimiento INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_u (id_usuario), INDEX idx_e (estado)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_vac_ajuste_firmas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_ajuste INT NOT NULL, paso INT NOT NULL, rol VARCHAR(12) NOT NULL,
    id_usuario INT NOT NULL, nombre VARCHAR(160), cargo VARCHAR(120),
    decision VARCHAR(10) NOT NULL, comentario VARCHAR(300) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_aj_paso (id_ajuste, paso)
  )`);
  console.log('[rrhh-vac-cuenta] listo');
});

/* Backfill del cambio de convención: los PROGRESIVO ya depositados se
   recalculan con la fórmula nueva (al cierre del período). Los períodos que
   antes daban 0 y ahora dan >0 los inserta solo generarDevengos() al correr. */
require('../../../../shared/migrate').migrar('vac-prog-convencion-v1', async () => {
  const [rows] = await pool.query(`
    SELECT m.id, m.id_usuario, m.dias, DATE_FORMAT(m.periodo_desde,'%Y-%m-%d') pd,
           DATE_FORMAT(u.fecha_ingreso,'%Y-%m-%d') fi, COALESCE(f.anos_trabajados_previos,0) previos
      FROM rh_vac_movimientos m
      JOIN usuarios u ON u.id_usuario = m.id_usuario
      LEFT JOIN rh_fichas f ON f.id_usuario = m.id_usuario
     WHERE m.tipo='PROGRESIVO'`);
  let corregidos = 0;
  for (const r of rows) {
    if (!r.fi || !r.pd) continue;
    const n = (parseInt(r.pd.slice(0, 4)) - parseInt(r.fi.slice(0, 4))) + 1;
    const nuevo = progresivoDelPeriodo(r.previos, n);
    if (nuevo !== Number(r.dias)) {
      await pool.query('UPDATE rh_vac_movimientos SET dias=?, glosa=CONCAT(glosa, \' — recalculado convención al cierre del período\') WHERE id=?', [nuevo, r.id]);
      corregidos++;
    }
  }
  await generarDevengos();   // deposita los períodos que la fórmula vieja dejó en 0
  console.log(`[vac-prog convención] ${rows.length} movimientos revisados, ${corregidos} corregidos + devengos regenerados`);
});

/* ── Alegato SEMANAL: años previos declarados SIN certificado AFP ───────────── */
const _w = require('../../../../api-gateway/public/js/rrhh-core').semanaISO; // motor único
async function alegarSinCertificadoAFP() {
  try {
    const [pend] = await pool.query(
      `SELECT u.id_usuario, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) nombre, f.anos_trabajados_previos
         FROM rh_fichas f JOIN usuarios u ON u.id_usuario=f.id_usuario AND u.estado='activo'
        WHERE f.anos_trabajados_previos > 0
          AND NOT EXISTS (SELECT 1 FROM rh_documentos d WHERE d.id_usuario=f.id_usuario AND d.tipo LIKE 'CERTIFICADO AFP%')`);
    if (!pend.length) return;
    const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');
    const [rr] = await pool.query(
      `SELECT DISTINCT u.id_usuario FROM usuarios u
        JOIN permisos_perfil pp ON pp.id_perfil=u.id_perfil AND pp.habilitado=1
        JOIN funcionalidades f ON f.id_funcionalidad=pp.id_funcionalidad
       WHERE f.codigo='rh_colaboradores' AND u.estado='activo'`);
    // la clave NO deduplica en notificar(): chequear aquí para no repetir en la semana
    const _clave = 'afp_cert_pendiente_' + _w(new Date());
    const [[_ya]] = await pool.query('SELECT 1 ok FROM notificaciones WHERE clave=? LIMIT 1', [_clave]);
    if (_ya) return;
    const lista = pend.slice(0, 5).map(p => `${p.nombre} (${p.anos_trabajados_previos} años)`).join(', ') + (pend.length > 5 ? '…' : '');
    notificar(rr.map(x => x.id_usuario), {
      tipo: 'RRHH', prioridad: 'alta',
      titulo: `${pend.length} colaborador(es) con años previos SIN certificado AFP`,
      mensaje: `El feriado progresivo declara años trabajados que deben respaldarse con el certificado de cotizaciones de la AFP: ${lista}. Súbelo a la carpeta digital (tipo "CERTIFICADO AFP").`,
      href: '/recursos-humanos/colaboradores/',
      clave: _clave,
    });
  } catch (e) { console.error('[alegato cert AFP]', e.message); }
}
setTimeout(alegarSinCertificadoAFP, 140 * 1000);
programar('rrhh-certificado-afp', alegarSinCertificadoAFP, 24 * 60 * 60 * 1000);

/* ── Generación de devengos: cada aniversario cumplido deposita su período ──── */
function progresivoDelPeriodo(previos, periodoN) {
  /* CONVENCIÓN (cambiada 20-08-2026, decisión de Pato): el día progresivo se
     abona con el período en que se CUMPLE el trienio — años trabajados al
     CIERRE del período (previos + periodoN). Es la interpretación de la DT y
     el criterio de las AFP ("debe sumar 13 años cotizados", cumplidos).
     Antes se contaban los años al inicio del período (previos + N − 1), lo
     que corría todo un año hacia adelante. Backfill: vac-prog-convencion-v1. */
  return Math.max(0, Math.floor(((previos || 0) + periodoN - 10) / 3));
}

async function generarDevengos() {
  try {
    const [[cfgV]] = await pool.query("SELECT valor FROM rh_config WHERE clave='vac_dias_anuales'");
    const anuales = parseFloat(cfgV?.valor) || 15;
    const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
    // Universo canónico (mismo de toda RRHH): no devengar a cuentas técnicas/externos
    const [users] = await pool.query(
      `SELECT u.id_usuario, DATE_FORMAT(u.fecha_ingreso,'%Y-%m-%d') fi, COALESCE(f.anos_trabajados_previos,0) previos
         FROM usuarios u LEFT JOIN rh_fichas f ON f.id_usuario=u.id_usuario
        WHERE u.estado='activo' AND COALESCE(f.no_mostrar,0)=0 AND u.fecha_ingreso IS NOT NULL`);
    for (const u of users) {
      const [devs] = await pool.query(
        `SELECT tipo, DATE_FORMAT(periodo_desde,'%Y-%m-%d') pd FROM rh_vac_movimientos WHERE id_usuario=? AND tipo IN ('DEVENGO','PROGRESIVO')`, [u.id_usuario]);
      const tieneDev = new Set(devs.filter(d => d.tipo === 'DEVENGO').map(d => d.pd));
      const tieneProg = new Set(devs.filter(d => d.tipo === 'PROGRESIVO').map(d => d.pd));
      const fi = new Date(u.fi + 'T12:00:00');
      // el período N se DEPOSITA al cumplirse (aniversario N): períodos cuyo fin ya pasó o hoy
      for (let n = 1; n < 60; n++) {
        const pd = new Date(fi); pd.setFullYear(fi.getFullYear() + (n - 1));
        const ph = new Date(fi); ph.setFullYear(fi.getFullYear() + n); ph.setDate(ph.getDate() - 1);
        const finPeriodo = new Date(fi); finPeriodo.setFullYear(fi.getFullYear() + n);   // aniversario N
        if (isoF(finPeriodo) > hoy) break;                        // período aún no cumplido
        const pdIso = isoF(pd);
        if (!tieneDev.has(pdIso))
          await pool.query(`INSERT INTO rh_vac_movimientos (id_usuario, tipo, dias, periodo_desde, periodo_hasta, glosa)
            VALUES (?,?,?,?,?,?)`, [u.id_usuario, 'DEVENGO', anuales, pdIso, isoF(ph), `Período ${n} (${pdIso} → ${isoF(ph)})`]);
        // el progresivo se backfillea aparte (ej: al cargar los años previos después)
        const prog = progresivoDelPeriodo(u.previos, n);
        if (prog > 0 && !tieneProg.has(pdIso))
          await pool.query(`INSERT INTO rh_vac_movimientos (id_usuario, tipo, dias, periodo_desde, periodo_hasta, glosa)
            VALUES (?,?,?,?,?,?)`, [u.id_usuario, 'PROGRESIVO', prog, pdIso, isoF(ph), `Feriado progresivo período ${n} (art. 68)`]);
      }
    }
  } catch (e) { console.error('[vac devengos]', e.message); }
}
setTimeout(generarDevengos, 100 * 1000);
programar('rrhh-devengo-vacaciones', generarDevengos, 24 * 60 * 60 * 1000);
exports.generarDevengos = generarDevengos;

/* ── MOTOR ÚNICO de saldo: movimientos + proporcional del período en curso ──── */
async function saldoCuenta(idUsuario, aFecha) {
  const fecha = aFecha || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
  const [[m]] = await pool.query(
    `SELECT COALESCE(SUM(dias),0) s,
            COALESCE(SUM(CASE WHEN dias>0 THEN dias END),0) abonos,
            COALESCE(SUM(CASE WHEN dias<0 THEN -dias END),0) cargos
       FROM rh_vac_movimientos WHERE id_usuario=?`, [idUsuario]);
  // proporcional del período en curso (desde el último aniversario, 30avos → anuales/12 por mes completo)
  const [[u]] = await pool.query(
    `SELECT DATE_FORMAT(u.fecha_ingreso,'%Y-%m-%d') fi, COALESCE(f.anos_trabajados_previos,0) previos
       FROM usuarios u LEFT JOIN rh_fichas f ON f.id_usuario=u.id_usuario WHERE u.id_usuario=?`, [idUsuario]);
  let proporcional = 0;
  if (u?.fi) {
    const [[cfgV]] = await pool.query("SELECT valor FROM rh_config WHERE clave='vac_dias_anuales'");
    const anuales = parseFloat(cfgV?.valor) || 15;
    const fi = new Date(u.fi + 'T12:00:00'), h = new Date(fecha + 'T12:00:00');
    let mesesTot = (h.getFullYear() - fi.getFullYear()) * 12 + (h.getMonth() - fi.getMonth());
    if (h.getDate() < fi.getDate()) mesesTot--;
    mesesTot = Math.max(0, mesesTot);
    const mesesEnCurso = mesesTot % 12;
    const n = Math.floor(mesesTot / 12) + 1;
    const progAnual = progresivoDelPeriodo(u.previos, n);
    proporcional = Math.round(mesesEnCurso * ((anuales + progAnual) / 12) * 10) / 10;
  }
  return {
    saldo_periodos: Number(m.s), abonos: Number(m.abonos), cargos: Number(m.cargos),
    proporcional, disponibles: Math.round((Number(m.s) + proporcional) * 10) / 10,
  };
}
exports.saldoCuenta = saldoCuenta;

/* Cargo automático al aprobar una solicitud (llamado desde resolverVacaciones) */
async function registrarTomado(solicitud) {
  try {
    const [[ya]] = await pool.query(`SELECT id FROM rh_vac_movimientos WHERE tipo='TOMADO' AND id_ref=?`, [solicitud.id]);
    if (ya) return;
    // días hábiles del rango — MOTOR ÚNICO shared/feriados (L-V y descuenta feriados legales)
    const habiles = require('../../../../shared/feriados').diasHabilesEntre(isoF(solicitud.fecha_desde), isoF(solicitud.fecha_hasta));
    await pool.query(`INSERT INTO rh_vac_movimientos (id_usuario, tipo, dias, glosa, id_ref)
      VALUES (?,?,?,?,?)`, [solicitud.id_usuario, 'TOMADO', -habiles,
      `Vacaciones ${isoF(solicitud.fecha_desde)} al ${isoF(solicitud.fecha_hasta)} (${habiles} hábiles)`, solicitud.id]);
  } catch (e) { console.error('[vac tomado]', e.message); }
}
exports.registrarTomado = registrarTomado;

/* ── Endpoints ──────────────────────────────────────────────────────────────── */
exports.getCuenta = async (req, res) => {
  try {
    const u = req.usuario || {};
    let objetivo = u.id_usuario;
    if (req.query.id_usuario && String(req.query.id_usuario) !== String(u.id_usuario)) objetivo = parseInt(req.query.id_usuario);
    // el TOMADO trae las fechas reales de la solicitud (desde → hasta y hábiles)
    const [movs] = await pool.query(
      `SELECT m.id, m.tipo, m.dias, DATE_FORMAT(m.periodo_desde,'%Y-%m-%d') periodo_desde,
              DATE_FORMAT(m.periodo_hasta,'%Y-%m-%d') periodo_hasta, m.glosa,
              DATE_FORMAT(m.created_at,'%Y-%m-%d') fecha,
              DATE_FORMAT(v.fecha_desde,'%Y-%m-%d') uso_desde, DATE_FORMAT(v.fecha_hasta,'%Y-%m-%d') uso_hasta,
              TRIM(CONCAT_WS(' ', a.nombre, a.apellido)) autor
         FROM rh_vac_movimientos m
         LEFT JOIN rh_vacaciones v ON v.id = m.id_ref AND m.tipo='TOMADO'
         LEFT JOIN usuarios a ON a.id_usuario = m.creado_por
        WHERE m.id_usuario=? ORDER BY COALESCE(m.periodo_desde, m.created_at), m.id`, [objetivo]);
    const saldo = await saldoCuenta(objetivo);

    // Vista cuenta corriente: los CARGOS se consumen FIFO desde el período más
    // antiguo — cada consumo se muestra DEBAJO del período que lo financió.
    const periodos = [];
    for (const m of movs.filter(x => x.dias > 0 && x.periodo_desde)) {
      let p = periodos.find(x => x.desde === m.periodo_desde);
      if (!p) { p = { desde: m.periodo_desde, hasta: m.periodo_hasta, abonos: 0, detalle_abono: [], consumos: [], saldo: 0 }; periodos.push(p); }
      p.abonos += Number(m.dias); p.saldo += Number(m.dias);
      p.detalle_abono.push({ tipo: m.tipo, dias: Number(m.dias) });
    }
    periodos.sort((a, b) => a.desde < b.desde ? -1 : 1);
    const sueltosAbono = movs.filter(x => x.dias > 0 && !x.periodo_desde)
      .map(m => ({ tipo: m.tipo, dias: Number(m.dias), glosa: m.glosa, fecha: m.fecha, autor: m.autor }));
    const cargos = movs.filter(x => x.dias < 0).map(m => ({ tipo: m.tipo, dias: -Number(m.dias), glosa: m.glosa,
      fecha: m.fecha, desde: m.uso_desde, hasta: m.uso_hasta, autor: m.autor }));
    const sinPeriodo = [];
    for (const c of cargos) {
      let resto = c.dias;
      for (const p of periodos) {
        if (resto <= 0) break;
        if (p.saldo <= 0) continue;
        const usa = Math.min(p.saldo, resto);
        p.saldo = Math.round((p.saldo - usa) * 10) / 10;
        resto = Math.round((resto - usa) * 10) / 10;
        p.consumos.push({ tipo: c.tipo, dias: usa, glosa: c.glosa, fecha: c.fecha });
      }
      if (resto > 0) sinPeriodo.push({ ...c, dias: resto });   // sobregiro: cargo sin período que lo cubra
    }
    // Período EN CURSO (aún no cumplido): fechas + días proporcionales a hoy
    let enCurso = null;
    const [[uf]] = await pool.query(`SELECT DATE_FORMAT(fecha_ingreso,'%Y-%m-%d') fi FROM usuarios WHERE id_usuario=?`, [objetivo]);
    if (uf?.fi && saldo.proporcional >= 0) {
      const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
      const fi = new Date(uf.fi + 'T12:00:00'), h = new Date(hoy + 'T12:00:00');
      let anios = h.getFullYear() - fi.getFullYear();
      const aniv = new Date(fi); aniv.setFullYear(fi.getFullYear() + anios);
      if (aniv > h) anios--;
      const pd = new Date(fi); pd.setFullYear(fi.getFullYear() + anios);
      const ph = new Date(fi); ph.setFullYear(fi.getFullYear() + anios + 1); ph.setDate(ph.getDate() - 1);
      enCurso = { desde: isoF(pd), hasta: isoF(ph), proporcional: saldo.proporcional };
    }
    // Ajustes propuestos por RRHH que aún no firman jefatura/gerencia: se
    // muestran en la cartola como "pendientes" (no suman al saldo todavía).
    const [ajPend] = await pool.query(
      `SELECT a.id, a.dias, a.glosa, a.paso, DATE_FORMAT(a.created_at,'%Y-%m-%d') fecha,
              TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) autor
         FROM rh_vac_ajustes a LEFT JOIN usuarios u ON u.id_usuario=a.creado_por
        WHERE a.id_usuario=? AND a.estado='PENDIENTE' ORDER BY a.id`, [objetivo]);
    ok(res, { movimientos: movs, periodos, abonos_sueltos: sueltosAbono, cargos_sin_periodo: sinPeriodo,
      periodo_en_curso: enCurso, ajustes_pendientes: ajPend, ...saldo });
  } catch (e) { fail(res, e.message); }
};

/* MOTOR ÚNICO del cálculo de saldos+provisión del equipo — lo usan la pestaña
   "Saldos del equipo" y la contabilización al cierre de mes. */
async function calcularSaldosEquipo() {
  const [users] = await pool.query(
      `SELECT u.id_usuario, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) nombre, u.rut,
              DATE_FORMAT(u.fecha_ingreso,'%Y-%m-%d') fecha_ingreso, COALESCE(f.anos_trabajados_previos,0) previos
         FROM usuarios u LEFT JOIN rh_fichas f ON f.id_usuario=u.id_usuario
        WHERE u.estado='activo' AND COALESCE(f.no_mostrar,0)=0 ORDER BY u.apellido, u.nombre`);
    // Provisión de vacaciones (lo que habría que pagar si la persona se va):
    // motores únicos — base desde base-remuneracion.js y fórmula desde rrhh-core.js
    // (los mismos que usa el finiquito para el feriado proporcional).
    const baseDe = await require('../base-remuneracion').remuneracionBaseMapa();
    const { provisionVacaciones } = require('../../../../api-gateway/public/js/rrhh-core');
    // días de feriado progresivo (art. 68) ya abonados, por colaborador
    const [progs] = await pool.query(
      `SELECT id_usuario, COALESCE(SUM(dias),0) d FROM rh_vac_movimientos WHERE tipo='PROGRESIVO' GROUP BY id_usuario`);
    const progDe = new Map(progs.map(p => [p.id_usuario, Number(p.d)]));
    const filas = [];
    let totDias = 0, totProv = 0;
    for (const u of users) {
      const s = await saldoCuenta(u.id_usuario);
      const base = baseDe(u.id_usuario);
      const provision = provisionVacaciones(s.disponibles, base);
      totDias += s.disponibles; totProv += provision;
      filas.push({ ...u, ...s, base, provision, progresivos: progDe.get(u.id_usuario) || 0 });
    }
    return { saldos: filas, total_dias: Math.round(totDias * 10) / 10, total_provision: totProv };
}
exports.calcularSaldosEquipo = calcularSaldosEquipo;

/* ── Alcance jerárquico: yo + TODA mi línea directa hacia abajo ─────────────── */
async function miLinea(idUsuario) {
  const [rows] = await pool.query(
    `WITH RECURSIVE linea (id_usuario) AS (
        SELECT ? UNION ALL
        SELECT u.id_usuario FROM usuarios u JOIN linea l ON u.id_supervisor = l.id_usuario)
     SELECT id_usuario FROM linea`, [idUsuario]).catch(async () => {
    // sin CTE recursiva: se recorre por niveles (mismo resultado)
    const vistos = new Set([idUsuario]); let frente = [idUsuario];
    while (frente.length) {
      const [hijos] = await pool.query(`SELECT id_usuario FROM usuarios WHERE id_supervisor IN (?)`, [frente]);
      frente = hijos.map(h => h.id_usuario).filter(id => !vistos.has(id));
      frente.forEach(id => vistos.add(id));
    }
    return [[...vistos].map(id => ({ id_usuario: id }))];
  });
  return new Set(rows.map(r => r.id_usuario));
}
const esRRHH = id => require('../../../../shared/middleware/permisos').tieneFunc(id, 'rh_colaboradores').catch(() => false);

/* Gerencia = perfil gerencial (los que además firman el 2º paso del ajuste) */
async function esGerente(idUsuario) {
  const [[r]] = await pool.query(
    `SELECT p.nombre FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil WHERE u.id_usuario=?`, [idUsuario]);
  return /gerente|director|administrador/i.test(r?.nombre || '');
}

/* GET /api/rrhh/vacaciones/saldos — mi línea directa (RRHH y gerencia ven todo) */
exports.getSaldos = async (req, res) => {
  try {
    const yo = req.usuario.id_usuario;
    const [rrhh, gerente] = await Promise.all([esRRHH(yo), esGerente(yo)]);
    const data = await calcularSaldosEquipo();
    let saldos = data.saldos;
    if (!rrhh) {                                   // jefaturas: solo su línea
      const linea = await miLinea(yo);
      saldos = saldos.filter(s => linea.has(s.id_usuario));
    }
    if (!gerente) saldos = saldos.map(({ provision, base, ...s }) => s);   // provisión: solo gerencia
    ok(res, {
      saldos, es_rrhh: rrhh, ver_provision: gerente,
      total_dias: Math.round(saldos.reduce((a, s) => a + s.disponibles, 0) * 10) / 10,
      total_provision: gerente ? saldos.reduce((a, s) => a + (s.provision || 0), 0) : null,
    });
  } catch (e) { fail(res, e.message); }
};

/* ── AJUSTES DE SALDO (los propone RRHH · firman jefatura y gerencia) ───────── */
const ROLES_AJUSTE = ['JEFATURA', 'GERENCIA'];

async function firmantesDe(aj) {
  if (aj.paso === 0) {
    const [[u]] = await pool.query(`SELECT id_supervisor FROM usuarios WHERE id_usuario=?`, [aj.id_usuario]);
    if (u?.id_supervisor) return [u.id_supervisor];
  }
  const [rows] = await pool.query(
    `SELECT DISTINCT u.id_usuario FROM usuarios u
       JOIN permisos_perfil pp ON pp.id_perfil=u.id_perfil AND pp.habilitado=1
       JOIN funcionalidades f ON f.id_funcionalidad=pp.id_funcionalidad
      WHERE f.codigo='rh_aprobar' AND u.estado='activo'`);
  return rows.map(r => r.id_usuario);
}

async function avisarAjuste(aj, nombre) {
  const ids = await firmantesDe(aj);
  if (!ids.length) return;
  require('../../../notificaciones/src/controllers/notificaciones.controller').notificar(ids, {
    tipo: 'RRHH', prioridad: 'alta', sonar: true,
    titulo: `Ajuste de vacaciones por aprobar: ${nombre}`,
    mensaje: `${aj.dias > 0 ? '+' : ''}${aj.dias} día(s) — ${aj.glosa}. Paso ${aj.paso + 1} de 2 (${ROLES_AJUSTE[aj.paso]}).`,
    href: '/recursos-humanos/vacaciones/', clave: `vaj_${aj.id}_p${aj.paso}`,
  });
}

/* POST /vacaciones/cuenta/ajuste — RRHH propone (no aplica hasta las 2 firmas) */
exports.ajuste = async (req, res) => {
  try {
    const { id_usuario, dias, glosa } = req.body || {};
    const d = Math.round(parseFloat(dias) * 10) / 10;
    if (!parseInt(id_usuario) || !d || !String(glosa || '').trim())
      return fail(res, 'Faltan colaborador, días (±) o comentario', 400);
    if (!(await esRRHH(req.usuario.id_usuario)))
      return fail(res, 'Solo Recursos Humanos puede proponer ajustes de saldo', 403);
    const [r] = await pool.query(
      `INSERT INTO rh_vac_ajustes (id_usuario, dias, glosa, creado_por) VALUES (?,?,?,?)`,
      [parseInt(id_usuario), d, String(glosa).slice(0, 300), req.usuario.id_usuario]);
    const [[u]] = await pool.query(`SELECT TRIM(CONCAT_WS(' ', nombre, apellido)) n FROM usuarios WHERE id_usuario=?`, [id_usuario]);
    await avisarAjuste({ id: r.insertId, id_usuario: parseInt(id_usuario), dias: d, glosa, paso: 0 }, u?.n || '');
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'vac_ajuste', entidad_id: r.insertId,
      detalle: `Propone ajuste vacaciones ${d > 0 ? '+' : ''}${d} días a ${u?.n}: ${glosa}` });
    ok(res, { id: r.insertId, estado: 'PENDIENTE' });
  } catch (e) { fail(res, e.message); }
};

/* GET /vacaciones/ajustes — los que me toca firmar + los que propuse */
exports.ajustesListar = async (req, res) => {
  try {
    const yo = req.usuario.id_usuario;
    const [pend] = await pool.query(
      `SELECT a.*, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) nombre, u.id_supervisor,
              TRIM(CONCAT_WS(' ', c.nombre, c.apellido)) autor
         FROM rh_vac_ajustes a
         JOIN usuarios u ON u.id_usuario=a.id_usuario
         LEFT JOIN usuarios c ON c.id_usuario=a.creado_por
        WHERE a.estado='PENDIENTE' ORDER BY a.id`);
    const gerente = await esGerente(yo);
    const mios = [];
    for (const a of pend) {
      const puedo = a.paso === 0
        ? (a.id_supervisor === yo || (!a.id_supervisor && gerente))
        : gerente;
      if (puedo && a.creado_por !== yo) mios.push({ ...a, rol_paso: ROLES_AJUSTE[a.paso] });
    }
    ok(res, { ajustes: mios });
  } catch (e) { fail(res, e.message); }
};

/* POST /vacaciones/ajustes/:id/resolver — APROBAR | RECHAZAR (comentario) */
exports.ajusteResolver = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { decision, comentario } = req.body || {};
    const [[aj]] = await pool.query(`SELECT * FROM rh_vac_ajustes WHERE id=?`, [id]);
    if (!aj || aj.estado !== 'PENDIENTE') return fail(res, 'El ajuste ya fue resuelto', 400);
    const yo = req.usuario.id_usuario;
    if (aj.creado_por === yo) return fail(res, 'Quien propone el ajuste no puede firmarlo', 403);
    const habilitados = await firmantesDe(aj);
    if (!habilitados.includes(yo)) return fail(res, 'No te corresponde firmar este paso', 403);
    if (decision === 'RECHAZAR' && !String(comentario || '').trim())
      return fail(res, 'El rechazo exige un comentario', 400);

    const [[u]] = await pool.query(
      `SELECT TRIM(CONCAT_WS(' ', nombre, apellido)) n, cargo FROM usuarios WHERE id_usuario=?`, [yo]);
    await pool.query(`INSERT IGNORE INTO rh_vac_ajuste_firmas (id_ajuste, paso, rol, id_usuario, nombre, cargo, decision, comentario)
      VALUES (?,?,?,?,?,?,?,?)`, [id, aj.paso, ROLES_AJUSTE[aj.paso], yo, u?.n, u?.cargo,
      decision === 'RECHAZAR' ? 'RECHAZA' : 'APRUEBA', String(comentario || '').slice(0, 300) || null]);

    if (decision === 'RECHAZAR') {
      await pool.query(`UPDATE rh_vac_ajustes SET estado='RECHAZADO', resuelto_motivo=? WHERE id=?`, [String(comentario).slice(0, 300), id]);
    } else if (aj.paso + 1 >= ROLES_AJUSTE.length) {
      // última firma → recién ahora nace el movimiento en la cuenta corriente
      const [mv] = await pool.query(
        `INSERT INTO rh_vac_movimientos (id_usuario, tipo, dias, glosa, creado_por) VALUES (?,?,?,?,?)`,
        [aj.id_usuario, 'AJUSTE', aj.dias, `${aj.glosa} — aprobado por jefatura y gerencia`, aj.creado_por]);
      await pool.query(`UPDATE rh_vac_ajustes SET estado='APROBADO', paso=?, id_movimiento=? WHERE id=?`,
        [aj.paso + 1, mv.insertId, id]);
    } else {
      await pool.query(`UPDATE rh_vac_ajustes SET paso=? WHERE id=?`, [aj.paso + 1, id]);
      const [[c]] = await pool.query(`SELECT TRIM(CONCAT_WS(' ', nombre, apellido)) n FROM usuarios WHERE id_usuario=?`, [aj.id_usuario]);
      await avisarAjuste({ ...aj, paso: aj.paso + 1 }, c?.n || '');
    }
    auditar({ req, accion: decision === 'RECHAZAR' ? 'RECHAZAR' : 'APROBAR', modulo: 'rrhh',
      entidad: 'vac_ajuste', entidad_id: id, detalle: `${ROLES_AJUSTE[aj.paso]} ${decision} ajuste de ${aj.dias} días` });
    ok(res, { ok: true });
  } catch (e) { fail(res, e.message); }
};
