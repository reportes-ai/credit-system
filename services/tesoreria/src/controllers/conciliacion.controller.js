'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   CONCILIACIÓN BANCARIA (Tesorería) — matchea los movimientos de la cartola del
   banco contra lo registrado en el sistema:
     · ABONOS (+)  → pagos de cuotas (pagos_credito por TRX / cuotas_credito PAGADA)
     · CARGOS (−)  → órdenes de pago PAGADAS (ordenes_pago)
   Fuente de la cartola:
     · Fintoc (banco_movimientos, sync automático) cuando esté contratado, o
     · CARGA MANUAL de la cartola Excel del banco (este módulo) — misma tabla
       banco_movimientos, con cuenta manual (link_token='MANUAL') e idempotencia
       por hash (fintoc_id='MAN-<sha1>'), así al llegar Fintoc NADA cambia aquí.
   La conciliación marca el movimiento (conciliado/match_tipo/match_ref) — nunca
   toca los pagos ni las ODP: es una capa de verificación, no de registro.
   ───────────────────────────────────────────────────────────────────────────── */
const crypto = require('crypto');
const XLSX = require('xlsx');
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });

/* ── Migración ──────────────────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('conciliacion-bancaria', async () => {
  try {
    // Columnas de conciliación sobre la cartola existente (banco_movimientos)
    const [cols] = await pool.query("SHOW COLUMNS FROM banco_movimientos");
    const has = (c) => cols.some(x => x.Field === c);
    const alters = [];
    if (!has('conciliado'))         alters.push("ADD COLUMN conciliado TINYINT(1) DEFAULT 0");
    if (!has('match_tipo'))         alters.push("ADD COLUMN match_tipo VARCHAR(20) NULL");     // TRX | CUOTA | ODP | MANUAL
    if (!has('match_ref'))          alters.push("ADD COLUMN match_ref VARCHAR(80) NULL");
    if (!has('match_detalle'))      alters.push("ADD COLUMN match_detalle VARCHAR(300) NULL");
    if (!has('conciliado_por'))     alters.push("ADD COLUMN conciliado_por VARCHAR(120) NULL");
    if (!has('fecha_conciliacion')) alters.push("ADD COLUMN fecha_conciliacion DATETIME NULL");
    if (!has('origen'))             alters.push("ADD COLUMN origen VARCHAR(10) DEFAULT 'FINTOC'"); // FINTOC | MANUAL
    if (alters.length) await pool.query('ALTER TABLE banco_movimientos ' + alters.join(', '));

    await pool.query(`
      CREATE TABLE IF NOT EXISTS banco_cartola_cargas (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        id_conexion INT NOT NULL,
        archivo     VARCHAR(255) NULL,
        filas       INT DEFAULT 0,
        nuevas      INT DEFAULT 0,
        duplicadas  INT DEFAULT 0,
        usuario     VARCHAR(120) NULL,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

    // Card en Tesorería + permiso Administrador
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Tesorería' OR ruta LIKE '/tesoreria%' LIMIT 1");
    if (mod) {
      const f = { codigo: 'conciliacion_bancaria', nombre: 'Conciliación Bancaria', href: '/tesoreria/conciliacion-bancaria', icono: 'bi-check2-square' };
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [f.codigo]);
      let idF = ex && ex.id_funcionalidad;
      if (!idF) {
        const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
          [mod.id_modulo, f.nombre, f.codigo, f.href, f.icono]);
        idF = r.insertId;
      }
      await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idF]);
    }
    console.log('[conciliacion-bancaria] módulo listo');
  } catch (e) { console.error('[conciliacion-bancaria migration]', e.message); }
});

/* ── Cuentas (Fintoc + manuales) ────────────────────────────────────────────── */
const cuentas = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT c.id, c.banco, c.alias, c.numero, c.moneda, c.activo,
             (c.link_token='MANUAL') AS es_manual,
             c.saldo_disponible, c.saldo_actualizado,
             SUM(CASE WHEN m.id IS NOT NULL AND COALESCE(m.conciliado,0)=0 THEN 1 ELSE 0 END) AS pendientes,
             SUM(CASE WHEN COALESCE(m.conciliado,0)=1 THEN 1 ELSE 0 END) AS conciliados,
             MAX(m.fecha) AS ultima_fecha
      FROM banco_conexiones c
      LEFT JOIN banco_movimientos m ON m.id_conexion = c.id
      WHERE c.activo=1
      GROUP BY c.id ORDER BY c.banco, c.alias`);
    ok(res, rows);
  } catch (e) { fail(res, e.message); }
};

const crearCuentaManual = async (req, res) => {
  try {
    const { banco, alias, numero } = req.body || {};
    if (!banco || !numero) return fail(res, 'Banco y número de cuenta son obligatorios', 400);
    const [r] = await pool.query(
      "INSERT INTO banco_conexiones (banco, alias, link_token, numero, moneda, activo) VALUES (?,?, 'MANUAL', ?, 'CLP', 1)",
      [String(banco).trim(), (alias || '').trim() || null, String(numero).trim()]);
    auditar({ req, accion: 'CREAR', modulo: 'tesoreria', entidad: 'banco_conexiones', entidad_id: r.insertId,
      detalle: `Creó cuenta manual para conciliación: ${banco} ${numero}` });
    ok(res, { id: r.insertId });
  } catch (e) { fail(res, e.message); }
};

/* ── Parser genérico de cartola Excel ───────────────────────────────────────────
   Los bancos chilenos exportan formatos distintos; se detecta la fila de
   encabezados buscando "fecha" + alguna columna de monto, y se mapean columnas
   por nombre. Soporta cargo/abono en columnas separadas o un solo monto firmado. */
function parseFecha(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 60000) {          // serial Excel
    const d = new Date(Date.UTC(1899, 11, 30) + v * 864e5);
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);   // dd/mm/yyyy
  if (m) {
    let y = +m[3]; if (y < 100) y += 2000;
    return `${y}-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);                     // yyyy-mm-dd
  if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
  return null;
}
function parseMonto(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  // es-CL: punto de miles, coma decimal; también tolera formato en-US
  let s = String(v).replace(/[$\s]/g, '');
  const neg = /^\(.*\)$/.test(s) || /-/.test(s);
  s = s.replace(/[()-]/g, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');          // 1.234.567,89 → es-CL con decimales
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');             // 320.192 → puntos de miles es-CL
  else s = s.replace(/,/g, '');                                                 // 1,234,567.89 → en-US
  const n = parseFloat(s);
  return isNaN(n) ? 0 : (neg ? -n : n);
}
function parsearCartola(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const low = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  // Detectar fila de encabezados (primeras 20 filas)
  let hIdx = -1, map = {};
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cells = rows[i].map(low);
    const iF = cells.findIndex(c => /fecha/.test(c));
    if (iF < 0) continue;
    const iCargo = cells.findIndex(c => /(cargo|debito|giro)/.test(c) && !/fecha/.test(c));
    const iAbono = cells.findIndex(c => /(abono|credito|deposito)/.test(c) && !/fecha/.test(c));
    const iMonto = cells.findIndex(c => /^monto|importe/.test(c));
    if (iCargo < 0 && iAbono < 0 && iMonto < 0) continue;
    const iDesc = cells.findIndex(c => /(descripc|detalle|glosa|movimiento|concepto|transacc)/.test(c));
    const iDoc  = cells.findIndex(c => /(n.*doc|documento|nro|serial)/.test(c) && !/fecha/.test(c));
    hIdx = i; map = { iF, iCargo, iAbono, iMonto, iDesc, iDoc };
    break;
  }
  if (hIdx < 0) throw new Error('No se encontró la fila de encabezados (se busca una columna "Fecha" y columnas de Cargo/Abono o Monto).');

  const movs = [];
  for (let i = hIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const fecha = parseFecha(r[map.iF]);
    if (!fecha) continue;                                          // filas de totales/pie
    let monto;
    if (map.iCargo >= 0 || map.iAbono >= 0) {
      const cargo = map.iCargo >= 0 ? Math.abs(parseMonto(r[map.iCargo])) : 0;
      const abono = map.iAbono >= 0 ? Math.abs(parseMonto(r[map.iAbono])) : 0;
      monto = abono - cargo;                                       // + abono / − cargo
    } else monto = parseMonto(r[map.iMonto]);
    if (!monto) continue;
    movs.push({
      fecha, monto,
      descripcion: map.iDesc >= 0 ? String(r[map.iDesc] || '').trim().slice(0, 400) : '',
      documento:   map.iDoc  >= 0 ? String(r[map.iDoc]  || '').trim().slice(0, 60)  : '',
    });
  }
  return movs;
}
// Hash idempotente: mismo archivo re-cargado no duplica; movimientos idénticos
// legítimos (misma fecha/monto/glosa) se distinguen por su nº de ocurrencia.
function hashMovs(idConexion, movs) {
  const seen = {};
  return movs.map(m => {
    const base = `${idConexion}|${m.fecha}|${m.monto}|${m.descripcion}|${m.documento}`;
    seen[base] = (seen[base] || 0) + 1;
    const h = crypto.createHash('sha1').update(base + '|' + seen[base]).digest('hex');
    return { ...m, fintoc_id: 'MAN-' + h.slice(0, 32) };
  });
}

