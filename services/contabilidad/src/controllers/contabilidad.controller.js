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

/* ── Punto de Restauración (Contabilidad) ──────────────────────────────────────
   Marca de agua antes de algo arriesgado (importar un libro, digitación masiva,
   probar reglas): guarda el MAX(id) de comprobantes y del log del motor.
   Restaurar borra TODO lo contabilizado después de la marca (comprobantes +
   movimientos + adjuntos + log). NO toca plan de cuentas, reglas, plantillas,
   guardián ni candados — solo asientos. Nivel Dios y auditado. */
const PR_KEY = 'punto_restauracion';

exports.prEstado = async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT valor FROM ctb_config WHERE clave=?', [PR_KEY]).catch(() => [[null]]);
    const punto = row ? JSON.parse(row.valor) : null;
    let pendientes = null;
    if (punto) {
      const [[c]] = await pool.query('SELECT COUNT(*) n, COALESCE(SUM(total),0) monto FROM ctb_comprobantes WHERE id > ?', [punto.max_comprobante]);
      pendientes = { comprobantes: Number(c.n), monto: Number(c.monto) };
    }
    ok(res, { punto, pendientes });
  } catch (e) { fail(res, e.message); }
};

exports.prCrear = async (req, res) => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS ctb_config (clave VARCHAR(60) PRIMARY KEY, valor VARCHAR(200) NOT NULL)`);
    const [[c]] = await pool.query('SELECT COALESCE(MAX(id),0) mx FROM ctb_comprobantes');
    const [[l]] = await pool.query('SELECT COALESCE(MAX(id),0) mx FROM ctb_eventos_log');
    const punto = { max_comprobante: Number(c.mx), max_log: Number(l.mx), creado_at: new Date().toISOString(), creado_por: nombreDe(req.user) };
    await pool.query('INSERT INTO ctb_config (clave, valor) VALUES (?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)', [PR_KEY, JSON.stringify(punto)]);
    auditar({ req, accion: 'CREAR', modulo: 'contabilidad', entidad: 'punto_restauracion', entidad_id: null, detalle: 'Punto creado: ' + JSON.stringify(punto) });
    ok(res, punto);
  } catch (e) { fail(res, e.message); }
};

exports.prRestaurar = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const [[row]] = await pool.query('SELECT valor FROM ctb_config WHERE clave=?', [PR_KEY]);
    if (!row) return fail(res, 'No hay punto de restauración creado', 400);
    if (String(req.body?.confirmar) !== 'RESTAURAR') return fail(res, 'Falta la confirmación (escribe RESTAURAR)', 400);
    const punto = JSON.parse(row.valor);
    const marca = Number(punto.max_comprobante) || 0;
    await conn.beginTransaction();
    const [movs] = await conn.query('DELETE FROM ctb_movimientos WHERE id_comprobante > ?', [marca]);
    const [adjs] = await conn.query('DELETE FROM ctb_adjuntos WHERE id_comprobante > ?', [marca]);
    const [comps] = await conn.query('DELETE FROM ctb_comprobantes WHERE id > ?', [marca]);
    const [logs] = await conn.query('DELETE FROM ctb_eventos_log WHERE id > ?', [Number(punto.max_log) || 0]);
    await conn.commit();
    const borrado = { comprobantes: comps.affectedRows, movimientos: movs.affectedRows, adjuntos: adjs.affectedRows, eventos_log: logs.affectedRows };
    auditar({ req, accion: 'ELIMINAR', modulo: 'contabilidad', entidad: 'punto_restauracion', entidad_id: null,
      detalle: 'RESTAURACIÓN CONTABLE ejecutada (marca id ' + marca + '): ' + JSON.stringify(borrado) });
    ok(res, { borrado, punto });
  } catch (e) {
    await conn.rollback().catch(() => {});
    fail(res, e.message);
  } finally { conn.release(); }
};

// Card (solo Admin: sin permisos_perfil asignados)
require('../../../../shared/migrate').enFila('contabilidad-punto-restauracion', async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS ctb_config (clave VARCHAR(60) PRIMARY KEY, valor VARCHAR(200) NOT NULL)`);
    await pool.query('ALTER TABLE ctb_config MODIFY valor VARCHAR(500) NOT NULL').catch(() => {});
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='ctb_punto_restauracion' LIMIT 1");
    if (!ex) await pool.query(
      "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (500003, 'Punto de Restauración (Contabilidad)', 'ctb_punto_restauracion', '/contabilidad/punto-restauracion/', 'bi-clock-history')");
  } catch (e) { console.error('[contabilidad-punto-restauracion seed]', e.message); }
});

/* ── Buscador global de movimientos ────────────────────────────────────────────
   "Todos los movimientos de la cuenta X con la palabra NOTARIA": busca en las
   glosas (línea y comprobante), RUT y N° OP, con filtros opcionales de cuenta
   y fechas. Siempre acotado (LIMIT 500). */
exports.buscarMovimientos = async (req, res) => {
  try {
    const { q, cuenta, desde, hasta } = req.query;
    if (!q && !cuenta) return fail(res, 'Indica texto a buscar (q) o una cuenta', 400);
    const w = ["c.estado='CONTABILIZADO'"], vals = [];
    if (q) { w.push('(m.glosa LIKE ? OR c.glosa LIKE ? OR m.rut LIKE ? OR CAST(m.num_op AS CHAR) LIKE ? OR c.origen_ref LIKE ?)');
      const like = `%${q}%`; vals.push(like, like, like, like, like); }
    if (cuenta) { w.push('m.cuenta=?'); vals.push(cuenta); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(desde || '')) { w.push('c.fecha>=?'); vals.push(desde); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(hasta || '')) { w.push('c.fecha<=?'); vals.push(hasta); }
    const [rows] = await pool.query(
      `SELECT c.id, c.tipo, c.anio, c.numero, c.fecha, c.glosa comp_glosa, c.origen,
              m.cuenta, k.nombre cuenta_nombre, m.glosa, m.debe, m.haber, m.num_op, m.rut
         FROM ctb_movimientos m
         JOIN ctb_comprobantes c ON c.id=m.id_comprobante
         LEFT JOIN ctb_cuentas k ON k.codigo=m.cuenta
        WHERE ${w.join(' AND ')} ORDER BY c.fecha DESC, c.id DESC, m.id LIMIT 500`, vals);
    ok(res, rows.map(x => ({ ...x, num: fmtNum(x) })));
  } catch (e) { fail(res, e.message); }
};

/* ── Adjuntos de respaldo (factura PDF, comprobante de transferencia…) ──────── */
require('../../../../shared/migrate').enFila('contabilidad-adjuntos', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ctb_adjuntos (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        id_comprobante INT NOT NULL,
        nombre         VARCHAR(200) NOT NULL,
        mime           VARCHAR(100) NOT NULL,
        tamano         INT NOT NULL DEFAULT 0,
        datos          MEDIUMBLOB NOT NULL,
        subido_por     VARCHAR(160) NULL,
        created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_comp (id_comprobante)
      )`);
  } catch (e) { console.error('[contabilidad-adjuntos migration]', e.message); }
});

const MAX_ADJUNTO = 5 * 1024 * 1024; // 5 MB

exports.listarAdjuntos = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, nombre, mime, tamano, subido_por, created_at FROM ctb_adjuntos WHERE id_comprobante=? ORDER BY id', [req.params.id]);
    ok(res, rows);
  } catch (e) { fail(res, e.message); }
};

exports.subirAdjunto = async (req, res) => {
  try {
    const { nombre, mime, base64 } = req.body || {};
    if (!nombre || !base64) return fail(res, 'nombre y base64 obligatorios', 400);
    const [[comp]] = await pool.query('SELECT id FROM ctb_comprobantes WHERE id=?', [req.params.id]);
    if (!comp) return fail(res, 'Comprobante no existe', 404);
    const buf = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buf.length) return fail(res, 'Archivo vacío', 400);
    if (buf.length > MAX_ADJUNTO) return fail(res, 'Máximo 5 MB por adjunto', 400);
    const [r] = await pool.query(
      'INSERT INTO ctb_adjuntos (id_comprobante, nombre, mime, tamano, datos, subido_por) VALUES (?,?,?,?,?,?)',
      [comp.id, String(nombre).slice(0, 200), String(mime || 'application/octet-stream').slice(0, 100), buf.length, buf, nombreDe(req.user)]);
    auditar({ req, accion: 'CREAR', modulo: 'contabilidad', entidad: 'adjunto', entidad_id: r.insertId, detalle: `${nombre} (${buf.length} bytes) en comprobante ${comp.id}` });
    ok(res, { id: r.insertId });
  } catch (e) { fail(res, e.message); }
};

exports.descargarAdjunto = async (req, res) => {
  try {
    const [[a]] = await pool.query('SELECT * FROM ctb_adjuntos WHERE id=?', [req.params.id]);
    if (!a) return fail(res, 'No existe', 404);
    res.setHeader('Content-Type', a.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(a.nombre)}"`);
    res.send(a.datos);
  } catch (e) { fail(res, e.message); }
};

