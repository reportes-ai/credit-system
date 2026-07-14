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
      ['Informe Cierre Mensual',  'ctb_cierre_mes',   '/contabilidad/cierre-mes/',   'bi-flag'],
      ['Bitácora de Cierres',     'ctb_bitacora',     '/contabilidad/bitacora-cierres/', 'bi-journal-bookmark'],
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

    // Candado: mes reportado no se toca
    const candado = await mesConCandado(fecha);
    if (candado) return fail(res, `El mes ${candado} está CERRADO con candado (ya fue reportado). Para digitar en él, reábrelo primero en Informe Cierre Mensual.`, 423);

    // Guardián contable: reglas de coherencia antes de tocar los libros.
    // BLOQUEA → error; ADVIERTE → 409 con las advertencias para que el usuario
    // confirme (el frontend reenvía con confirmar_guardian=true).
    const guardian = await evaluarGuardian({ glosa, movimientos });
    if (guardian.bloqueos.length)
      return res.status(400).json({ success: false, data: { bloqueos: guardian.bloqueos }, error: 'GUARDIAN_BLOQUEA' });
    if (guardian.advertencias.length && !req.body.confirmar_guardian)
      return res.status(409).json({ success: false, data: { advertencias: guardian.advertencias }, error: 'GUARDIAN_ADVIERTE' });

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
    const [[comp]] = await pool.query('SELECT fecha FROM ctb_comprobantes WHERE id=?', [req.params.id]);
    if (comp) {
      const candado = await mesConCandado(comp.fecha.toISOString ? comp.fecha.toISOString().slice(0, 10) : comp.fecha);
      if (candado) return fail(res, `El comprobante es del mes ${candado}, que está CERRADO con candado. Reábrelo primero en Informe Cierre Mensual.`, 423);
    }
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

/* ── Informe de Cierre Mensual (reporte a la matriz en Ecuador) ────────────────
   Un solo payload con TODO el mes: Balance General al último día, EERR del mes,
   EERR acumulado del año y el tipo de cambio del cierre (último dólar CMF ≤ fin
   de mes, tabla `dolar`). La conversión a USD la hace el frontend con ese TC
   (o con el TC manual que el usuario ingrese). Reusa los motores de balance y
   EERR llamándolos internamente — un solo motor por magnitud. */
