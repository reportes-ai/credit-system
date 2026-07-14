'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   CONTABILIDAD — Fase 1: Núcleo contable (reemplazo de AVSOFT)
   · Plan de cuentas paramétrico jerárquico (mantenedor, no código).
   · Comprobantes INGRESO/EGRESO/TRASPASO con partida doble validada
     (debe = haber, solo cuentas imputables) y correlativo por tipo+año.
   · Libro Diario, Libro Mayor y Balance de Comprobación (8 columnas).
   · Los comprobantes nacen CONTABILIZADOS; anular no borra: marca ANULADO
     y queda fuera de los libros (auditoría intacta).
   Fase 2 (futura): centralización automática — reglas evento→asiento desde
   cajas, ODP, castigos, provisiones, comisiones y remuneraciones.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
require('../motor-asientos'); // Fase 2: carga el motor (migra reglas + log al boot)

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });
const nombreDe = u => `${u?.nombre || ''} ${u?.apellido || ''}`.trim() || u?.email || null;

/* ── Migración ─────────────────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('contabilidad-nucleo', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ctb_cuentas (
        codigo     VARCHAR(20) PRIMARY KEY,        -- jerárquico: 1, 1.1, 1.1.01
        nombre     VARCHAR(150) NOT NULL,
        tipo       VARCHAR(20) NOT NULL,           -- ACTIVO/PASIVO/PATRIMONIO/INGRESO/GASTO
        imputable  TINYINT NOT NULL DEFAULT 1,     -- 1 = recibe movimientos (hoja)
        activo     TINYINT NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ctb_comprobantes (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        tipo       VARCHAR(10) NOT NULL,           -- INGRESO/EGRESO/TRASPASO
        anio       INT NOT NULL,
        numero     INT NOT NULL,                   -- correlativo por tipo+año
        fecha      DATE NOT NULL,
        glosa      VARCHAR(300) NOT NULL,
        estado     VARCHAR(15) NOT NULL DEFAULT 'CONTABILIZADO',  -- CONTABILIZADO/ANULADO
        origen     VARCHAR(30) NOT NULL DEFAULT 'MANUAL',         -- MANUAL / (fase 2: CAJA, ODP, ...)
        origen_ref VARCHAR(40) NULL,               -- TRX-000123, num_op, etc.
        total      DECIMAL(14,0) NOT NULL DEFAULT 0,
        creado_por VARCHAR(160) NULL,
        anulado_por VARCHAR(160) NULL,
        anulado_motivo VARCHAR(300) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_tipo_anio_num (tipo, anio, numero),
        INDEX idx_fecha (fecha), INDEX idx_origen (origen, origen_ref)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ctb_movimientos (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        id_comprobante INT NOT NULL,
        cuenta         VARCHAR(20) NOT NULL,
        glosa          VARCHAR(300) NULL,
        debe           DECIMAL(14,0) NOT NULL DEFAULT 0,
        haber          DECIMAL(14,0) NOT NULL DEFAULT 0,
        num_op         BIGINT NULL,
        rut            VARCHAR(15) NULL,
        centro_costo   VARCHAR(80) NULL,
        INDEX idx_comp (id_comprobante), INDEX idx_cuenta (cuenta), INDEX idx_op (num_op)
      )`);

    // Plan de cuentas semilla (solo si está vacío) — ajustable 100% desde el mantenedor
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM ctb_cuentas');
    if (!n) {
      const P = [ // [codigo, nombre, tipo, imputable]
        ['1', 'ACTIVO', 'ACTIVO', 0], ['1.1', 'Activo Circulante', 'ACTIVO', 0],
        ['1.1.01', 'Caja', 'ACTIVO', 1], ['1.1.02', 'Banco', 'ACTIVO', 1],
        ['1.1.03', 'Colocaciones (créditos)', 'ACTIVO', 1], ['1.1.04', 'Intereses por cobrar', 'ACTIVO', 1],
        ['1.1.05', 'Deudores varios', 'ACTIVO', 1], ['1.1.06', 'IVA crédito fiscal', 'ACTIVO', 1],
        ['1.1.07', 'Anticipos al personal', 'ACTIVO', 1], ['1.1.08', 'Cuentas transitorias', 'ACTIVO', 1],
        ['1.2', 'Activo Fijo', 'ACTIVO', 0], ['1.2.01', 'Muebles y equipos', 'ACTIVO', 1],
        ['1.2.02', 'Depreciación acumulada', 'ACTIVO', 1],
        ['2', 'PASIVO', 'PASIVO', 0], ['2.1', 'Pasivo Circulante', 'PASIVO', 0],
        ['2.1.01', 'Proveedores', 'PASIVO', 1], ['2.1.02', 'Comisiones por pagar dealers', 'PASIVO', 1],
        ['2.1.03', 'Remuneraciones por pagar', 'PASIVO', 1], ['2.1.04', 'Retenciones previsionales', 'PASIVO', 1],
        ['2.1.05', 'Impuestos por pagar', 'PASIVO', 1], ['2.1.06', 'IVA débito fiscal', 'PASIVO', 1],
        ['2.1.07', 'Provisión incobrables', 'PASIVO', 1], ['2.1.08', 'Saldos precio por pagar', 'PASIVO', 1],
        ['2.2', 'Pasivo Largo Plazo', 'PASIVO', 0], ['2.2.01', 'Préstamos relacionados', 'PASIVO', 1],
        ['3', 'PATRIMONIO', 'PATRIMONIO', 0],
        ['3.1.01', 'Capital', 'PATRIMONIO', 1], ['3.1.02', 'Resultados acumulados', 'PATRIMONIO', 1],
        ['4', 'INGRESOS', 'INGRESO', 0],
        ['4.1.01', 'Intereses ganados', 'INGRESO', 1], ['4.1.02', 'Comisiones ganadas', 'INGRESO', 1],
        ['4.1.03', 'Ingresos por seguros', 'INGRESO', 1], ['4.1.04', 'Otros ingresos', 'INGRESO', 1],
        ['5', 'GASTOS', 'GASTO', 0],
        ['5.1.01', 'Remuneraciones', 'GASTO', 1], ['5.1.02', 'Comisiones dealers', 'GASTO', 1],
        ['5.1.03', 'Castigos incobrables', 'GASTO', 1], ['5.1.04', 'Gasto provisión', 'GASTO', 1],
        ['5.1.05', 'Arriendos', 'GASTO', 1], ['5.1.06', 'Gastos de oficina', 'GASTO', 1],
        ['5.1.07', 'Gastos bancarios', 'GASTO', 1], ['5.1.08', 'Honorarios', 'GASTO', 1],
        ['5.1.09', 'Otros gastos', 'GASTO', 1],
      ];
      for (const c of P) await pool.query('INSERT IGNORE INTO ctb_cuentas (codigo,nombre,tipo,imputable) VALUES (?,?,?,?)', c);
    }

    // ── Módulo Contabilidad en el Home ──
    await pool.query(`INSERT IGNORE INTO modulos (id_modulo, nombre, icono, ruta, orden, estado)
                      VALUES (500003, 'Contabilidad', 'bi-calculator-fill', '/contabilidad/', 96, 'activo')`);
    const funcs = [
      ['Contabilidad',            'ctb_ver',          '/contabilidad/',              'bi-calculator'],
      ['Plan de Cuentas',         'ctb_plan',         '/contabilidad/plan-cuentas/', 'bi-diagram-3'],
      ['Comprobantes',            'ctb_comprobantes', '/contabilidad/comprobantes/', 'bi-journal-plus'],
      ['Libros Diario y Mayor',   'ctb_libros',       '/contabilidad/libros/',       'bi-book'],
      ['Balance de Comprobación', 'ctb_balance',      '/contabilidad/balance/',      'bi-clipboard-data'],
      ['Reglas de Centralización', 'ctb_reglas',      '/contabilidad/reglas/',       'bi-gear-wide-connected'],
      ['Estados Financieros',     'ctb_estados',      '/contabilidad/estados/',      'bi-graph-up-arrow'],
    ];
    const idFunc = {};
    for (const [nombre, codigo, href, icono] of funcs) {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [codigo]);
      if (ex) { idFunc[codigo] = ex.id_funcionalidad; continue; }
      const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (500003,?,?,?,?)', [nombre, codigo, href, icono]);
      idFunc[codigo] = r.insertId;
    }
    // Semilla de permisos: Admin, Analista Financiero, Gte. Finanzas, Gte. General; el resto por matriz de Perfiles
    for (const codigo of Object.keys(idFunc)) {
      for (const idp of [1, 90003, 90007, 90009]) {
        await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idFunc[codigo]]);
      }
    }
    console.log('[contabilidad] núcleo contable listo');
  } catch (e) { console.error('[contabilidad migration]', e.message); }
});

/* ── Plan de cuentas ───────────────────────────────────────────────────────── */
exports.getCuentas = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM ctb_cuentas ORDER BY codigo');
    ok(res, rows);
  } catch (e) { fail(res, e.message); }
};

