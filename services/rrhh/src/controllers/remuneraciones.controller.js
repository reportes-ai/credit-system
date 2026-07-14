'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   RECURSOS HUMANOS — Fase 3: REMUNERACIONES (liquidaciones de sueldo chilenas).
   MOTOR ÚNICO calcLiquidacion(): un solo lugar calcula la liquidación.

   Haberes:
     · Imponibles: sueldo base + comisiones (auto desde el motor de comisiones,
       editable) + otros imponibles + gratificación legal (25% con tope 4,75 IMM/12).
     · No imponibles: colación + movilización + otros.
   Descuentos legales (sobre imponible topado a rem_tope_imponible_uf × UF):
     · AFP: tasa por administradora (rh_afp_tasas, paramétrica).
     · Salud: 7% legal (rem_salud_pct) — plan Isapre pactado en UF pendiente.
     · AFC: 0,6% trabajador solo contrato INDEFINIDO (tope rem_tope_afc_uf).
     · Impuesto único 2ª categoría: tramos UTM paramétricos (rh_impuesto_tramos).
   Indicadores paramétricos en rh_config (rem_*); UF de shared/uf.js; UTM tabla utm.
   Liquidaciones en rh_liquidaciones: BORRADOR (recalculable) → EMITIDA (congelada).
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { tieneFunc } = require('../../../../shared/middleware/permisos');
const { getUF } = require('../../../../shared/uf');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });
const nombreDe = u => `${u?.nombre || ''} ${u?.apellido || ''}`.trim() || u?.email || null;
const R = v => Math.round(Number(v) || 0);

/* ── Migración ─────────────────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('rrhh-remuneraciones', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rh_liquidaciones (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        id_usuario      INT NOT NULL,
        mes             CHAR(7) NOT NULL,
        nombre          VARCHAR(200) NULL,
        rut             VARCHAR(20) NULL,
        cargo           VARCHAR(120) NULL,
        detalle         JSON NULL,
        total_imponible DECIMAL(12,0) DEFAULT 0,
        total_haberes   DECIMAL(12,0) DEFAULT 0,
        total_descuentos DECIMAL(12,0) DEFAULT 0,
        liquido         DECIMAL(12,0) DEFAULT 0,
        estado          VARCHAR(12) NOT NULL DEFAULT 'BORRADOR',
        emitido_por     VARCHAR(160) NULL,
        emitido_at      DATETIME NULL,
        created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_usuario_mes (id_usuario, mes)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rh_afp_tasas (
        afp       VARCHAR(30) PRIMARY KEY,
        tasa_pct  DECIMAL(5,2) NOT NULL COMMENT '10% cotización + comisión AFP',
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
    const afps = [['CAPITAL', 11.44], ['CUPRUM', 11.44], ['HABITAT', 11.27], ['MODELO', 10.58], ['PLANVITAL', 11.16], ['PROVIDA', 11.45], ['UNO', 10.49]];
    for (const [a, t] of afps) await pool.query('INSERT IGNORE INTO rh_afp_tasas (afp, tasa_pct) VALUES (?,?)', [a, t]);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rh_impuesto_tramos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        desde_utm DECIMAL(8,2) NOT NULL,
        hasta_utm DECIMAL(8,2) NULL,
        factor    DECIMAL(6,4) NOT NULL,
        rebaja_utm DECIMAL(8,2) NOT NULL
      )`);
    const [[nt]] = await pool.query('SELECT COUNT(*) c FROM rh_impuesto_tramos');
    if (!nt.c) {
      const tramos = [[0, 13.5, 0, 0], [13.5, 30, 0.04, 0.54], [30, 50, 0.08, 1.74], [50, 70, 0.135, 4.49],
                      [70, 90, 0.23, 11.14], [90, 120, 0.304, 17.80], [120, 310, 0.35, 23.32], [310, null, 0.40, 38.82]];
      for (const t of tramos) await pool.query('INSERT INTO rh_impuesto_tramos (desde_utm, hasta_utm, factor, rebaja_utm) VALUES (?,?,?,?)', t);
    }
    await pool.query(`INSERT IGNORE INTO rh_config (clave, valor) VALUES
      ('rem_tope_imponible_uf', '87.8'),
      ('rem_tope_afc_uf', '131.9'),
      ('rem_afc_trabajador_pct', '0.6'),
      ('rem_salud_pct', '7'),
      ('rem_imm', '529000'),
      ('rem_grat_tope_imm', '4.75')`);
    // Haberes no imponibles fijos en la ficha
    await pool.query('ALTER TABLE rh_fichas ADD COLUMN colacion DECIMAL(10,0) NULL').catch(() => {});
    await pool.query('ALTER TABLE rh_fichas ADD COLUMN movilizacion DECIMAL(10,0) NULL').catch(() => {});
    // Funcionalidad (solo RRHH)
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='rh_remuneraciones' LIMIT 1");
    let idf = ex && ex.id_funcionalidad;
    if (!idf) {
      const [r] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (500002, 'Remuneraciones', 'rh_remuneraciones', '/recursos-humanos/remuneraciones/', 'bi-cash-stack')");
      idf = r.insertId;
    }
    for (const idp of [1, 2, 90009]) {
      await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
    }
    // Mantenedor "Indicadores de Remuneraciones" (AFP, topes, IMM, tramos impuesto)
    const [[modM]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' LIMIT 1");
    if (modM) {
      const [[exm]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mant_remuneraciones' LIMIT 1");
      let idm = exm && exm.id_funcionalidad;
      if (!idm) {
        const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
          [modM.id_modulo, 'Indicadores de Remuneraciones', 'mant_remuneraciones', '/mantenedores/remuneraciones/', 'bi-percent']);
        idm = r.insertId;
      }
      await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idm]);
    }
    console.log('[rrhh-remuneraciones] listo');
  } catch (e) { console.error('[rrhh-remuneraciones migration]', e.message); }
});

/* v2: plan isapre pactado en UF, días trabajados proporcionales y aportes
   del empleador (SIS, AFC empleador, mutual) — cierran la brecha contra la
   liquidación real de AVSOFT (validado con liquidación may-2026). */