exports.cierreMes = async (req, res) => {
  try {
    const mes = req.query.mes;
    if (!/^\d{4}-\d{2}$/.test(mes || '')) return fail(res, 'mes (YYYY-MM) obligatorio', 400);
    const [y, m] = mes.split('-').map(Number);
    const fin = `${y}-${String(m).padStart(2, '0')}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
    const ini = `${mes}-01`;
    const interno = (fn, query) => new Promise((resolve, reject) => {
      const r2 = { status() { return this; }, json(j) { j.success ? resolve(j.data) : reject(new Error(j.error)); } };
      fn({ query, params: {}, body: {}, user: req.user }, r2).catch(reject);
    });
    const [balance, eerr_mes, eerr_acum] = await Promise.all([
      interno(exports.balanceGeneral, { hasta: fin }),
      interno(exports.estadoResultados, { desde: ini, hasta: fin }),
      interno(exports.estadoResultados, { desde: `${y}-01-01`, hasta: fin }),
    ]);
    const [[tc]] = await pool.query('SELECT DATE_FORMAT(fecha, "%Y-%m-%d") fecha, valor FROM dolar WHERE fecha <= ? ORDER BY fecha DESC LIMIT 1', [fin]);
    const [[com]] = await pool.query('SELECT comentario, actualizado_por, updated_at FROM ctb_cierre_comentarios WHERE mes=?', [mes]).catch(() => [[null]]);
    ok(res, {
      mes, fin_mes: fin,
      tipo_cambio: tc ? { fecha: tc.fecha, valor: Number(tc.valor) } : null,
      balance, eerr_mes, eerr_acum,
      comentario: com || null,
    });
  } catch (e) { fail(res, e.message); }
};

/* ── Comentarios al cierre mensual (management commentary) ─────────────────────
   Texto libre por mes, guardado con autor y fecha; sale en el PDF del informe.
   El borrador con IA compara el mes contra el anterior y propone 4-6 puntos —
   nada se guarda sin que el usuario lo revise y grabe. */
require('../../../../shared/migrate').enFila('contabilidad-comentarios', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ctb_cierre_comentarios (
        mes         VARCHAR(7) PRIMARY KEY,
        comentario  TEXT NOT NULL,
        borrador_ia TINYINT NOT NULL DEFAULT 0,
        actualizado_por VARCHAR(160) NULL,
        updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
    // Registrar la funcionalidad en el subsistema de IA (el admin la gobierna desde el mantenedor IA)
    await require('../../../../shared/ia').registrarFuncionalidad({
      codigo: 'ctb_comentario_cierre',
      nombre: 'Comentarios al Cierre Mensual',
      descripcion: 'Borrador de los comentarios de la administración del informe mensual a la matriz: compara el mes contra el anterior y propone 4-6 viñetas (resultado, variaciones, alertas). El usuario siempre revisa y guarda.',
    });
  } catch (e) { console.error('[contabilidad-comentarios migration]', e.message); }
});

exports.guardarComentario = async (req, res) => {
  try {
    const { mes, comentario } = req.body || {};
    if (!/^\d{4}-\d{2}$/.test(mes || '')) return fail(res, 'mes inválido', 400);
    await pool.query(
      `INSERT INTO ctb_cierre_comentarios (mes, comentario, borrador_ia, actualizado_por) VALUES (?,?,0,?)
       ON DUPLICATE KEY UPDATE comentario=VALUES(comentario), borrador_ia=0, actualizado_por=VALUES(actualizado_por)`,
      [mes, String(comentario || '').slice(0, 8000), nombreDe(req.user)]);
    auditar({ req, accion: 'EDITAR', modulo: 'contabilidad', entidad: 'comentario_cierre', entidad_id: mes, detalle: `Comentarios al cierre ${mes} guardados` });
    ok(res, { mes });
  } catch (e) { fail(res, e.message); }
};

exports.comentarioIA = async (req, res) => {
  try {
    const mes = req.body?.mes;
    if (!/^\d{4}-\d{2}$/.test(mes || '')) return fail(res, 'mes inválido', 400);
    const interno = (fn, query) => new Promise((resolve, reject) => {
      const r2 = { status() { return this; }, json(j) { j.success ? resolve(j.data) : reject(new Error(j.error)); } };
      fn({ query, params: {}, body: {}, user: req.user }, r2).catch(reject);
    });
    const [y, m] = mes.split('-').map(Number);
    const mesAnt = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    const [actual, anterior] = await Promise.all([
      interno(exports.cierreMes, { mes }),
      interno(exports.cierreMes, { mes: mesAnt }).catch(() => null),
    ]);
    const resumen = d => d && {
      mes: d.mes, tc: d.tipo_cambio?.valor,
      activo: d.balance.tot.activo, pasivo: d.balance.tot.pasivo, patrimonio: d.balance.tot.patrimonio,
      resultado_ejercicio: d.balance.resultado_ejercicio,
      ingresos_mes: d.eerr_mes.total_ingresos, gastos_mes: d.eerr_mes.total_gastos, resultado_mes: d.eerr_mes.resultado,
      resultado_acumulado: d.eerr_acum.resultado,
      top_ingresos: d.eerr_mes.ingresos.slice().sort((a, b) => b.monto - a.monto).slice(0, 6),
      top_gastos: d.eerr_mes.gastos.slice().sort((a, b) => b.monto - a.monto).slice(0, 6),
    };
    const { analizar } = require('../../../../shared/anthropic');
    const out = await analizar({
      codigo: 'ctb_comentario_cierre',
      id_usuario: (req.usuario || req.user || {}).id_usuario || null,
      system: 'Eres el contador gerencial de AutoFácil Chile (crédito automotriz). Escribes los comentarios de la administración del informe mensual que se envía a la matriz en Ecuador. Estilo: profesional, directo, en español, montos en CLP con separador de miles. NO inventes cifras: usa solo los datos entregados.',
      prompt: `Datos del mes reportado y del mes anterior (JSON):\n${JSON.stringify({ actual: resumen(actual), anterior: resumen(anterior) })}\n\nEscribe los "Comentarios al cierre" del mes ${mes}: 4 a 6 viñetas (formato "• ..."), cada una de 1-2 líneas. Cubre: resultado del mes y su variación contra el mes anterior (si hay datos), los movimientos más relevantes de ingresos y gastos, la posición de balance (activo/pasivo/patrimonio) y cualquier alerta que un gerente deba saber (patrimonio negativo, pérdidas sostenidas, concentraciones). Sin encabezado ni despedida: solo las viñetas.`,
      max_tokens: 1024,
    });
    if (!out || !out.texto) return fail(res, 'La IA no devolvió comentarios', 502);
    ok(res, { borrador: out.texto.trim() });
  } catch (e) {
    console.error('[ctb comentarioIA]', e.message);
    fail(res, 'No se pudo generar el borrador con IA: ' + e.message, 502);
  }
};

/* ── Bitácora de Cierres ───────────────────────────────────────────────────────
   Memoria financiera mes a mes: snapshot de KPIs del cierre + análisis en
   profundidad generado con IA (tendencia de 6 meses incluida). Cada análisis
   queda guardado con fecha y autor; re-analizar reemplaza el texto (la foto de
   KPIs se recalcula al momento de analizar). */
require('../../../../shared/migrate').enFila('contabilidad-bitacora', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ctb_cierres_bitacora (
        mes         VARCHAR(7) PRIMARY KEY,
        kpis        JSON NULL,
        analisis    TEXT NULL,
        generado_por VARCHAR(160) NULL,
        updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
    await require('../../../../shared/ia').registrarFuncionalidad({
      codigo: 'ctb_analisis_cierre',
      nombre: 'Análisis de Cierre (Bitácora)',
      descripcion: 'Análisis financiero en profundidad de cada mes cerrado para la Bitácora de Cierres: tendencia de 6 meses, variaciones relevantes, riesgos y recomendaciones. Se genera a pedido y queda guardado.',
    });
  } catch (e) { console.error('[contabilidad-bitacora migration]', e.message); }
});

const mesAnteriorDe = mes => { let [y, m] = mes.split('-').map(Number); m--; if (m < 1) { m = 12; y--; } return `${y}-${String(m).padStart(2, '0')}`; };

exports.bitacoraCierres = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM ctb_cierres_bitacora ORDER BY mes DESC LIMIT 60');
    ok(res, rows.map(r => ({ ...r, kpis: typeof r.kpis === 'string' ? JSON.parse(r.kpis) : r.kpis })));
  } catch (e) { fail(res, e.message); }
};

exports.analizarCierre = async (req, res) => {
  try {
    const mes = req.params.mes;
    if (!/^\d{4}-\d{2}$/.test(mes || '')) return fail(res, 'mes inválido', 400);
    const interno = (fn, query) => new Promise((resolve, reject) => {
      const r2 = { status() { return this; }, json(j) { j.success ? resolve(j.data) : reject(new Error(j.error)); } };
      fn({ query, params: {}, body: {}, user: req.user }, r2).catch(reject);
    });
    const actual = await interno(exports.cierreMes, { mes });
    const anterior = await interno(exports.cierreMes, { mes: mesAnteriorDe(mes) }).catch(() => null);
    // Tendencia: resultado mensual de los últimos 6 meses (excluye cierre de ejercicio)
    const [tend] = await pool.query(
      `SELECT DATE_FORMAT(c.fecha,'%Y-%m') mes,
              SUM(CASE WHEN k.tipo='INGRESO' THEN m.haber-m.debe ELSE 0 END) ingresos,
              SUM(CASE WHEN k.tipo='GASTO' THEN m.debe-m.haber ELSE 0 END) gastos
         FROM ctb_movimientos m
         JOIN ctb_comprobantes c ON c.id=m.id_comprobante
         JOIN ctb_cuentas k ON k.codigo=m.cuenta
        WHERE c.estado='CONTABILIZADO' AND c.origen<>'CIERRE_EJERCICIO' AND k.tipo IN ('INGRESO','GASTO')
          AND c.fecha > DATE_SUB(CONCAT(?, '-01'), INTERVAL 6 MONTH) AND c.fecha <= LAST_DAY(CONCAT(?, '-01'))
        GROUP BY 1 ORDER BY 1`, [mes, mes]);
    const kpis = {
      tc: actual.tipo_cambio?.valor || null,
      activo: actual.balance.tot.activo, pasivo: actual.balance.tot.pasivo,
      patrimonio: actual.balance.tot.patrimonio, resultado_ejercicio: actual.balance.resultado_ejercicio,
      ingresos_mes: actual.eerr_mes.total_ingresos, gastos_mes: actual.eerr_mes.total_gastos,
      resultado_mes: actual.eerr_mes.resultado, resultado_acumulado: actual.eerr_acum.resultado,
      cuadre: actual.balance.cuadre,
    };
    const datos = {
      mes, kpis,
      mes_anterior: anterior && { ingresos: anterior.eerr_mes.total_ingresos, gastos: anterior.eerr_mes.total_gastos, resultado: anterior.eerr_mes.resultado, activo: anterior.balance.tot.activo, patrimonio: anterior.balance.tot.patrimonio },
      tendencia_6m: tend.map(t => ({ mes: t.mes, resultado: Number(t.ingresos) - Number(t.gastos) })),
      top_ingresos: actual.eerr_mes.ingresos.slice().sort((a, b) => b.monto - a.monto).slice(0, 8),
      top_gastos: actual.eerr_mes.gastos.slice().sort((a, b) => b.monto - a.monto).slice(0, 8),
      pasivos_principales: actual.balance.pasivo.slice().sort((a, b) => b.saldo - a.saldo).slice(0, 6),
      activos_principales: actual.balance.activo.slice().sort((a, b) => b.saldo - a.saldo).slice(0, 6),
    };
    const { analizar } = require('../../../../shared/anthropic');
    const out = await analizar({
      codigo: 'ctb_analisis_cierre',
      id_usuario: (req.usuario || req.user || {}).id_usuario || null,
      system: 'Eres el analista financiero senior de AutoFácil Chile (crédito automotriz, matriz en Ecuador). Escribes el análisis del cierre mensual para la bitácora interna: lo lee gerencia y el directorio. Español claro, montos CLP con miles, sin jerga innecesaria. NO inventes cifras: usa solo los datos entregados.',
      prompt: `Datos del cierre (JSON):\n${JSON.stringify(datos)}\n\nEscribe el ANÁLISIS DEL CIERRE de ${mes} con esta estructura (títulos en negrita markdown **así**):\n**Resumen ejecutivo** (2-3 líneas: cómo le fue al mes)\n**Resultados** (resultado del mes vs mes anterior y vs tendencia de 6 meses; qué partidas lo explican)\n**Balance** (posición: activos y pasivos principales, patrimonio y su evolución)\n**Alertas y riesgos** (lo que gerencia debe vigilar: patrimonio negativo, pérdidas sostenidas, concentraciones, descuadres)\n**Recomendaciones** (2-3 acciones concretas)\nMáximo ~350 palabras en total.`,
      max_tokens: 1500,
    });
    if (!out || !out.texto) return fail(res, 'La IA no devolvió análisis', 502);
    await pool.query(
      `INSERT INTO ctb_cierres_bitacora (mes, kpis, analisis, generado_por) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE kpis=VALUES(kpis), analisis=VALUES(analisis), generado_por=VALUES(generado_por)`,
      [mes, JSON.stringify(kpis), out.texto.trim(), nombreDe(req.user)]);
    auditar({ req, accion: 'CREAR', modulo: 'contabilidad', entidad: 'bitacora_cierre', entidad_id: mes, detalle: `Análisis IA del cierre ${mes} generado` });
    ok(res, { mes, kpis, analisis: out.texto.trim() });
  } catch (e) {
    console.error('[ctb analizarCierre]', e.message);
    fail(res, 'No se pudo generar el análisis: ' + e.message, 502);
  }
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
    const candado = await mesConCandado(fecha);
    if (candado) return fail(res, `Diciembre ${anio} está cerrado con candado; reábrelo antes de ejecutar el cierre de ejercicio.`, 423);
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

/* ── Candado de mes cerrado ────────────────────────────────────────────────────
   Un mes reportado a la matriz se cierra con candado: nadie puede digitar ni
   anular comprobantes en él (tampoco el motor de asientos → log MES_CERRADO).
   Reabrir queda auditado. Así el informe enviado nunca queda desactualizado
   en silencio. */
require('../../../../shared/migrate').enFila('contabilidad-candado', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ctb_meses_cerrados (
        mes        VARCHAR(7) PRIMARY KEY,
        cerrado_por VARCHAR(160) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
  } catch (e) { console.error('[contabilidad-candado migration]', e.message); }
});

const mesConCandado = async (fecha) => {
  const mes = String(fecha).slice(0, 7);
  const [[r]] = await pool.query('SELECT mes FROM ctb_meses_cerrados WHERE mes=?', [mes]);
  return r ? mes : null;
};

exports.getMesesCerrados = async (req, res) => {
  try { const [rows] = await pool.query('SELECT * FROM ctb_meses_cerrados ORDER BY mes DESC'); ok(res, rows); }
  catch (e) { fail(res, e.message); }
};

exports.cerrarMesCandado = async (req, res) => {
  try {
    const mes = req.body?.mes;
    if (!/^\d{4}-\d{2}$/.test(mes || '')) return fail(res, 'mes (YYYY-MM) obligatorio', 400);
    await pool.query('INSERT IGNORE INTO ctb_meses_cerrados (mes, cerrado_por) VALUES (?,?)', [mes, nombreDe(req.user)]);
    auditar({ req, accion: 'EDITAR', modulo: 'contabilidad', entidad: 'candado_mes', entidad_id: mes, detalle: `Mes ${mes} CERRADO con candado` });
    ok(res, { mes, cerrado: true });
  } catch (e) { fail(res, e.message); }
};

exports.reabrirMes = async (req, res) => {
  try {
    const mes = req.params.mes;
    const [r] = await pool.query('DELETE FROM ctb_meses_cerrados WHERE mes=?', [mes]);
    if (!r.affectedRows) return fail(res, 'El mes no estaba cerrado', 404);
    auditar({ req, accion: 'EDITAR', modulo: 'contabilidad', entidad: 'candado_mes', entidad_id: mes, detalle: `Mes ${mes} REABIERTO` });
    ok(res, { mes, cerrado: false });
  } catch (e) { fail(res, e.message); }
};

/* ── Guardián contable ─────────────────────────────────────────────────────────
   Reglas de coherencia que revisan cada comprobante ANTES de contabilizar,
   para que un error conceptual no entre a los libros. Dos familias:
   · COMBINACION: pares de cuentas (por prefijo) que no deben ir juntas en un
     mismo asiento (ej. provisión contra banco). 100% paramétricas.
   · SISTEMA: chequeos con lógica propia (monto atípico, saldo de naturaleza
     contraria, glosa pobre) que se activan/desactivan desde el mantenedor.
   Severidad: BLOQUEA (no deja grabar) o ADVIERTE (pide confirmación). */
require('../../../../shared/migrate').enFila('contabilidad-guardian', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ctb_guardian_reglas (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        codigo     VARCHAR(40) NULL,               -- solo reglas SISTEMA (lógica en código)
        nombre     VARCHAR(150) NOT NULL,
        tipo       VARCHAR(15) NOT NULL DEFAULT 'COMBINACION',  -- COMBINACION / SISTEMA
        cuentas_a  VARCHAR(300) NULL,              -- prefijos separados por coma
        cuentas_b  VARCHAR(300) NULL,
        severidad  VARCHAR(10) NOT NULL DEFAULT 'ADVIERTE',     -- BLOQUEA / ADVIERTE
        mensaje    VARCHAR(400) NOT NULL,
        activo     TINYINT NOT NULL DEFAULT 1,
        UNIQUE KEY uq_codigo (codigo)
      )`);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM ctb_guardian_reglas');
    if (!n) {
      const S = [ // [codigo, nombre, tipo, a, b, severidad, mensaje]
        [null, 'Provisión contra banco o caja', 'COMBINACION', '2106,1104050', '1101', 'ADVIERTE',
         'Una provisión se constituye contra una cuenta de GASTO (o se libera contra la que la originó), no contra el banco. Si estás pagando algo, la contrapartida del banco debiera ser la deuda o el gasto real.'],
        [null, 'Provisión contra compras/gastos de oficina', 'COMBINACION', '2106,1104050', '4002060,4002070', 'ADVIERTE',
         'Estás moviendo una provisión contra compras/gastos de oficina. Las provisiones se constituyen contra su gasto específico (ej. estimación incobrables contra 4001190). Revisa que no sea un error de cuenta.'],
        [null, 'Ingreso neteado contra gasto', 'COMBINACION', '3', '4', 'ADVIERTE',
         'Este asiento mueve un INGRESO directamente contra un GASTO. Salvo reclasificaciones deliberadas, ingresos y gastos se registran por separado (cada uno contra su contraparte de balance) para no distorsionar el EERR.'],
        ['GLOSA_POBRE', 'Glosa vacía o demasiado corta', 'SISTEMA', null, null, 'ADVIERTE',
         'La glosa es muy corta. En 6 meses nadie va a recordar qué fue este asiento: describe qué se pagó/recibió y a quién.'],
        ['MONTO_ATIPICO', 'Monto fuera de lo habitual para la cuenta', 'SISTEMA', null, null, 'ADVIERTE',
         'El monto es más de 10 veces el movimiento promedio de esta cuenta en los últimos 12 meses. Verifica que no tenga un cero de más.'],
        ['NATURALEZA_CONTRARIA', 'La cuenta quedaría con saldo contrario a su naturaleza', 'SISTEMA', null, null, 'ADVIERTE',
         'Con este asiento la cuenta queda con saldo contrario a su naturaleza (ej. un activo con saldo acreedor). Puede ser legítimo (sobregiro, anticipo) pero revísalo.'],
      ];
      for (const s of S) await pool.query(
        'INSERT IGNORE INTO ctb_guardian_reglas (codigo,nombre,tipo,cuentas_a,cuentas_b,severidad,mensaje) VALUES (?,?,?,?,?,?,?)', s);
    }
    // Funcionalidad + card del mantenedor
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='ctb_guardian' LIMIT 1");
    let idf = ex?.id_funcionalidad;
    if (!idf) {
      const [r] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (500003,'Guardián Contable','ctb_guardian','/contabilidad/guardian/','bi-shield-check')");
      idf = r.insertId;
    }
    for (const idp of [1, 90003, 90007, 90009])
      await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
    console.log('[contabilidad] guardián listo');
  } catch (e) { console.error('[contabilidad-guardian migration]', e.message); }
});