exports.crearCuenta = async (req, res) => {
  try {
    const { codigo, nombre, tipo, imputable } = req.body || {};
    if (!codigo || !nombre || !tipo) return fail(res, 'codigo, nombre y tipo son obligatorios', 400);
    if (!/^[0-9]+(\.[0-9]+)*$/.test(codigo)) return fail(res, 'Código inválido (formato 1.1.01)', 400);
    if (!['ACTIVO', 'PASIVO', 'PATRIMONIO', 'INGRESO', 'GASTO'].includes(tipo)) return fail(res, 'Tipo inválido', 400);
    await pool.query('INSERT INTO ctb_cuentas (codigo,nombre,tipo,imputable) VALUES (?,?,?,?)',
      [codigo.trim(), nombre.trim(), tipo, imputable ? 1 : 0]);
    auditar({ req, accion:'CREAR', modulo:'contabilidad', entidad:'cuenta', entidad_id:codigo, detalle:`Cuenta ${codigo} ${nombre} (${tipo})` });
    ok(res, { codigo });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return fail(res, `La cuenta ${req.body.codigo} ya existe`, 409);
    fail(res, e.message);
  }
};

exports.editarCuenta = async (req, res) => {
  try {
    const { nombre, tipo, imputable, activo } = req.body || {};
    const sets = [], vals = [];
    if (nombre !== undefined) { sets.push('nombre=?'); vals.push(String(nombre).trim()); }
    if (tipo !== undefined) {
      if (!['ACTIVO', 'PASIVO', 'PATRIMONIO', 'INGRESO', 'GASTO'].includes(tipo)) return fail(res, 'Tipo inválido', 400);
      sets.push('tipo=?'); vals.push(tipo);
    }
    if (imputable !== undefined) { sets.push('imputable=?'); vals.push(imputable ? 1 : 0); }
    if (activo !== undefined) { sets.push('activo=?'); vals.push(activo ? 1 : 0); }
    if (!sets.length) return fail(res, 'Nada que actualizar', 400);
    vals.push(req.params.codigo);
    const [r] = await pool.query(`UPDATE ctb_cuentas SET ${sets.join(', ')} WHERE codigo=?`, vals);
    if (!r.affectedRows) return fail(res, 'Cuenta no existe', 404);
    auditar({ req, accion:'EDITAR', modulo:'contabilidad', entidad:'cuenta', entidad_id:req.params.codigo, detalle:JSON.stringify(req.body) });
    ok(res, { codigo: req.params.codigo });
  } catch (e) { fail(res, e.message); }
};