require('../../../../shared/migrate').enFila('rrhh-remuneraciones-v2', async () => {
  try {
    await pool.query('ALTER TABLE rh_fichas ADD COLUMN plan_isapre_uf DECIMAL(8,3) NULL').catch(() => {});
    await pool.query(`INSERT IGNORE INTO rh_config (clave, valor) VALUES
      ('rem_sis_pct', '1.88'),
      ('rem_afc_emp_pct', '2.4'),
      ('rem_afc_emp_pfijo_pct', '3'),
      ('rem_mutual_pct', '0.93')`);
    console.log('[rrhh-remuneraciones-v2] listo');
  } catch (e) { console.error('[rrhh-remuneraciones-v2 migration]', e.message); }
});

/* ── Indicadores del período ────────────────────────────────────────────────── */
async function indicadores(mes) {
  const [cfgRows] = await pool.query("SELECT clave, valor FROM rh_config WHERE clave LIKE 'rem_%'");
  const cfg = {}; cfgRows.forEach(r => cfg[r.clave] = parseFloat(r.valor) || 0);
  const finMes = mes + '-28';
  const uf = (await getUF(finMes)) || (await getUF(new Date().toISOString().slice(0, 10))) || 0;
  const [[utmRow]] = await pool.query('SELECT valor FROM utm WHERE fecha <= ? ORDER BY fecha DESC LIMIT 1', [finMes + ' 23:59:59']);
  const utm = parseFloat(utmRow?.valor) || 0;
  const [afps] = await pool.query('SELECT afp, tasa_pct FROM rh_afp_tasas ORDER BY afp');
  const [tramos] = await pool.query('SELECT desde_utm, hasta_utm, factor, rebaja_utm FROM rh_impuesto_tramos ORDER BY desde_utm');
  return { ...cfg, uf, utm, afps, tramos };
}