const prefMatch = (cuenta, lista) => String(lista || '').split(',').map(s => s.trim()).filter(Boolean).some(p => String(cuenta).startsWith(p));

/* Evalúa todas las reglas activas sobre un comprobante propuesto.
   Devuelve { bloqueos: [msg], advertencias: [msg] }. Nunca lanza. */
async function evaluarGuardian({ glosa, movimientos }) {
  const out = { bloqueos: [], advertencias: [] };
  const push = (regla, msg) => out[regla.severidad === 'BLOQUEA' ? 'bloqueos' : 'advertencias'].push(msg);
  try {
    const [reglas] = await pool.query('SELECT * FROM ctb_guardian_reglas WHERE activo=1');
    const cuentas = movimientos.map(m => String(m.cuenta));
    for (const r of reglas) {
      if (r.tipo === 'COMBINACION') {
        const hitA = cuentas.filter(c => prefMatch(c, r.cuentas_a));
        const hitB = cuentas.filter(c => prefMatch(c, r.cuentas_b));
        if (hitA.length && hitB.length && hitA.some(a => hitB.some(b => a !== b)))
          push(r, `${r.nombre} (${[...new Set([...hitA, ...hitB])].join(' + ')}): ${r.mensaje}`);
        continue;
      }
      if (r.codigo === 'GLOSA_POBRE') {
        if (String(glosa || '').trim().length < 8) push(r, r.mensaje);
        continue;
      }
      if (r.codigo === 'MONTO_ATIPICO') {
        const unicas = [...new Set(cuentas)];
        const [hist] = await pool.query(
          `SELECT m.cuenta, AVG(GREATEST(m.debe, m.haber)) prom, COUNT(*) n
             FROM ctb_movimientos m JOIN ctb_comprobantes c ON c.id=m.id_comprobante
            WHERE c.estado='CONTABILIZADO' AND m.cuenta IN (?) AND c.fecha >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
            GROUP BY m.cuenta HAVING n >= 5`, [unicas]);
        for (const h of hist) {
          const max = Math.max(...movimientos.filter(m => String(m.cuenta) === h.cuenta)
            .map(m => Math.max(Number(m.debe) || 0, Number(m.haber) || 0)));
          if (max > Number(h.prom) * 10)
            push(r, `Cuenta ${h.cuenta}: monto $${max.toLocaleString('es-CL')} vs promedio histórico $${Math.round(h.prom).toLocaleString('es-CL')}. ${r.mensaje}`);
        }
        continue;
      }
      if (r.codigo === 'NATURALEZA_CONTRARIA') {
        const unicas = [...new Set(cuentas)];
        const [saldos] = await pool.query(
          `SELECT m.cuenta, k.tipo, k.nombre, SUM(m.debe)-SUM(m.haber) s
             FROM ctb_movimientos m JOIN ctb_comprobantes c ON c.id=m.id_comprobante
             JOIN ctb_cuentas k ON k.codigo=m.cuenta
            WHERE c.estado='CONTABILIZADO' AND m.cuenta IN (?) GROUP BY m.cuenta, k.tipo, k.nombre`, [unicas]);
        const mapa = Object.fromEntries(saldos.map(x => [x.cuenta, x]));
        const [tipos] = await pool.query('SELECT codigo, tipo, nombre FROM ctb_cuentas WHERE codigo IN (?)', [unicas]);
        for (const t of tipos) {
          const previo = Number(mapa[t.codigo]?.s || 0);
          const delta = movimientos.filter(m => String(m.cuenta) === t.codigo)
            .reduce((s, m) => s + (Number(m.debe) || 0) - (Number(m.haber) || 0), 0);
          const final = previo + delta;
          const deudora = ['ACTIVO', 'GASTO'].includes(t.tipo);
          if ((deudora && final < 0) || (!deudora && final > 0))
            push(r, `Cuenta ${t.codigo} ${t.nombre} (${t.tipo}) quedaría con saldo ${final < 0 ? 'acreedor' : 'deudor'} de $${Math.abs(final).toLocaleString('es-CL')}. ${r.mensaje}`);
        }
      }
    }
  } catch (e) { console.error('[ctb guardian]', e.message); }
  return out;
}