exports.eliminarAdjunto = async (req, res) => {
  try {
    const [[a]] = await pool.query(
      'SELECT a.id, a.nombre, c.fecha FROM ctb_adjuntos a JOIN ctb_comprobantes c ON c.id=a.id_comprobante WHERE a.id=?', [req.params.id]);
    if (!a) return fail(res, 'No existe', 404);
    const candado = await mesConCandado(a.fecha.toISOString ? a.fecha.toISOString().slice(0, 10) : a.fecha);
    if (candado) return fail(res, `El comprobante es del mes ${candado} (cerrado con candado); no se pueden quitar respaldos`, 423);
    await pool.query('DELETE FROM ctb_adjuntos WHERE id=?', [req.params.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'contabilidad', entidad: 'adjunto', entidad_id: req.params.id, detalle: `Adjunto ${a.nombre} eliminado` });
    ok(res, { id: Number(req.params.id) });
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

/* ── Presentación Directorio ───────────────────────────────────────────────────
   Réplica viva del PPT mensual de finanzas para el directorio: balance con
   variación contra el mes anterior, detalle CxC/CxP, EERR del mes y acumulado
   comparados contra el mismo período del año anterior, movimiento de caja y
   "Hechos Relevantes" editables por lámina (con borrador IA). Los números
   salen SOLOS de los libros — se acabó pegar tablas de Excel como imagen. */
require('../../../../shared/migrate').enFila('contabilidad-directorio', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ctb_dir_hechos (
        mes        VARCHAR(7) NOT NULL,
        seccion    VARCHAR(30) NOT NULL,      -- BALANCE / CXC / CXP / EERR_MES / EERR_ACUM / CAJA
        texto      TEXT NOT NULL,
        actualizado_por VARCHAR(160) NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (mes, seccion)
      )`);
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='ctb_directorio' LIMIT 1");
    let idf = ex?.id_funcionalidad;
    if (!idf) {
      const [r] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (500003,'Presentación Directorio','ctb_directorio','/contabilidad/directorio/','bi-easel2')");
      idf = r.insertId;
    }
    for (const idp of [1, 90003, 90007, 90009])
      await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
    await require('../../../../shared/ia').registrarFuncionalidad({
      codigo: 'ctb_directorio_ia',
      nombre: 'Hechos Relevantes Directorio',
      descripcion: 'Borrador de los "Hechos Relevantes" de cada lámina de la Presentación Directorio (balance, CxC/CxP, resultados, caja) a partir de las cifras del mes. El usuario siempre revisa y guarda.',
    });
    console.log('[contabilidad] presentación directorio lista');
  } catch (e) { console.error('[contabilidad-directorio migration]', e.message); }
});

const finDeMes = mes => { const [y, m] = mes.split('-').map(Number); return `${y}-${String(m).padStart(2, '0')}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };

/* ── Rubros de presentación (mapeo cuenta→rubro, 100% paramétrico) ─────────────
   Los cuadros del directorio agrupan las cuentas en rubros gerenciales (como
   los Excel de finanzas): el balance por grupos con columnas mensuales y el
   P&G con márgenes acumulativos. La asignación es por PREFIJO de cuenta, gana
   el primer rubro (por orden); lo no asignado cae a "Otros". Se configura
   desde la propia página (botón Configurar rubros). */
require('../../../../shared/migrate').enFila('contabilidad-dir-rubros', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ctb_dir_rubros (
        id       INT AUTO_INCREMENT PRIMARY KEY,
        cuadro   VARCHAR(10) NOT NULL,          -- BALANCE / EERR
        grupo    VARCHAR(80) NULL,              -- BALANCE: Activo Corriente, Pasivo Corriente…
        etiqueta VARCHAR(120) NOT NULL,         -- nombre de la fila en el cuadro
        clase    VARCHAR(10) NOT NULL DEFAULT 'RUBRO',  -- RUBRO / MARGEN (EERR: fila azul calculada)
        tipo     VARCHAR(10) NULL,              -- EERR: INGRESO / GASTO
        prefijos TEXT NULL,                     -- prefijos de cuenta separados por coma
        orden    INT NOT NULL DEFAULT 0,
        activo   TINYINT NOT NULL DEFAULT 1
      )`);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM ctb_dir_rubros');
    if (!n) {
      const B = [ // [grupo, etiqueta, prefijos]
        ['Activo Corriente', 'Efectivo y equivalentes', '1101'],
        ['Activo Corriente', 'Inversiones', '1102,1103'],
        ['Activo Corriente', 'Cuentas por cobrar Cartera', '110401,110402,110403,110406'],
        ['Activo Corriente', '(-) Provisión cartera', '110405'],
        ['Activo Corriente', 'Otras cuentas por cobrar', '1105,1106,1107,1108,1109'],
        ['Activo no Corriente', 'Activo fijo', '12'],
        ['Activo no Corriente', 'Otros activos no corrientes', '13,14,15,16,17,18,19'],
        ['Pasivo Corriente', 'Cuentas por pagar Proveedores', '210202,210206'],
        ['Pasivo Corriente', 'Cuentas por pagar Concesionarios', '2102024,2102025,2106012'],
        ['Pasivo Corriente', 'Remuneraciones y previsión', '2104,2105,221090'],
        ['Pasivo Corriente', 'Impuestos por pagar', '2103'],
        ['Pasivo Corriente', 'Provisiones', '2106'],
        ['Pasivo Corriente', 'Otras cuentas por pagar', '21'],
        ['Pasivo no Corriente', 'Préstamos relacionados y LP', '22'],
        ['Patrimonio', 'Capital', '2701'],
        ['Patrimonio', 'Resultados acumulados', '2702,2703'],
      ];
      let o = 0;
      for (const [g, e, p] of B)
        await pool.query("INSERT INTO ctb_dir_rubros (cuadro, grupo, etiqueta, clase, prefijos, orden) VALUES ('BALANCE',?,?,'RUBRO',?,?)", [g, e, p, ++o]);
      const E = [ // [etiqueta, clase, tipo, prefijos]
        ['Ingresos Financieros', 'RUBRO', 'INGRESO', '3001010,3001040,3001090,3001120,3001150'],
        ['Egresos Financieros', 'RUBRO', 'GASTO', '4201010,4201030,4001020,4001030,4001040,4301050'],
        ['Provisiones', 'RUBRO', 'GASTO', '4001190'],
        ['Margen Ordinario', 'MARGEN', null, null],
        ['Ingresos Operativos', 'RUBRO', 'INGRESO', '3001020,3001072,3001073,3001075,3001087,3001170'],
        ['Egresos Operativos', 'RUBRO', 'GASTO', '4001050,4001100,4001110,4001127,4001128,4001150,4001152,4001162,4001171,4001172,4001180'],
        ['Margen Operativo Bruto', 'MARGEN', null, null],
        ['Gastos de Personal', 'RUBRO', 'GASTO', '400106,400107,400108,400109,4002030,4002050,4002060,4002120,4002302'],
        ['Gastos de Operación', 'RUBRO', 'GASTO', '4002'],
        ['Margen Operativo Neto', 'MARGEN', null, null],
        ['Gastos No Operacionales', 'RUBRO', 'GASTO', '4003,4201,4401'],
        ['Ingresos No Operacionales', 'RUBRO', 'INGRESO', '3001151,3001200,3'],
        ['Utilidad Antes de Impuestos', 'MARGEN', null, null],
      ];
      o = 0;
      for (const [e, c, t, p] of E)
        await pool.query("INSERT INTO ctb_dir_rubros (cuadro, etiqueta, clase, tipo, prefijos, orden) VALUES ('EERR',?,?,?,?,?)", [e, c, t, p, ++o]);
    }
    console.log('[contabilidad] rubros directorio listos');
  } catch (e) { console.error('[contabilidad-dir-rubros migration]', e.message); }
});

const asignaRubro = (cuenta, rubros) => rubros.find(r =>
  r.clase === 'RUBRO' && String(r.prefijos || '').split(',').map(s => s.trim()).filter(Boolean).some(p => String(cuenta).startsWith(p))) || null;

/* Cuadros estilo Excel del directorio: balance por rubros con columnas mensuales
   (dic año anterior + ene→mes) y P&G comparativo (acumulado y del mes) con
   márgenes acumulativos. */
exports.directorioCuadros = async (req, res) => {
  try {
    const mes = req.query.mes;
    if (!/^\d{4}-\d{2}$/.test(mes || '')) return fail(res, 'mes (YYYY-MM) obligatorio', 400);
    const [y, m] = mes.split('-').map(Number);
    const [rubros] = await pool.query('SELECT * FROM ctb_dir_rubros WHERE activo=1 ORDER BY orden, id');
    const rB = rubros.filter(r => r.cuadro === 'BALANCE'), rE = rubros.filter(r => r.cuadro === 'EERR');

    // ── BALANCE: saldo por cuenta al cierre de dic-(y-1) y de cada mes ene..m
    const cortes = [`${y - 1}-12-31`];
    const etiquetasCol = [`DIC.${String(y - 1).slice(2)}`];
    const MESL = ['', 'ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
    for (let k = 1; k <= m; k++) { cortes.push(finDeMes(`${y}-${String(k).padStart(2, '0')}`)); etiquetasCol.push(MESL[k]); }
    const colsSQL = cortes.map((f, i) => `SUM(CASE WHEN c.fecha <= '${f}' THEN m.debe - m.haber ELSE 0 END) c${i}`).join(', ');
    const [salBal] = await pool.query(
      `SELECT m.cuenta, k.tipo, ${colsSQL}
         FROM ctb_movimientos m JOIN ctb_comprobantes c ON c.id=m.id_comprobante
         JOIN ctb_cuentas k ON k.codigo=m.cuenta
        WHERE c.estado='CONTABILIZADO' AND c.fecha <= ? AND k.tipo IN ('ACTIVO','PASIVO','PATRIMONIO')
        GROUP BY m.cuenta, k.tipo`, [cortes[cortes.length - 1]]);
    const nCols = cortes.length;
    const filaB = new Map(); // etiqueta rubro → valores[]
    const otros = { ACTIVO: Array(nCols).fill(0), PASIVO: Array(nCols).fill(0), PATRIMONIO: Array(nCols).fill(0) };
    for (const x of salBal) {
      const signo = x.tipo === 'ACTIVO' ? 1 : -1; // pasivo/patrimonio se muestran acreedor +
      const ru = asignaRubro(x.cuenta, rB);
      const destino = ru ? (filaB.get(ru.id) || filaB.set(ru.id, Array(nCols).fill(0)).get(ru.id)) : otros[x.tipo];
      for (let i = 0; i < nCols; i++) destino[i] += signo * Number(x[`c${i}`]);
    }
    const GRUPO_TIPO = g => /^Activo/.test(g) ? 'ACTIVO' : (/^Patrimonio/.test(g) ? 'PATRIMONIO' : 'PASIVO');
    const balance = { columnas: etiquetasCol, grupos: [] };
    const gruposOrden = [...new Set(rB.map(r => r.grupo))];
    for (const g of gruposOrden) {
      const filas = rB.filter(r => r.grupo === g).map(r => ({ etiqueta: r.etiqueta, valores: filaB.get(r.id) || Array(nCols).fill(0) }));
      // "Otros" sin rubro caen al último grupo de su tipo
      const esUltimoDelTipo = g === gruposOrden.filter(x => GRUPO_TIPO(x) === GRUPO_TIPO(g)).pop();
      if (esUltimoDelTipo && otros[GRUPO_TIPO(g)].some(v => Math.abs(v) > 0.5))
        filas.push({ etiqueta: 'Otros (sin rubro asignado)', valores: otros[GRUPO_TIPO(g)] });
      balance.grupos.push({ grupo: g, tipo: GRUPO_TIPO(g), filas, subtotal: filas.reduce((acc, f) => acc.map((v, i) => v + f.valores[i]), Array(nCols).fill(0)) });
    }

    // ── EERR por cuenta: acumulado y mes, año actual y anterior
    const finMes = finDeMes(mes), iniAnio = `${y}-01-01`, iniMes = `${mes}-01`;
    const mesAA = `${y - 1}-${String(m).padStart(2, '0')}`;
    const finAA = finDeMes(mesAA), iniAnioAA = `${y - 1}-01-01`, iniAA = `${mesAA}-01`;
    const [salE] = await pool.query(
      `SELECT m.cuenta, k.tipo,
              SUM(CASE WHEN c.fecha BETWEEN ? AND ? THEN (CASE WHEN k.tipo='INGRESO' THEN m.haber-m.debe ELSE m.debe-m.haber END) ELSE 0 END) acum,
              SUM(CASE WHEN c.fecha BETWEEN ? AND ? THEN (CASE WHEN k.tipo='INGRESO' THEN m.haber-m.debe ELSE m.debe-m.haber END) ELSE 0 END) acum_aa,
              SUM(CASE WHEN c.fecha BETWEEN ? AND ? THEN (CASE WHEN k.tipo='INGRESO' THEN m.haber-m.debe ELSE m.debe-m.haber END) ELSE 0 END) mes,
              SUM(CASE WHEN c.fecha BETWEEN ? AND ? THEN (CASE WHEN k.tipo='INGRESO' THEN m.haber-m.debe ELSE m.debe-m.haber END) ELSE 0 END) mes_aa
         FROM ctb_movimientos m JOIN ctb_comprobantes c ON c.id=m.id_comprobante
         JOIN ctb_cuentas k ON k.codigo=m.cuenta
        WHERE c.estado='CONTABILIZADO' AND c.origen<>'CIERRE_EJERCICIO' AND k.tipo IN ('INGRESO','GASTO')
          AND ((c.fecha BETWEEN ? AND ?) OR (c.fecha BETWEEN ? AND ?))
        GROUP BY m.cuenta, k.tipo`,
      [iniAnio, finMes, iniAnioAA, finAA, iniMes, finMes, iniAA, finAA, iniAnio, finMes, iniAnioAA, finAA]);
    const CAMPOS = ['acum', 'acum_aa', 'mes', 'mes_aa'];
    const filaE = new Map();
    const otrosE = { INGRESO: [0, 0, 0, 0], GASTO: [0, 0, 0, 0] };
    for (const x of salE) {
      const ru = asignaRubro(x.cuenta, rE.filter(r => r.tipo === x.tipo));
      const destino = ru ? (filaE.get(ru.id) || filaE.set(ru.id, [0, 0, 0, 0]).get(ru.id)) : otrosE[x.tipo];
      CAMPOS.forEach((c, i) => destino[i] += Number(x[c]));
    }
    const eerr = [];
    const acumulado = [0, 0, 0, 0]; // margen acumulativo (ingresos − gastos)
    for (const r of rE) {
      if (r.clase === 'MARGEN') { eerr.push({ etiqueta: r.etiqueta, clase: 'MARGEN', valores: [...acumulado] }); continue; }
      const v = filaE.get(r.id) || [0, 0, 0, 0];
      eerr.push({ etiqueta: r.etiqueta, clase: 'RUBRO', tipo: r.tipo, valores: v });
      CAMPOS.forEach((c, i) => acumulado[i] += (r.tipo === 'INGRESO' ? v[i] : -v[i]));
    }
    for (const t of ['INGRESO', 'GASTO']) if (otrosE[t].some(v => Math.abs(v) > 0.5)) {
      eerr.push({ etiqueta: `Otros ${t === 'INGRESO' ? 'ingresos' : 'gastos'} (sin rubro)`, clase: 'RUBRO', tipo: t, valores: otrosE[t] });
      CAMPOS.forEach((c, i) => acumulado[i] += (t === 'INGRESO' ? otrosE[t][i] : -otrosE[t][i]));
      const ult = eerr.map(x => x.clase).lastIndexOf('MARGEN');
      if (ult >= 0) eerr[ult].valores = [...acumulado]; // la utilidad final incluye lo sin rubro
    }
    // ── PPTO: presupuesto anual de finanzas por rubro (acumulado ene..m y del mes)
    try {
      const [ppto] = await pool.query('SELECT cuenta, mes, monto FROM ctb_presupuesto WHERE anio=?', [y]);
      const pptoRubro = new Map(); // id rubro → [acum, mes]
      const pptoOtros = { INGRESO: [0, 0], GASTO: [0, 0] };
      for (const p of ppto) {
        if (p.mes > m) continue;
        const tipo = String(p.cuenta).startsWith('3') ? 'INGRESO' : 'GASTO';
        const ru = asignaRubro(p.cuenta, rE.filter(r => r.tipo === tipo));
        const destino = ru ? (pptoRubro.get(ru.id) || pptoRubro.set(ru.id, [0, 0]).get(ru.id)) : pptoOtros[tipo];
        destino[0] += Number(p.monto);
        if (p.mes === m) destino[1] += Number(p.monto);
      }
      const pptoAcum = [0, 0];
      for (const fila of eerr) {
        if (fila.clase === 'MARGEN') { fila.ppto = [...pptoAcum]; continue; }
        const rid = rE.find(r => r.etiqueta === fila.etiqueta && r.clase === 'RUBRO')?.id;
        const v = /sin rubro/.test(fila.etiqueta) ? pptoOtros[fila.tipo] : (rid != null ? pptoRubro.get(rid) : null) || [0, 0];
        fila.ppto = v;
        [0, 1].forEach(i => pptoAcum[i] += (fila.tipo === 'INGRESO' ? v[i] : -v[i]));
      }
      const ultM = eerr.map(x => x.clase).lastIndexOf('MARGEN');
      if (ultM >= 0) eerr[ultM].ppto = [...pptoAcum];
    } catch (_) { /* sin presupuesto cargado: columna queda vacía */ }
    const totIng = f => eerr.filter(x => x.tipo === 'INGRESO').reduce((s, x) => s + x.valores[f], 0);
    ok(res, { mes, balance, eerr, base_pct: { acum: totIng(0), acum_aa: totIng(1), mes: totIng(2), mes_aa: totIng(3) } });
  } catch (e) { fail(res, e.message); }
};

/* ── Presupuesto anual (PPTO del P&G del directorio) ──────────────────────────
   El Excel de finanzas ("Plantilla Presupuestos": id_cuenta + 12 meses) se
   importa desde la Presentación Directorio y llena la columna PPTO del EERR.
   Se guarda NORMALIZADO en sentido natural (ingresos positivos): en el Excel
   los ingresos vienen en negativo (convención al haber). Re-importar un año
   lo reemplaza completo. */
require('../../../../shared/migrate').enFila('contabilidad-presupuesto', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ctb_presupuesto (
        anio   SMALLINT NOT NULL,
        mes    TINYINT NOT NULL,          -- 1..12
        cuenta VARCHAR(20) NOT NULL,
        nombre VARCHAR(160) NULL,
        monto  DECIMAL(14,0) NOT NULL,    -- sentido natural: ingreso +, gasto +
        PRIMARY KEY (anio, mes, cuenta)
      )`);
  } catch (e) { console.error('[contabilidad-presupuesto migration]', e.message); }
});