/* ── Carga de cartola (preview + importar) ──────────────────────────────────── */
const previewCartola = async (req, res) => {
  try {
    if (!req.file) return fail(res, 'Adjunta el archivo Excel de la cartola', 400);
    const idConexion = parseInt(req.params.id, 10);
    const [[cx]] = await pool.query('SELECT id FROM banco_conexiones WHERE id=? LIMIT 1', [idConexion]);
    if (!cx) return fail(res, 'Cuenta no encontrada', 404);
    const movs = hashMovs(idConexion, parsearCartola(req.file.buffer));
    if (!movs.length) return fail(res, 'El archivo no contiene movimientos reconocibles.', 400);

    const hashes = movs.map(m => m.fintoc_id);
    const [ex] = await pool.query('SELECT fintoc_id FROM banco_movimientos WHERE fintoc_id IN (?)', [hashes]);
    const dupSet = new Set(ex.map(r => r.fintoc_id));
    const nuevas = movs.filter(m => !dupSet.has(m.fintoc_id));
    ok(res, {
      filas: movs.length, nuevas: nuevas.length, duplicadas: movs.length - nuevas.length,
      abonos: movs.filter(m => m.monto > 0).length, cargos: movs.filter(m => m.monto < 0).length,
      desde: movs.reduce((a, m) => m.fecha < a ? m.fecha : a, movs[0].fecha),
      hasta: movs.reduce((a, m) => m.fecha > a ? m.fecha : a, movs[0].fecha),
      muestra: movs.slice(0, 15).map(m => ({ ...m, duplicado: dupSet.has(m.fintoc_id) })),
    });
  } catch (e) { fail(res, e.message, 400); }
};