exports.getGuardianReglas = async (req, res) => {
  try { const [rows] = await pool.query('SELECT * FROM ctb_guardian_reglas ORDER BY tipo, id'); ok(res, rows); }
  catch (e) { fail(res, e.message); }
};

exports.crearGuardianRegla = async (req, res) => {
  try {
    const { nombre, cuentas_a, cuentas_b, severidad, mensaje } = req.body || {};
    if (!nombre || !cuentas_a || !cuentas_b || !mensaje) return fail(res, 'nombre, cuentas_a, cuentas_b y mensaje son obligatorios', 400);
    if (!['BLOQUEA', 'ADVIERTE'].includes(severidad)) return fail(res, 'Severidad inválida', 400);
    const [r] = await pool.query(
      "INSERT INTO ctb_guardian_reglas (nombre, tipo, cuentas_a, cuentas_b, severidad, mensaje) VALUES (?,'COMBINACION',?,?,?,?)",
      [String(nombre).trim().slice(0, 150), String(cuentas_a).trim(), String(cuentas_b).trim(), severidad, String(mensaje).trim().slice(0, 400)]);
    auditar({ req, accion: 'CREAR', modulo: 'contabilidad', entidad: 'guardian_regla', entidad_id: r.insertId, detalle: `Regla "${nombre}" (${severidad})` });
    ok(res, { id: r.insertId });
  } catch (e) { fail(res, e.message); }
};