/* ── MOTOR ÚNICO: liquidación de un colaborador ─────────────────────────────── */
function calcLiquidacion(inp, ind) {
  // Días trabajados: sueldo proporcional en 30avos (ausencias/ingresos parciales)
  const dias = inp.dias == null || inp.dias === '' ? 30 : Math.max(0, Math.min(30, Number(inp.dias)));
  const sueldo = R(R(inp.sueldo_base) * dias / 30), comisiones = R(inp.comisiones), otrosImp = R(inp.otros_imponibles);
  const colacion = R(inp.colacion), movilizacion = R(inp.movilizacion), otrosNoImp = R(inp.otros_no_imponibles);
  const otrosDesc = R(inp.otros_descuentos);

  const baseGrat = sueldo + comisiones + otrosImp;
  // Gratificación legal art. 50: 25% mensual con tope (4,75 IMM)/12
  const topeGrat = R(ind.rem_grat_tope_imm * ind.rem_imm / 12);
  const gratificacion = Math.min(R(baseGrat * 0.25), topeGrat);

  const imponible = baseGrat + gratificacion;
  const topeImp = R(ind.rem_tope_imponible_uf * ind.uf);
  const baseCotiz = Math.min(imponible, topeImp);

  const afpPct = parseFloat((ind.afps.find(a => a.afp === String(inp.afp || '').toUpperCase()) || {}).tasa_pct) || 0;
  const descAfp = inp.afp ? R(baseCotiz * afpPct / 100) : 0;
  const descSalud = R(baseCotiz * ind.rem_salud_pct / 100);
  // Plan Isapre pactado en UF: lo que exceda el 7% legal es "adicional isapre"
  // (descuento al líquido, pero NO rebaja la base tributable — solo el 7% legal).
  const planUF = Number(inp.plan_isapre_uf) || 0;
  const descSaludAdicional = planUF > 0 ? Math.max(0, R(planUF * ind.uf) - descSalud) : 0;
  const esIndef = String(inp.tipo_contrato || '').toUpperCase() === 'INDEFINIDO';
  const baseAfc = Math.min(imponible, R(ind.rem_tope_afc_uf * ind.uf));
  const descAfc = esIndef ? R(baseAfc * ind.rem_afc_trabajador_pct / 100) : 0;

  // Impuesto único 2ª categoría sobre la base tributable (imponible − previsión), tramos en UTM
  const baseTrib = Math.max(0, imponible - descAfp - descSalud - descAfc);
  const baseUtm = ind.utm > 0 ? baseTrib / ind.utm : 0;
  let impuesto = 0;
  for (const t of ind.tramos) {
    const desde = parseFloat(t.desde_utm), hasta = t.hasta_utm == null ? Infinity : parseFloat(t.hasta_utm);
    if (baseUtm > desde && baseUtm <= hasta) { impuesto = R(baseTrib * parseFloat(t.factor) - parseFloat(t.rebaja_utm) * ind.utm); break; }
  }
  impuesto = Math.max(0, impuesto);

  const totalHaberes = imponible + colacion + movilizacion + otrosNoImp;
  const totalDescuentos = descAfp + descSalud + descSaludAdicional + descAfc + impuesto + otrosDesc;
  // Aportes del EMPLEADOR (no afectan el líquido; alimentan costo empresa/Previred)
  const aporteSis = R(baseCotiz * (ind.rem_sis_pct || 0) / 100);
  const aporteAfcEmp = R(baseAfc * ((esIndef ? ind.rem_afc_emp_pct : ind.rem_afc_emp_pfijo_pct) || 0) / 100);
  const aporteMutual = R(baseCotiz * (ind.rem_mutual_pct || 0) / 100);
  return {
    dias, sueldo_base: sueldo, comisiones, otros_imponibles: otrosImp, gratificacion,
    total_imponible: imponible, base_cotizacion: baseCotiz,
    colacion, movilizacion, otros_no_imponibles: otrosNoImp,
    total_haberes: totalHaberes,
    afp: inp.afp || null, afp_pct: afpPct, desc_afp: descAfp,
    salud: inp.salud || null, salud_pct: ind.rem_salud_pct, desc_salud: descSalud,
    plan_isapre_uf: planUF || null, desc_salud_adicional: descSaludAdicional,
    afc_pct: esIndef ? ind.rem_afc_trabajador_pct : 0, desc_afc: descAfc,
    base_tributable: baseTrib, impuesto,
    otros_descuentos: otrosDesc, total_descuentos: totalDescuentos,
    liquido: totalHaberes - totalDescuentos,
    aporte_sis: aporteSis, aporte_afc_emp: aporteAfcEmp, aporte_mutual: aporteMutual,
    costo_empresa: totalHaberes + aporteSis + aporteAfcEmp + aporteMutual,
    tipo_contrato: inp.tipo_contrato || null,
  };
}

/* ── Comisiones del mes por colaborador (motor único de comisiones) ─────────── */
async function comisionesDelMes(mes) {
  try {
    const { calcularMes } = require('../../../comisiones/src/controllers/comisiones.controller');
    const filas = await calcularMes(mes);
    const porNombre = {};
    for (const f of filas) porNombre[String(f.ejecutivo || '').toUpperCase().trim()] = R(f.con_semana_corrida || f.incentivo_final);
    return porNombre;
  } catch (e) { console.error('[remuneraciones comisiones]', e.message); return {}; }
}