exports.eliminarCuenta = async (req, res) => {
  try {
    const cod = req.params.codigo;
    const [[m]] = await pool.query('SELECT COUNT(*) n FROM ctb_movimientos WHERE cuenta=?', [cod]);
    if (m.n) return fail(res, `La cuenta tiene ${m.n} movimientos; desactívala en vez de eliminarla`, 409);
    const [[h]] = await pool.query("SELECT COUNT(*) n FROM ctb_cuentas WHERE codigo LIKE CONCAT(?, '.%')", [cod]);
    if (h.n) return fail(res, 'La cuenta tiene subcuentas', 409);
    const [r] = await pool.query('DELETE FROM ctb_cuentas WHERE codigo=?', [cod]);
    if (!r.affectedRows) return fail(res, 'Cuenta no existe', 404);
    auditar({ req, accion:'ELIMINAR', modulo:'contabilidad', entidad:'cuenta', entidad_id:cod, detalle:`Cuenta ${cod} eliminada` });
    ok(res, { codigo: cod });
  } catch (e) { fail(res, e.message); }
};

/* ── Comprobantes ──────────────────────────────────────────────────────────── */
const fmtNum = c => `${c.tipo[0]}-${c.anio}-${String(c.numero).padStart(5, '0')}`;

exports.crearComprobante = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { tipo, fecha, glosa, movimientos } = req.body || {};
    if (!['INGRESO', 'EGRESO', 'TRASPASO'].includes(tipo)) return fail(res, 'Tipo inválido', 400);
    if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return fail(res, 'Fecha inválida', 400);
    if (!glosa || !String(glosa).trim()) return fail(res, 'Glosa obligatoria', 400);
    if (!Array.isArray(movimientos) || movimientos.length < 2) return fail(res, 'Mínimo 2 líneas de movimiento', 400);

    let debe = 0, haber = 0;
    for (const m of movimientos) {
      const d = Math.round(Number(m.debe) || 0), h = Math.round(Number(m.haber) || 0);
      if (d < 0 || h < 0) return fail(res, 'Montos negativos no permitidos', 400);
      if ((d > 0) === (h > 0)) return fail(res, `Cada línea lleva Debe O Haber (cuenta ${m.cuenta})`, 400);
      if (!m.cuenta) return fail(res, 'Toda línea necesita cuenta', 400);
      debe += d; haber += h;
    }
    if (debe !== haber) return fail(res, `Descuadrado: Debe $${debe.toLocaleString('es-CL')} ≠ Haber $${haber.toLocaleString('es-CL')}`, 400);
    if (!debe) return fail(res, 'Comprobante en cero', 400);

    // Cuentas válidas e imputables
    const codigos = [...new Set(movimientos.map(m => String(m.cuenta)))];
    const [ctas] = await pool.query('SELECT codigo, imputable, activo FROM ctb_cuentas WHERE codigo IN (?)', [codigos]);
    const mapa = Object.fromEntries(ctas.map(c => [c.codigo, c]));
    for (const cod of codigos) {
      const c = mapa[cod];
      if (!c) return fail(res, `Cuenta ${cod} no existe en el plan`, 400);
      if (!c.imputable) return fail(res, `Cuenta ${cod} no es imputable (es de agrupación)`, 400);
      if (!c.activo) return fail(res, `Cuenta ${cod} está desactivada`, 400);
    }

    const anio = Number(fecha.slice(0, 4));
    await conn.beginTransaction();
    const [[{ sig }]] = await conn.query(
      'SELECT COALESCE(MAX(numero),0)+1 sig FROM ctb_comprobantes WHERE tipo=? AND anio=? FOR UPDATE', [tipo, anio]);
    const [r] = await conn.query(
      `INSERT INTO ctb_comprobantes (tipo, anio, numero, fecha, glosa, total, creado_por) VALUES (?,?,?,?,?,?,?)`,
      [tipo, anio, sig, fecha, String(glosa).trim(), debe, nombreDe(req.user)]);
    for (const m of movimientos) {
      await conn.query(
        'INSERT INTO ctb_movimientos (id_comprobante, cuenta, glosa, debe, haber, num_op, rut, centro_costo) VALUES (?,?,?,?,?,?,?,?)',
        [r.insertId, m.cuenta, m.glosa || null, Math.round(Number(m.debe) || 0), Math.round(Number(m.haber) || 0),
         m.num_op || null, m.rut || null, m.centro_costo || null]);
    }
    await conn.commit();
    const num = fmtNum({ tipo, anio, numero: sig });
    auditar({ req, accion:'CREAR', modulo:'contabilidad', entidad:'comprobante', entidad_id:r.insertId, detalle:`${num} por $${debe.toLocaleString('es-CL')}` });
    ok(res, { id: r.insertId, numero: num, total: debe });
  } catch (e) {
    await conn.rollback().catch(() => {});
    fail(res, e.message);
  } finally { conn.release(); }
};