exports.editarGuardianRegla = async (req, res) => {
  try {
    const { nombre, cuentas_a, cuentas_b, severidad, mensaje, activo } = req.body || {};
    const [[regla]] = await pool.query('SELECT * FROM ctb_guardian_reglas WHERE id=?', [req.params.id]);
    if (!regla) return fail(res, 'No existe', 404);
    const sets = [], vals = [];
    if (nombre !== undefined) { sets.push('nombre=?'); vals.push(String(nombre).trim().slice(0, 150)); }
    if (mensaje !== undefined) { sets.push('mensaje=?'); vals.push(String(mensaje).trim().slice(0, 400)); }
    if (severidad !== undefined) {
      if (!['BLOQUEA', 'ADVIERTE'].includes(severidad)) return fail(res, 'Severidad inválida', 400);
      sets.push('severidad=?'); vals.push(severidad);
    }
    if (activo !== undefined) { sets.push('activo=?'); vals.push(activo ? 1 : 0); }
    if (regla.tipo === 'COMBINACION') { // las SISTEMA no cambian sus cuentas (lógica en código)
      if (cuentas_a !== undefined) { sets.push('cuentas_a=?'); vals.push(String(cuentas_a).trim()); }
      if (cuentas_b !== undefined) { sets.push('cuentas_b=?'); vals.push(String(cuentas_b).trim()); }
    }
    if (!sets.length) return fail(res, 'Nada que actualizar', 400);
    vals.push(req.params.id);
    await pool.query(`UPDATE ctb_guardian_reglas SET ${sets.join(', ')} WHERE id=?`, vals);
    auditar({ req, accion: 'EDITAR', modulo: 'contabilidad', entidad: 'guardian_regla', entidad_id: req.params.id, detalle: JSON.stringify(req.body) });
    ok(res, { id: Number(req.params.id) });
  } catch (e) { fail(res, e.message); }
};

