'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   CUENTAS CORRIENTES (Tesorería) — registro de los movimientos de las cuentas
   corrientes de la empresa, alimentado por la carga de cartolas del banco.

   Máximas respetadas:
   · Una sola fuente de datos: los movimientos viven en banco_movimientos (la
     MISMA tabla que usa Conciliación Bancaria y Fintoc). Este módulo es otra
     vista sobre esa fuente, no una copia.
   · Un solo motor: el parser de cartolas es el de conciliacion.controller
     (parsearCartola + hashMovs). Cargar aquí o en Conciliación da lo mismo:
     el hash idempotente anexa SOLO los movimientos que no estén.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { parsearCartola, hashMovs, cuentaNoCoincide } = require('./conciliacion.controller');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });

/* ── Migración: card + permiso (las columnas las crea conciliacion) ─────────── */
require('../../../../shared/migrate').enFila('cuentas-corrientes', async () => {
  try {
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Tesorería' OR ruta LIKE '/tesoreria%' LIMIT 1");
    if (mod) {
      const f = { codigo: 'tesoreria_cuentas_corrientes', nombre: 'Cuentas Corrientes', href: '/tesoreria/cuentas-corrientes.html', icono: 'bi-bank' };
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [f.codigo]);
      let idF = ex && ex.id_funcionalidad;
      if (!idF) {
        const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
          [mod.id_modulo, f.nombre, f.codigo, f.href, f.icono]);
        idF = r.insertId;
      }
      // Admin + los perfiles que operan tesorería (misma regla que el resto del módulo)
      await pool.query(`
        INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
        SELECT id_perfil, ?, 1 FROM perfiles
        WHERE nombre IN ('Administrador','Tesorero','Gerente de Finanzas','Analista Financiero')`, [idF]);
    }
    console.log('[cuentas-corrientes] módulo listo');
  } catch (e) { console.error('[cuentas-corrientes migration]', e.message); }
});