/* ── GET /api/rrhh/remuneraciones?mes=YYYY-MM ───────────────────────────────── */
const getMes = async (req, res) => {
  try {
    const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : new Date().toISOString().slice(0, 7);
    const ind = await indicadores(mes);
    const [emps] = await pool.query(
      `SELECT u.id_usuario, TRIM(CONCAT_WS(' ', u.nombre, u.apellido, u.apellido_materno)) AS nombre,
              CONCAT(UPPER(COALESCE(u.nombre,'')), ' ', UPPER(COALESCE(u.apellido,''))) AS nombre_corto,
              u.rut, u.cargo, f.sueldo_base, f.afp, f.salud, f.tipo_contrato, f.colacion, f.movilizacion, f.plan_isapre_uf
         FROM usuarios u JOIN rh_fichas f ON f.id_usuario = u.id_usuario
        WHERE u.estado='activo' AND COALESCE(f.sueldo_base,0) > 0
        ORDER BY nombre`);
    const [guardadas] = await pool.query('SELECT * FROM rh_liquidaciones WHERE mes = ?', [mes]);
    const gMap = {}; guardadas.forEach(g => gMap[g.id_usuario] = g);
    const comis = await comisionesDelMes(mes);

    const filas = emps.map(e => {
      const g = gMap[e.id_usuario];
      if (g && g.estado === 'EMITIDA') {
        // Emitida = congelada: se devuelve el snapshot tal cual
        let det = {}; try { det = typeof g.detalle === 'string' ? JSON.parse(g.detalle) : (g.detalle || {}); } catch (_) {}
        return { id_usuario: e.id_usuario, nombre: e.nombre, rut: e.rut, cargo: e.cargo, estado: 'EMITIDA', id_liq: g.id, ...det };
      }
      let over = {};
      if (g) { try { over = typeof g.detalle === 'string' ? JSON.parse(g.detalle) : (g.detalle || {}); } catch (_) {} }
      const inp = {
        sueldo_base: e.sueldo_base, afp: e.afp, salud: e.salud, tipo_contrato: e.tipo_contrato,
        plan_isapre_uf: e.plan_isapre_uf, dias: over.dias ?? 30,
        colacion: over.colacion ?? e.colacion, movilizacion: over.movilizacion ?? e.movilizacion,
        comisiones: over.comisiones ?? (comis[String(e.nombre_corto).trim()] || 0),
        otros_imponibles: over.otros_imponibles ?? 0,
        otros_no_imponibles: over.otros_no_imponibles ?? 0,
        otros_descuentos: over.otros_descuentos ?? 0,
      };
      return { id_usuario: e.id_usuario, nombre: e.nombre, rut: e.rut, cargo: e.cargo,
        estado: g ? 'BORRADOR' : 'SIN GUARDAR', id_liq: g?.id || null, ...calcLiquidacion(inp, ind) };
    });
    const emitidas = filas.filter(f => f.estado === 'EMITIDA').length;
    ok(res, { mes, filas, indicadores: { uf: ind.uf, utm: ind.utm, imm: ind.rem_imm, tope_uf: ind.rem_tope_imponible_uf, salud_pct: ind.rem_salud_pct, afc_pct: ind.rem_afc_trabajador_pct, grat_tope_imm: ind.rem_grat_tope_imm, afps: ind.afps, tramos: ind.tramos },
      mes_emitido: emitidas > 0 && emitidas === filas.length });
  } catch (e) { console.error('[rrhh remuneraciones getMes]', e.message); fail(res, 'Error interno del servidor'); }
};

/* ── POST /api/rrhh/remuneraciones/guardar { mes, filas:[{id_usuario, comisiones?, otros_imponibles?, ...}] } ── */
const guardar = async (req, res) => {
  try {
    const { mes, filas } = req.body || {};
    if (!/^\d{4}-\d{2}$/.test(mes || '') || !Array.isArray(filas)) return fail(res, 'mes y filas requeridos', 400);
    const ind = await indicadores(mes);
    let n = 0;
    for (const f of filas) {
      const [[emp]] = await pool.query(
        `SELECT u.id_usuario, TRIM(CONCAT_WS(' ', u.nombre, u.apellido, u.apellido_materno)) AS nombre, u.rut, u.cargo,
                fi.sueldo_base, fi.afp, fi.salud, fi.tipo_contrato, fi.colacion, fi.movilizacion, fi.plan_isapre_uf
           FROM usuarios u JOIN rh_fichas fi ON fi.id_usuario = u.id_usuario WHERE u.id_usuario = ?`, [f.id_usuario]);
      if (!emp) continue;
      const [[ya]] = await pool.query('SELECT id, estado FROM rh_liquidaciones WHERE id_usuario=? AND mes=?', [f.id_usuario, mes]);
      if (ya && ya.estado === 'EMITIDA') continue;   // congelada
      const inp = {
        sueldo_base: emp.sueldo_base, afp: emp.afp, salud: emp.salud, tipo_contrato: emp.tipo_contrato,
        plan_isapre_uf: emp.plan_isapre_uf, dias: f.dias ?? 30,
        colacion: f.colacion ?? emp.colacion, movilizacion: f.movilizacion ?? emp.movilizacion,
        comisiones: f.comisiones ?? 0, otros_imponibles: f.otros_imponibles ?? 0,
        otros_no_imponibles: f.otros_no_imponibles ?? 0, otros_descuentos: f.otros_descuentos ?? 0,
      };
      const calc = calcLiquidacion(inp, ind);
      await pool.query(
        `INSERT INTO rh_liquidaciones (id_usuario, mes, nombre, rut, cargo, detalle, total_imponible, total_haberes, total_descuentos, liquido, estado)
         VALUES (?,?,?,?,?,?,?,?,?,?,'BORRADOR')
         ON DUPLICATE KEY UPDATE nombre=VALUES(nombre), rut=VALUES(rut), cargo=VALUES(cargo), detalle=VALUES(detalle),
           total_imponible=VALUES(total_imponible), total_haberes=VALUES(total_haberes),
           total_descuentos=VALUES(total_descuentos), liquido=VALUES(liquido)`,
        [f.id_usuario, mes, emp.nombre, emp.rut, emp.cargo, JSON.stringify(calc),
         calc.total_imponible, calc.total_haberes, calc.total_descuentos, calc.liquido]);
      n++;
    }
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'liquidaciones', detalle: `Guardó borrador de remuneraciones ${mes} (${n} liquidaciones)` });
    ok(res, { guardadas: n });
  } catch (e) { console.error('[rrhh remuneraciones guardar]', e.message); fail(res, 'Error interno del servidor'); }
};