exports.listarComprobantes = async (req, res) => {
  try {
    const { mes, tipo, estado, q } = req.query;
    const w = ['1=1'], vals = [];
    if (mes && /^\d{4}-\d{2}$/.test(mes)) { w.push("DATE_FORMAT(fecha,'%Y-%m')=?"); vals.push(mes); }
    if (tipo) { w.push('tipo=?'); vals.push(tipo); }
    if (estado) { w.push('estado=?'); vals.push(estado); }
    if (q) { w.push('(glosa LIKE ? OR origen_ref LIKE ?)'); vals.push(`%${q}%`, `%${q}%`); }
    const [rows] = await pool.query(
      `SELECT id, tipo, anio, numero, fecha, glosa, estado, origen, origen_ref, total, creado_por, created_at
         FROM ctb_comprobantes WHERE ${w.join(' AND ')} ORDER BY fecha DESC, id DESC LIMIT 500`, vals);
    ok(res, rows.map(r => ({ ...r, num: fmtNum(r) })));
  } catch (e) { fail(res, e.message); }
};

exports.getComprobante = async (req, res) => {
  try {
    const [[c]] = await pool.query('SELECT * FROM ctb_comprobantes WHERE id=?', [req.params.id]);
    if (!c) return fail(res, 'No existe', 404);
    const [movs] = await pool.query(
      `SELECT m.*, k.nombre cuenta_nombre FROM ctb_movimientos m
        LEFT JOIN ctb_cuentas k ON k.codigo=m.cuenta WHERE m.id_comprobante=? ORDER BY m.id`, [c.id]);
    ok(res, { ...c, num: fmtNum(c), movimientos: movs });
  } catch (e) { fail(res, e.message); }
};