/* ── Cuentas con su saldo de cartola más reciente ───────────────────────────── */
const cuentas = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT c.id, c.banco, c.alias, c.numero, c.moneda, (c.link_token='MANUAL') AS es_manual,
             COUNT(m.id)  AS movimientos,
             MIN(m.fecha) AS primera_fecha,
             MAX(m.fecha) AS ultima_fecha,
             SUM(CASE WHEN m.monto>0 THEN m.monto ELSE 0 END) AS abonos,
             SUM(CASE WHEN m.monto<0 THEN -m.monto ELSE 0 END) AS cargos,
             (SELECT m2.saldo FROM banco_movimientos m2
               WHERE m2.id_conexion=c.id AND m2.saldo IS NOT NULL
               ORDER BY m2.fecha DESC, CAST(m2.n_movimiento AS UNSIGNED) DESC, m2.id DESC LIMIT 1) AS saldo_cartola
      FROM banco_conexiones c
      LEFT JOIN banco_movimientos m ON m.id_conexion = c.id
      WHERE c.activo=1
      GROUP BY c.id ORDER BY c.banco, c.alias`);
    ok(res, rows);
  } catch (e) { fail(res, e.message); }
};

/* ── Movimientos (filtros + paginación server-side) ─────────────────────────── */
const movimientos = async (req, res) => {
  try {
    const idConexion = parseInt(req.params.id, 10);
    if (!idConexion) return fail(res, 'Cuenta inválida', 400);
    const { desde, hasta, texto, tipo } = req.query;
    const pag  = Math.max(1, parseInt(req.query.pagina, 10) || 1);
    const por  = Math.min(500, Math.max(10, parseInt(req.query.por_pagina, 10) || 100));

    const cond = ['id_conexion=?']; const args = [idConexion];
    if (desde) { cond.push('fecha>=?'); args.push(desde); }
    if (hasta) { cond.push('fecha<=?'); args.push(hasta); }
    // UPPER en ambos lados: la tabla usa collation binaria (case-sensitive) y "zor" no encontraba "ZORZETTO"
    if (texto) { cond.push('(UPPER(descripcion) LIKE ? OR n_documento LIKE ? OR n_movimiento LIKE ?)'); const t = `%${texto}%`; args.push(t.toUpperCase(), t, t); }
    if (tipo === 'ABONO') cond.push('monto>0');
    if (tipo === 'CARGO') cond.push('monto<0');
    const where = cond.join(' AND ');

    // Stats totales SIEMPRE con query aparte sin LIMIT (conteos reales)
    const [[st]] = await pool.query(`
      SELECT COUNT(*) total,
             SUM(CASE WHEN monto>0 THEN monto ELSE 0 END) abonos,
             SUM(CASE WHEN monto<0 THEN -monto ELSE 0 END) cargos
      FROM banco_movimientos WHERE ${where}`, args);
    const [rows] = await pool.query(`
      SELECT id, fecha, monto, saldo, descripcion, sucursal, n_movimiento, n_documento,
             origen, conciliado, match_tipo, match_ref
      FROM banco_movimientos WHERE ${where}
      ORDER BY fecha DESC, CAST(n_movimiento AS UNSIGNED) DESC, id DESC
      LIMIT ? OFFSET ?`, [...args, por, (pag - 1) * por]);
    ok(res, { movimientos: rows, stats: st, pagina: pag, por_pagina: por });
  } catch (e) { fail(res, e.message); }
};

/* ── Resumen por tipo de transacción (Gastos / Ingresos) ────────────────────
   Agrupa por descripción del movimiento: N° de transacciones, suma y % del
   total del período. El signo lo decide el parámetro tipo (CARGO|ABONO). */
const resumenTipos = async (req, res) => {
  try {
    const idConexion = parseInt(req.params.id, 10);
    if (!idConexion) return fail(res, 'Cuenta inválida', 400);
    const tipo = req.query.tipo === 'ABONO' ? 'ABONO' : 'CARGO';
    const { desde, hasta } = req.query;
    const cond = ['id_conexion=?', tipo === 'ABONO' ? 'monto>0' : 'monto<0'];
    const args = [idConexion];
    if (desde) { cond.push('fecha>=?'); args.push(desde); }
    if (hasta) { cond.push('fecha<=?'); args.push(hasta); }
    const [rows] = await pool.query(`
      SELECT COALESCE(NULLIF(TRIM(descripcion),''),'(sin descripción)') AS cuenta,
             COUNT(*) AS transacciones,
             SUM(ABS(monto)) AS total
      FROM banco_movimientos WHERE ${cond.join(' AND ')}
      GROUP BY cuenta ORDER BY total DESC LIMIT 500`, args);
    const granTotal = rows.reduce((s, r) => s + Number(r.total || 0), 0);
    ok(res, {
      tipo, gran_total: granTotal,
      filas: rows.map(r => ({ ...r, pct: granTotal ? Number(r.total) / granTotal * 100 : 0 })),
    });
  } catch (e) { fail(res, e.message); }
};

/* ── Carga de cartola: anexa SOLO lo que no está (motor único) ──────────────── */
const cargarCartola = async (req, res) => {
  try {
    if (!req.file) return fail(res, 'Adjunta el archivo Excel de la cartola', 400);
    const idConexion = parseInt(req.params.id, 10);
    const [[cx]] = await pool.query('SELECT id, banco, numero FROM banco_conexiones WHERE id=? LIMIT 1', [idConexion]);
    if (!cx) return fail(res, 'Cuenta no encontrada', 404);

    // Cartola de OTRA cuenta → se rechaza (caso real 27-08-2026: la cartola de la
    // 7486599-2 se cargó sobre la 7045074-7 y hubo que separar los movimientos a mano)
    const parsed = parsearCartola(req.file.buffer);
    const errCta = cuentaNoCoincide(parsed.cuenta_archivo, cx.numero, req.file.originalname);
    if (errCta) return fail(res, errCta, 400);
    const movs = hashMovs(idConexion, parsed);
    if (!movs.length) return fail(res, 'El archivo no contiene movimientos reconocibles.', 400);

    let nuevas = 0;
    for (const m of movs) {
      const [r] = await pool.query(
        `INSERT IGNORE INTO banco_movimientos (id_conexion, fintoc_id, fecha, monto, moneda, descripcion, tipo, origen, saldo, sucursal, n_movimiento, n_documento)
         VALUES (?,?,?,?,'CLP',?,?, 'MANUAL',?,?,?,?)`,
        [idConexion, m.fintoc_id, m.fecha, m.monto, m.descripcion || null, m.documento ? ('DOC ' + m.documento) : null,
         m.saldo ?? null, m.sucursal || null, m.n_movimiento || null, m.documento || null]);
      if (r.affectedRows === 1) nuevas++;
      else if (m.saldo != null || m.n_movimiento) {
        // Ya estaba (cargado antes desde Conciliación sin estos campos): completarlos
        await pool.query(
          `UPDATE banco_movimientos SET saldo=COALESCE(saldo,?), sucursal=COALESCE(sucursal,?),
                  n_movimiento=COALESCE(n_movimiento,?), n_documento=COALESCE(n_documento,?)
           WHERE id_conexion=? AND fintoc_id=?`,
          [m.saldo ?? null, m.sucursal || null, m.n_movimiento || null, m.documento || null, idConexion, m.fintoc_id]);
      }
    }
    await pool.query(
      'INSERT INTO banco_cartola_cargas (id_conexion, archivo, filas, nuevas, duplicadas, usuario) VALUES (?,?,?,?,?,?)',
      [idConexion, req.file.originalname || null, movs.length, nuevas, movs.length - nuevas, req.user && (req.user.nombre || req.user.email) || null]);
    auditar({ req, accion: 'IMPORTAR', modulo: 'tesoreria', entidad: 'banco_cartola', entidad_id: idConexion,
      detalle: `Cargó cartola en Cuentas Corrientes ${cx.banco} ${cx.numero || ''}: ${movs.length} filas, ${nuevas} nuevas (${req.file.originalname || 'archivo'})` });
    ok(res, { filas: movs.length, nuevas, duplicadas: movs.length - nuevas });
  } catch (e) { fail(res, e.message, 400); }
};

module.exports = { cuentas, movimientos, cargarCartola, resumenTipos };
