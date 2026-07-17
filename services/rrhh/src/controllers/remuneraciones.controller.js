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

/* v3: ADICIONALES DE REMUNERACIÓN — pagos extra del mes por colaborador con
   causal paramétrica (la causal define si es imponible); "líquido" = se paga
   tal cual, sin descuentos (entra como haber no imponible). Se integran solos
   al libro del mes y se bloquean cuando el mes ya fue EMITIDO. */
require('../../../../shared/migrate').enFila('rrhh-adicionales', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rh_adicionales (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        mes          CHAR(7) NOT NULL,
        id_usuario   INT NOT NULL,
        nombre       VARCHAR(200) NULL,
        causal       VARCHAR(60) NOT NULL,
        causal_texto VARCHAR(200) NULL,          -- solo cuando causal=OTRO
        imponible    TINYINT(1) NOT NULL DEFAULT 1,
        es_liquido   TINYINT(1) NOT NULL DEFAULT 0,
        monto        DECIMAL(12,0) NOT NULL,
        creado_por   VARCHAR(160) NULL,
        created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_mes (mes), INDEX idx_usuario (id_usuario, mes)
      )`);
    console.log('[rrhh-adicionales] listo');
  } catch (e) { console.error('[rrhh-adicionales migration]', e.message); }
});

// Causal → imponible (paramétrico simple; OTRO lo decide el usuario)
const CAUSALES_ADIC = {
  'BONO DE DESEMPEÑO': 1, 'AGUINALDO': 1, 'HORAS EXTRAS': 1, 'COMISIÓN EXTRAORDINARIA': 1,
  'BONO POR META': 1, 'DIFERENCIA DE SUELDO': 1,
  'VIÁTICO': 0, 'COLACIÓN ADICIONAL': 0, 'MOVILIZACIÓN ADICIONAL': 0,
  'ASIGNACIÓN DE CELULAR': 0, 'DEVOLUCIÓN DE DESCUENTO': 0, 'OTRO': null,
};

const mesEmitido = async (mes) => {
  const [[e]] = await pool.query("SELECT COUNT(*) c FROM rh_liquidaciones WHERE mes=? AND estado='EMITIDA'", [mes]);
  return (e?.c || 0) > 0;
};

const getAdicionales = async (req, res) => {
  try {
    const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : new Date().toISOString().slice(0, 7);
    const [rows] = await pool.query(
      `SELECT a.*, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) nombre_actual FROM rh_adicionales a
        LEFT JOIN usuarios u ON u.id_usuario=a.id_usuario WHERE a.mes=? ORDER BY a.created_at DESC`, [mes]);
    const tot = { imponible: 0, no_imponible: 0, liquido: 0 };
    rows.forEach(r => { const m = Number(r.monto);
      if (r.es_liquido) tot.liquido += m; else if (r.imponible) tot.imponible += m; else tot.no_imponible += m; });
    ok(res, { mes, adicionales: rows, totales: tot, bloqueado: await mesEmitido(mes), causales: CAUSALES_ADIC });
  } catch (e) { console.error('[rrhh adicionales get]', e.message); fail(res, 'Error interno del servidor'); }
};

const crearAdicional = async (req, res) => {
  try {
    const u = req.usuario || {}; const b = req.body || {};
    const mes = b.mes;
    if (!/^\d{4}-\d{2}$/.test(mes || '')) return fail(res, 'Mes inválido', 400);
    if (await mesEmitido(mes)) return fail(res, `Las remuneraciones de ${mes} ya fueron EMITIDAS: el mes está bloqueado para nuevos adicionales.`, 423);
    const idU = Number(b.id_usuario);
    const monto = Math.round(Number(b.monto) || 0);
    const causal = String(b.causal || '').toUpperCase().trim();
    if (!idU || monto <= 0) return fail(res, 'Colaborador y monto son obligatorios', 400);
    if (!(causal in CAUSALES_ADIC)) return fail(res, 'Causal no válida', 400);
    if (causal === 'OTRO' && !String(b.causal_texto || '').trim()) return fail(res, 'Describe la causal en "Otro"', 400);
    const esLiquido = b.es_liquido ? 1 : 0;
    const imponible = esLiquido ? 0 : (CAUSALES_ADIC[causal] != null ? CAUSALES_ADIC[causal] : (b.imponible ? 1 : 0));
    const [[colab]] = await pool.query("SELECT TRIM(CONCAT_WS(' ', nombre, apellido)) nombre FROM usuarios WHERE id_usuario=?", [idU]);
    if (!colab) return fail(res, 'Colaborador no encontrado', 404);
    const [r] = await pool.query(
      'INSERT INTO rh_adicionales (mes, id_usuario, nombre, causal, causal_texto, imponible, es_liquido, monto, creado_por) VALUES (?,?,?,?,?,?,?,?,?)',
      [mes, idU, colab.nombre, causal, causal === 'OTRO' ? String(b.causal_texto).trim().slice(0, 200) : null, imponible, esLiquido, monto, nombreDe(u)]);
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'adicional', entidad_id: r.insertId,
      detalle: `Adicional ${mes} ${colab.nombre}: ${causal}${causal === 'OTRO' ? ' (' + b.causal_texto + ')' : ''} $${monto.toLocaleString('es-CL')}${esLiquido ? ' LÍQUIDO' : imponible ? ' imponible' : ' no imponible'}` });
    ok(res, { id: r.insertId, imponible, es_liquido: esLiquido });
  } catch (e) { console.error('[rrhh adicionales crear]', e.message); fail(res, 'Error interno del servidor'); }
};

const eliminarAdicional = async (req, res) => {
  try {
    const [[a]] = await pool.query('SELECT * FROM rh_adicionales WHERE id=?', [req.params.id]);
    if (!a) return fail(res, 'No existe', 404);
    if (await mesEmitido(a.mes)) return fail(res, 'El mes ya fue emitido: no se puede eliminar', 423);
    await pool.query('DELETE FROM rh_adicionales WHERE id=?', [req.params.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'rrhh', entidad: 'adicional', entidad_id: Number(req.params.id), detalle: `Eliminó adicional ${a.mes} ${a.nombre} ${a.causal} $${Number(a.monto).toLocaleString('es-CL')}` });
    ok(res, { eliminado: true });
  } catch (e) { fail(res, 'Error interno del servidor'); }
};

// Suma de adicionales del mes por usuario → alimenta el libro de liquidaciones
async function adicionalesDelMes(mes) {
  const [rows] = await pool.query(
    `SELECT id_usuario,
            SUM(CASE WHEN es_liquido=0 AND imponible=1 THEN monto ELSE 0 END) imp,
            SUM(CASE WHEN es_liquido=1 OR imponible=0 THEN monto ELSE 0 END) noimp
       FROM rh_adicionales WHERE mes=? GROUP BY id_usuario`, [mes]);
  const m = {}; rows.forEach(r => m[r.id_usuario] = { imp: Number(r.imp), noimp: Number(r.noimp) });
  return m;
}

/* v4: DESCUENTOS DE REMUNERACIÓN — anticipos en N meses, préstamos al personal
   con interés (cuota francesa capital+interés, tasa tope = TMC vigente),
   pagos en exceso y descuentos permanentes (tribunal/TGR/APV/otro). Las
   cuotas parten en la PRÓXIMA remuneración y se integran solas al libro. */
require('../../../../shared/migrate').enFila('rrhh-descuentos', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rh_descuentos (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        id_usuario    INT NOT NULL,
        nombre        VARCHAR(200) NULL,
        tipo          VARCHAR(20) NOT NULL,        -- ANTICIPO / PRESTAMO / PAGO_EXCESO / PERMANENTE
        subtipo       VARCHAR(30) NULL,            -- PERMANENTE: ORDEN TRIBUNAL / ORDEN TGR / APV / OTRO
        detalle_texto VARCHAR(200) NULL,
        mes_referencia CHAR(7) NULL,               -- PAGO_EXCESO: mes del pago en exceso
        monto_total   DECIMAL(12,0) NOT NULL,      -- capital (PERMANENTE: monto mensual)
        tasa_pct      DECIMAL(6,3) NULL,           -- PRESTAMO: interés mensual %
        cuotas        INT NOT NULL DEFAULT 1,      -- PERMANENTE: 0 = indefinido
        valor_cuota   DECIMAL(12,0) NOT NULL,
        mes_inicio    CHAR(7) NOT NULL,            -- próxima remuneración
        estado        VARCHAR(12) NOT NULL DEFAULT 'VIGENTE',   -- VIGENTE / ANULADO
        creado_por    VARCHAR(160) NULL,
        created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        anulado_por   VARCHAR(160) NULL,
        anulado_at    DATETIME NULL,
        INDEX idx_usuario (id_usuario), INDEX idx_mes (mes_inicio)
      )`);
    console.log('[rrhh-descuentos] listo');
  } catch (e) { console.error('[rrhh-descuentos migration]', e.message); }
});