/* Card Presupuesto Anual: grilla cuenta × 12 meses editable (estilo Excel de
   finanzas), con copia al año siguiente ("continuar el presupuesto"). */
require('../../../../shared/migrate').enFila('contabilidad-presupuesto-card', async () => {
  try {
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='ctb_presupuesto' LIMIT 1");
    let idf = ex?.id_funcionalidad;
    if (!idf) {
      const [r] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (500003,'Presupuesto Anual','ctb_presupuesto','/contabilidad/presupuesto/','bi-calculator')");
      idf = r.insertId;
    }
    for (const idp of [1, 90003, 90007, 90009])
      await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
    console.log('[contabilidad] presupuesto anual listo');
  } catch (e) { console.error('[contabilidad-presupuesto-card migration]', e.message); }
});

exports.getPresupuesto = async (req, res) => {
  try {
    const y = Number(req.query.anio);
    if (!y) return fail(res, 'anio obligatorio', 400);
    const [anios] = await pool.query('SELECT DISTINCT anio FROM ctb_presupuesto ORDER BY anio');
    const [plan] = await pool.query("SELECT codigo, nombre, tipo FROM ctb_cuentas WHERE tipo IN ('INGRESO','GASTO') AND activo=1 ORDER BY codigo");
    const [vals] = await pool.query('SELECT cuenta, nombre, mes, monto FROM ctb_presupuesto WHERE anio=?', [y]);
    const filas = new Map(); // cuenta → fila
    for (const c of plan) filas.set(c.codigo, { cuenta: c.codigo, nombre: c.nombre, tipo: c.tipo, meses: Array(12).fill(0) });
    for (const v of vals) {
      if (!filas.has(v.cuenta)) filas.set(v.cuenta, { cuenta: v.cuenta, nombre: v.nombre || v.cuenta, tipo: String(v.cuenta).startsWith('3') ? 'INGRESO' : 'GASTO', meses: Array(12).fill(0) });
      filas.get(v.cuenta).meses[v.mes - 1] = Number(v.monto);
    }
    ok(res, { anio: y, anios: anios.map(a => a.anio), filas: [...filas.values()].sort((a, b) => a.cuenta.localeCompare(b.cuenta)) });
  } catch (e) { fail(res, e.message); }
};

/* Guarda el año completo desde el editor. A diferencia del import Excel, aquí
   los montos ya vienen en sentido natural (ingresos y gastos positivos). */
exports.guardarPresupuesto = async (req, res) => {
  try {
    const { anio, filas } = req.body || {};
    const y = Number(anio);
    if (!y || y < 2020 || y > 2100) return fail(res, 'anio inválido', 400);
    if (!Array.isArray(filas)) return fail(res, 'filas obligatorias', 400);
    const values = [];
    for (const f of filas) {
      const cuenta = String(f.cuenta || '').trim();
      if (!/^\d{4,}$/.test(cuenta) || !Array.isArray(f.meses)) continue;
      f.meses.forEach((v, i) => {
        const m = Math.round(Number(v) || 0);
        if (m && i < 12) values.push([y, i + 1, cuenta, String(f.nombre || '').slice(0, 160) || null, m]);
      });
    }
    await pool.query('DELETE FROM ctb_presupuesto WHERE anio=?', [y]);
    if (values.length) await pool.query('INSERT INTO ctb_presupuesto (anio, mes, cuenta, nombre, monto) VALUES ?', [values]);
    auditar({ req, accion: 'EDITAR', modulo: 'contabilidad', entidad: 'presupuesto', entidad_id: String(y), detalle: `Presupuesto ${y} guardado (${values.length} celdas)` });
    ok(res, { anio: y, celdas: values.length });
  } catch (e) { fail(res, e.message); }
};

/* "Continuar el presupuesto": copia un año al siguiente con reajuste % opcional. */
exports.copiarPresupuesto = async (req, res) => {
  try {
    const desde = Number(req.body?.desde), hacia = Number(req.body?.hacia), pct = Number(req.body?.reajuste_pct) || 0;
    if (!desde || !hacia || hacia === desde) return fail(res, 'desde/hacia inválidos', 400);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM ctb_presupuesto WHERE anio=?', [hacia]);
    if (n) return fail(res, `El año ${hacia} ya tiene presupuesto (${n} celdas). Bórralo o edítalo directo.`, 409);
    const [r] = await pool.query(
      `INSERT INTO ctb_presupuesto (anio, mes, cuenta, nombre, monto)
       SELECT ?, mes, cuenta, nombre, ROUND(monto * (1 + ?/100)) FROM ctb_presupuesto WHERE anio=?`, [hacia, pct, desde]);
    auditar({ req, accion: 'CREAR', modulo: 'contabilidad', entidad: 'presupuesto', entidad_id: String(hacia), detalle: `Presupuesto ${hacia} creado desde ${desde} (reajuste ${pct}%)` });
    ok(res, { hacia, celdas: r.affectedRows });
  } catch (e) { fail(res, e.message); }
};

exports.importarPresupuesto = async (req, res) => {
  try {
    const { anio, filas } = req.body || {};
    const y = Number(anio);
    if (!y || y < 2020 || y > 2100) return fail(res, 'anio inválido', 400);
    if (!Array.isArray(filas) || !filas.length) return fail(res, 'filas obligatorias', 400);
    const values = [];
    for (const f of filas) {
      const cuenta = String(f.cuenta || '').trim();
      if (!/^\d{4,}$/.test(cuenta) || !Array.isArray(f.meses)) continue;
      const esIngreso = cuenta.startsWith('3');
      f.meses.forEach((v, i) => {
        const raw = Math.round(Number(v) || 0);
        if (!raw || i > 11) return;
        values.push([y, i + 1, cuenta, String(f.nombre || '').slice(0, 160) || null, esIngreso ? -raw : raw]);
      });
    }
    if (!values.length) return fail(res, 'El archivo no trae montos (revisa la hoja "Plantilla Presupuestos")', 400);
    await pool.query('DELETE FROM ctb_presupuesto WHERE anio=?', [y]);
    await pool.query('INSERT INTO ctb_presupuesto (anio, mes, cuenta, nombre, monto) VALUES ?', [values]);
    const cuentas = new Set(values.map(v => v[2]));
    ok(res, { anio: y, cuentas: cuentas.size, celdas: values.length });
  } catch (e) { fail(res, e.message); }
};

/* ── Auxiliar de Compras (export AVSOFT "Documentos de Compras 1 Línea") ──────
   Detalle factura por factura de proveedores: alimenta la lámina de compras
   del directorio. Se re-importa cuando quieran (botón en la página): borra y
   reemplaza los meses que vienen en el archivo. */
require('../../../../shared/migrate').enFila('contabilidad-compras-aux', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ctb_compras_aux (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        mes          VARCHAR(7) NOT NULL,        -- YYYY-MM (período contable del doc)
        tipo_doc     VARCHAR(10) NULL,
        num_doc      VARCHAR(30) NULL,
        fecha_doc    DATE NULL,
        fecha_vcto   DATE NULL,
        estado       VARCHAR(20) NULL,
        rut          VARCHAR(15) NULL,
        razon_social VARCHAR(200) NULL,
        cuenta_cxp   VARCHAR(20) NULL,
        cuenta_gasto VARCHAR(20) NULL,
        neto         DECIMAL(14,0) NOT NULL DEFAULT 0,
        exento       DECIMAL(14,0) NOT NULL DEFAULT 0,
        iva          DECIMAL(14,0) NOT NULL DEFAULT 0,
        total        DECIMAL(14,0) NOT NULL DEFAULT 0,
        INDEX idx_mes (mes), INDEX idx_rut (rut)
      )`);
  } catch (e) { console.error('[contabilidad-compras-aux migration]', e.message); }
});

const fechaCL = s => { const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(s || '').trim()); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

exports.importarComprasAux = async (req, res) => {
  try {
    const { base64 } = req.body || {};
    if (!base64) return fail(res, 'Archivo (base64) obligatorio', 400);
    const texto = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ''), 'base64').toString('latin1');
    const lineas = texto.split(/\r?\n/).filter(l => l.trim());
    if (lineas.length < 2) return fail(res, 'Archivo vacío', 400);
    const head = lineas[0].split(';').map(s => s.trim().toLowerCase());
    const col = (frag) => head.findIndex(h => h.includes(frag));
    const ix = {
      anio: col('a'), mes: col('mes'), tipo: col('tipo de doc'), num: col('documento'),
      fdoc: col('fecha doc'), fvcto: col('fecha venc'), estado: col('estado'),
      rut: col('rut proveedor'), razon: col('raz'), cxp: col('concepto cliente'),
      gasto: head.findIndex(h => h === 'cuenta contable'), neto: col('monto afecto'),
      exento: col('monto exento'), iva: col('iva total'), total: col('total documento'),
    };
    ix.anio = 0; // primera columna siempre Año (el acento rompe el match)
    if (ix.total < 0 || ix.rut < 0) return fail(res, 'El archivo no parece el export "Documentos de Compras (1 Línea)" de AVSOFT', 400);
    const filas = [];
    for (let i = 1; i < lineas.length; i++) {
      const c = lineas[i].split(';');
      if (c.length < 10) continue;
      const mes = `${c[ix.anio]}-${String(Number(c[ix.mes])).padStart(2, '0')}`;
      if (!/^\d{4}-\d{2}$/.test(mes)) continue;
      filas.push([mes, c[ix.tipo]?.trim() || null, c[ix.num]?.trim() || null, fechaCL(c[ix.fdoc]), fechaCL(c[ix.fvcto]),
        c[ix.estado]?.trim() || null, c[ix.rut]?.trim() || null, c[ix.razon]?.trim().slice(0, 200) || null,
        c[ix.cxp]?.trim() || null, c[ix.gasto]?.trim() || null,
        Number(c[ix.neto]) || 0, Number(c[ix.exento]) || 0, Number(c[ix.iva]) || 0, Number(c[ix.total]) || 0]);
    }
    if (!filas.length) return fail(res, 'No se pudo interpretar ninguna fila', 400);
    const meses = [...new Set(filas.map(f => f[0]))];
    await pool.query('DELETE FROM ctb_compras_aux WHERE mes IN (?)', [meses]);
    for (let i = 0; i < filas.length; i += 500)
      await pool.query(
        'INSERT INTO ctb_compras_aux (mes, tipo_doc, num_doc, fecha_doc, fecha_vcto, estado, rut, razon_social, cuenta_cxp, cuenta_gasto, neto, exento, iva, total) VALUES ?',
        [filas.slice(i, i + 500)]);
    auditar({ req, accion: 'CREAR', modulo: 'contabilidad', entidad: 'compras_aux', entidad_id: null, detalle: `Import compras AVSOFT: ${filas.length} docs, meses ${meses.join(', ')}` });
    ok(res, { documentos: filas.length, meses });
  } catch (e) { fail(res, e.message); }
};

exports.getComprasAux = async (req, res) => {
  try {
    const mes = req.query.mes;
    if (!/^\d{4}-\d{2}$/.test(mes || '')) return fail(res, 'mes obligatorio', 400);
    const [docs] = await pool.query(
      'SELECT * FROM ctb_compras_aux WHERE mes=? ORDER BY total DESC LIMIT 300', [mes]);
    const [prov] = await pool.query(
      `SELECT razon_social, rut, COUNT(*) docs, SUM(total) total
         FROM ctb_compras_aux WHERE mes LIKE CONCAT(LEFT(?,4),'-%') AND mes <= ?
        GROUP BY razon_social, rut ORDER BY total DESC LIMIT 12`, [mes, mes]);
    const [[tot]] = await pool.query('SELECT COUNT(*) n, COALESCE(SUM(total),0) total FROM ctb_compras_aux WHERE mes=?', [mes]);
    ok(res, { documentos: docs, proveedores_anio: prov, total_mes: { docs: Number(tot.n), total: Number(tot.total) } });
  } catch (e) { fail(res, e.message); }
};

/* ── Auxiliar de Honorarios (export AVSOFT "Movimiento Honorarios") ───────────
   Boleta por boleta con bruto/retención/líquido: alimenta la lámina de
   honorarios del directorio. Mismo patrón que compras: borra y reemplaza
   los meses que vienen en el archivo. */
require('../../../../shared/migrate').enFila('contabilidad-honorarios-aux', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ctb_honorarios_aux (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        mes           VARCHAR(7) NOT NULL,       -- YYYY-MM (período contable)
        rut           VARCHAR(15) NULL,
        nombre        VARCHAR(200) NULL,
        num_boleta    VARCHAR(30) NULL,
        fecha_emision DATE NULL,
        glosa         VARCHAR(200) NULL,
        cuenta_gasto  VARCHAR(20) NULL,
        bruto         DECIMAL(14,0) NOT NULL DEFAULT 0,
        tasa_retencion DECIMAL(6,2) NOT NULL DEFAULT 0,
        retencion     DECIMAL(14,0) NOT NULL DEFAULT 0,
        liquido       DECIMAL(14,0) NOT NULL DEFAULT 0,
        INDEX idx_mes (mes), INDEX idx_rut (rut)
      )`);
  } catch (e) { console.error('[contabilidad-honorarios-aux migration]', e.message); }
});