/* ── POST /api/rrhh/remuneraciones/emitir { mes } — congela el mes ──────────── */
const emitir = async (req, res) => {
  try {
    const { mes } = req.body || {};
    if (!/^\d{4}-\d{2}$/.test(mes || '')) return fail(res, 'mes requerido', 400);
    const [[nb]] = await pool.query("SELECT COUNT(*) c FROM rh_liquidaciones WHERE mes=? AND estado='BORRADOR'", [mes]);
    if (!nb.c) return fail(res, 'No hay borradores guardados para emitir en ' + mes, 400);
    const u = req.usuario || {};
    const [r] = await pool.query(
      "UPDATE rh_liquidaciones SET estado='EMITIDA', emitido_por=?, emitido_at=NOW() WHERE mes=? AND estado='BORRADOR'",
      [nombreDe(u), mes]);
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'liquidaciones', detalle: `EMITIÓ las liquidaciones de ${mes} (${r.affectedRows}) — quedan congeladas` });
    // Centralización: asiento del libro de remuneraciones (haberes = líquidos + descuentos)
    const [[t]] = await pool.query(
      "SELECT COALESCE(SUM(total_haberes),0) h, COALESCE(SUM(liquido),0) l, COALESCE(SUM(total_descuentos),0) d FROM rh_liquidaciones WHERE mes=? AND estado='EMITIDA'", [mes]);
    require('../../../contabilidad/src/motor-asientos').contabilizar({
      evento: 'REMUNERACIONES', glosa: `Libro de remuneraciones ${mes}`, ref: `REM-${mes}`,
      montos: { haberes: Number(t.h), liquido: Number(t.l), descuentos: Number(t.d) },
    }).catch(() => {});
    ok(res, { emitidas: r.affectedRows });
  } catch (e) { console.error('[rrhh remuneraciones emitir]', e.message); fail(res, 'Error interno del servidor'); }
};

/* ── GET /api/rrhh/remuneraciones/liquidacion/:id — detalle imprimible (dueño o RRHH) ── */
const getLiquidacion = async (req, res) => {
  try {
    const u = req.usuario || {};
    const [[l]] = await pool.query('SELECT * FROM rh_liquidaciones WHERE id=?', [req.params.id]);
    if (!l) return fail(res, 'Liquidación no encontrada', 404);
    const rrhh = await tieneFunc(u.id_usuario, 'rh_remuneraciones').catch(() => false) || await tieneFunc(u.id_usuario, 'rh_aprobar').catch(() => false);
    if (String(l.id_usuario) !== String(u.id_usuario) && !rrhh) return fail(res, 'Sin permiso', 403);
    let det = {}; try { det = typeof l.detalle === 'string' ? JSON.parse(l.detalle) : (l.detalle || {}); } catch (_) {}
    ok(res, { ...l, detalle: det });
  } catch (e) { fail(res, 'Error interno del servidor'); }
};

/* ── GET /api/rrhh/remuneraciones/mias — liquidaciones emitidas del colaborador ── */
const misLiquidaciones = async (req, res) => {
  try {
    const u = req.usuario || {};
    const [rows] = await pool.query(
      "SELECT id, mes, liquido, total_haberes, total_descuentos, emitido_at FROM rh_liquidaciones WHERE id_usuario=? AND estado='EMITIDA' ORDER BY mes DESC LIMIT 36", [u.id_usuario]);
    ok(res, rows);
  } catch (e) { fail(res, 'Error interno del servidor'); }
};

/* ════════════ REVISOR AUTOMÁTICO DE INDICADORES (Previred + IA) ══════════════
   Previred/SII/SP no tienen API oficial → un job mensual (días 1-3) baja la
   página de Indicadores Previsionales de Previred, la IA extrae IMM, topes y
   tasas AFP, se comparan con el mantenedor y si hay diferencias se crea una
   PROPUESTA + correo a RRHH. NUNCA aplica solo: el humano confirma en el
   mantenedor (Aplicar/Descartar). Ver Definiciones: "Indicadores de
   Remuneraciones — actualización automática". */