exports.anularComprobante = async (req, res) => {
  try {
    const motivo = String(req.body?.motivo || '').trim();
    if (!motivo) return fail(res, 'Motivo de anulación obligatorio', 400);
    const [r] = await pool.query(
      "UPDATE ctb_comprobantes SET estado='ANULADO', anulado_por=?, anulado_motivo=? WHERE id=? AND estado='CONTABILIZADO'",
      [nombreDe(req.user), motivo, req.params.id]);
    if (!r.affectedRows) return fail(res, 'No existe o ya está anulado', 404);
    auditar({ req, accion:'ANULAR', modulo:'contabilidad', entidad:'comprobante', entidad_id:req.params.id, detalle:motivo });
    ok(res, { id: Number(req.params.id) });
  } catch (e) { fail(res, e.message); }
};

/* ── Libros ────────────────────────────────────────────────────────────────── */
const rangoFechas = (req) => {
  const { desde, hasta } = req.query;
  const okF = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  return okF(desde) && okF(hasta) ? { desde, hasta } : null;
};

exports.libroDiario = async (req, res) => {
  try {
    const r = rangoFechas(req);
    if (!r) return fail(res, 'desde y hasta (YYYY-MM-DD) obligatorios', 400);
    const [rows] = await pool.query(
      `SELECT c.id, c.tipo, c.anio, c.numero, c.fecha, c.glosa comp_glosa,
              m.cuenta, k.nombre cuenta_nombre, m.glosa, m.debe, m.haber, m.num_op, m.rut
         FROM ctb_comprobantes c
         JOIN ctb_movimientos m ON m.id_comprobante=c.id
         LEFT JOIN ctb_cuentas k ON k.codigo=m.cuenta
        WHERE c.estado='CONTABILIZADO' AND c.fecha BETWEEN ? AND ?
        ORDER BY c.fecha, c.id, m.id LIMIT 5000`, [r.desde, r.hasta]);
    ok(res, rows.map(x => ({ ...x, num: fmtNum(x) })));
  } catch (e) { fail(res, e.message); }
};

exports.libroMayor = async (req, res) => {
  try {
    const r = rangoFechas(req);
    const cuenta = req.query.cuenta;
    if (!r || !cuenta) return fail(res, 'cuenta, desde y hasta obligatorios', 400);
    const [[ini]] = await pool.query(
      `SELECT COALESCE(SUM(m.debe),0) d, COALESCE(SUM(m.haber),0) h
         FROM ctb_movimientos m JOIN ctb_comprobantes c ON c.id=m.id_comprobante
        WHERE c.estado='CONTABILIZADO' AND m.cuenta=? AND c.fecha < ?`, [cuenta, r.desde]);
    const [rows] = await pool.query(
      `SELECT c.id, c.tipo, c.anio, c.numero, c.fecha, c.glosa comp_glosa, m.glosa, m.debe, m.haber, m.num_op, m.rut
         FROM ctb_movimientos m JOIN ctb_comprobantes c ON c.id=m.id_comprobante
        WHERE c.estado='CONTABILIZADO' AND m.cuenta=? AND c.fecha BETWEEN ? AND ?
        ORDER BY c.fecha, c.id LIMIT 5000`, [cuenta, r.desde, r.hasta]);
    ok(res, { saldo_inicial: Number(ini.d) - Number(ini.h), movimientos: rows.map(x => ({ ...x, num: fmtNum(x) })) });
  } catch (e) { fail(res, e.message); }
};

/* ── Estados financieros (Fase 3) ──────────────────────────────────────────────
   Balance General a una fecha: saldos acumulados de ACTIVO / PASIVO / PATRIMONIO
   + Resultado del Ejercicio (ingresos − gastos acumulados) para que cuadre.
   EERR de un período: ingresos y gastos entre fechas, utilidad/pérdida. */