const importarCartola = async (req, res) => {
  try {
    if (!req.file) return fail(res, 'Adjunta el archivo Excel de la cartola', 400);
    const idConexion = parseInt(req.params.id, 10);
    const [[cx]] = await pool.query('SELECT id, banco, numero FROM banco_conexiones WHERE id=? LIMIT 1', [idConexion]);
    if (!cx) return fail(res, 'Cuenta no encontrada', 404);
    const movs = hashMovs(idConexion, parsearCartola(req.file.buffer));
    if (!movs.length) return fail(res, 'El archivo no contiene movimientos reconocibles.', 400);

    let nuevas = 0;
    for (const m of movs) {
      const [r] = await pool.query(
        `INSERT IGNORE INTO banco_movimientos (id_conexion, fintoc_id, fecha, monto, moneda, descripcion, tipo, origen)
         VALUES (?,?,?,?,'CLP',?,?, 'MANUAL')`,
        [idConexion, m.fintoc_id, m.fecha, m.monto, m.descripcion || null, m.documento ? ('DOC ' + m.documento) : null]);
      if (r.affectedRows === 1) nuevas++;
    }
    await pool.query(
      'INSERT INTO banco_cartola_cargas (id_conexion, archivo, filas, nuevas, duplicadas, usuario) VALUES (?,?,?,?,?,?)',
      [idConexion, req.file.originalname || null, movs.length, nuevas, movs.length - nuevas, req.user && (req.user.nombre || req.user.email) || null]);
    auditar({ req, accion: 'IMPORTAR', modulo: 'tesoreria', entidad: 'banco_cartola', entidad_id: idConexion,
      detalle: `Cargó cartola ${cx.banco} ${cx.numero || ''}: ${movs.length} filas, ${nuevas} nuevas (${req.file.originalname || 'archivo'})` });
    ok(res, { filas: movs.length, nuevas, duplicadas: movs.length - nuevas });
  } catch (e) { fail(res, e.message, 400); }
};