exports.importarHonorariosAux = async (req, res) => {
  try {
    const { base64 } = req.body || {};
    if (!base64) return fail(res, 'Archivo (base64) obligatorio', 400);
    const texto = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ''), 'base64').toString('latin1');
    const lineas = texto.split(/\r?\n/).filter(l => l.trim() && l.replace(/;/g, '').trim());
    // buscar la fila de encabezado (el export trae un título arriba)
    const iHead = lineas.findIndex(l => l.toLowerCase().includes('rut profesional'));
    if (iHead < 0) return fail(res, 'El archivo no parece el export de Honorarios de AVSOFT', 400);
    const head = lineas[iHead].split(';').map(s => s.trim().toLowerCase());
    const col = (frag) => head.findIndex(h => h.includes(frag));
    const ix = {
      anio: 0, mes: col('mes'), rut: col('rut profesional'), nombre: col('nombre'),
      num: col('nro boleta'), femi: col('fecha emision'), glosa: col('glosa'),
      cuenta: col('cod cuenta'), bruto: col('bruto'), tasa: col('tasa retencion'),
      ret: head.findIndex(h => h === 'retencion'), liq: col('liquido'),
    };
    if (ix.bruto < 0 || ix.rut < 0) return fail(res, 'El archivo no parece el export de Honorarios de AVSOFT', 400);
    const filas = [];
    for (let i = iHead + 1; i < lineas.length; i++) {
      const c = lineas[i].split(';');
      if (c.length < 10) continue;
      const mes = `${c[ix.anio]}-${String(Number(c[ix.mes])).padStart(2, '0')}`;
      if (!/^\d{4}-\d{2}$/.test(mes)) continue;
      filas.push([mes, c[ix.rut]?.trim() || null, c[ix.nombre]?.replace(/�| /g, ' ').trim().slice(0, 200) || null,
        c[ix.num]?.trim() || null, fechaCL(c[ix.femi]), c[ix.glosa]?.trim().slice(0, 200) || null,
        c[ix.cuenta]?.trim() || null, Number(c[ix.bruto]) || 0,
        Number(String(c[ix.tasa] || '0').replace(',', '.')) || 0,
        Number(c[ix.ret]) || 0, Number(c[ix.liq]) || 0]);
    }
    if (!filas.length) return fail(res, 'No se pudo interpretar ninguna fila', 400);
    const meses = [...new Set(filas.map(f => f[0]))];
    await pool.query('DELETE FROM ctb_honorarios_aux WHERE mes IN (?)', [meses]);
    for (let i = 0; i < filas.length; i += 500)
      await pool.query(
        'INSERT INTO ctb_honorarios_aux (mes, rut, nombre, num_boleta, fecha_emision, glosa, cuenta_gasto, bruto, tasa_retencion, retencion, liquido) VALUES ?',
        [filas.slice(i, i + 500)]);
    auditar({ req, accion: 'CREAR', modulo: 'contabilidad', entidad: 'honorarios_aux', entidad_id: null, detalle: `Import honorarios AVSOFT: ${filas.length} boletas, meses ${meses.join(', ')}` });
    ok(res, { boletas: filas.length, meses });
  } catch (e) { fail(res, e.message); }
};

exports.getHonorariosAux = async (req, res) => {
  try {
    const mes = req.query.mes;
    if (!/^\d{4}-\d{2}$/.test(mes || '')) return fail(res, 'mes obligatorio', 400);
    const [docs] = await pool.query(
      'SELECT * FROM ctb_honorarios_aux WHERE mes=? ORDER BY bruto DESC LIMIT 300', [mes]);
    const [prof] = await pool.query(
      `SELECT nombre, rut, COUNT(*) boletas, SUM(bruto) bruto, SUM(liquido) liquido
         FROM ctb_honorarios_aux WHERE mes LIKE CONCAT(LEFT(?,4),'-%') AND mes <= ?
        GROUP BY nombre, rut ORDER BY bruto DESC LIMIT 12`, [mes, mes]);
    const [[tot]] = await pool.query('SELECT COUNT(*) n, COALESCE(SUM(bruto),0) bruto, COALESCE(SUM(retencion),0) retencion, COALESCE(SUM(liquido),0) liquido FROM ctb_honorarios_aux WHERE mes=?', [mes]);
    ok(res, { boletas: docs, profesionales_anio: prof, total_mes: { docs: Number(tot.n), bruto: Number(tot.bruto), retencion: Number(tot.retencion), liquido: Number(tot.liquido) } });
  } catch (e) { fail(res, e.message); }
};

/* ── Auxiliar de Ventas (export AVSOFT "Exportar Documentos de Ventas") ───────
   Formato multilínea: ENC (encabezado del doc) + DEA/DEE/DEI (detalle). Se
   toma el ENC y la cuenta de ingreso del primer DEA/DEE. Un archivo por mes.
   Notas de crédito (tipo 61) se guardan con signo negativo. */