exports.balanceGeneral = async (req, res) => {
  try {
    const hasta = req.query.hasta;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(hasta || '')) return fail(res, 'hasta (YYYY-MM-DD) obligatorio', 400);
    const [rows] = await pool.query(
      `SELECT m.cuenta, k.nombre, k.tipo, SUM(m.debe) debe, SUM(m.haber) haber
         FROM ctb_movimientos m
         JOIN ctb_comprobantes c ON c.id=m.id_comprobante
         LEFT JOIN ctb_cuentas k ON k.codigo=m.cuenta
        WHERE c.estado='CONTABILIZADO' AND c.fecha <= ?
        GROUP BY m.cuenta, k.nombre, k.tipo ORDER BY m.cuenta`, [hasta]);
    const out = { activo: [], pasivo: [], patrimonio: [], tot: { activo: 0, pasivo: 0, patrimonio: 0 }, resultado_ejercicio: 0 };
    for (const x of rows) {
      const deudor = Number(x.debe) - Number(x.haber);          // saldo con signo (deudor +)
      if (x.tipo === 'ACTIVO') { if (deudor) { out.activo.push({ cuenta: x.cuenta, nombre: x.nombre, saldo: deudor }); out.tot.activo += deudor; } }
      else if (x.tipo === 'PASIVO') { const s = -deudor; if (s) { out.pasivo.push({ cuenta: x.cuenta, nombre: x.nombre, saldo: s }); out.tot.pasivo += s; } }
      else if (x.tipo === 'PATRIMONIO') { const s = -deudor; if (s) { out.patrimonio.push({ cuenta: x.cuenta, nombre: x.nombre, saldo: s }); out.tot.patrimonio += s; } }
      else out.resultado_ejercicio += -deudor;                  // INGRESO acreedor (+), GASTO deudor (−)
    }
    out.tot.pas_pat_result = out.tot.pasivo + out.tot.patrimonio + out.resultado_ejercicio;
    out.cuadre = Math.round(out.tot.activo) === Math.round(out.tot.pas_pat_result);
    ok(res, out);
  } catch (e) { fail(res, e.message); }
};

exports.estadoResultados = async (req, res) => {
  try {
    const { desde, hasta, cc } = req.query;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde || '') || !/^\d{4}-\d{2}-\d{2}$/.test(hasta || ''))
      return fail(res, 'desde y hasta obligatorios', 400);
    // El cierre de ejercicio deja los resultados en cero: se excluye para que el EERR muestre el período real
    const base = `FROM ctb_movimientos m
         JOIN ctb_comprobantes c ON c.id=m.id_comprobante
         LEFT JOIN ctb_cuentas k ON k.codigo=m.cuenta
        WHERE c.estado='CONTABILIZADO' AND c.origen<>'CIERRE_EJERCICIO' AND c.fecha BETWEEN ? AND ? AND k.tipo IN ('INGRESO','GASTO')`;
    const vals = [desde, hasta];
    let filtroCC = '';
    if (cc === '__SIN__') filtroCC = ' AND m.centro_costo IS NULL';
    else if (cc) { filtroCC = ' AND m.centro_costo = ?'; vals.push(cc); }
    const [rows] = await pool.query(
      `SELECT m.cuenta, k.nombre, k.tipo, SUM(m.debe) debe, SUM(m.haber) haber ${base}${filtroCC}
        GROUP BY m.cuenta, k.nombre, k.tipo ORDER BY m.cuenta`, vals);
    const [ccs] = await pool.query(
      `SELECT DISTINCT m.centro_costo ${base} AND m.centro_costo IS NOT NULL ORDER BY 1`, [desde, hasta]);
    const ingresos = [], gastos = []; let ti = 0, tg = 0;
    for (const x of rows) {
      if (x.tipo === 'INGRESO') { const s = Number(x.haber) - Number(x.debe); if (s) { ingresos.push({ cuenta: x.cuenta, nombre: x.nombre, monto: s }); ti += s; } }
      else { const s = Number(x.debe) - Number(x.haber); if (s) { gastos.push({ cuenta: x.cuenta, nombre: x.nombre, monto: s }); tg += s; } }
    }
    ok(res, { ingresos, gastos, total_ingresos: ti, total_gastos: tg, resultado: ti - tg, centros: ccs.map(x => x.centro_costo) });
  } catch (e) { fail(res, e.message); }
};

/* ── Cierre de ejercicio ───────────────────────────────────────────────────────
   Genera el comprobante de TRASPASO al 31-12 que deja en CERO todas las cuentas
   de resultado (ingresos y gastos) y lleva la utilidad/pérdida del año a la
   cuenta de Resultados Acumulados (paramétrica en ctb_config). Idempotente por
   origen CIERRE_EJERCICIO + ref CIERRE-<año>; se deshace anulando el comprobante. */