/* ── Motor de sugerencias (matching automático) ──────────────────────────────
   Regla: monto EXACTO + fecha dentro de la ventana (±3 días pagos, ±5 ODP).
   Nunca sugiere una referencia ya usada en otra conciliación. */
const TOL_DIAS_PAGO = 3, TOL_DIAS_ODP = 5;
const difDias = (a, b) => Math.abs((new Date(a) - new Date(b)) / 864e5);

async function candidatos(desde, hasta) {
  const d1 = new Date(new Date(desde).getTime() - 7 * 864e5).toISOString().slice(0, 10);
  const d2 = new Date(new Date(hasta).getTime() + 7 * 864e5).toISOString().slice(0, 10);

  // Referencias ya conciliadas (no volver a sugerirlas)
  const [usadas] = await pool.query(
    "SELECT match_tipo, match_ref FROM banco_movimientos WHERE conciliado=1 AND match_ref IS NOT NULL");
  const usada = new Set(usadas.map(u => u.match_tipo + ':' + u.match_ref));

  // 1) Transacciones de caja (pagos_credito agrupado por TRX) — flujo nuevo
  const [trx] = await pool.query(`
    SELECT numero_transaccion ref, SUM(total_pagado) monto, MAX(fecha_pago) fecha,
           COUNT(*) cuotas, MAX(origen_fondos) origen_fondos,
           GROUP_CONCAT(DISTINCT id_credito) ids
    FROM pagos_credito
    WHERE fecha_pago BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
      AND (estado_pago IS NULL OR estado_pago NOT LIKE 'REVERS%')
      AND numero_transaccion IS NOT NULL
    GROUP BY numero_transaccion`, [d1, d2]);

  // 2) Cuotas pagadas del calendario (histórico/migración) — agrupadas por op+fecha
  const [cuotas] = await pool.query(`
    SELECT CONCAT(num_op, '@', fecha_pago) ref, num_op, fecha_pago fecha,
           SUM(valor_cuota) monto, COUNT(*) n, GROUP_CONCAT(numero_cuota ORDER BY numero_cuota) nums
    FROM cuotas_credito
    WHERE estado_cuota='PAGADA' AND fecha_pago BETWEEN ? AND ?
    GROUP BY num_op, fecha_pago`, [d1, d2]);

  // 3) ODP pagadas (egresos)
  const [odps] = await pool.query(`
    SELECT numero ref, monto, COALESCE(fecha_pago, fecha_emision) fecha,
           proveedor_nombre, concepto
    FROM ordenes_pago
    WHERE estado='PAGADA' AND COALESCE(fecha_pago, fecha_emision) BETWEEN ? AND ?`, [d1, d2]);

  return {
    trx:    trx.filter(t => !usada.has('TRX:' + t.ref)),
    cuotas: cuotas.filter(c => !usada.has('CUOTA:' + c.ref)),
    odps:   odps.filter(o => !usada.has('ODP:' + o.ref)),
  };
}