require('../../../../shared/migrate').enFila('contabilidad-ventas-aux', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ctb_ventas_aux (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        mes            VARCHAR(7) NOT NULL,        -- YYYY-MM (período contable)
        tipo_doc       VARCHAR(10) NULL,           -- 33 factura, 61 NC, 56 ND...
        num_doc        VARCHAR(30) NULL,
        fecha_doc      DATE NULL,
        rut            VARCHAR(15) NULL,
        razon_social   VARCHAR(200) NULL,
        cuenta_ingreso VARCHAR(20) NULL,
        neto           DECIMAL(14,0) NOT NULL DEFAULT 0,
        exento         DECIMAL(14,0) NOT NULL DEFAULT 0,
        iva            DECIMAL(14,0) NOT NULL DEFAULT 0,
        total          DECIMAL(14,0) NOT NULL DEFAULT 0,
        INDEX idx_mes (mes), INDEX idx_rut (rut)
      )`);
  } catch (e) { console.error('[contabilidad-ventas-aux migration]', e.message); }
});

exports.importarVentasAux = async (req, res) => {
  try {
    const { base64 } = req.body || {};
    if (!base64) return fail(res, 'Archivo (base64) obligatorio', 400);
    const texto = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ''), 'base64').toString('latin1');
    const lineas = texto.split(/\r?\n/);
    const filas = [];
    let actual = null;
    for (const l of lineas) {
      const c = l.split(';');
      if (c[0] === 'ENC') {
        const mes = `${c[1]}-${String(Number(c[2])).padStart(2, '0')}`;
        if (!/^\d{4}-\d{2}$/.test(mes)) { actual = null; continue; }
        const tipo = String(c[3] || '').trim();
        const sgn = tipo === '61' ? -1 : 1;   // nota de crédito resta
        actual = [mes, tipo, String(c[4] || '').trim(), fechaCL(c[8]), String(c[5] || '').trim(),
          String(c[6] || '').trim().slice(0, 200), null,
          sgn * (Number(c[13]) || 0), sgn * (Number(c[14]) || 0), sgn * (Number(c[17]) || 0), sgn * (Number(c[20]) || 0)];
        filas.push(actual);
      } else if ((c[0] === 'DEA' || c[0] === 'DEE') && actual && !actual[6]) {
        actual[6] = String(c[1] || '').trim() || null; // cuenta de ingreso del primer detalle
      }
    }
    if (!filas.length) return fail(res, 'El archivo no parece el export "Documentos de Ventas" de AVSOFT (líneas ENC/DEA)', 400);
    const meses = [...new Set(filas.map(f => f[0]))];
    await pool.query('DELETE FROM ctb_ventas_aux WHERE mes IN (?)', [meses]);
    for (let i = 0; i < filas.length; i += 500)
      await pool.query(
        'INSERT INTO ctb_ventas_aux (mes, tipo_doc, num_doc, fecha_doc, rut, razon_social, cuenta_ingreso, neto, exento, iva, total) VALUES ?',
        [filas.slice(i, i + 500)]);
    auditar({ req, accion: 'CREAR', modulo: 'contabilidad', entidad: 'ventas_aux', entidad_id: null, detalle: `Import ventas AVSOFT: ${filas.length} docs, meses ${meses.join(', ')}` });
    ok(res, { documentos: filas.length, meses });
  } catch (e) { fail(res, e.message); }
};

exports.listaVentasAux = async (req, res) => {
  try {
    const { desde, hasta, q, cuenta } = req.query;
    const w = [], p = [];
    if (/^\d{4}-\d{2}$/.test(desde || '')) { w.push('mes >= ?'); p.push(desde); }
    if (/^\d{4}-\d{2}$/.test(hasta || '')) { w.push('mes <= ?'); p.push(hasta); }
    if (q) { w.push('(razon_social LIKE ? OR rut LIKE ? OR num_doc LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (cuenta) { w.push('cuenta_ingreso LIKE ?'); p.push(`${cuenta}%`); }
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const [docs] = await pool.query(`SELECT * FROM ctb_ventas_aux ${where} ORDER BY mes DESC, ABS(total) DESC LIMIT 1000`, p);
    const [meses] = await pool.query(
      `SELECT mes, COUNT(*) docs, SUM(neto) neto, SUM(exento) exento, SUM(iva) iva, SUM(total) total
         FROM ctb_ventas_aux ${where} GROUP BY mes ORDER BY mes DESC`, p);
    const [[tot]] = await pool.query(`SELECT COUNT(*) docs, COALESCE(SUM(neto),0) neto, COALESCE(SUM(iva),0) iva, COALESCE(SUM(total),0) total FROM ctb_ventas_aux ${where}`, p);
    ok(res, { documentos: docs, meses, total: tot, truncado: docs.length === 1000 });
  } catch (e) { fail(res, e.message); }
};

/* ── Digitación de documentos tributarios (compras y honorarios) ──────────────
   Reemplaza la digitación en AVSOFT: el documento entra al auxiliar
   (origen='DIGITADO') y opcionalmente genera su asiento contable de una vez.
   Cuentas y tasa de retención son paramétricas (ctb_config, se recuerda lo
   último usado). Ventas NO se digitan: nacen en la facturación electrónica. */
require('../../../../shared/migrate').enFila('contabilidad-digitar-docs', async () => {
  try {
    await pool.query("ALTER TABLE ctb_compras_aux ADD COLUMN origen VARCHAR(10) NOT NULL DEFAULT 'AVSOFT', ADD COLUMN id_comprobante INT NULL").catch(() => {});
    await pool.query("ALTER TABLE ctb_honorarios_aux ADD COLUMN origen VARCHAR(10) NOT NULL DEFAULT 'AVSOFT', ADD COLUMN id_comprobante INT NULL").catch(() => {});
    await pool.query("ALTER TABLE ctb_ventas_aux ADD COLUMN origen VARCHAR(10) NOT NULL DEFAULT 'AVSOFT'").catch(() => {});
    console.log('[contabilidad] digitación de documentos lista');
  } catch (e) { console.error('[contabilidad-digitar-docs migration]', e.message); }
});

const getConfigDig = async () => {
  const [rows] = await pool.query("SELECT clave, valor FROM ctb_config WHERE clave LIKE 'dig_%'");
  const c = Object.fromEntries(rows.map(r => [r.clave, r.valor]));
  return {
    cta_iva_credito: c.dig_cta_iva_credito || '',
    cta_cxp: c.dig_cta_cxp || '',
    cta_ret_honorarios: c.dig_cta_ret_honorarios || '',
    cta_hon_por_pagar: c.dig_cta_hon_por_pagar || '',
    tasa_retencion: Number(c.dig_tasa_retencion || 15.25),
  };
};
const setConfigDig = async (pares) => {
  for (const [k, v] of Object.entries(pares))
    if (v !== undefined && v !== null && v !== '')
      await pool.query('INSERT INTO ctb_config (clave, valor) VALUES (?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)', ['dig_' + k, String(v)]);
};
exports.getDigitarConfig = async (req, res) => {
  try { ok(res, await getConfigDig()); } catch (e) { fail(res, e.message); }
};

/* Comprobante interno para la digitación de documentos: respeta candado y
   correlativo; no pasa por el guardián (el documento ya trae su estructura). */
const crearComprobanteDoc = async ({ fecha, glosa, movimientos, origen, origen_ref, usuario }) => {
  const candado = await mesConCandado(fecha);
  if (candado) throw Object.assign(new Error(`El mes ${candado} está CERRADO con candado. Reábrelo en Informe Cierre Mensual para digitar en él.`), { http: 423 });
  const codigos = [...new Set(movimientos.map(m => String(m.cuenta)))];
  const [ctas] = await pool.query('SELECT codigo, imputable, activo FROM ctb_cuentas WHERE codigo IN (?)', [codigos]);
  const mapa = Object.fromEntries(ctas.map(c => [c.codigo, c]));
  for (const cod of codigos) {
    if (!mapa[cod]) throw new Error(`Cuenta ${cod} no existe en el plan`);
    if (!mapa[cod].imputable) throw new Error(`Cuenta ${cod} no es imputable`);
    if (!mapa[cod].activo) throw new Error(`Cuenta ${cod} está desactivada`);
  }
  const debe = movimientos.reduce((s, m) => s + (m.debe || 0), 0);
  const haber = movimientos.reduce((s, m) => s + (m.haber || 0), 0);
  if (debe !== haber || !debe) throw new Error(`Asiento descuadrado: $${debe.toLocaleString('es-CL')} ≠ $${haber.toLocaleString('es-CL')}`);
  const conn = await pool.getConnection();
  try {
    const anio = Number(fecha.slice(0, 4));
    await conn.beginTransaction();
    const [[{ sig }]] = await conn.query(
      'SELECT COALESCE(MAX(numero),0)+1 sig FROM ctb_comprobantes WHERE tipo=? AND anio=? FOR UPDATE', ['TRASPASO', anio]);
    const [r] = await conn.query(
      `INSERT INTO ctb_comprobantes (tipo, anio, numero, fecha, glosa, total, origen, origen_ref, creado_por) VALUES ('TRASPASO',?,?,?,?,?,?,?,?)`,
      [anio, sig, fecha, glosa, debe, origen, origen_ref, usuario]);
    for (const m of movimientos)
      await conn.query('INSERT INTO ctb_movimientos (id_comprobante, cuenta, glosa, debe, haber, rut) VALUES (?,?,?,?,?,?)',
        [r.insertId, m.cuenta, m.glosa || null, m.debe || 0, m.haber || 0, m.rut || null]);
    await conn.commit();
    return { id: r.insertId, numero: `T-${anio}-${String(sig).padStart(5, '0')}` };
  } catch (e) { await conn.rollback().catch(() => {}); throw e; }
  finally { conn.release(); }
};

exports.digitarCompraAux = async (req, res) => {
  try {
    const b = req.body || {};
    const { tipo_doc, num_doc, rut, razon_social, fecha_doc, fecha_vcto, cuenta_gasto, cuenta_iva, cuenta_cxp } = b;
    const neto = Math.round(Number(b.neto) || 0), exento = Math.round(Number(b.exento) || 0), iva = Math.round(Number(b.iva) || 0);
    const total = neto + exento + iva;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha_doc || '')) return fail(res, 'Fecha del documento inválida', 400);
    if (!num_doc || !rut || !razon_social) return fail(res, 'Folio, RUT y razón social son obligatorios', 400);
    if (total <= 0) return fail(res, 'Montos en cero', 400);
    if (!cuenta_gasto) return fail(res, 'Cuenta de gasto obligatoria', 400);
    const mes = fecha_doc.slice(0, 7);
    const [[dup]] = await pool.query('SELECT id FROM ctb_compras_aux WHERE rut=? AND tipo_doc=? AND num_doc=? LIMIT 1', [rut, tipo_doc || '33', String(num_doc)]);
    if (dup) return fail(res, `Ya existe la factura ${num_doc} de ${rut} en el auxiliar (id ${dup.id})`, 409);

    let comp = null;
    if (b.generar_asiento) {
      if (iva > 0 && !cuenta_iva) return fail(res, 'Cuenta IVA crédito obligatoria para el asiento', 400);
      if (!cuenta_cxp) return fail(res, 'Cuenta por pagar obligatoria para el asiento', 400);
      const movimientos = [
        { cuenta: cuenta_gasto, debe: neto + exento, haber: 0, glosa: `FC ${num_doc} ${razon_social}`.slice(0, 200), rut },
        ...(iva > 0 ? [{ cuenta: cuenta_iva, debe: iva, haber: 0, glosa: `IVA FC ${num_doc}`, rut }] : []),
        { cuenta: cuenta_cxp, debe: 0, haber: total, glosa: `FC ${num_doc} ${razon_social}`.slice(0, 200), rut },
      ];
      comp = await crearComprobanteDoc({
        fecha: fecha_doc, glosa: `Compra ${tipo_doc || '33'}-${num_doc} ${razon_social}`.slice(0, 250),
        movimientos, origen: 'COMPRA_DIG', origen_ref: `${rut}|${tipo_doc || '33'}|${num_doc}`, usuario: nombreDe(req.user),
      });
    }
    const [r] = await pool.query(
      `INSERT INTO ctb_compras_aux (mes, tipo_doc, num_doc, fecha_doc, fecha_vcto, estado, rut, razon_social, cuenta_cxp, cuenta_gasto, neto, exento, iva, total, origen, id_comprobante)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DIGITADO',?)`,
      [mes, tipo_doc || '33', String(num_doc), fecha_doc, fecha_vcto || null, 'Vigente', rut, String(razon_social).slice(0, 200),
       cuenta_cxp || null, cuenta_gasto, neto, exento, iva, total, comp?.id || null]);
    await setConfigDig({ cta_iva_credito: cuenta_iva, cta_cxp: cuenta_cxp });
    auditar({ req, accion: 'CREAR', modulo: 'contabilidad', entidad: 'compra_digitada', entidad_id: r.insertId, detalle: `FC ${num_doc} ${razon_social} $${total.toLocaleString('es-CL')}${comp ? ' → ' + comp.numero : ''}` });
    ok(res, { id: r.insertId, comprobante: comp });
  } catch (e) { fail(res, e.message, e.http || 500); }
};

exports.digitarHonorarioAux = async (req, res) => {
  try {
    const b = req.body || {};
    const { rut, nombre, num_boleta, fecha_emision, glosa, cuenta_gasto, cuenta_retencion, cuenta_por_pagar } = b;
    const bruto = Math.round(Number(b.bruto) || 0);
    const tasa = Number(b.tasa_retencion) || 0;
    const retencion = Math.round(bruto * tasa / 100);
    const liquido = bruto - retencion;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha_emision || '')) return fail(res, 'Fecha de emisión inválida', 400);
    if (!rut || !nombre || !num_boleta) return fail(res, 'RUT, nombre y N° de boleta son obligatorios', 400);
    if (bruto <= 0) return fail(res, 'Bruto en cero', 400);
    if (!cuenta_gasto) return fail(res, 'Cuenta de gasto obligatoria', 400);
    const mes = fecha_emision.slice(0, 7);
    const [[dup]] = await pool.query('SELECT id FROM ctb_honorarios_aux WHERE rut=? AND num_boleta=? LIMIT 1', [rut, String(num_boleta)]);
    if (dup) return fail(res, `Ya existe la boleta ${num_boleta} de ${rut} en el auxiliar (id ${dup.id})`, 409);

    let comp = null;
    if (b.generar_asiento) {
      if (retencion > 0 && !cuenta_retencion) return fail(res, 'Cuenta de retención obligatoria para el asiento', 400);
      if (!cuenta_por_pagar) return fail(res, 'Cuenta honorarios por pagar obligatoria para el asiento', 400);
      const movimientos = [
        { cuenta: cuenta_gasto, debe: bruto, haber: 0, glosa: `BH ${num_boleta} ${nombre}`.slice(0, 200), rut },
        ...(retencion > 0 ? [{ cuenta: cuenta_retencion, debe: 0, haber: retencion, glosa: `Ret ${tasa}% BH ${num_boleta}`, rut }] : []),
        { cuenta: cuenta_por_pagar, debe: 0, haber: liquido, glosa: `BH ${num_boleta} ${nombre}`.slice(0, 200), rut },
      ];
      comp = await crearComprobanteDoc({
        fecha: fecha_emision, glosa: `Honorarios BH ${num_boleta} ${nombre}`.slice(0, 250),
        movimientos, origen: 'HONORARIO_DIG', origen_ref: `${rut}|BH|${num_boleta}`, usuario: nombreDe(req.user),
      });
    }
    const [r] = await pool.query(
      `INSERT INTO ctb_honorarios_aux (mes, rut, nombre, num_boleta, fecha_emision, glosa, cuenta_gasto, bruto, tasa_retencion, retencion, liquido, origen, id_comprobante)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'DIGITADO',?)`,
      [mes, rut, String(nombre).slice(0, 200), String(num_boleta), fecha_emision, (glosa || '').slice(0, 200) || null,
       cuenta_gasto, bruto, tasa, retencion, liquido, comp?.id || null]);
    await setConfigDig({ cta_ret_honorarios: cuenta_retencion, cta_hon_por_pagar: cuenta_por_pagar, tasa_retencion: tasa });
    auditar({ req, accion: 'CREAR', modulo: 'contabilidad', entidad: 'honorario_digitado', entidad_id: r.insertId, detalle: `BH ${num_boleta} ${nombre} $${bruto.toLocaleString('es-CL')}${comp ? ' → ' + comp.numero : ''}` });
    ok(res, { id: r.insertId, retencion, liquido, comprobante: comp });
  } catch (e) { fail(res, e.message, e.http || 500); }
};

exports.eliminarDocAux = async (req, res) => {
  try {
    const tabla = { compras: 'ctb_compras_aux', honorarios: 'ctb_honorarios_aux' }[req.params.tipo];
    if (!tabla) return fail(res, 'Tipo inválido', 400);
    const [[doc]] = await pool.query(`SELECT * FROM ${tabla} WHERE id=?`, [req.params.id]);
    if (!doc) return fail(res, 'No existe', 404);
    if (doc.origen !== 'DIGITADO') return fail(res, 'Solo se pueden eliminar documentos DIGITADOS (los importados se corrigen re-importando el mes)', 400);
    const candado = await mesConCandado(doc.mes + '-01');
    if (candado) return fail(res, `El mes ${candado} está cerrado con candado`, 423);
    await pool.query(`DELETE FROM ${tabla} WHERE id=?`, [req.params.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'contabilidad', entidad: req.params.tipo + '_digitado', entidad_id: Number(req.params.id), detalle: `${doc.num_doc || doc.num_boleta} ${doc.razon_social || doc.nombre}${doc.id_comprobante ? ` (OJO: su asiento id ${doc.id_comprobante} sigue vigente — anúlalo en Comprobantes si corresponde)` : ''}` });
    ok(res, { eliminado: true, id_comprobante: doc.id_comprobante });
  } catch (e) { fail(res, e.message); }
};

/* ── Auxiliar de Remuneraciones (export AVSOFT "Libro de Remuneraciones") ─────
   LIBREMUN_MMYYYY.CSV: una fila por trabajador con haberes, imposiciones,
   impuesto único y líquido. Alimenta la pestaña Remuneraciones y el código
   048 del F29. Mismo patrón: reemplaza los meses del archivo. */