exports.cerrarEjercicio = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const anio = Number(req.body?.anio);
    if (!anio || anio < 2020 || anio > 2100) return fail(res, 'anio inválido', 400);
    const fecha = `${anio}-12-31`;
    const ref = `CIERRE-${anio}`;
    const [[dup]] = await pool.query(
      "SELECT id FROM ctb_comprobantes WHERE origen='CIERRE_EJERCICIO' AND origen_ref=? AND estado='CONTABILIZADO' LIMIT 1", [ref]);
    if (dup) return fail(res, `El ejercicio ${anio} ya está cerrado (comprobante id ${dup.id}); anúlalo si necesitas rehacerlo`, 409);

    // Cuenta destino paramétrica (default: Resultados Acumulados del plan AVSOFT)
    await pool.query(`CREATE TABLE IF NOT EXISTS ctb_config (clave VARCHAR(60) PRIMARY KEY, valor VARCHAR(200) NOT NULL)`);
    await pool.query(`INSERT IGNORE INTO ctb_config (clave, valor) VALUES ('cuenta_resultados_acumulados','2703010')`);
    const [[cfg]] = await pool.query("SELECT valor FROM ctb_config WHERE clave='cuenta_resultados_acumulados'");
    const ctaResult = cfg.valor;
    const [[cr]] = await pool.query('SELECT imputable, activo FROM ctb_cuentas WHERE codigo=?', [ctaResult]);
    if (!cr || !cr.imputable || !cr.activo) return fail(res, `Cuenta de Resultados Acumulados ${ctaResult} inválida (revisa ctb_config)`, 400);

    // Saldos de las cuentas de resultado hasta el 31-12 (cierres previos ya se netean solos)
    const [rows] = await pool.query(
      `SELECT m.cuenta, k.nombre, SUM(m.debe)-SUM(m.haber) s
         FROM ctb_movimientos m
         JOIN ctb_comprobantes c ON c.id=m.id_comprobante
         JOIN ctb_cuentas k ON k.codigo=m.cuenta
        WHERE c.estado='CONTABILIZADO' AND c.fecha <= ? AND k.tipo IN ('INGRESO','GASTO')
        GROUP BY m.cuenta, k.nombre HAVING s <> 0 ORDER BY m.cuenta`, [fecha]);
    if (!rows.length) return fail(res, `No hay saldos de resultado que cerrar al ${fecha}`, 400);

    let debe = 0, haber = 0;
    const movs = rows.map(x => {
      const s = Math.round(Number(x.s));
      const m = { cuenta: x.cuenta, glosa: `Cierre ${x.nombre}`.slice(0, 200), debe: s < 0 ? -s : 0, haber: s > 0 ? s : 0 };
      debe += m.debe; haber += m.haber;
      return m;
    });
    const resultado = debe - haber; // + = utilidad (ingresos > gastos)
    movs.push({ cuenta: ctaResult, glosa: `${resultado >= 0 ? 'Utilidad' : 'Pérdida'} del ejercicio ${anio}`,
      debe: resultado < 0 ? -resultado : 0, haber: resultado > 0 ? resultado : 0 });
    const total = Math.max(debe, haber);

    await conn.beginTransaction();
    const [[{ sig }]] = await conn.query(
      "SELECT COALESCE(MAX(numero),0)+1 sig FROM ctb_comprobantes WHERE tipo='TRASPASO' AND anio=? FOR UPDATE", [anio]);
    const [r] = await conn.query(
      `INSERT INTO ctb_comprobantes (tipo, anio, numero, fecha, glosa, origen, origen_ref, total, creado_por)
       VALUES ('TRASPASO',?,?,?,?,'CIERRE_EJERCICIO',?,?,?)`,
      [anio, sig, fecha, `Cierre de ejercicio ${anio}`, ref, total, nombreDe(req.user) || 'Cierre de ejercicio']);
    for (const m of movs)
      await conn.query('INSERT INTO ctb_movimientos (id_comprobante, cuenta, glosa, debe, haber) VALUES (?,?,?,?,?)',
        [r.insertId, m.cuenta, m.glosa, m.debe, m.haber]);
    await conn.commit();
    auditar({ req, accion: 'EDITAR', modulo: 'contabilidad', entidad: 'cierre_ejercicio', entidad_id: anio,
      detalle: `Cierre ${anio}: ${rows.length} cuentas de resultado → ${resultado >= 0 ? 'utilidad' : 'pérdida'} $${Math.abs(resultado).toLocaleString('es-CL')} a ${ctaResult}` });
    ok(res, { id: r.insertId, numero: `T-${anio}-${String(sig).padStart(5, '0')}`, resultado, cuentas_cerradas: rows.length });
  } catch (e) {
    await conn.rollback().catch(() => {});
    fail(res, e.message);
  } finally { conn.release(); }
};