function sugerirPara(mov, cand) {
  const sug = [];
  const monto = Number(mov.monto);
  if (monto > 0) {
    for (const t of cand.trx)
      if (Math.abs(Number(t.monto) - monto) < 1 && difDias(mov.fecha, t.fecha) <= TOL_DIAS_PAGO)
        sug.push({ tipo: 'TRX', ref: String(t.ref), fecha: t.fecha,
          detalle: `TRX-${String(t.ref).padStart(6, '0')} · ${t.cuotas} cuota(s) · ${t.origen_fondos || 'caja'}` });
    for (const c of cand.cuotas)
      if (Math.abs(Number(c.monto) - monto) < 1 && difDias(mov.fecha, c.fecha) <= TOL_DIAS_PAGO)
        sug.push({ tipo: 'CUOTA', ref: c.ref, fecha: c.fecha,
          detalle: `Op ${c.num_op} · cuota(s) ${c.nums}` });
  } else if (monto < 0) {
    for (const o of cand.odps)
      if (Math.abs(Number(o.monto) - Math.abs(monto)) < 1 && difDias(mov.fecha, o.fecha) <= TOL_DIAS_ODP)
        sug.push({ tipo: 'ODP', ref: o.ref, fecha: o.fecha,
          detalle: `${o.ref} · ${o.proveedor_nombre || ''} · ${(o.concepto || '').slice(0, 60)}` });
  }
  // Las de fecha más cercana primero; máximo 5 por movimiento
  sug.sort((a, b) => difDias(mov.fecha, a.fecha) - difDias(mov.fecha, b.fecha));
  return sug.slice(0, 5);
}

/* ── Pendientes / conciliados / resumen ─────────────────────────────────────── */
const pendientes = async (req, res) => {
  try {
    const idConexion = parseInt(req.params.id, 10);
    const { desde, hasta } = req.query;
    const cond = ['id_conexion=?', 'COALESCE(conciliado,0)=0']; const args = [idConexion];
    if (desde) { cond.push('fecha>=?'); args.push(desde); }
    if (hasta) { cond.push('fecha<=?'); args.push(hasta); }
    const [movs] = await pool.query(
      `SELECT id, fecha, monto, descripcion, tipo, origen FROM banco_movimientos
       WHERE ${cond.join(' AND ')} ORDER BY fecha, id LIMIT 500`, args);
    if (!movs.length) return ok(res, { movimientos: [] });

    const f1 = movs[0].fecha, f2 = movs[movs.length - 1].fecha;
    const cand = await candidatos(f1, f2);
    ok(res, { movimientos: movs.map(m => ({ ...m, sugerencias: sugerirPara(m, cand) })) });
  } catch (e) { fail(res, e.message); }
};

const conciliados = async (req, res) => {
  try {
    const idConexion = parseInt(req.params.id, 10);
    const { desde, hasta } = req.query;
    const cond = ['id_conexion=?', 'conciliado=1']; const args = [idConexion];
    if (desde) { cond.push('fecha>=?'); args.push(desde); }
    if (hasta) { cond.push('fecha<=?'); args.push(hasta); }
    const [rows] = await pool.query(
      `SELECT id, fecha, monto, descripcion, match_tipo, match_ref, match_detalle, conciliado_por, fecha_conciliacion
       FROM banco_movimientos WHERE ${cond.join(' AND ')} ORDER BY fecha DESC, id DESC LIMIT 500`, args);
    ok(res, rows);
  } catch (e) { fail(res, e.message); }
};