require('../../../../shared/migrate').enFila('contabilidad-remun-aux', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ctb_remun_aux (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        mes           VARCHAR(7) NOT NULL,
        rut           VARCHAR(15) NULL,
        nombre        VARCHAR(200) NULL,
        cargo         VARCHAR(120) NULL,
        centro_costo  VARCHAR(80) NULL,
        dias          INT NOT NULL DEFAULT 0,
        sueldo_base   DECIMAL(14,0) NOT NULL DEFAULT 0,
        imponible     DECIMAL(14,0) NOT NULL DEFAULT 0,
        haberes       DECIMAL(14,0) NOT NULL DEFAULT 0,
        afp_nombre    VARCHAR(40) NULL,
        afp_monto     DECIMAL(14,0) NOT NULL DEFAULT 0,
        salud_nombre  VARCHAR(40) NULL,
        salud_monto   DECIMAL(14,0) NOT NULL DEFAULT 0,
        impuesto_unico DECIMAL(14,0) NOT NULL DEFAULT 0,
        descuentos    DECIMAL(14,0) NOT NULL DEFAULT 0,
        liquido       DECIMAL(14,0) NOT NULL DEFAULT 0,
        seg_ces_emp   DECIMAL(14,0) NOT NULL DEFAULT 0,
        sis_emp       DECIMAL(14,0) NOT NULL DEFAULT 0,
        INDEX idx_mes (mes), INDEX idx_rut (rut)
      )`);
  } catch (e) { console.error('[contabilidad-remun-aux migration]', e.message); }
});

exports.importarRemunAux = async (req, res) => {
  try {
    const { base64 } = req.body || {};
    if (!base64) return fail(res, 'Archivo (base64) obligatorio', 400);
    const texto = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ''), 'base64').toString('latin1');
    const lineas = texto.split(/\r?\n/).filter(l => l.trim());
    const iHead = lineas.findIndex(l => /A.O;MES;CODIGO;RUT/i.test(l));
    if (iHead < 0) return fail(res, 'El archivo no parece el Libro de Remuneraciones de AVSOFT (LIBREMUN)', 400);
    const head = lineas[iHead].split(';').map(s => s.trim().toUpperCase());
    const col = (nom) => head.findIndex(h => h === nom);
    // Columnas de identificación: posición fija desde el INICIO.
    const ini = {
      rut: col('RUT'), nombre: col('NOMBRE'), pat: col('AP PATERNO'), mat: col('AP MATERNO'),
      cargo: col('CARGO'), cc: col('CENTRO COSTO'), dias: col('DIAS TRABAJADOS'), base: col('SUELDO BASE CALC.'),
    };
    // Columnas de montos: offset desde el FINAL. El export anual de AVSOFT trae
    // más columnas en el encabezado que en las filas (sección haberes variable),
    // pero la cola (imposiciones→aportes) es idéntica en todos los layouts.
    const off = {};
    for (const [k, nom] of Object.entries({
      imponible: 'TOTAL IMPONIBLE', haberes: 'TOTAL HABERES', afp: 'AFP', afpM: 'TOTAL AFP',
      salud: 'ORG.SALUD', saludM: 'TOTAL SALUD', impUnico: 'IMPTO UNICO', desc: 'TOTAL DESCUENTOS',
      liquido: 'SUELDO LIQUIDO', segCes: 'SEG.CES. EMP.', sis: 'SIS EMP.',
    })) { const i = col(nom); off[k] = i < 0 ? -1 : head.length - i; }
    if (ini.rut < 0 || off.imponible < 0 || off.liquido < 0) return fail(res, 'No se reconocieron las columnas del LIBREMUN', 400);
    const filas = [];
    for (let i = iHead + 1; i < lineas.length; i++) {
      const c = lineas[i].split(';');
      if (c.length < 20 || !/^\d{4}$/.test(c[0])) continue;
      const mes = `${c[0]}-${String(Number(c[1])).padStart(2, '0')}`;
      if (!/^\d{4}-\d{2}$/.test(mes)) continue;
      const fin = k => off[k] < 0 ? undefined : c[c.length - off[k]];
      const n = v => Math.round(Number(v) || 0);
      filas.push([mes, c[ini.rut]?.trim() || null,
        `${c[ini.nombre] || ''} ${c[ini.pat] || ''} ${c[ini.mat] || ''}`.replace(/\s+/g, ' ').trim().slice(0, 200) || null,
        c[ini.cargo]?.trim().slice(0, 120) || null, c[ini.cc]?.trim().slice(0, 80) || null,
        n(c[ini.dias]), n(c[ini.base]), n(fin('imponible')), n(fin('haberes')),
        (fin('afp') || '').trim().slice(0, 40) || null, n(fin('afpM')),
        (fin('salud') || '').trim().slice(0, 40) || null, n(fin('saludM')),
        n(fin('impUnico')), n(fin('desc')), n(fin('liquido')), n(fin('segCes')), n(fin('sis'))]);
    }
    if (!filas.length) return fail(res, 'No se pudo interpretar ninguna fila', 400);
    const meses = [...new Set(filas.map(f => f[0]))];
    await pool.query('DELETE FROM ctb_remun_aux WHERE mes IN (?)', [meses]);
    for (let i = 0; i < filas.length; i += 300)
      await pool.query(
        `INSERT INTO ctb_remun_aux (mes, rut, nombre, cargo, centro_costo, dias, sueldo_base, imponible, haberes,
          afp_nombre, afp_monto, salud_nombre, salud_monto, impuesto_unico, descuentos, liquido, seg_ces_emp, sis_emp) VALUES ?`,
        [filas.slice(i, i + 300)]);
    auditar({ req, accion: 'CREAR', modulo: 'contabilidad', entidad: 'remun_aux', entidad_id: null, detalle: `Import remuneraciones AVSOFT: ${filas.length} liquidaciones, meses ${meses.join(', ')}` });
    ok(res, { liquidaciones: filas.length, meses });
  } catch (e) { fail(res, e.message); }
};

exports.listaRemunAux = async (req, res) => {
  try {
    const { desde, hasta, q } = req.query;
    const w = [], p = [];
    if (/^\d{4}-\d{2}$/.test(desde || '')) { w.push('mes >= ?'); p.push(desde); }
    if (/^\d{4}-\d{2}$/.test(hasta || '')) { w.push('mes <= ?'); p.push(hasta); }
    if (q) { w.push('(nombre LIKE ? OR rut LIKE ? OR cargo LIKE ? OR centro_costo LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const [docs] = await pool.query(`SELECT * FROM ctb_remun_aux ${where} ORDER BY mes DESC, liquido DESC LIMIT 1000`, p);
    const [meses] = await pool.query(
      `SELECT mes, COUNT(*) docs, SUM(imponible) imponible, SUM(haberes) haberes, SUM(impuesto_unico) impuesto_unico, SUM(liquido) liquido
         FROM ctb_remun_aux ${where} GROUP BY mes ORDER BY mes DESC`, p);
    const [[tot]] = await pool.query(`SELECT COUNT(*) docs, COALESCE(SUM(haberes),0) haberes, COALESCE(SUM(impuesto_unico),0) impuesto_unico, COALESCE(SUM(liquido),0) liquido FROM ctb_remun_aux ${where}`, p);
    ok(res, { documentos: docs, meses, total: tot, truncado: docs.length === 1000 });
  } catch (e) { fail(res, e.message); }
};

/* ── F29 Borrador (/contabilidad/f29/) ────────────────────────────────────────
   Propuesta del Formulario 29 mensual a partir de los auxiliares de ventas
   (débito fiscal), compras (crédito fiscal) y honorarios (retención). Los
   códigos que el sistema no puede conocer (proporcionalidad del crédito,
   impuesto único trabajadores, PPM) son editables y se guardan por mes.
   ES UN BORRADOR: la declaración se hace en el SII. Validado contra el F29
   real de mayo 2026 (débitos y NC al peso; crédito difiere solo por la
   proporcionalidad; honorarios el SII los toma por fecha de pago). */
require('../../../../shared/migrate').enFila('contabilidad-f29', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ctb_f29 (
        mes        VARCHAR(7) PRIMARY KEY,
        ajustes    TEXT NOT NULL,                 -- JSON {codigo: valor} de los códigos manuales
        actualizado_por VARCHAR(160) NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='ctb_f29' LIMIT 1");
    let idf = ex?.id_funcionalidad;
    if (!idf) {
      const [r] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (500003,'F29 Borrador','ctb_f29','/contabilidad/f29/','bi-file-earmark-ruled')");
      idf = r.insertId;
    }
    for (const idp of [1, 90003, 90007, 90009])
      await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
    console.log('[contabilidad] f29 borrador listo');
  } catch (e) { console.error('[contabilidad-f29 migration]', e.message); }
});

exports.getF29 = async (req, res) => {
  try {
    const mes = req.query.mes;
    if (!/^\d{4}-\d{2}$/.test(mes || '')) return fail(res, 'mes obligatorio', 400);
    // Ventas (débito fiscal). Las NC 61 están guardadas con signo negativo.
    const [[v]] = await pool.query(`SELECT
        COUNT(CASE WHEN tipo_doc IN ('33','34') THEN 1 END) c503,
        COUNT(CASE WHEN tipo_doc='56' THEN 1 END) c512,
        COUNT(CASE WHEN tipo_doc='61' THEN 1 END) c509,
        COALESCE(SUM(CASE WHEN tipo_doc='33' THEN iva END),0) c502,
        COALESCE(SUM(CASE WHEN tipo_doc='56' THEN iva END),0) c513,
        COALESCE(SUM(CASE WHEN tipo_doc='61' THEN -iva END),0) c510,
        COALESCE(SUM(iva),0) c538
      FROM ctb_ventas_aux WHERE mes=?`, [mes]);
    // Compras (crédito fiscal)
    const [[c]] = await pool.query(`SELECT
        COUNT(CASE WHEN tipo_doc IN ('33','34','30','46') THEN 1 END) c519,
        COUNT(CASE WHEN tipo_doc IN ('61','60') THEN 1 END) c527,
        COALESCE(SUM(CASE WHEN tipo_doc NOT IN ('61','60') THEN iva END),0) c520,
        COALESCE(SUM(CASE WHEN tipo_doc IN ('61','60') THEN iva END),0) c528
      FROM ctb_compras_aux WHERE mes=?`, [mes]);
    // Honorarios (retención 151) — ojo: el SII declara por fecha de PAGO
    const [[h]] = await pool.query('SELECT COALESCE(SUM(retencion),0) c151, COUNT(*) n FROM ctb_honorarios_aux WHERE mes=?', [mes]);
    // Remuneraciones (impuesto único código 048)
    const [[r]] = await pool.query('SELECT COALESCE(SUM(impuesto_unico),0) c048, COUNT(*) n FROM ctb_remun_aux WHERE mes=?', [mes]);
    const [[aj]] = await pool.query('SELECT ajustes, actualizado_por, updated_at FROM ctb_f29 WHERE mes=?', [mes]);
    ok(res, {
      mes,
      ventas: { c503: Number(v.c503), c512: Number(v.c512), c509: Number(v.c509), c502: Number(v.c502), c513: Number(v.c513), c510: Number(v.c510), c538: Number(v.c538) },
      compras: { c519: Number(c.c519), c527: Number(c.c527), c520: Number(c.c520), c528: Number(c.c528) },
      honorarios: { c151: Number(h.c151), boletas: Number(h.n) },
      remuneraciones: { c048: Number(r.c048), trabajadores: Number(r.n) },
      ajustes: aj ? JSON.parse(aj.ajustes) : {},
      guardado: aj ? { por: aj.actualizado_por, en: aj.updated_at } : null,
    });
  } catch (e) { fail(res, e.message); }
};

exports.guardarF29 = async (req, res) => {
  try {
    const { mes, ajustes } = req.body || {};
    if (!/^\d{4}-\d{2}$/.test(mes || '')) return fail(res, 'mes inválido', 400);
    await pool.query(
      'INSERT INTO ctb_f29 (mes, ajustes, actualizado_por) VALUES (?,?,?) ON DUPLICATE KEY UPDATE ajustes=VALUES(ajustes), actualizado_por=VALUES(actualizado_por)',
      [mes, JSON.stringify(ajustes || {}), nombreDe(req.user)]);
    auditar({ req, accion: 'EDITAR', modulo: 'contabilidad', entidad: 'f29', entidad_id: null, detalle: `Ajustes F29 ${mes}` });
    ok(res, { guardado: true });
  } catch (e) { fail(res, e.message); }
};

/* ── LRE: Libro de Remuneraciones Electrónico (Dirección del Trabajo) ─────────
   Genera el CSV mensual oficial (Manual LRE de la DT: separador ';', nombre
   rutempleador_aaaamm.csv, montos enteros, opcionales vacíos, headers =
   códigos de concepto). Fuente preferente: liquidaciones EMITIDAS del motor
   propio (rh_liquidaciones); si el mes aún se pagó por AVSOFT, cae al
   auxiliar importado (ctb_remun_aux) como referencial. */
require('../../../../shared/migrate').enFila('contabilidad-lre', async () => {
  try {
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='ctb_lre' LIMIT 1");
    let idf = ex?.id_funcionalidad;
    if (!idf) {
      const [r] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (500003,'LRE — Libro Remuneraciones Electrónico','ctb_lre','/contabilidad/lre/','bi-journal-arrow-up')");
      idf = r.insertId;
    }
    for (const idp of [1, 90003, 90007, 90009])
      await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
    console.log('[contabilidad] lre listo');
  } catch (e) { console.error('[contabilidad-lre migration]', e.message); }
});

// Catálogos oficiales del Manual LRE (tablas N°9, 11, 13, 14)
const LRE_AFP = { 'PROVIDA': 6, 'PLANVITAL': 11, 'PLAN VITAL': 11, 'CUPRUM': 13, 'HABITAT': 14, 'UNO': 19, 'CAPITAL': 31, 'MODELO': 103 };
const LRE_SALUD = { 'FONASA': 102, 'CRUZ BLANCA': 1, 'ISAPRE CRUZ BLANCA S.A.': 1, 'BANMEDICA': 3, 'COLMENA': 4, 'CONSALUD': 9, 'VIDA TRES': 12, 'NUEVA MAS VIDA': 43, 'ESENCIAL': 44, 'ESCENCIAL': 44 };
const lreFecha = f => { const s = isoF(f); return s ? s.split('-').reverse().join('/') : ''; };
const isoF = f => f == null ? null
  : (f instanceof Date ? new Date(f.getTime() - f.getTimezoneOffset() * 60000).toISOString() : String(f)).slice(0, 10);

// Orden de columnas del archivo (solo los conceptos que la empresa usa + obligatorios)
const LRE_COLS = ['1101','1102','1103','1104','1105','1106','1170','1146','1107','1108','1109','1141','1142','1143','1151','1110','1152',
  '1115','1116','1118','1155','1157','1131',
  '2101','2103','2106','2113','2301','2302','2306',
  '3141','3143','3144','3151','3161','3183',
  '4151','4152','4155',
  '5201','5210','5220','5230','5240','5301','5361','5341','5302','5410','5501','5564'];

exports.getLRE = async (req, res) => {
  try {
    const mes = req.query.mes;
    if (!/^\d{4}-\d{2}$/.test(mes || '')) return fail(res, 'mes obligatorio', 400);
    // Días de licencia médica del mes por usuario (corridos, tope 30)
    const [lics] = await pool.query(
      `SELECT a.id_usuario, u.rut, a.fecha_desde, a.fecha_hasta FROM rh_ausencias a JOIN usuarios u ON u.id_usuario=a.id_usuario
        WHERE a.tipo='LICENCIA MEDICA' AND a.estado='APROBADA'
          AND a.fecha_desde <= LAST_DAY(CONCAT(?, '-01')) AND a.fecha_hasta >= CONCAT(?, '-01')`, [mes, mes]);
    const licDias = {};
    const ini = mes + '-01', finStr = mes + '-31';
    for (const l of lics) {
      const d = isoF(l.fecha_desde) > ini ? isoF(l.fecha_desde) : ini;
      const h = isoF(l.fecha_hasta) < finStr ? isoF(l.fecha_hasta) : finStr;
      if (h >= d) {
        const n = Math.min(30, Number(h.slice(8, 10))) - Math.min(30, Number(d.slice(8, 10))) + 1;
        const key = String(l.rut || '').replace(/\./g, '').toUpperCase();
        licDias[key] = Math.min(30, (licDias[key] || 0) + Math.max(0, n));
      }
    }
    const nRut = r => String(r || '').replace(/\./g, '').replace(/\s/g, '').toUpperCase();
    const afpCod = n => LRE_AFP[String(n || '').toUpperCase().trim()] ?? 100;
    const salCod = n => LRE_SALUD[String(n || '').toUpperCase().trim()] ?? 99;

    // Fuente 1: liquidaciones EMITIDAS del motor propio
    const [liqs] = await pool.query(
      `SELECT l.*, u.rut urut, u.fecha_ingreso, f.afp fafp, f.salud fsalud, f.tipo_contrato
         FROM rh_liquidaciones l JOIN usuarios u ON u.id_usuario=l.id_usuario
         LEFT JOIN rh_fichas f ON f.id_usuario=l.id_usuario
        WHERE l.mes=? AND l.estado='EMITIDA'`, [mes]);
    let fuente, filas;
    if (liqs.length) {
      fuente = 'MOTOR';
      filas = liqs.map(l => {
        let d = {}; try { d = typeof l.detalle === 'string' ? JSON.parse(l.detalle) : (l.detalle || {}); } catch (_) {}
        const rut = nRut(l.rut || l.urut);
        const cotiz = (d.desc_afp || 0) + (d.desc_salud || 0) + (d.desc_salud_adicional || 0) + (d.desc_afc || 0);
        const noImp = (d.colacion || 0) + (d.movilizacion || 0) + (d.otros_no_imponibles || 0);
        const aportes = (d.aporte_afc_emp || 0) + (d.aporte_mutual || 0) + (d.aporte_sis || 0);
        return {
          '1101': rut, '1102': lreFecha(l.fecha_ingreso), '1105': 13, '1106': 13114, '1170': 1, '1146': 0, '1107': 101,
          '1108': 0, '1109': 0, '1141': afpCod(d.afp || l.fafp), '1142': 0, '1143': salCod(d.salud || l.fsalud),
          '1151': 1, '1110': 1, '1152': 2,
          '1115': d.dias ?? 30, '1116': licDias[rut] || '', '1118': 0, '1155': 0, '1157': 0, '1131': 0,
          '2101': d.sueldo_base || 0, '2103': d.comisiones || '', '2106': d.gratificacion || '', '2113': d.otros_imponibles || '',
          '2301': d.colacion || '', '2302': d.movilizacion || '', '2306': d.otros_no_imponibles || '',
          '3141': d.desc_afp || 0, '3143': d.desc_salud || 0, '3144': d.desc_salud_adicional || '',
          '3151': d.desc_afc || '', '3161': d.impuesto || 0, '3183': d.otros_descuentos || '',
          '4151': d.aporte_afc_emp || '', '4152': d.aporte_mutual || 0, '4155': d.aporte_sis || 0,
          '5201': d.total_haberes || 0, '5210': d.total_imponible || 0, '5220': 0, '5230': noImp, '5240': 0,
          '5301': d.total_descuentos || 0, '5361': d.impuesto || 0, '5341': cotiz,
          '5302': Math.max(0, (d.total_descuentos || 0) - (d.impuesto || 0) - cotiz),
          '5410': aportes, '5501': d.liquido || 0, '5564': 0,
          _nombre: l.nombre,
        };
      });
    } else {
      // Fuente 2: auxiliar AVSOFT (referencial: sin desglose fino de haberes)
      const [rem] = await pool.query('SELECT * FROM ctb_remun_aux WHERE mes=?', [mes]);
      if (!rem.length) return fail(res, `No hay remuneraciones para ${mes} (ni emitidas en el motor ni importadas de AVSOFT)`, 404);
      fuente = 'AVSOFT';
      const [usrs] = await pool.query("SELECT rut, fecha_ingreso, id_usuario FROM usuarios WHERE rut IS NOT NULL");
      const uMap = {}; usrs.forEach(u => uMap[nRut(u.rut)] = u);
      const [fichas] = await pool.query('SELECT f.id_usuario, f.afp, f.salud FROM rh_fichas f');
      const fMap = {}; fichas.forEach(f => fMap[f.id_usuario] = f);
      filas = rem.map(r => {
        const rut = nRut(r.rut);
        const u = uMap[rut] || {};
        const cotiz = Number(r.afp_monto) + Number(r.salud_monto);
        const resto = Math.max(0, Number(r.imponible) - Number(r.sueldo_base));
        const noImp = Math.max(0, Number(r.haberes) - Number(r.imponible));
        const otrosDesc = Math.max(0, Number(r.descuentos) - cotiz - Number(r.impuesto_unico) - Number(r.seg_ces_emp) * 0);
        return {
          '1101': rut, '1102': lreFecha(u.fecha_ingreso), '1105': 13, '1106': 13114, '1170': 1, '1146': 0, '1107': 101,
          '1108': 0, '1109': 0, '1141': afpCod(r.afp_nombre), '1142': 0, '1143': salCod(r.salud_nombre),
          '1151': 1, '1110': 1, '1152': 2,
          '1115': r.dias || 30, '1116': licDias[rut] || '', '1118': 0, '1155': 0, '1157': 0, '1131': 0,
          '2101': Number(r.sueldo_base) || 0, '2103': '', '2106': '', '2113': resto || '',
          '2301': '', '2302': '', '2306': noImp || '',
          '3141': Number(r.afp_monto) || 0, '3143': Number(r.salud_monto) || 0, '3144': '',
          '3151': '', '3161': Number(r.impuesto_unico) || 0, '3183': otrosDesc || '',
          '4151': '', '4152': '', '4155': Number(r.sis_emp) || '',
          '5201': Number(r.haberes) || 0, '5210': Number(r.imponible) || 0, '5220': 0, '5230': noImp, '5240': 0,
          '5301': Number(r.descuentos) || 0, '5361': Number(r.impuesto_unico) || 0, '5341': cotiz,
          '5302': otrosDesc, '5410': Number(r.sis_emp) + Number(r.seg_ces_emp), '5501': Number(r.liquido) || 0, '5564': 0,
          _nombre: r.nombre,
        };
      });
    }
    ok(res, { mes, fuente, columnas: LRE_COLS, filas, archivo: `76545638-K_${mes.replace('-', '')}.csv` });
  } catch (e) { console.error('[ctb lre]', e.message); fail(res, e.message); }
};

/* ── Libros Auxiliares (/contabilidad/libros-auxiliares/) ─────────────────────
   Consulta completa de los auxiliares importados (compras, honorarios) con
   filtros y totales por mes. Solo lectura: la importación vive en el
   directorio y en esta misma página. */
require('../../../../shared/migrate').enFila('contabilidad-libros-aux', async () => {
  try {
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='ctb_libros_aux' LIMIT 1");
    let idf = ex?.id_funcionalidad;
    if (!idf) {
      const [r] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (500003,'Libros Auxiliares','ctb_libros_aux','/contabilidad/libros-auxiliares/','bi-journals')");
      idf = r.insertId;
    }
    for (const idp of [1, 90003, 90007, 90009])
      await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
    console.log('[contabilidad] libros auxiliares listos');
  } catch (e) { console.error('[contabilidad-libros-aux migration]', e.message); }
});

exports.listaComprasAux = async (req, res) => {
  try {
    const { desde, hasta, q, cuenta } = req.query;
    const w = [], p = [];
    if (/^\d{4}-\d{2}$/.test(desde || '')) { w.push('mes >= ?'); p.push(desde); }
    if (/^\d{4}-\d{2}$/.test(hasta || '')) { w.push('mes <= ?'); p.push(hasta); }
    if (q) { w.push('(razon_social LIKE ? OR rut LIKE ? OR num_doc LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (cuenta) { w.push('(cuenta_gasto LIKE ? OR cuenta_cxp LIKE ?)'); p.push(`${cuenta}%`, `${cuenta}%`); }
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const [docs] = await pool.query(`SELECT * FROM ctb_compras_aux ${where} ORDER BY mes DESC, total DESC LIMIT 1000`, p);
    const [meses] = await pool.query(
      `SELECT mes, COUNT(*) docs, SUM(neto) neto, SUM(exento) exento, SUM(iva) iva, SUM(total) total
         FROM ctb_compras_aux ${where} GROUP BY mes ORDER BY mes DESC`, p);
    const [[tot]] = await pool.query(`SELECT COUNT(*) docs, COALESCE(SUM(neto),0) neto, COALESCE(SUM(iva),0) iva, COALESCE(SUM(total),0) total FROM ctb_compras_aux ${where}`, p);
    ok(res, { documentos: docs, meses, total: tot, truncado: docs.length === 1000 });
  } catch (e) { fail(res, e.message); }
};

exports.listaHonorariosAux = async (req, res) => {
  try {
    const { desde, hasta, q, cuenta } = req.query;
    const w = [], p = [];
    if (/^\d{4}-\d{2}$/.test(desde || '')) { w.push('mes >= ?'); p.push(desde); }
    if (/^\d{4}-\d{2}$/.test(hasta || '')) { w.push('mes <= ?'); p.push(hasta); }
    if (q) { w.push('(nombre LIKE ? OR rut LIKE ? OR num_boleta LIKE ? OR glosa LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    if (cuenta) { w.push('cuenta_gasto LIKE ?'); p.push(`${cuenta}%`); }
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const [docs] = await pool.query(`SELECT * FROM ctb_honorarios_aux ${where} ORDER BY mes DESC, bruto DESC LIMIT 1000`, p);
    const [meses] = await pool.query(
      `SELECT mes, COUNT(*) docs, SUM(bruto) bruto, SUM(retencion) retencion, SUM(liquido) liquido
         FROM ctb_honorarios_aux ${where} GROUP BY mes ORDER BY mes DESC`, p);
    const [[tot]] = await pool.query(`SELECT COUNT(*) docs, COALESCE(SUM(bruto),0) bruto, COALESCE(SUM(retencion),0) retencion, COALESCE(SUM(liquido),0) liquido FROM ctb_honorarios_aux ${where}`, p);
    ok(res, { documentos: docs, meses, total: tot, truncado: docs.length === 1000 });
  } catch (e) { fail(res, e.message); }
};

/* CRUD de rubros (botón Configurar rubros en la página) */
exports.getDirRubros = async (req, res) => {
  try { const [rows] = await pool.query('SELECT * FROM ctb_dir_rubros ORDER BY cuadro, orden, id'); ok(res, rows); }
  catch (e) { fail(res, e.message); }
};
exports.putDirRubro = async (req, res) => {
  try {
    const { etiqueta, grupo, prefijos, orden, activo } = req.body || {};
    const sets = [], vals = [];
    if (etiqueta !== undefined) { sets.push('etiqueta=?'); vals.push(String(etiqueta).trim().slice(0, 120)); }
    if (grupo !== undefined) { sets.push('grupo=?'); vals.push(String(grupo).trim().slice(0, 80) || null); }
    if (prefijos !== undefined) { sets.push('prefijos=?'); vals.push(String(prefijos).trim() || null); }
    if (orden !== undefined) { sets.push('orden=?'); vals.push(Number(orden) || 0); }
    if (activo !== undefined) { sets.push('activo=?'); vals.push(activo ? 1 : 0); }
    if (!sets.length) return fail(res, 'Nada que actualizar', 400);
    vals.push(req.params.id);
    const [r] = await pool.query(`UPDATE ctb_dir_rubros SET ${sets.join(', ')} WHERE id=?`, vals);
    if (!r.affectedRows) return fail(res, 'No existe', 404);
    auditar({ req, accion: 'EDITAR', modulo: 'contabilidad', entidad: 'dir_rubro', entidad_id: req.params.id, detalle: JSON.stringify(req.body) });
    ok(res, { id: Number(req.params.id) });
  } catch (e) { fail(res, e.message); }
};
exports.crearDirRubro = async (req, res) => {
  try {
    const { cuadro, grupo, etiqueta, tipo, prefijos, orden } = req.body || {};
    if (!['BALANCE', 'EERR'].includes(cuadro)) return fail(res, 'cuadro inválido', 400);
    if (!etiqueta) return fail(res, 'etiqueta obligatoria', 400);
    if (cuadro === 'EERR' && !['INGRESO', 'GASTO'].includes(tipo)) return fail(res, 'tipo INGRESO/GASTO obligatorio en EERR', 400);
    const [r] = await pool.query(
      "INSERT INTO ctb_dir_rubros (cuadro, grupo, etiqueta, clase, tipo, prefijos, orden) VALUES (?,?,?,'RUBRO',?,?,?)",
      [cuadro, grupo || null, String(etiqueta).trim().slice(0, 120), cuadro === 'EERR' ? tipo : null, String(prefijos || '').trim() || null, Number(orden) || 0]);
    auditar({ req, accion: 'CREAR', modulo: 'contabilidad', entidad: 'dir_rubro', entidad_id: r.insertId, detalle: etiqueta });
    ok(res, { id: r.insertId });
  } catch (e) { fail(res, e.message); }
};
exports.eliminarDirRubro = async (req, res) => {
  try {
    const [r] = await pool.query("DELETE FROM ctb_dir_rubros WHERE id=? AND clase='RUBRO'", [req.params.id]);
    if (!r.affectedRows) return fail(res, 'No existe (los márgenes no se eliminan, se desactivan)', 404);
    auditar({ req, accion: 'ELIMINAR', modulo: 'contabilidad', entidad: 'dir_rubro', entidad_id: req.params.id, detalle: 'Rubro eliminado' });
    ok(res, { id: Number(req.params.id) });
  } catch (e) { fail(res, e.message); }
};

exports.directorioMes = async (req, res) => {
  try {
    const mes = req.query.mes;
    if (!/^\d{4}-\d{2}$/.test(mes || '')) return fail(res, 'mes (YYYY-MM) obligatorio', 400);
    const [y, m] = mes.split('-').map(Number);
    const mesAnt = mesAnteriorDe(mes);
    const finMes = finDeMes(mes), finAnt = finDeMes(mesAnt);
    const iniMes = `${mes}-01`, iniAnio = `${y}-01-01`;
    const mesAA = `${y - 1}-${String(m).padStart(2, '0')}`;               // mismo mes año anterior
    const finAA = finDeMes(mesAA), iniAA = `${mesAA}-01`, iniAnioAA = `${y - 1}-01-01`;

    // Balance: saldo por cuenta al fin de mes y al fin del mes anterior (una pasada)
    const [bal] = await pool.query(
      `SELECT m.cuenta, k.nombre, k.tipo,
              SUM(CASE WHEN c.fecha <= ? THEN m.debe - m.haber ELSE 0 END) s_actual,
              SUM(CASE WHEN c.fecha <= ? THEN m.debe - m.haber ELSE 0 END) s_anterior
         FROM ctb_movimientos m
         JOIN ctb_comprobantes c ON c.id = m.id_comprobante
         JOIN ctb_cuentas k ON k.codigo = m.cuenta
        WHERE c.estado='CONTABILIZADO' AND c.fecha <= ? AND k.tipo IN ('ACTIVO','PASIVO','PATRIMONIO')
        GROUP BY m.cuenta, k.nombre, k.tipo HAVING ABS(s_actual) > 0.5 OR ABS(s_anterior) > 0.5
        ORDER BY m.cuenta`, [finMes, finAnt, finMes]);

    // EERR: mes / acumulado, año actual y año anterior (una pasada, excluye cierre de ejercicio)
    const [eerr] = await pool.query(
      `SELECT m.cuenta, k.nombre, k.tipo,
              SUM(CASE WHEN c.fecha BETWEEN ? AND ? THEN (CASE WHEN k.tipo='INGRESO' THEN m.haber-m.debe ELSE m.debe-m.haber END) ELSE 0 END) mes_actual,
              SUM(CASE WHEN c.fecha BETWEEN ? AND ? THEN (CASE WHEN k.tipo='INGRESO' THEN m.haber-m.debe ELSE m.debe-m.haber END) ELSE 0 END) mes_aa,
              SUM(CASE WHEN c.fecha BETWEEN ? AND ? THEN (CASE WHEN k.tipo='INGRESO' THEN m.haber-m.debe ELSE m.debe-m.haber END) ELSE 0 END) acum_actual,
              SUM(CASE WHEN c.fecha BETWEEN ? AND ? THEN (CASE WHEN k.tipo='INGRESO' THEN m.haber-m.debe ELSE m.debe-m.haber END) ELSE 0 END) acum_aa
         FROM ctb_movimientos m
         JOIN ctb_comprobantes c ON c.id = m.id_comprobante
         JOIN ctb_cuentas k ON k.codigo = m.cuenta
        WHERE c.estado='CONTABILIZADO' AND c.origen<>'CIERRE_EJERCICIO' AND k.tipo IN ('INGRESO','GASTO')
          AND ((c.fecha BETWEEN ? AND ?) OR (c.fecha BETWEEN ? AND ?))
        GROUP BY m.cuenta, k.nombre, k.tipo
        HAVING ABS(mes_actual)+ABS(mes_aa)+ABS(acum_actual)+ABS(acum_aa) > 0.5
        ORDER BY k.tipo DESC, m.cuenta`,
      [iniMes, finMes, iniAA, finAA, iniAnio, finMes, iniAnioAA, finAA, iniAnio, finMes, iniAnioAA, finAA]);

    // Movimiento de caja y bancos del mes (cuentas 1101/1102/1103)
    const [caja] = await pool.query(
      `SELECT m.cuenta, k.nombre,
              SUM(CASE WHEN c.fecha < ? THEN m.debe - m.haber ELSE 0 END) saldo_ini,
              SUM(CASE WHEN c.fecha BETWEEN ? AND ? THEN m.debe ELSE 0 END) entradas,
              SUM(CASE WHEN c.fecha BETWEEN ? AND ? THEN m.haber ELSE 0 END) salidas
         FROM ctb_movimientos m
         JOIN ctb_comprobantes c ON c.id = m.id_comprobante
         JOIN ctb_cuentas k ON k.codigo = m.cuenta
        WHERE c.estado='CONTABILIZADO' AND c.fecha <= ?
          AND (m.cuenta LIKE '1101%' OR m.cuenta LIKE '1102%' OR m.cuenta LIKE '1103%')
        GROUP BY m.cuenta, k.nombre
        HAVING ABS(saldo_ini)+entradas+salidas > 0.5 ORDER BY m.cuenta`,
      [iniMes, iniMes, finMes, iniMes, finMes, finMes]);

    const [[tc]] = await pool.query('SELECT DATE_FORMAT(fecha,"%Y-%m-%d") fecha, valor FROM dolar WHERE fecha <= ? ORDER BY fecha DESC LIMIT 1', [finMes]);
    const [hechos] = await pool.query('SELECT seccion, texto, actualizado_por, updated_at FROM ctb_dir_hechos WHERE mes=?', [mes]);
    ok(res, {
      mes, fin_mes: finMes, mes_anterior: mesAnt, mes_aa: mesAA,
      tipo_cambio: tc ? { fecha: tc.fecha, valor: Number(tc.valor) } : null,
      balance: bal.map(x => ({ ...x, s_actual: Number(x.s_actual), s_anterior: Number(x.s_anterior) })),
      eerr: eerr.map(x => ({ ...x, mes_actual: Number(x.mes_actual), mes_aa: Number(x.mes_aa), acum_actual: Number(x.acum_actual), acum_aa: Number(x.acum_aa) })),
      caja: caja.map(x => ({ ...x, saldo_ini: Number(x.saldo_ini), entradas: Number(x.entradas), salidas: Number(x.salidas) })),
      hechos: Object.fromEntries(hechos.map(h => [h.seccion, { texto: h.texto, actualizado_por: h.actualizado_por, updated_at: h.updated_at }])),
    });
  } catch (e) { fail(res, e.message); }
};

const SECCIONES_DIR = ['BALANCE', 'CXC', 'CXP', 'EERR_MES', 'EERR_ACUM', 'CAJA', 'COMPRAS', 'HONORARIOS'];

exports.guardarHechoDirectorio = async (req, res) => {
  try {
    const { mes, seccion, texto } = req.body || {};
    if (!/^\d{4}-\d{2}$/.test(mes || '')) return fail(res, 'mes inválido', 400);
    // AN_<sección> = análisis del analista IA que se muestra sobre los hechos
    const base = String(seccion || '').replace(/^AN_/, '');
    if (!SECCIONES_DIR.includes(base)) return fail(res, 'Sección inválida', 400);
    await pool.query(
      `INSERT INTO ctb_dir_hechos (mes, seccion, texto, actualizado_por) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE texto=VALUES(texto), actualizado_por=VALUES(actualizado_por)`,
      [mes, seccion, String(texto || '').slice(0, 8000), nombreDe(req.user)]);
    auditar({ req, accion: 'EDITAR', modulo: 'contabilidad', entidad: 'directorio_hechos', entidad_id: `${mes}/${seccion}`, detalle: 'Hechos relevantes guardados' });
    ok(res, { mes, seccion });
  } catch (e) { fail(res, e.message); }
};

exports.hechosDirectorioIA = async (req, res) => {
  try {
    const { mes, seccion, datos, modo } = req.body || {};
    if (!/^\d{4}-\d{2}$/.test(mes || '')) return fail(res, 'mes inválido', 400);
    if (!SECCIONES_DIR.includes(seccion)) return fail(res, 'Sección inválida', 400);
    const NOMBRES = { BALANCE: 'Balance General', CXC: 'Cuentas por Cobrar', CXP: 'Cuentas por Pagar', EERR_MES: 'Resultados del mes', EERR_ACUM: 'Resultados acumulados vs año anterior', CAJA: 'Caja y bancos', COMPRAS: 'Compras del mes (facturas de proveedores)', HONORARIOS: 'Honorarios del mes (boletas de profesionales)' };
    const { analizar } = require('../../../../shared/anthropic');
    const esAnalisis = modo === 'analisis';
    const out = await analizar({
      codigo: 'ctb_directorio_ia',
      id_usuario: (req.usuario || req.user || {}).id_usuario || null,
      system: esAnalisis
        ? 'Eres el analista financiero de AutoFácil Chile (crédito automotriz). Escribes el ANÁLISIS de una lámina de la presentación mensual al directorio (matriz en Ecuador): lectura ejecutiva de las cifras, no una lista de hechos. Montos en millones de pesos con una decimal ("$207,6 Millones"), directo, sin adornos. NO inventes cifras: usa solo los datos entregados.'
        : 'Eres el gerente de finanzas de AutoFácil Chile (crédito automotriz). Escribes los "Hechos Relevantes" de la presentación mensual al directorio (matriz en Ecuador). Estilo del directorio: puntos numerados 1), 2)…, montos en millones de pesos con una decimal ("$207,6 Millones"), directo, sin adornos. NO inventes cifras: usa solo los datos entregados.',
      prompt: `Lámina: ${NOMBRES[seccion]} — mes ${mes}.\nCifras de la lámina (JSON):\n${JSON.stringify(datos || {}).slice(0, 14000)}\n\n` + (esAnalisis
        ? 'Escribe un análisis breve (2-4 frases corridas, sin numerar): la lectura principal de la lámina, la variación que más pesa y su implicancia para el directorio. Si hay presupuesto (ppto) en los datos, compara contra él. Sin encabezado ni cierre.'
        : 'Escribe 3-6 "Hechos Relevantes" numerados (1), 2)…) para el directorio: qué cambió contra el período de comparación, qué explica las variaciones grandes y qué debe saber o decidir el directorio. Sin encabezado ni cierre: solo los puntos.'),
      max_tokens: 1024,
    });
    if (!out || !out.texto) return fail(res, 'La IA no devolvió borrador', 502);
    ok(res, { borrador: out.texto.trim() });
  } catch (e) {
    console.error('[ctb directorioIA]', e.message);
    fail(res, 'No se pudo generar el borrador: ' + e.message, 502);
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