require('../../../../shared/migrate').enFila('rrhh-indicadores-sync', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rh_indicadores_propuestas (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        mes        CHAR(7) NOT NULL,
        fuente     VARCHAR(200) NULL,
        datos      JSON NULL,
        diffs      JSON NULL,
        estado     VARCHAR(12) NOT NULL DEFAULT 'PENDIENTE',
        resuelto_por VARCHAR(160) NULL,
        resuelto_at  DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_mes (mes, estado)
      )`);
    const ia = require('../../../../shared/ia');
    await ia.registrarFuncionalidad({
      codigo: 'ia_indicadores_previred',
      nombre: 'Indicadores Previred (Remuneraciones)',
      descripcion: 'Extrae IMM, topes imponibles y tasas AFP desde la página de Indicadores Previsionales de Previred para proponer la actualización mensual del mantenedor.',
    });
  } catch (e) { console.error('[rrhh-indicadores-sync migration]', e.message); }
});

const PREVIRED_URL = 'https://www.previred.com/indicadores-previsionales/';

async function extraerIndicadoresPrevired() {
  const resp = await fetch(PREVIRED_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (AutoFacil BusinessSuite)' } });
  if (!resp.ok) throw new Error('Previred respondió HTTP ' + resp.status);
  let html = await resp.text();
  // HTML → texto plano acotado (la página trae las tablas del mes)
  const texto = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ')
    .slice(0, 28000);
  const { analizar } = require('../../../../shared/anthropic');
  const out = await analizar({
    codigo: 'ia_indicadores_previred', json: true, max_tokens: 1200,
    system: 'Eres un analista previsional chileno. Extraes indicadores desde texto de la página de Previred. Respondes SOLO JSON válido.',
    prompt: `Del siguiente texto de la página "Indicadores Previsionales" de Previred, extrae EXACTAMENTE este JSON (números sin puntos de miles, decimales con punto; si un valor no aparece usa null):
{"imm": <ingreso mínimo mensual trabajadores 18-65 en pesos>,
 "tope_imponible_uf": <tope imponible AFP/Salud en UF>,
 "tope_afc_uf": <tope imponible seguro cesantía en UF>,
 "afps": {"CAPITAL": <tasa AFP dependiente %>, "CUPRUM": <>, "HABITAT": <>, "MODELO": <>, "PLANVITAL": <>, "PROVIDA": <>, "UNO": <>}}
Las tasas AFP son la cotización obligatoria del trabajador dependiente (10% + comisión, ej: 11.44).
TEXTO: ${texto}`,
  });
  // analizar() devuelve { texto, datos, ... } — con json:true el JSON parseado viene en .datos
  const datos = out && out.datos ? out.datos : null;
  if (!datos || (!datos.imm && !datos.afps)) throw new Error('La IA no pudo extraer indicadores (respuesta: ' + String(out && out.texto || '').slice(0, 120) + ')');
  return datos;
}

function compararIndicadores(datos, ind) {
  const diffs = [];
  const num = v => v == null || v === '' ? null : parseFloat(v);
  const cmp = (campo, etiqueta, actual, propuesto, tol = 0.001) => {
    const p = num(propuesto); if (p == null || p <= 0) return;
    if (Math.abs((num(actual) || 0) - p) > tol) diffs.push({ campo, etiqueta, actual: num(actual), propuesto: p });
  };
  cmp('rem_imm', 'Ingreso Mínimo Mensual', ind.rem_imm, datos.imm, 0.5);
  cmp('rem_tope_imponible_uf', 'Tope imponible AFP/Salud (UF)', ind.rem_tope_imponible_uf, datos.tope_imponible_uf);
  cmp('rem_tope_afc_uf', 'Tope imponible AFC (UF)', ind.rem_tope_afc_uf, datos.tope_afc_uf);
  for (const a of ind.afps || []) {
    const p = datos.afps ? datos.afps[a.afp] : null;
    cmp('afp:' + a.afp, 'Tasa AFP ' + a.afp + ' (%)', a.tasa_pct, p, 0.005);
  }
  return diffs;
}

async function revisarIndicadores(usuario) {
  const mes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date()).slice(0, 7);
  const datos = await extraerIndicadoresPrevired();
  const ind = await indicadores(mes);
  const diffs = compararIndicadores(datos, ind);
  // Cerrar propuestas pendientes anteriores del mismo mes (la nueva manda)
  await pool.query("UPDATE rh_indicadores_propuestas SET estado='DESCARTADA', resuelto_por='sistema (nueva revisión)', resuelto_at=NOW() WHERE mes=? AND estado='PENDIENTE'", [mes]);
  const [r] = await pool.query(
    'INSERT INTO rh_indicadores_propuestas (mes, fuente, datos, diffs) VALUES (?,?,?,?)',
    [mes, PREVIRED_URL, JSON.stringify(datos), JSON.stringify(diffs)]);
  if (diffs.length) {
    try {
      const { enviarCorreo, envolverHTML } = require('../../../../shared/mailer');
      const [dest] = await pool.query(
        `SELECT DISTINCT u.email FROM usuarios u
           LEFT JOIN perfiles p ON p.id_perfil=u.id_perfil
           LEFT JOIN permisos_perfil pp ON pp.id_perfil=u.id_perfil
           LEFT JOIN funcionalidades f ON f.id_funcionalidad=pp.id_funcionalidad
          WHERE u.estado='activo' AND u.email IS NOT NULL AND (p.nombre='Administrador' OR (f.codigo='rh_remuneraciones' AND pp.habilitado=1))`);
      const filas = diffs.map(d => `<tr><td style="padding:4px 10px;border:1px solid #e2e8f0">${d.etiqueta}</td><td style="padding:4px 10px;border:1px solid #e2e8f0;text-align:right">${(d.actual ?? '—').toLocaleString ? Number(d.actual).toLocaleString('es-CL') : d.actual}</td><td style="padding:4px 10px;border:1px solid #e2e8f0;text-align:right;font-weight:700;color:#b45309">${Number(d.propuesto).toLocaleString('es-CL')}</td></tr>`).join('');
      const html = `<p>La revisión mensual de <b>Previred</b> detectó ${diffs.length} indicador(es) de remuneraciones distintos a los del mantenedor:</p>
        <table style="border-collapse:collapse;font-size:13px"><tr><th style="padding:4px 10px;border:1px solid #e2e8f0;background:#f8fafc">Indicador</th><th style="padding:4px 10px;border:1px solid #e2e8f0;background:#f8fafc">Actual</th><th style="padding:4px 10px;border:1px solid #e2e8f0;background:#f8fafc">Previred</th></tr>${filas}</table>
        <p>Revísalos y aplícalos con un clic en el mantenedor:<br><a href="https://app.autofacilchile.cl/mantenedores/remuneraciones/">Mantenedores → Indicadores de Remuneraciones</a></p>
        <p style="color:#94a3b8;font-size:12px">Los valores fueron extraídos por IA desde ${PREVIRED_URL} — nada se aplica sin tu confirmación.</p>`;
      if (dest.length) await enviarCorreo({ to: dest.map(d => d.email), subject: `📊 Indicadores Previred ${mes}: ${diffs.length} cambio(s) por revisar`, html: envolverHTML ? envolverHTML(html) : html });
    } catch (e) { console.error('[indicadores-sync correo]', e.message); }
  }
  auditar({ req: { usuario: usuario || { id_usuario: null } }, accion: 'CREAR', modulo: 'rrhh', entidad: 'indicadores_propuesta', entidad_id: r.insertId,
    detalle: `Revisión Previred ${mes}: ${diffs.length} diferencia(s) detectada(s)` });
  return { id: r.insertId, mes, diffs, datos };
}

// Cron liviano: cada hora; corre los días 1-3 (09-18h Chile) si el mes no tiene revisión aún.
setInterval(async () => {
  try {
    const ahora = new Date().toLocaleString('en-CA', { timeZone: 'America/Santiago', hour12: false });
    const dia = parseInt(ahora.slice(8, 10), 10), hora = parseInt(ahora.slice(11, 13), 10);
    if (dia < 1 || dia > 3 || hora < 9 || hora > 18) return;
    const mes = ahora.slice(0, 7);
    const [[ya]] = await pool.query('SELECT id FROM rh_indicadores_propuestas WHERE mes=? LIMIT 1', [mes]);
    if (ya) return;
    console.log('[indicadores-sync] revisión mensual automática', mes);
    await revisarIndicadores(null);
  } catch (e) { console.error('[indicadores-sync cron]', e.message); }
}, 60 * 60 * 1000);

/* POST /api/rrhh/remuneraciones/indicadores/revisar — gatillo manual.
   502 (no 500): el error describe un servicio EXTERNO (Previred / IA) y el
   gateway deja pasar los 502 al usuario — un 500 se sanitiza a mensaje genérico. */
const revisarAhora = async (req, res) => {
  try { ok(res, await revisarIndicadores(req.usuario)); }
  catch (e) { console.error('[rrhh revisarAhora]', e.message); fail(res, 'No se pudo revisar Previred: ' + e.message, 502); }
};

/* GET /api/rrhh/remuneraciones/indicadores/propuesta — última pendiente */
const getPropuesta = async (req, res) => {
  try {
    const [[p]] = await pool.query("SELECT * FROM rh_indicadores_propuestas WHERE estado='PENDIENTE' ORDER BY id DESC LIMIT 1");
    if (!p) return ok(res, null);
    const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
    ok(res, { ...p, datos: parse(p.datos), diffs: parse(p.diffs) });
  } catch (e) { fail(res, 'Error interno del servidor'); }
};

/* POST /api/rrhh/remuneraciones/indicadores/propuesta/:id/resolver { accion: 'APLICAR'|'DESCARTAR' } */
const resolverPropuesta = async (req, res) => {
  try {
    const accion = String((req.body || {}).accion || '').toUpperCase();
    if (!['APLICAR', 'DESCARTAR'].includes(accion)) return fail(res, 'Acción inválida', 400);
    const [[p]] = await pool.query("SELECT * FROM rh_indicadores_propuestas WHERE id=? AND estado='PENDIENTE'", [req.params.id]);
    if (!p) return fail(res, 'Propuesta no encontrada o ya resuelta', 404);
    let aplicados = 0;
    if (accion === 'APLICAR') {
      let diffs = []; try { diffs = typeof p.diffs === 'string' ? JSON.parse(p.diffs) : (p.diffs || []); } catch (_) {}
      for (const d of diffs) {
        if (d.campo.startsWith('afp:')) {
          await pool.query('UPDATE rh_afp_tasas SET tasa_pct=? WHERE afp=?', [d.propuesto, d.campo.slice(4)]);
        } else {
          await pool.query('INSERT INTO rh_config (clave, valor) VALUES (?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)', [d.campo, String(d.propuesto)]);
        }
        aplicados++;
      }
    }
    await pool.query('UPDATE rh_indicadores_propuestas SET estado=?, resuelto_por=?, resuelto_at=NOW() WHERE id=?',
      [accion === 'APLICAR' ? 'APLICADA' : 'DESCARTADA', nombreDe(req.usuario), p.id]);
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'indicadores_propuesta', entidad_id: p.id,
      detalle: `Propuesta Previred ${p.mes} → ${accion}${aplicados ? ` (${aplicados} indicadores actualizados)` : ''}` });
    ok(res, { estado: accion === 'APLICAR' ? 'APLICADA' : 'DESCARTADA', aplicados });
  } catch (e) { console.error('[rrhh resolverPropuesta]', e.message); fail(res, 'Error interno del servidor'); }
};

/* ── Mantenedor Indicadores de Remuneraciones ───────────────────────────────── */
const getIndicadores = async (req, res) => {
  try {
    const mes = new Date().toISOString().slice(0, 7);
    ok(res, await indicadores(mes));
  } catch (e) { fail(res, 'Error interno del servidor'); }
};
const putIndicadores = async (req, res) => {
  try {
    const b = req.body || {};
    // Config rem_* permitidas
    const PERM = ['rem_tope_imponible_uf', 'rem_tope_afc_uf', 'rem_afc_trabajador_pct', 'rem_salud_pct', 'rem_imm', 'rem_grat_tope_imm',
                  'rem_sis_pct', 'rem_afc_emp_pct', 'rem_afc_emp_pfijo_pct', 'rem_mutual_pct'];
    for (const k of PERM) if (k in b && b[k] !== '' && !isNaN(parseFloat(b[k]))) {
      await pool.query('INSERT INTO rh_config (clave, valor) VALUES (?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)', [k, String(parseFloat(b[k]))]);
    }
    // Tasas AFP: upsert por administradora
    if (Array.isArray(b.afps)) for (const a of b.afps) {
      const nombre = String(a.afp || '').toUpperCase().trim(); const tasa = parseFloat(a.tasa_pct);
      if (!nombre || isNaN(tasa) || tasa <= 0 || tasa > 20) continue;
      await pool.query('INSERT INTO rh_afp_tasas (afp, tasa_pct) VALUES (?,?) ON DUPLICATE KEY UPDATE tasa_pct=VALUES(tasa_pct)', [nombre, tasa]);
    }
    // Tramos de impuesto: reemplazo completo si vienen (validados)
    if (Array.isArray(b.tramos) && b.tramos.length >= 2) {
      const val = b.tramos.map(t => [parseFloat(t.desde_utm), t.hasta_utm == null || t.hasta_utm === '' ? null : parseFloat(t.hasta_utm), parseFloat(t.factor), parseFloat(t.rebaja_utm)]);
      if (val.every(t => !isNaN(t[0]) && !isNaN(t[2]) && !isNaN(t[3]))) {
        await pool.query('DELETE FROM rh_impuesto_tramos');
        for (const t of val) await pool.query('INSERT INTO rh_impuesto_tramos (desde_utm, hasta_utm, factor, rebaja_utm) VALUES (?,?,?,?)', t);
      }
    }
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'indicadores_remuneraciones', detalle: 'Actualizó indicadores de remuneraciones: ' + Object.keys(b).join(', ') });
    ok(res, { ok: true });
  } catch (e) { console.error('[rrhh putIndicadores]', e.message); fail(res, 'Error interno del servidor'); }
};

module.exports = { getMes, guardar, emitir, getLiquidacion, misLiquidaciones, calcLiquidacion, getIndicadores, putIndicadores,
  revisarAhora, getPropuesta, resolverPropuesta };