const mesMas = (mes, n) => { const [y, m] = mes.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const difMeses = (a, b) => { const [ya, ma] = a.split('-').map(Number), [yb, mb] = b.split('-').map(Number); return (yb - ya) * 12 + (mb - ma); };
// Cuota francesa (solo capital + interés)
const cuotaFrancesa = (M, iPct, n) => { const i = iPct / 100; return i > 0 ? Math.round(M * i / (1 - Math.pow(1 + i, -n))) : Math.round(M / n); };
const tmcVigente = async () => {
  const [[t]] = await pool.query('SELECT tasa_mensual_menor FROM tasas ORDER BY fecha_desde DESC LIMIT 1').catch(() => [[null]]);
  return t ? parseFloat(t.tasa_mensual_menor) : null;
};

// Cuota del descuento VIGENTE d en el mes m (null si ese mes no le toca)
const cuotaEnMes = (d, m) => {
  const k = difMeses(d.mes_inicio, m);
  if (k < 0) return null;
  if (d.tipo === 'PERMANENTE') return Number(d.valor_cuota);   // mensual hasta anular
  if (k >= d.cuotas) return null;                              // plan ya pagado
  return Number(d.valor_cuota);
};

const getDescuentos = async (req, res) => {
  try {
    const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : new Date().toISOString().slice(0, 7);
    const [rows] = await pool.query(
      `SELECT d.*, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) nombre_actual, u.rut,
              EXISTS(SELECT 1 FROM rh_documentos rd WHERE rd.id_usuario=d.id_usuario
                     AND rd.tipo='CONVENIO DESCUENTO' AND rd.nombre_archivo LIKE CONCAT('DESC-', d.id, '-%')) tiene_convenio
         FROM rh_descuentos d
        LEFT JOIN usuarios u ON u.id_usuario=d.id_usuario ORDER BY d.created_at DESC LIMIT 500`);
    const delMes = rows.filter(d => d.estado === 'VIGENTE' && cuotaEnMes(d, mes) != null)
      .map(d => ({ ...d, cuota_mes: cuotaEnMes(d, mes), cuota_num: d.tipo === 'PERMANENTE' ? null : difMeses(d.mes_inicio, mes) + 1 }));
    const total_mes = delMes.reduce((s, d) => s + d.cuota_mes, 0);
    ok(res, { mes, descuentos: rows, del_mes: delMes, total_mes, bloqueado: await mesEmitido(mes), tmc: await tmcVigente() });
  } catch (e) { console.error('[rrhh descuentos get]', e.message); fail(res, 'Error interno del servidor'); }
};

const crearDescuento = async (req, res) => {
  try {
    const u = req.usuario || {}; const b = req.body || {};
    const idU = Number(b.id_usuario);
    const tipo = String(b.tipo || '').toUpperCase();
    const monto = Math.round(Number(b.monto) || 0);
    if (!idU || monto <= 0) return fail(res, 'Colaborador y monto son obligatorios', 400);
    if (!['ANTICIPO', 'PRESTAMO', 'PAGO_EXCESO', 'PERMANENTE'].includes(tipo)) return fail(res, 'Tipo inválido', 400);
    const [[colab]] = await pool.query("SELECT TRIM(CONCAT_WS(' ', nombre, apellido)) nombre FROM usuarios WHERE id_usuario=?", [idU]);
    if (!colab) return fail(res, 'Colaborador no encontrado', 404);
    // Siempre parte en la PRÓXIMA remuneración (mes siguiente al actual)
    const mesInicio = mesMas(new Date().toISOString().slice(0, 7), 1);
    let cuotas = 1, valorCuota = monto, tasa = null, subtipo = null, detalle = null, mesRef = null;
    if (tipo === 'ANTICIPO') {
      cuotas = Math.max(1, Math.min(24, Number(b.cuotas) || 1));
      valorCuota = Math.round(monto / cuotas);
    } else if (tipo === 'PRESTAMO') {
      cuotas = Math.max(1, Math.min(48, Number(b.cuotas) || 1));
      tasa = Number(b.tasa_pct);
      if (!(tasa >= 0)) return fail(res, 'Indica la tasa de interés mensual', 400);
      const tmc = await tmcVigente();
      if (tmc != null && tasa > tmc) return fail(res, `La tasa (${tasa}% mensual) supera la TMC vigente (${tmc}% mensual). Máximo legal: ${tmc}%.`, 400);
      valorCuota = cuotaFrancesa(monto, tasa, cuotas);
    } else if (tipo === 'PAGO_EXCESO') {
      if (!/^\d{4}-\d{2}$/.test(b.mes_referencia || '')) return fail(res, 'Indica el mes del pago en exceso', 400);
      mesRef = b.mes_referencia;
      cuotas = Math.max(1, Math.min(12, Number(b.cuotas) || 1));
      valorCuota = Math.round(monto / cuotas);
    } else { // PERMANENTE
      subtipo = String(b.subtipo || '').toUpperCase();
      if (!['ORDEN TRIBUNAL', 'ORDEN TGR', 'APV', 'OTRO'].includes(subtipo)) return fail(res, 'Subtipo inválido', 400);
      if (subtipo === 'OTRO' && !String(b.detalle_texto || '').trim()) return fail(res, 'Describe el descuento permanente', 400);
      detalle = String(b.detalle_texto || '').trim().slice(0, 200) || null;
      cuotas = 0; valorCuota = monto; // mensual indefinido hasta anular
    }
    const [r] = await pool.query(
      `INSERT INTO rh_descuentos (id_usuario, nombre, tipo, subtipo, detalle_texto, mes_referencia, monto_total, tasa_pct, cuotas, valor_cuota, mes_inicio, creado_por)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [idU, colab.nombre, tipo, subtipo, detalle, mesRef, monto, tasa, cuotas, valorCuota, mesInicio, nombreDe(u)]);
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'descuento', entidad_id: r.insertId,
      detalle: `${tipo}${subtipo ? '/' + subtipo : ''} ${colab.nombre}: $${monto.toLocaleString('es-CL')}${tasa != null ? ` al ${tasa}% mensual` : ''} en ${cuotas || '∞'} cuota(s) de $${valorCuota.toLocaleString('es-CL')} desde ${mesInicio}` });
    ok(res, { id: r.insertId, valor_cuota: valorCuota, cuotas, mes_inicio: mesInicio });
  } catch (e) { console.error('[rrhh descuentos crear]', e.message); fail(res, 'Error interno del servidor'); }
};

const anularDescuento = async (req, res) => {
  try {
    const u = req.usuario || {};
    const [[d]] = await pool.query("SELECT * FROM rh_descuentos WHERE id=? AND estado='VIGENTE'", [req.params.id]);
    if (!d) return fail(res, 'No existe o ya está anulado', 404);
    await pool.query("UPDATE rh_descuentos SET estado='ANULADO', anulado_por=?, anulado_at=NOW() WHERE id=?", [nombreDe(u), d.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'rrhh', entidad: 'descuento', entidad_id: d.id, detalle: `Anuló ${d.tipo} de ${d.nombre} ($${Number(d.valor_cuota).toLocaleString('es-CL')}/mes) — deja de descontarse desde ahora` });
    ok(res, { anulado: true });
  } catch (e) { fail(res, 'Error interno del servidor'); }
};

// Suma de cuotas de descuento del mes por usuario → alimenta el libro
async function descuentosDelMes(mes) {
  const [rows] = await pool.query("SELECT * FROM rh_descuentos WHERE estado='VIGENTE'");
  const m = {};
  for (const d of rows) {
    const c = cuotaEnMes(d, mes);
    if (c != null) m[d.id_usuario] = (m[d.id_usuario] || 0) + c;
  }
  return m;
}

/* ── Indicadores del período ────────────────────────────────────────────────── */
async function indicadores(mes) {
  const [cfgRows] = await pool.query("SELECT clave, valor FROM rh_config WHERE clave LIKE 'rem_%'");
  const cfg = {}; cfgRows.forEach(r => cfg[r.clave] = parseFloat(r.valor) || 0);
  const finMes = mes + '-28';
  const uf = (await getUF(finMes)) || (await getUF(new Date().toISOString().slice(0, 10))) || 0;
  const [[utmRow]] = await pool.query('SELECT valor FROM utm WHERE fecha <= ? ORDER BY fecha DESC LIMIT 1', [finMes + ' 23:59:59']);
  const utm = parseFloat(utmRow?.valor) || 0;
  const [afps] = await pool.query('SELECT afp, tasa_pct, codigo_previred FROM rh_afp_tasas ORDER BY afp');
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

/* ── Días trabajados del mes (convención 30avos): 30 − ingreso parcial − licencias ── */
const isoF = f => f == null ? null
  : (f instanceof Date ? new Date(f.getTime() - f.getTimezoneOffset() * 60000).toISOString() : String(f)).slice(0, 10);

function diasTrabajadosMes(mes, fechaIngreso, licencias) {
  let dias = 30;
  const ini = mes + '-01', finStr = mes + '-31';
  const fi = isoF(fechaIngreso);
  if (fi) {
    if (fi > finStr) return 0;                                   // ingresó después del mes
    if (fi >= ini) dias = 30 - (Number(fi.slice(8, 10)) - 1);    // ingresó dentro del mes
  }
  let lic = 0;
  for (const l of licencias || []) {
    const d = isoF(l.fecha_desde) > ini ? isoF(l.fecha_desde) : ini;
    const h = isoF(l.fecha_hasta) < finStr ? isoF(l.fecha_hasta) : finStr;
    if (h >= d) lic += Math.min(30, Number(h.slice(8, 10))) - Math.min(30, Number(d.slice(8, 10))) + 1;
  }
  return Math.max(0, Math.min(30, dias - lic));
}

async function licenciasDelMes(mes) {
  // Descuentan días trabajados: licencias (paga el subsidio la isapre/Fonasa),
  // permisos SIN goce y ausencias injustificadas. Vacaciones NO descuentan (pagadas).
  const [rows] = await pool.query(
    `SELECT id_usuario, fecha_desde, fecha_hasta FROM rh_ausencias
      WHERE tipo IN ('LICENCIA MEDICA','PERMISO SIN GOCE','AUSENCIA INJUSTIFICADA') AND estado='APROBADA'
        AND fecha_desde <= LAST_DAY(CONCAT(?, '-01')) AND fecha_hasta >= CONCAT(?, '-01')`, [mes, mes]);
  const m = {};
  rows.forEach(r => { (m[r.id_usuario] = m[r.id_usuario] || []).push(r); });
  return m;
}

/* ── Comisiones aprobadas: sin aprobación de Operaciones no se emite el mes ── */
async function comisionesSinAprobar(mes, comis) {
  const conComision = Object.entries(comis).filter(([, monto]) => monto > 0).map(([nom]) => nom);
  if (!conComision.length) return [];
  const [aps] = await pool.query("SELECT ejecutivo FROM comisiones_aprobaciones WHERE mes=? AND estado='aprobado'", [mes]).catch(() => [[]]);
  const okSet = new Set(aps.map(a => String(a.ejecutivo).toUpperCase().trim()));
  return conComision.filter(n => !okSet.has(n));
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
              u.rut, u.cargo, u.fecha_ingreso, f.sueldo_base, f.afp, f.salud, f.tipo_contrato, f.colacion, f.movilizacion, f.plan_isapre_uf
         FROM usuarios u JOIN rh_fichas f ON f.id_usuario = u.id_usuario
        WHERE u.estado='activo' AND COALESCE(f.sueldo_base,0) > 0
        ORDER BY nombre`);
    const [guardadas] = await pool.query('SELECT * FROM rh_liquidaciones WHERE mes = ?', [mes]);
    const gMap = {}; guardadas.forEach(g => gMap[g.id_usuario] = g);
    const comis = await comisionesDelMes(mes);
    const adics = await adicionalesDelMes(mes);
    const descs = await descuentosDelMes(mes);
    const lics = await licenciasDelMes(mes);

    // Todo viene de su fuente: días (ficha ingreso + licencias), comisiones
    // (motor de comisiones), otros haberes (Adicionales), otros descuentos
    // (Descuentos). En este libro no se digita nada.
    const filas = emps.map(e => {
      const g = gMap[e.id_usuario];
      if (g && g.estado === 'EMITIDA') {
        // Emitida = congelada: se devuelve el snapshot tal cual
        let det = {}; try { det = typeof g.detalle === 'string' ? JSON.parse(g.detalle) : (g.detalle || {}); } catch (_) {}
        return { id_usuario: e.id_usuario, nombre: e.nombre, rut: e.rut, cargo: e.cargo, estado: 'EMITIDA', id_liq: g.id, ...det };
      }
      const inp = {
        sueldo_base: e.sueldo_base, afp: e.afp, salud: e.salud, tipo_contrato: e.tipo_contrato,
        plan_isapre_uf: e.plan_isapre_uf,
        dias: diasTrabajadosMes(mes, e.fecha_ingreso, lics[e.id_usuario]),
        colacion: e.colacion, movilizacion: e.movilizacion,
        comisiones: comis[String(e.nombre_corto).trim()] || 0,
        otros_imponibles: adics[e.id_usuario]?.imp || 0,
        otros_no_imponibles: adics[e.id_usuario]?.noimp || 0,
        otros_descuentos: descs[e.id_usuario] || 0,
      };
      return { id_usuario: e.id_usuario, nombre: e.nombre, rut: e.rut, cargo: e.cargo,
        licencia_dias: 30 - diasTrabajadosMes(mes, null, lics[e.id_usuario]),
        estado: g ? 'BORRADOR' : 'SIN GUARDAR', id_liq: g?.id || null, ...calcLiquidacion(inp, ind) };
    });
    const emitidas = filas.filter(f => f.estado === 'EMITIDA').length;
    const sinAprobar = await comisionesSinAprobar(mes, comis);
    ok(res, { mes, filas, comisiones_sin_aprobar: sinAprobar,
      indicadores: { uf: ind.uf, utm: ind.utm, imm: ind.rem_imm, tope_uf: ind.rem_tope_imponible_uf, salud_pct: ind.rem_salud_pct, afc_pct: ind.rem_afc_trabajador_pct, grat_tope_imm: ind.rem_grat_tope_imm, afps: ind.afps, tramos: ind.tramos },
      mes_emitido: emitidas > 0 && emitidas === filas.length });
  } catch (e) { console.error('[rrhh remuneraciones getMes]', e.message); fail(res, 'Error interno del servidor'); }
};

/* ── POST /api/rrhh/remuneraciones/guardar { mes, filas:[{id_usuario, comisiones?, otros_imponibles?, ...}] } ── */
const guardar = async (req, res) => {
  try {
    const { mes, filas } = req.body || {};
    if (!/^\d{4}-\d{2}$/.test(mes || '') || !Array.isArray(filas)) return fail(res, 'mes y filas requeridos', 400);
    const ind = await indicadores(mes);
    // Se recalcula SIEMPRE desde las fuentes (nada viene digitado del libro)
    const comis = await comisionesDelMes(mes);
    const adics = await adicionalesDelMes(mes);
    const descs = await descuentosDelMes(mes);
    const lics = await licenciasDelMes(mes);
    let n = 0;
    for (const f of filas) {
      const [[emp]] = await pool.query(
        `SELECT u.id_usuario, TRIM(CONCAT_WS(' ', u.nombre, u.apellido, u.apellido_materno)) AS nombre,
                CONCAT(UPPER(COALESCE(u.nombre,'')), ' ', UPPER(COALESCE(u.apellido,''))) AS nombre_corto,
                u.rut, u.cargo, u.fecha_ingreso,
                fi.sueldo_base, fi.afp, fi.salud, fi.tipo_contrato, fi.colacion, fi.movilizacion, fi.plan_isapre_uf
           FROM usuarios u JOIN rh_fichas fi ON fi.id_usuario = u.id_usuario WHERE u.id_usuario = ?`, [f.id_usuario]);
      if (!emp) continue;
      const [[ya]] = await pool.query('SELECT id, estado FROM rh_liquidaciones WHERE id_usuario=? AND mes=?', [f.id_usuario, mes]);
      if (ya && ya.estado === 'EMITIDA') continue;   // congelada
      const inp = {
        sueldo_base: emp.sueldo_base, afp: emp.afp, salud: emp.salud, tipo_contrato: emp.tipo_contrato,
        plan_isapre_uf: emp.plan_isapre_uf,
        dias: diasTrabajadosMes(mes, emp.fecha_ingreso, lics[emp.id_usuario]),
        colacion: emp.colacion, movilizacion: emp.movilizacion,
        comisiones: comis[String(emp.nombre_corto).trim()] || 0,
        otros_imponibles: adics[emp.id_usuario]?.imp || 0,
        otros_no_imponibles: adics[emp.id_usuario]?.noimp || 0,
        otros_descuentos: descs[emp.id_usuario] || 0,
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
    // Gate: sin comisiones APROBADAS (Operaciones) no se emiten las liquidaciones
    const sinAprobar = await comisionesSinAprobar(mes, await comisionesDelMes(mes));
    if (sinAprobar.length)
      return fail(res, `No se puede emitir: hay comisiones SIN APROBAR en Revisión de Comisiones para: ${sinAprobar.join(', ')}. Apruébalas primero en /comisiones/revision/.`, 409);
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
    // Envío automático: cada colaborador recibe su liquidación al correo
    // (no bloquea la respuesta; Modo Desarrollo redirige solo, vía shared/mailer)
    enviarLiquidacionesCorreo(mes).catch(e => console.error('[remuneraciones correo]', e.message));
    ok(res, { emitidas: r.affectedRows });
  } catch (e) { console.error('[rrhh remuneraciones emitir]', e.message); fail(res, 'Error interno del servidor'); }
};

/* ── Correo de liquidación a cada colaborador al emitir el mes ─────────────── */
const MESES_TXT = ['', 'ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];
const mesPalabras = m => `${MESES_TXT[Number(String(m).slice(5, 7))] || ''} ${String(m).slice(0, 4)}`;

async function enviarLiquidacionesCorreo(mes) {
  const { enviarCorreo, envolverHTML } = require('../../../../shared/mailer');
  const [liqs] = await pool.query(
    `SELECT l.*, u.email FROM rh_liquidaciones l JOIN usuarios u ON u.id_usuario=l.id_usuario
      WHERE l.mes=? AND l.estado='EMITIDA' AND u.email IS NOT NULL`, [mes]);
  const co = v => '$' + Math.round(Number(v) || 0).toLocaleString('es-CL');
  let enviadas = 0;
  for (const l of liqs) {
    let d = {}; try { d = typeof l.detalle === 'string' ? JSON.parse(l.detalle) : (l.detalle || {}); } catch (_) {}
    const fila = (lbl, v, neg) => (Number(v) || 0) ? `<tr><td style="padding:3px 10px">${lbl}</td><td style="padding:3px 10px;text-align:right;${neg ? 'color:#b91c1c' : ''}">${neg ? '−' : ''}${co(v)}</td></tr>` : '';
    const html = `
      <p>Hola ${String(l.nombre || '').split(' ')[0]}, tu liquidación de sueldo de <b>${mesPalabras(mes)}</b> fue emitida:</p>
      <table style="border-collapse:collapse;font-size:13px;border:1px solid #e2e8f0;width:100%;max-width:460px">
        <tr><td colspan="2" style="background:#eff6ff;color:#1e3a8a;font-weight:700;padding:5px 10px">HABERES</td></tr>
        ${fila('Sueldo base' + (d.dias != null && d.dias !== 30 ? ` (${d.dias}/30 días)` : ''), d.sueldo_base)}${fila('Comisiones', d.comisiones)}${fila('Otros imponibles', d.otros_imponibles)}${fila('Gratificación legal', d.gratificacion)}${fila('Colación', d.colacion)}${fila('Movilización', d.movilizacion)}${fila('Otros no imponibles', d.otros_no_imponibles)}
        <tr><td style="padding:3px 10px;font-weight:700">Total haberes</td><td style="padding:3px 10px;text-align:right;font-weight:700">${co(d.total_haberes)}</td></tr>
        <tr><td colspan="2" style="background:#eff6ff;color:#1e3a8a;font-weight:700;padding:5px 10px">DESCUENTOS</td></tr>
        ${fila('AFP ' + (d.afp || ''), d.desc_afp, 1)}${fila('Salud 7%', d.desc_salud, 1)}${fila('Adicional Isapre', d.desc_salud_adicional, 1)}${fila('Seguro cesantía', d.desc_afc, 1)}${fila('Impuesto único', d.impuesto, 1)}${fila('Otros descuentos', d.otros_descuentos, 1)}
        <tr><td style="padding:3px 10px;font-weight:700">Total descuentos</td><td style="padding:3px 10px;text-align:right;font-weight:700;color:#b91c1c">−${co(d.total_descuentos)}</td></tr>
        <tr><td style="padding:8px 10px;font-weight:800;font-size:14px">LÍQUIDO A PAGAR</td><td style="padding:8px 10px;text-align:right;font-weight:800;font-size:14px;color:#15803d">${co(d.liquido)}</td></tr>
      </table>
      <p style="font-size:12px;color:#64748b">El detalle completo e imprimible está en el Business Suite → Recursos Humanos → <a href="https://app.autofacilchile.cl/recursos-humanos/mi-ficha/">Mi Ficha</a>.</p>`;
    try {
      await enviarCorreo({ to: l.email, subject: `💰 Liquidación de sueldo ${mesPalabras(mes)} — AutoFácil`, html: envolverHTML ? envolverHTML(html) : html });
      enviadas++;
    } catch (e) { console.error('[remuneraciones correo]', l.email, e.message); }
  }
  console.log(`[remuneraciones] liquidaciones ${mes}: ${enviadas}/${liqs.length} correos enviados`);
  return enviadas;
}

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
      const cod = /^\d{2}$/.test(String(a.codigo_previred || '')) ? String(a.codigo_previred) : null;
      await pool.query('INSERT INTO rh_afp_tasas (afp, tasa_pct, codigo_previred) VALUES (?,?,?) ON DUPLICATE KEY UPDATE tasa_pct=VALUES(tasa_pct), codigo_previred=COALESCE(VALUES(codigo_previred), codigo_previred)', [nombre, tasa, cod]);
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

/* ── AUMENTO DE RENTA: calculadora por persona sobre el MOTOR ÚNICO ────────────
   "Alcance líquido" = liquidación con SOLO los descuentos legales (AFP, salud 7%,
   AFC, impuesto único): se excluyen créditos, anticipos, APV, adicional de isapre
   y cualquier otro descuento personal, para que el resultado sea comparable entre
   personas y no dependa de su situación puntual del mes. */
require('../../../../shared/migrate').enFila('rrhh-aumento-renta', async () => {
  try {
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='rh_aumento_renta' LIMIT 1");
    let idf = ex && ex.id_funcionalidad;
    if (!idf) {
      const [r] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (500002, 'Aumento de Renta', 'rh_aumento_renta', '/recursos-humanos/aumento-renta/', 'bi-graph-up-arrow')");
      idf = r.insertId;
    }
    for (const idp of [1, 2, 90009])
      await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
    console.log('[rrhh-aumento-renta] listo');
  } catch (e) { console.error('[rrhh-aumento-renta migration]', e.message); }
});

// Liquidación de ALCANCE LÍQUIDO para un sueldo base dado (sin descuentos personales)
function liqAlcance(sueldoBase, ficha, ind) {
  return calcLiquidacion({
    sueldo_base: sueldoBase, dias: 30,
    comisiones: 0, otros_imponibles: 0, otros_no_imponibles: 0, otros_descuentos: 0,
    colacion: ficha.colacion || 0, movilizacion: ficha.movilizacion || 0,
    afp: ficha.afp || null, salud: ficha.salud || null,
    plan_isapre_uf: 0,                    // adicional isapre EXCLUIDO del alcance
    tipo_contrato: ficha.tipo_contrato || 'INDEFINIDO',
  }, ind);
}

// Búsqueda binaria del sueldo base que logra un objetivo (imponible o líquido) —
// ambas magnitudes son monótonas crecientes en el sueldo base.
function resolverSueldo(objetivo, campo, ficha, ind) {
  let lo = 0, hi = 200000000;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (liqAlcance(mid, ficha, ind)[campo] < objetivo) lo = mid; else hi = mid;
  }
  return Math.round(hi);
}

// GET /remuneraciones/aumento-renta/personas → colaboradores activos con ficha
const aumentoPersonas = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.id_usuario, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) nombre, u.cargo,
             f.sueldo_base, f.afp, f.tipo_contrato
      FROM usuarios u JOIN rh_fichas f ON f.id_usuario = u.id_usuario
      WHERE u.estado='activo' AND f.sueldo_base > 0
      ORDER BY nombre`);
    ok(res, { personas: rows });
  } catch (e) { console.error('[rrhh aumento personas]', e.message); fail(res, 'Error interno del servidor'); }
};

// POST /remuneraciones/aumento-renta { id_usuario, modo, valor }
// modos: A_BRUTO (que quede en $X imponible) · EN_BRUTO (+$X imponible)
//        A_LIQUIDO (que quede en $X líquido) · EN_LIQUIDO (+$X líquido)
const aumentoRenta = async (req, res) => {
  try {
    const idU = Number(req.body.id_usuario);
    const modo = String(req.body.modo || '').toUpperCase();
    const valor = Math.round(Number(req.body.valor) || 0);
    if (!idU) return fail(res, 'Selecciona un colaborador', 400);
    if (!['A_BRUTO', 'EN_BRUTO', 'A_LIQUIDO', 'EN_LIQUIDO'].includes(modo)) return fail(res, 'Modo inválido', 400);
    if (valor <= 0) return fail(res, 'Ingresa un monto mayor a 0', 400);

    const [[p]] = await pool.query(`
      SELECT u.id_usuario, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) nombre,
             TRIM(CONCAT_WS(' ', u.nombre, u.apellido, u.apellido_materno)) nombre_completo,
             u.rut, u.cargo, DATE_FORMAT(u.fecha_ingreso,'%Y-%m-%d') fecha_ingreso,
             f.direccion, f.comuna, f.nacionalidad, f.estado_civil,
             f.sueldo_base, f.colacion, f.movilizacion, f.afp, f.salud, f.plan_isapre_uf, f.tipo_contrato
      FROM usuarios u JOIN rh_fichas f ON f.id_usuario = u.id_usuario
      WHERE u.id_usuario=? LIMIT 1`, [idU]);
    if (!p) return fail(res, 'Colaborador sin ficha RRHH', 404);
    if (!(Number(p.sueldo_base) > 0)) return fail(res, 'El colaborador no tiene sueldo base en su ficha', 400);

    const ind = await indicadores(new Date().toISOString().slice(0, 7));
    const actual = liqAlcance(Number(p.sueldo_base), p, ind);

    let objetivo, campo;
    if (modo === 'A_BRUTO')    { campo = 'total_imponible'; objetivo = valor; }
    if (modo === 'EN_BRUTO')   { campo = 'total_imponible'; objetivo = actual.total_imponible + valor; }
    if (modo === 'A_LIQUIDO')  { campo = 'liquido';         objetivo = valor; }
    if (modo === 'EN_LIQUIDO') { campo = 'liquido';         objetivo = actual.liquido + valor; }

    const advertencias = [];
    if (objetivo <= actual[campo])
      advertencias.push(`El objetivo (${objetivo.toLocaleString('es-CL')}) es menor o igual al valor actual: el resultado es una REBAJA, no un aumento.`);

    const sueldoNuevo = resolverSueldo(objetivo, campo, p, ind);
    const nuevo = liqAlcance(sueldoNuevo, p, ind);
    if (Number(p.plan_isapre_uf) > 0)
      advertencias.push('Tiene plan de isapre pactado en UF: el adicional sobre el 7% legal NO está considerado (alcance líquido). Su líquido real de bolsillo será menor.');
    if (nuevo.base_cotizacion >= Math.round(ind.rem_tope_imponible_uf * ind.uf))
      advertencias.push(`El imponible supera el tope de cotización (${ind.rem_tope_imponible_uf} UF): sobre el tope solo crecen impuesto y líquido, no las cotizaciones.`);

    ok(res, {
      persona: { id_usuario: p.id_usuario, nombre: p.nombre, nombre_completo: p.nombre_completo, rut: p.rut,
                 cargo: p.cargo, afp: p.afp, tipo_contrato: p.tipo_contrato, fecha_ingreso: p.fecha_ingreso,
                 direccion: p.direccion, comuna: p.comuna, nacionalidad: p.nacionalidad, estado_civil: p.estado_civil },
      indicadores: { uf: ind.uf, utm: ind.utm, imm: ind.rem_imm, tope_imponible_uf: ind.rem_tope_imponible_uf },
      modo, valor, actual, nuevo,
      delta: {
        sueldo_base: sueldoNuevo - actual.sueldo_base,
        bruto: nuevo.total_imponible - actual.total_imponible,
        liquido: nuevo.liquido - actual.liquido,
        costo_empresa: nuevo.costo_empresa - actual.costo_empresa,
        pct_sueldo: actual.sueldo_base > 0 ? Math.round((sueldoNuevo / actual.sueldo_base - 1) * 1000) / 10 : null,
      },
      advertencias,
    });
    auditar({ req, accion: 'CONSULTA', modulo: 'rrhh', entidad: 'aumento_renta', entidad_id: idU,
      detalle: `Simuló aumento de renta de ${p.nombre}: ${modo} $${valor.toLocaleString('es-CL')}` });
  } catch (e) { console.error('[rrhh aumento renta]', e.message); fail(res, 'Error interno del servidor'); }
};

/* ── ARCHIVO PREVIRED (formato oficial "Estándar de Largo Variable", v96 jul-2026) ──
   105 campos separados por ';', un registro por trabajador, desde las
   liquidaciones EMITIDAS del mes. Campos no aplicables: 0 (numéricos) /
   blanco (alfanuméricos), como exige la especificación de Previred.
   Códigos: Tabla 10 (AFP), 16 (Salud), 18 (CCAF), 19 (Mutual), 7 (Movimiento). */
const PREV_AFP = { CUPRUM: '03', HABITAT: '05', PROVIDA: '08', PLANVITAL: '29', 'PLAN VITAL': '29', CAPITAL: '33', MODELO: '34', UNO: '35' };
const PREV_SALUD = { FONASA: '07', BANMEDICA: '01', 'BANMÉDICA': '01', CONSALUD: '02', 'VIDA TRES': '03', VIDATRES: '03', COLMENA: '04',
  'CRUZ BLANCA': '05', 'ISAPRE CRUZ BLANCA S.A.': '05', 'NUEVA MASVIDA': '10', 'NUEVA MAS VIDA': '10', ISALUD: '11',
  FUNDACION: '12', 'FUNDACIÓN': '12', 'CRUZ DEL NORTE': '25', ESENCIAL: '28', ESCENCIAL: '28' };

require('../../../../shared/migrate').enFila('previred-config', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_previred_config (
    id TINYINT PRIMARY KEY, ccaf VARCHAR(2) DEFAULT '00', mutual VARCHAR(2) DEFAULT '02', sucursal_mutual VARCHAR(3) DEFAULT ''
  )`);
  await pool.query(`INSERT IGNORE INTO rh_previred_config (id, ccaf, mutual) VALUES (1, '00', '02')`);
  // Código Previred por AFP (Tabla N°10) — editable en el mantenedor Indicadores
  await pool.query(`ALTER TABLE rh_afp_tasas ADD COLUMN IF NOT EXISTS codigo_previred VARCHAR(2) NULL`).catch(() => {});
  for (const [afp, cod] of Object.entries(PREV_AFP))
    await pool.query(`UPDATE rh_afp_tasas SET codigo_previred=? WHERE afp=? AND (codigo_previred IS NULL OR codigo_previred='')`, [cod, afp]);
});