/* ── Reglas de centralización (Fase 2) ─────────────────────────────────────── */
exports.getReglas = async (req, res) => {
  try {
    const [reglas] = await pool.query('SELECT * FROM ctb_reglas ORDER BY evento');
    const [lineas] = await pool.query(
      `SELECT l.*, k.nombre cuenta_nombre FROM ctb_reglas_lineas l
        LEFT JOIN ctb_cuentas k ON k.codigo=l.cuenta ORDER BY l.evento, l.id`);
    ok(res, reglas.map(r => ({ ...r, lineas: lineas.filter(l => l.evento === r.evento) })));
  } catch (e) { fail(res, e.message); }
};

exports.putRegla = async (req, res) => {
  try {
    const { activa, tipo, lineas } = req.body || {};
    const [[regla]] = await pool.query('SELECT evento FROM ctb_reglas WHERE evento=?', [req.params.evento]);
    if (!regla) return fail(res, 'Evento no existe', 404);
    if (tipo !== undefined && !['INGRESO', 'EGRESO', 'TRASPASO'].includes(tipo)) return fail(res, 'Tipo inválido', 400);
    if (Array.isArray(lineas)) {
      if (lineas.length < 2) return fail(res, 'Mínimo 2 líneas (partida doble)', 400);
      for (const l of lineas) {
        if (!l.cuenta || !['DEBE', 'HABER'].includes(l.lado) || !l.campo) return fail(res, 'Cada línea necesita cuenta, lado y campo', 400);
        const [[c]] = await pool.query('SELECT imputable, activo FROM ctb_cuentas WHERE codigo=?', [l.cuenta]);
        if (!c || !c.imputable || !c.activo) return fail(res, `Cuenta ${l.cuenta} no existe, no es imputable o está inactiva`, 400);
      }
      await pool.query('DELETE FROM ctb_reglas_lineas WHERE evento=?', [req.params.evento]);
      for (const l of lineas)
        await pool.query('INSERT INTO ctb_reglas_lineas (evento, cuenta, lado, campo, glosa) VALUES (?,?,?,?,?)',
          [req.params.evento, l.cuenta, l.lado, l.campo.trim(), (l.glosa || '').trim() || null]);
    }
    const sets = [], vals = [];
    if (activa !== undefined) { sets.push('activa=?'); vals.push(activa ? 1 : 0); }
    if (tipo !== undefined) { sets.push('tipo=?'); vals.push(tipo); }
    if (sets.length) { vals.push(req.params.evento); await pool.query(`UPDATE ctb_reglas SET ${sets.join(', ')} WHERE evento=?`, vals); }
    auditar({ req, accion: 'EDITAR', modulo: 'contabilidad', entidad: 'regla', entidad_id: req.params.evento, detalle: JSON.stringify({ activa, tipo, lineas: lineas?.length }) });
    ok(res, { evento: req.params.evento });
  } catch (e) { fail(res, e.message); }
};

exports.getEventosLog = async (req, res) => {
  try {
    const w = [], vals = [];
    if (req.query.evento) { w.push('evento=?'); vals.push(req.query.evento); }
    const [rows] = await pool.query(
      `SELECT * FROM ctb_eventos_log ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`, vals);
    ok(res, rows);
  } catch (e) { fail(res, e.message); }
};

exports.balance = async (req, res) => {
  try {
    const r = rangoFechas(req);
    if (!r) return fail(res, 'desde y hasta obligatorios', 400);
    const [rows] = await pool.query(
      `SELECT m.cuenta, k.nombre, k.tipo, SUM(m.debe) debe, SUM(m.haber) haber
         FROM ctb_movimientos m
         JOIN ctb_comprobantes c ON c.id=m.id_comprobante
         LEFT JOIN ctb_cuentas k ON k.codigo=m.cuenta
        WHERE c.estado='CONTABILIZADO' AND c.fecha BETWEEN ? AND ?
        GROUP BY m.cuenta, k.nombre, k.tipo ORDER BY m.cuenta`, [r.desde, r.hasta]);
    // Balance de comprobación de 8 columnas
    const data = rows.map(x => {
      const debe = Number(x.debe), haber = Number(x.haber);
      const deudor = Math.max(0, debe - haber), acreedor = Math.max(0, haber - debe);
      const esResultado = x.tipo === 'INGRESO' || x.tipo === 'GASTO';
      return {
        cuenta: x.cuenta, nombre: x.nombre, tipo: x.tipo, debe, haber, deudor, acreedor,
        activo: !esResultado ? deudor : 0, pasivo: !esResultado ? acreedor : 0,
        perdida: esResultado ? deudor : 0, ganancia: esResultado ? acreedor : 0,
      };
    });
    ok(res, data);
  } catch (e) { fail(res, e.message); }
};