const conciliar = async (req, res) => {
  try {
    const { id_mov, match_tipo, match_ref, detalle } = req.body || {};
    const tipos = ['TRX', 'CUOTA', 'ODP', 'MANUAL'];
    if (!id_mov || !tipos.includes(match_tipo)) return fail(res, 'id_mov y match_tipo válido son obligatorios', 400);
    if (match_tipo !== 'MANUAL' && !match_ref) return fail(res, 'match_ref es obligatorio para conciliación automática', 400);
    if (match_tipo === 'MANUAL' && !String(detalle || '').trim()) return fail(res, 'La conciliación manual requiere una glosa que la justifique', 400);

    const [[mov]] = await pool.query('SELECT * FROM banco_movimientos WHERE id=? LIMIT 1', [id_mov]);
    if (!mov) return fail(res, 'Movimiento no encontrado', 404);
    if (mov.conciliado) return fail(res, 'El movimiento ya está conciliado', 409);
    if (match_ref) {
      const [[dup]] = await pool.query(
        'SELECT id FROM banco_movimientos WHERE conciliado=1 AND match_tipo=? AND match_ref=? LIMIT 1', [match_tipo, match_ref]);
      if (dup) return fail(res, `Esa referencia ya está conciliada con otro movimiento (id ${dup.id})`, 409);
    }
    const usuario = req.user && (req.user.nombre || req.user.email) || null;
    await pool.query(
      `UPDATE banco_movimientos SET conciliado=1, match_tipo=?, match_ref=?, match_detalle=?, conciliado_por=?, fecha_conciliacion=NOW() WHERE id=?`,
      [match_tipo, match_ref || null, String(detalle || '').slice(0, 300) || null, usuario, id_mov]);
    auditar({ req, accion: 'CONCILIAR', modulo: 'tesoreria', entidad: 'banco_movimientos', entidad_id: id_mov,
      detalle: `Concilió mov ${mov.fecha ? String(mov.fecha).slice(0, 10) : ''} $${mov.monto} ← ${match_tipo} ${match_ref || '(manual)'} ${detalle || ''}`.trim() });
    ok(res, { conciliado: true });
  } catch (e) { fail(res, e.message); }
};

const desconciliar = async (req, res) => {
  try {
    const { id_mov } = req.body || {};
    const [[mov]] = await pool.query('SELECT * FROM banco_movimientos WHERE id=? LIMIT 1', [id_mov]);
    if (!mov) return fail(res, 'Movimiento no encontrado', 404);
    if (!mov.conciliado) return fail(res, 'El movimiento no está conciliado', 409);
    await pool.query(
      `UPDATE banco_movimientos SET conciliado=0, match_tipo=NULL, match_ref=NULL, match_detalle=NULL, conciliado_por=NULL, fecha_conciliacion=NULL WHERE id=?`,
      [id_mov]);
    auditar({ req, accion: 'DESCONCILIAR', modulo: 'tesoreria', entidad: 'banco_movimientos', entidad_id: id_mov,
      detalle: `Desconcilió mov $${mov.monto} (era ${mov.match_tipo} ${mov.match_ref || ''})` });
    ok(res, { desconciliado: true });
  } catch (e) { fail(res, e.message); }
};

const resumen = async (req, res) => {
  try {
    const idConexion = parseInt(req.params.id, 10);
    const { desde, hasta } = req.query;
    const cond = ['id_conexion=?']; const args = [idConexion];
    if (desde) { cond.push('fecha>=?'); args.push(desde); }
    if (hasta) { cond.push('fecha<=?'); args.push(hasta); }
    const [[r]] = await pool.query(`
      SELECT COUNT(*) total,
        SUM(CASE WHEN COALESCE(conciliado,0)=1 THEN 1 ELSE 0 END) conciliados,
        SUM(CASE WHEN COALESCE(conciliado,0)=0 THEN 1 ELSE 0 END) pendientes,
        SUM(CASE WHEN monto>0 THEN monto ELSE 0 END) abonos,
        SUM(CASE WHEN monto<0 THEN -monto ELSE 0 END) cargos,
        SUM(CASE WHEN COALESCE(conciliado,0)=0 THEN monto ELSE 0 END) monto_pendiente
      FROM banco_movimientos WHERE ${cond.join(' AND ')}`, args);
    const [cargas] = await pool.query(
      'SELECT * FROM banco_cartola_cargas WHERE id_conexion=? ORDER BY id DESC LIMIT 10', [idConexion]);
    ok(res, { ...r, cargas });
  } catch (e) { fail(res, e.message); }
};

module.exports = { cuentas, crearCuentaManual, previewCartola, importarCartola, pendientes, conciliados, conciliar, desconciliar, resumen };