async function getPrevired(req, res) {
  try {
    const mes = req.query.mes;
    if (!/^\d{4}-\d{2}$/.test(mes || '')) return fail(res, 'mes obligatorio (YYYY-MM)', 400);
    const [liqs] = await pool.query(
      `SELECT l.*, u.rut urut, u.nombre unombre, u.apellido, u.apellido_materno, u.sexo, u.fecha_ingreso,
              f.nacionalidad, f.jornada, f.tipo_contrato ftc
         FROM rh_liquidaciones l JOIN usuarios u ON u.id_usuario=l.id_usuario
         LEFT JOIN rh_fichas f ON f.id_usuario=l.id_usuario
        WHERE l.mes=? AND l.estado='EMITIDA' ORDER BY u.apellido, u.nombre`, [mes]);
    if (!liqs.length) return fail(res, `No hay liquidaciones EMITIDAS para ${mes}. Emite el mes primero.`, 404);
    const [[cfg]] = await pool.query('SELECT * FROM rh_previred_config WHERE id=1');
    // Códigos AFP desde el mantenedor (rh_afp_tasas), fallback a la tabla oficial
    const [afpsCod] = await pool.query('SELECT afp, codigo_previred FROM rh_afp_tasas');
    const afpCodDe = n => { const k = String(n || '').toUpperCase().trim();
      return (afpsCod.find(a => a.afp === k) || {}).codigo_previred || PREV_AFP[k]; };
    // Cargas familiares: tramo y cargas de la ficha + hijos marcados como carga (fuente única)
    const [cargasHijos] = await pool.query('SELECT id_usuario, COUNT(*) n FROM rh_hijos WHERE es_carga=1 GROUP BY id_usuario');
    const hijosDe = id => (cargasHijos.find(h => h.id_usuario === id) || {}).n || 0;
    const [fichasCargas] = await pool.query('SELECT id_usuario, tramo_asignacion, cargas_otras, cargas_maternales, cargas_invalidas FROM rh_fichas');
    const cargasDe = id => fichasCargas.find(f => f.id_usuario === id) || {};
    // Licencias del mes (movimiento de personal 3 = Subsidios)
    const [lics] = await pool.query(
      `SELECT id_usuario, fecha_desde, fecha_hasta FROM rh_ausencias
        WHERE tipo='LICENCIA MEDICA' AND estado='APROBADA'
          AND fecha_desde <= LAST_DAY(CONCAT(?, '-01')) AND fecha_hasta >= CONCAT(?, '-01')`, [mes, mes]);
    const licMap = {}; lics.forEach(l => { licMap[l.id_usuario] = licMap[l.id_usuario] || l; });
    // Movimiento de personal 11 = Retiro (desde los finiquitos del mes) y 1 = Contratación
    // (ingresos dentro del mes). Si no se informa el retiro, la AFP presume deuda (DNP).
    const [finiqs] = await pool.query(
      `SELECT id_usuario, DATE_FORMAT(fecha_termino,'%Y-%m-%d') ft FROM rh_finiquitos
        WHERE fecha_termino BETWEEN CONCAT(?, '-01') AND LAST_DAY(CONCAT(?, '-01'))`, [mes, mes]);
    const retMap = {}; finiqs.forEach(f => { retMap[f.id_usuario] = retMap[f.id_usuario] || f.ft; });
    const [ingresos] = await pool.query(
      `SELECT id_usuario, DATE_FORMAT(fecha_ingreso,'%Y-%m-%d') fi FROM usuarios
        WHERE fecha_ingreso BETWEEN CONCAT(?, '-01') AND LAST_DAY(CONCAT(?, '-01'))`, [mes, mes]);
    const ingMap = {}; ingresos.forEach(i => { ingMap[i.id_usuario] = i.fi; });

    const per = mes.slice(5, 7) + mes.slice(0, 4);                       // mmaaaa
    const fch = f => { const s = isoF(f); return s ? s.split('-').reverse().join('-') : ''; };  // dd-mm-aaaa
    const N = v => String(Math.max(0, Math.round(Number(v) || 0)));
    const avisos = [];
    const lineas = [];

    for (const l of liqs) {
      let d = {}; try { d = typeof l.detalle === 'string' ? JSON.parse(l.detalle) : (l.detalle || {}); } catch (_) {}
      const rutFull = String(l.rut || l.urut || '').replace(/\./g, '').toUpperCase();
      const [rutNum, dv] = rutFull.split('-');
      const nombreCompleto = `${l.unombre || ''}`.trim();
      const afpCod = afpCodDe(d.afp);
      const saludCod = PREV_SALUD[String(d.salud || '').toUpperCase().trim()];
      const esFonasa = saludCod === '07';
      const esIsapre = saludCod && !esFonasa;
      if (!rutNum || !dv) { avisos.push(`${l.nombre}: RUT inválido — línea omitida`); continue; }
      if (!afpCod) avisos.push(`${l.nombre}: AFP "${d.afp || '(vacía)'}" sin código Previred (campo 26 quedará 00)`);
      if (!saludCod) avisos.push(`${l.nombre}: salud "${d.salud || '(vacía)'}" sin código (campos de salud en 0)`);
      if (!l.sexo) avisos.push(`${l.nombre}: falta el sexo en la ficha (campo obligatorio)`);

      // Bases: la de cotización (tope 87,8 UF) viene del motor; la de AFC se
      // reconstruye exacta desde el propio descuento (misma matemática del motor)
      const baseCot = Math.round(d.base_cotizacion || d.total_imponible || 0);
      const esIndef = String(d.tipo_contrato || l.ftc || '').toUpperCase() === 'INDEFINIDO';
      let baseAfc = 0;
      if (d.desc_afc > 0 && d.afc_pct > 0) baseAfc = Math.round(d.desc_afc * 100 / d.afc_pct);
      else if (d.aporte_afc_emp > 0) baseAfc = Math.round(d.total_imponible || 0) ? Math.min(Math.round(d.total_imponible), Math.round(d.aporte_afc_emp * 100 / (esIndef ? 2.4 : 3))) : 0;
      if (!baseAfc) baseAfc = Math.round(d.total_imponible || 0);
      // deriva de redondeo al reconstruir desde el descuento → anclar al imponible
      if (Math.abs(baseAfc - Math.round(d.total_imponible || 0)) < 500) baseAfc = Math.round(d.total_imponible || 0);

      const lic = licMap[l.id_usuario];
      const retiro = retMap[l.id_usuario];
      const ingreso = ingMap[l.id_usuario];
      // Prioridad: retiro (2) manda sobre licencia (3) y contratación (1) — Tabla N°7 Previred
      const mov = retiro ? '2' : (lic ? '3' : (ingreso ? '1' : '0'));
      let movDesde = '', movHasta = '';
      if (retiro) { movHasta = fch(retiro); avisos.push(`${l.nombre}: RETIRO informado (movimiento 2, término ${fch(retiro)}) — con esto la AFP no presume deuda por los meses siguientes`); }
      else if (lic) { movDesde = fch(lic.fecha_desde); movHasta = fch(lic.fecha_hasta); avisos.push(`${l.nombre}: licencia médica en el mes — revisa la línea (movimiento 3, campo 92 renta mes anterior va en 0)`); }
      else if (ingreso) { movDesde = fch(ingreso); avisos.push(`${l.nombre}: CONTRATACIÓN informada (movimiento 1, ingreso ${fch(ingreso)})`); }

      const planUF = Number(d.plan_isapre_uf) || 0;
      const pactada = esIsapre ? Math.round((d.desc_salud || 0) + (d.desc_salud_adicional || 0)) : 0;

      const c = [];
      c[1] = rutNum; c[2] = dv;
      c[3] = String(l.apellido || '').toUpperCase(); c[4] = String(l.apellido_materno || '').toUpperCase();
      c[5] = nombreCompleto.toUpperCase();
      c[6] = String(l.sexo || 'M').toUpperCase().startsWith('F') ? 'F' : 'M';
      c[7] = /extranjer/i.test(l.nacionalidad || '') ? '1' : '0';
      c[8] = '01'; c[9] = per; c[10] = per;
      c[11] = 'AFP'; c[12] = '0'; c[13] = String(d.dias ?? 30);
      c[14] = '00'; c[15] = mov;
      c[16] = movDesde; c[17] = movHasta;
      const cg = cargasDe(l.id_usuario);
      const simples = hijosDe(l.id_usuario) + (Number(cg.cargas_otras) || 0);
      c[18] = /^[ABC]$/.test(cg.tramo_asignacion || '') ? cg.tramo_asignacion : 'D';
      c[19] = String(simples); c[20] = String(Number(cg.cargas_maternales) || 0); c[21] = String(Number(cg.cargas_invalidas) || 0);
      c[22] = '0'; c[23] = '0'; c[24] = '0'; c[25] = 'N';
      if (c[18] !== 'D' && (simples + Number(cg.cargas_maternales || 0) + Number(cg.cargas_invalidas || 0)) > 0)
        avisos.push(`${l.nombre}: tiene cargas con tramo ${c[18]} — el monto de asignación familiar (campo 22) va en 0 porque el motor aún no la paga en la liquidación; complétalo en Previred si corresponde`);
      c[26] = afpCod || '00'; c[27] = N(baseCot); c[28] = N(d.desc_afp); c[29] = N(d.aporte_sis);
      for (let i = 30; i <= 39; i++) c[i] = '0'; c[35] = ''; c[36] = ''; c[37] = '';
      c[40] = '000'; c[41] = ''; c[42] = '0'; c[43] = '0'; c[44] = '0';
      c[45] = '000'; c[46] = ''; c[47] = '0'; c[48] = '0'; c[49] = '0';
      c[50] = '0'; c[51] = ''; c[52] = ''; c[53] = ''; c[54] = '';
      c[55] = '0'; c[56] = ''; c[57] = ''; c[58] = '0'; c[59] = '0'; c[60] = '0'; c[61] = '0';
      c[62] = '0000'; c[63] = '0';
      c[64] = esFonasa || cfg.mutual === '00' ? N(baseCot) : '0';
      c[65] = '0'; c[66] = '0'; c[67] = '0000'; c[68] = '0'; c[69] = '0';
      c[70] = esFonasa ? N(d.desc_salud) : '0';
      c[71] = cfg.mutual === '00' ? N(d.aporte_mutual) : '0';
      c[72] = '0'; c[73] = '0'; c[74] = '0';
      c[75] = saludCod || '00'; c[76] = '';
      c[77] = esIsapre ? N(baseCot) : '0';
      c[78] = esIsapre ? (planUF > 0 ? '2' : '1') : '0';
      c[79] = esIsapre ? (planUF > 0 ? String(planUF).replace('.', ',') : N(pactada)) : '0';
      c[80] = esIsapre ? N(d.desc_salud) : '0';
      c[81] = esIsapre ? N(d.desc_salud_adicional) : '0';
      c[82] = '0';
      c[83] = cfg.ccaf || '00';
      c[84] = cfg.ccaf !== '00' ? N(baseCot) : '0';
      c[85] = '0'; c[86] = '0'; c[87] = '0'; c[88] = '0'; c[89] = '0';
      c[90] = cfg.ccaf !== '00' && esFonasa ? N(baseCot * 0.042) : '0';
      c[91] = '0'; c[92] = '0';
      c[93] = /parcial|part/i.test(l.jornada || '') ? '2' : '1';
      c[94] = '0'; c[95] = '';
      c[96] = cfg.mutual || '00';
      c[97] = cfg.mutual !== '00' ? N(baseCot) : '0';
      c[98] = cfg.mutual !== '00' ? N(d.aporte_mutual) : '0';
      c[99] = cfg.sucursal_mutual || '0';
      c[100] = N(baseAfc); c[101] = N(d.desc_afc); c[102] = N(d.aporte_afc_emp);
      c[103] = '0'; c[104] = ''; c[105] = '';
      lineas.push(c.slice(1).join(';'));
    }

    // CCAF adherida: Fonasa se divide 2,8% Fonasa + resto CCAF — avisar si aplica
    if (cfg.ccaf !== '00') avisos.push('Empresa con CCAF configurada: verifica en Previred la distribución Fonasa 2,8% / CCAF (campo 70 va con el 7% completo).');

    ok(res, {
      mes, archivo: `previred_${per}.txt`, contenido: lineas.join('\r\n'),
      trabajadores: lineas.length, avisos,
      config: { ccaf: cfg.ccaf, mutual: cfg.mutual },
    });
  } catch (e) { console.error('[previred]', e.message); fail(res, e.message); }
}