exports.eliminarGuardianRegla = async (req, res) => {
  try {
    const [r] = await pool.query("DELETE FROM ctb_guardian_reglas WHERE id=? AND tipo='COMBINACION'", [req.params.id]);
    if (!r.affectedRows) return fail(res, 'No existe (las reglas de sistema se desactivan, no se eliminan)', 404);
    auditar({ req, accion: 'ELIMINAR', modulo: 'contabilidad', entidad: 'guardian_regla', entidad_id: req.params.id, detalle: 'Regla eliminada' });
    ok(res, { id: Number(req.params.id) });
  } catch (e) { fail(res, e.message); }
};

/* ── Plantillas de asientos ────────────────────────────────────────────────────
   Asientos recurrentes (arriendo, honorarios, provisiones…) guardados como
   plantilla: cuentas + lados fijos, montos se digitan al aplicarla. */
require('../../../../shared/migrate').enFila('contabilidad-plantillas', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ctb_plantillas (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        nombre     VARCHAR(120) NOT NULL,
        tipo       VARCHAR(10) NOT NULL DEFAULT 'TRASPASO',
        lineas     JSON NOT NULL,                -- [{cuenta, glosa, lado DEBE/HABER}]
        creado_por VARCHAR(160) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_nombre (nombre)
      )`);
  } catch (e) { console.error('[contabilidad-plantillas migration]', e.message); }
});

exports.getPlantillas = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM ctb_plantillas ORDER BY nombre');
    ok(res, rows.map(r => ({ ...r, lineas: typeof r.lineas === 'string' ? JSON.parse(r.lineas) : r.lineas })));
  } catch (e) { fail(res, e.message); }
};

exports.crearPlantilla = async (req, res) => {
  try {
    const { nombre, tipo, lineas } = req.body || {};
    if (!nombre || !String(nombre).trim()) return fail(res, 'Nombre obligatorio', 400);
    if (!['INGRESO', 'EGRESO', 'TRASPASO'].includes(tipo)) return fail(res, 'Tipo inválido', 400);
    if (!Array.isArray(lineas) || lineas.length < 2) return fail(res, 'Mínimo 2 líneas', 400);
    for (const l of lineas) {
      if (!l.cuenta || !['DEBE', 'HABER'].includes(l.lado)) return fail(res, 'Cada línea necesita cuenta y lado', 400);
      const [[c]] = await pool.query('SELECT imputable, activo FROM ctb_cuentas WHERE codigo=?', [l.cuenta]);
      if (!c || !c.imputable || !c.activo) return fail(res, `Cuenta ${l.cuenta} no existe o no es imputable`, 400);
    }
    const limpio = lineas.map(l => ({ cuenta: l.cuenta, lado: l.lado, glosa: (l.glosa || '').slice(0, 200) || null }));
    await pool.query(
      `INSERT INTO ctb_plantillas (nombre, tipo, lineas, creado_por) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE tipo=VALUES(tipo), lineas=VALUES(lineas), creado_por=VALUES(creado_por)`,
      [String(nombre).trim().slice(0, 120), tipo, JSON.stringify(limpio), nombreDe(req.user)]);
    auditar({ req, accion: 'CREAR', modulo: 'contabilidad', entidad: 'plantilla', entidad_id: nombre, detalle: `Plantilla "${nombre}" (${tipo}, ${lineas.length} líneas)` });
    ok(res, { nombre });
  } catch (e) { fail(res, e.message); }
};

exports.eliminarPlantilla = async (req, res) => {
  try {
    const [r] = await pool.query('DELETE FROM ctb_plantillas WHERE id=?', [req.params.id]);
    if (!r.affectedRows) return fail(res, 'No existe', 404);
    auditar({ req, accion: 'ELIMINAR', modulo: 'contabilidad', entidad: 'plantilla', entidad_id: req.params.id, detalle: 'Plantilla eliminada' });
    ok(res, { id: Number(req.params.id) });
  } catch (e) { fail(res, e.message); }
};

/* ── Asistente IA de asientos ──────────────────────────────────────────────────
   El usuario describe en lenguaje natural lo que pasó ("pagamos $450.000 de la
   factura 830 de JFR por el Santander") y la IA propone el asiento completo
   usando el plan de cuentas real + asientos históricos similares como contexto.
   NUNCA graba: solo llena la grilla para que el usuario revise y contabilice
   (y ahí igual pasa por el Guardián). */
require('../../../../shared/migrate').enFila('contabilidad-asistente', async () => {
  try {
    await require('../../../../shared/ia').registrarFuncionalidad({
      codigo: 'ctb_asistente_asiento',
      nombre: 'Asistente de Asientos Contables',
      descripcion: 'Propone el asiento contable completo (cuentas, debe/haber, glosa) a partir de una descripción en lenguaje natural, usando el plan de cuentas y asientos históricos similares. Nunca contabiliza solo: el usuario siempre revisa y graba.',
    });
  } catch (e) { console.error('[contabilidad-asistente migration]', e.message); }
});

exports.asistenteAsiento = async (req, res) => {
  try {
    const texto = String(req.body?.texto || '').trim();
    if (texto.length < 10) return fail(res, 'Describe la operación con más detalle (mínimo 10 caracteres)', 400);

    const [cuentas] = await pool.query("SELECT codigo, nombre, tipo FROM ctb_cuentas WHERE imputable=1 AND activo=1 ORDER BY codigo");
    // Asientos históricos similares: palabras significativas de la descripción contra las glosas
    const palabras = [...new Set(texto.toUpperCase().replace(/[^A-ZÁÉÍÓÚÑ0-9 ]/g, ' ').split(/\s+/)
      .filter(w => w.length >= 4 && !/^\d+$/.test(w)))].slice(0, 6);
    let ejemplos = [];
    if (palabras.length) {
      const like = palabras.map(() => 'c.glosa LIKE ?').join(' OR ');
      const [comps] = await pool.query(
        `SELECT c.id, c.tipo, c.glosa FROM ctb_comprobantes c
          WHERE c.estado='CONTABILIZADO' AND (${like}) ORDER BY c.fecha DESC LIMIT 5`,
        palabras.map(w => `%${w}%`));
      if (comps.length) {
        const [movs] = await pool.query(
          'SELECT id_comprobante, cuenta, debe, haber FROM ctb_movimientos WHERE id_comprobante IN (?)',
          [comps.map(c => c.id)]);
        ejemplos = comps.map(c => ({ tipo: c.tipo, glosa: c.glosa,
          lineas: movs.filter(m => m.id_comprobante === c.id).map(m => ({ cuenta: m.cuenta, debe: Number(m.debe), haber: Number(m.haber) })) }));
      }
    }
    const { analizar } = require('../../../../shared/anthropic');
    const out = await analizar({
      codigo: 'ctb_asistente_asiento',
      id_usuario: (req.usuario || req.user || {}).id_usuario || null,
      json: true,
      system: 'Eres el contador senior de AutoFácil Chile (crédito automotriz). Propones asientos contables de partida doble usando SOLO cuentas del plan entregado. Respondes SOLO un JSON válido, sin texto adicional.',
      prompt: `PLAN DE CUENTAS (imputables): ${JSON.stringify(cuentas)}\n\nASIENTOS HISTÓRICOS SIMILARES (referencia de cómo se contabiliza aquí): ${JSON.stringify(ejemplos)}\n\nOPERACIÓN DESCRITA POR EL USUARIO: "${texto}"\n\nPropón el asiento. Responde SOLO este JSON:\n{"tipo":"INGRESO|EGRESO|TRASPASO","glosa":"glosa clara del comprobante","movimientos":[{"cuenta":"código del plan","glosa":"detalle línea o null","debe":numero,"haber":numero}],"explicacion":"1-2 frases de por qué estas cuentas"}\nReglas: suma debe = suma haber; cada línea lleva debe O haber (no ambos); usa los montos que el usuario indicó (pesos chilenos, sin decimales); si el usuario no dio monto usa 0 y explica; EGRESO = sale plata del banco/caja, INGRESO = entra, TRASPASO = no toca caja.`,
      max_tokens: 1500,
    });
    const prop = out?.datos;
    if (!prop || !Array.isArray(prop.movimientos) || prop.movimientos.length < 2)
      return fail(res, 'La IA no devolvió un asiento válido; intenta describir la operación de otra forma', 502);
    // Validar cuentas propuestas contra el plan (la IA no inventa códigos)
    const validas = new Set(cuentas.map(c => c.codigo));
    for (const m of prop.movimientos)
      if (!validas.has(String(m.cuenta))) return fail(res, `La IA propuso la cuenta ${m.cuenta}, que no existe en el plan; reintenta`, 502);
    auditar({ req, accion: 'CONSULTAR', modulo: 'contabilidad', entidad: 'asistente_asiento', entidad_id: null, detalle: texto.slice(0, 200) });
    ok(res, prop);
  } catch (e) {
    console.error('[ctb asistente]', e.message);
    fail(res, 'Asistente no disponible: ' + e.message, 502);
  }
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