/* ── Convenio firmado de anticipo/préstamo → carpeta digital del colaborador ──
   El documento se imprime desde la página de Descuentos, el colaborador lo
   firma, y el escaneado se sube aquí: queda en rh_documentos con tipo
   'CONVENIO DESCUENTO' y nombre DESC-{id}-... (ligado al descuento). */
require('../../../../shared/migrate').enFila('descuentos-convenio', async () => {
  const [[dt]] = await pool.query("SELECT valor FROM rh_config WHERE clave='doc_tipos'");
  if (dt && !dt.valor.includes('CONVENIO DESCUENTO'))
    await pool.query("UPDATE rh_config SET valor=CONCAT(valor, ',CONVENIO DESCUENTO') WHERE clave='doc_tipos'");
});

async function subirConvenioDescuento(req, res) {
  try {
    const id = parseInt(req.params.id);
    const b = req.body || {};
    const [[d]] = await pool.query('SELECT id_usuario, tipo FROM rh_descuentos WHERE id=?', [id]);
    if (!d) return fail(res, 'Descuento no existe', 404);
    if (!b.data) return fail(res, 'Falta el archivo', 400);
    const buf = Buffer.from(b.data, 'base64');
    if (buf.length > 10 * 1024 * 1024) return fail(res, 'Archivo supera 10 MB', 400);
    const nombre = `DESC-${id}-${String(b.nombre || 'convenio.pdf').slice(0, 180)}`;
    await pool.query(
      `INSERT INTO rh_documentos (id_usuario, tipo, nombre_archivo, mime_type, archivo_data, subido_por)
       VALUES (?,?,?,?,?,?)`,
      [d.id_usuario, 'CONVENIO DESCUENTO', nombre, b.mime || 'application/pdf', buf,
       `${req.usuario.nombre || ''} ${req.usuario.apellido || ''}`.trim()]);
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'convenio_descuento', entidad_id: id,
      detalle: `Convenio firmado subido para descuento #${id} (${d.tipo})` });
    ok(res, { ok: true });
  } catch (e) { console.error('[convenio descuento]', e.message); fail(res, e.message); }
}

async function getPreviredConfig(req, res) {
  try {
    const [[cfg]] = await pool.query('SELECT ccaf, mutual, sucursal_mutual FROM rh_previred_config WHERE id=1');
    ok(res, cfg || { ccaf: '00', mutual: '02', sucursal_mutual: '' });
  } catch (e) { fail(res, e.message); }
}

async function putPreviredConfig(req, res) {
  try {
    const { ccaf, mutual, sucursal_mutual } = req.body || {};
    await pool.query('UPDATE rh_previred_config SET ccaf=?, mutual=?, sucursal_mutual=? WHERE id=1',
      [String(ccaf || '00').slice(0, 2), String(mutual || '00').slice(0, 2), String(sucursal_mutual || '').slice(0, 3)]);
    ok(res, { ok: true });
  } catch (e) { fail(res, e.message); }
}

module.exports = { getMes, guardar, emitir, getLiquidacion, misLiquidaciones, calcLiquidacion, getIndicadores, putIndicadores,
  revisarAhora, getPropuesta, resolverPropuesta, getAdicionales, crearAdicional, eliminarAdicional,
  getDescuentos, crearDescuento, anularDescuento, aumentoRenta, aumentoPersonas, getPrevired, getPreviredConfig, putPreviredConfig, subirConvenioDescuento };
