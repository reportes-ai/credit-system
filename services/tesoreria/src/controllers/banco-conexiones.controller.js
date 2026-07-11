'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   CONEXIONES BANCARIAS (Tesorería) — trae SALDOS y CARTOLAS desde el banco vía
   Fintoc (Banco de Chile, Santander, etc.). Todo paramétrico:
     · La API key vive en el mantenedor (parametros_credito.fintoc_secret_key),
       no en el código. Env FINTOC_SECRET_KEY la sobreescribe si existe.
     · Modo sandbox (sk_test) para probar con datos ficticios / live al contratar.
   Cada cuenta enlazada = una fila en banco_conexiones (link_token + account_id).
   El sync refresca el saldo y hace UPSERT de los movimientos en banco_movimientos
   (fintoc_id UNIQUE → idempotente, no duplica al re-sincronizar).
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const fintoc = require('../fintoc-api');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });

/* ── Config (API key + modo) en parametros_credito ──────────────────────────── */
async function getParam(clave) {
  try { const [[r]] = await pool.query('SELECT valor FROM parametros_credito WHERE clave=? LIMIT 1', [clave]); return r ? r.valor : null; }
  catch { return null; }
}
async function setParam(clave, valor, desc) {
  await pool.query(
    'INSERT INTO parametros_credito (clave, valor, descripcion) VALUES (?,?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)',
    [clave, String(valor == null ? '' : valor), desc || '']);
}
// La key efectiva: env manda (más seguro); si no, la del mantenedor.
async function secretKey() {
  return process.env.FINTOC_SECRET_KEY || (await getParam('fintoc_secret_key')) || '';
}

/* ── Migración ──────────────────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('banco-conexiones', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS banco_conexiones (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        banco        VARCHAR(80)  NOT NULL,            -- 'Banco de Chile', 'Santander'…
        alias        VARCHAR(120) NULL,               -- nombre interno de la cuenta
        link_token   VARCHAR(255) NOT NULL,           -- token del enlace (Fintoc)
        account_id   VARCHAR(120) NULL,               -- id de la cuenta en Fintoc
        numero       VARCHAR(60)  NULL,
        titular      VARCHAR(160) NULL,
        moneda       VARCHAR(8)   DEFAULT 'CLP',
        activo       TINYINT(1)   DEFAULT 1,
        saldo_disponible DECIMAL(16,2) NULL,
        saldo_contable   DECIMAL(16,2) NULL,
        saldo_actualizado DATETIME NULL,
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS banco_movimientos (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        id_conexion  INT NOT NULL,
        fintoc_id    VARCHAR(120) NOT NULL UNIQUE,     -- idempotencia del sync
        fecha        DATE NULL,
        monto        DECIMAL(16,2) NOT NULL,           -- + abono / − cargo
        moneda       VARCHAR(8) DEFAULT 'CLP',
        descripcion  VARCHAR(400) NULL,
        tipo         VARCHAR(40)  NULL,
        contraparte      VARCHAR(160) NULL,
        contraparte_rut  VARCHAR(20)  NULL,
        pendiente    TINYINT(1) DEFAULT 0,
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX ix_conexion_fecha (id_conexion, fecha)
      )`);
    // Menú (mantenedor bajo Tesorería) + permiso Administrador
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Tesorería' OR ruta LIKE '/tesoreria%' LIMIT 1");
    if (mod) {
      const f = { codigo: 'banco_conexiones', nombre: 'Conexiones Bancarias', href: '/tesoreria/banco-conexiones', icono: 'bi-bank2' };
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [f.codigo]);
      let idF = ex && ex.id_funcionalidad;
      if (!idF) {
        const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
          [mod.id_modulo, f.nombre, f.codigo, f.href, f.icono]);
        idF = r.insertId;
      }
      await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idF]);
    }
    console.log('[banco-conexiones] módulo listo');
  } catch (e) { console.error('[banco-conexiones migration]', e.message); }
});

/* ── Config ─────────────────────────────────────────────────────────────────── */
const getConfig = async (req, res) => {
  try {
    const key = await secretKey();
    const modo = (await getParam('fintoc_modo')) || (key.startsWith('sk_live') ? 'live' : 'sandbox');
    ok(res, {
      configurado: !!key,
      // nunca se devuelve la key; solo una pista de que existe y su modo
      pista: key ? key.slice(0, 7) + '…' + key.slice(-4) : null,
      modo,
      via_env: !!process.env.FINTOC_SECRET_KEY,
    });
  } catch (e) { fail(res, e.message); }
};

const setConfig = async (req, res) => {
  try {
    if (process.env.FINTOC_SECRET_KEY)
      return fail(res, 'La API key está fijada por variable de entorno (FINTOC_SECRET_KEY) y no se edita desde aquí.', 409);
    const { secret_key, modo } = req.body || {};
    if (secret_key !== undefined) await setParam('fintoc_secret_key', String(secret_key).trim(), 'Fintoc: API key (sandbox sk_test / producción sk_live)');
    if (modo) await setParam('fintoc_modo', modo === 'live' ? 'live' : 'sandbox', 'Fintoc: modo de operación');
    auditar({ req, accion: 'EDITAR', modulo: 'tesoreria', entidad: 'banco_config', detalle: 'Actualizó configuración de Fintoc' });
    ok(res, { guardado: true });
  } catch (e) { fail(res, e.message); }
};

/* ── Conexiones (cuentas enlazadas) ─────────────────────────────────────────── */
const listar = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM banco_conexiones ORDER BY banco, alias');
    ok(res, rows);
  } catch (e) { fail(res, e.message); }
};

// Crea una conexión: valida el link contra Fintoc y trae la(s) cuenta(s) del enlace.
// Si el link tiene una sola cuenta, se enlaza automáticamente; si tiene varias,
// se crea una fila por cuenta.
const crear = async (req, res) => {
  try {
    const { banco, alias, link_token } = req.body || {};
    if (!banco || !link_token) return fail(res, 'Banco y link_token son obligatorios', 400);
    const key = await secretKey();
    if (!key) return fail(res, 'Configura primero la API key de Fintoc en el mantenedor.', 409);

    let cuentas;
    try { cuentas = await fintoc.listarCuentas(key, link_token); }
    catch (e) { return fail(res, 'Fintoc rechazó el enlace: ' + e.message, 400); }
    if (!cuentas.length) return fail(res, 'El enlace no devolvió cuentas.', 400);

    const creadas = [];
    for (const c of cuentas) {
      const [r] = await pool.query(
        `INSERT INTO banco_conexiones (banco, alias, link_token, account_id, numero, titular, moneda,
           saldo_disponible, saldo_contable, saldo_actualizado)
         VALUES (?,?,?,?,?,?,?,?,?,NOW())`,
        [banco, alias || c.nombre || null, link_token, c.account_id, c.numero, c.titular,
         c.moneda, c.saldo_disponible, c.saldo_contable]);
      creadas.push({ id: r.insertId, account_id: c.account_id, numero: c.numero, saldo_disponible: c.saldo_disponible });
    }
    auditar({ req, accion: 'CREAR', modulo: 'tesoreria', entidad: 'banco_conexiones', detalle: `Enlazó ${creadas.length} cuenta(s) de ${banco}` });
    ok(res, { creadas });
  } catch (e) { fail(res, e.message); }
};

const eliminar = async (req, res) => {
  try {
    await pool.query('DELETE FROM banco_movimientos WHERE id_conexion=?', [req.params.id]);
    await pool.query('DELETE FROM banco_conexiones WHERE id=?', [req.params.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'tesoreria', entidad: 'banco_conexiones', entidad_id: req.params.id, detalle: 'Eliminó conexión bancaria' });
    ok(res, { eliminado: true });
  } catch (e) { fail(res, e.message); }
};

/* ── Sync (saldo + movimientos) ─────────────────────────────────────────────── */
async function sincronizarConexion(conx, key) {
  // Saldo
  const cuenta = await fintoc.obtenerCuenta(key, conx.link_token, conx.account_id);
  await pool.query(
    'UPDATE banco_conexiones SET saldo_disponible=?, saldo_contable=?, saldo_actualizado=NOW() WHERE id=?',
    [cuenta.saldo_disponible, cuenta.saldo_contable, conx.id]);

  // Movimientos: desde el último que tenemos (menos 5 días de solape) o 90 días atrás.
  const [[u]] = await pool.query('SELECT MAX(fecha) f FROM banco_movimientos WHERE id_conexion=?', [conx.id]);
  const desde = new Date(u && u.f ? new Date(u.f).getTime() - 5 * 864e5 : Date.now() - 90 * 864e5);
  const since = desde.toISOString().slice(0, 10);
  const movs = await fintoc.listarMovimientos(key, conx.link_token, conx.account_id, { since });

  let nuevos = 0;
  for (const m of movs) {
    if (!m.fintoc_id) continue;
    const [r] = await pool.query(
      `INSERT INTO banco_movimientos (id_conexion, fintoc_id, fecha, monto, moneda, descripcion, tipo, contraparte, contraparte_rut, pendiente)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE monto=VALUES(monto), fecha=VALUES(fecha), descripcion=VALUES(descripcion), pendiente=VALUES(pendiente)`,
      [conx.id, m.fintoc_id, m.fecha || null, m.monto, m.moneda, m.descripcion, m.tipo, m.contraparte, m.contraparte_rut, m.pendiente ? 1 : 0]);
    if (r.affectedRows === 1) nuevos++;   // 1 = insert nuevo, 2 = update
  }
  return { saldo_disponible: cuenta.saldo_disponible, saldo_contable: cuenta.saldo_contable, movimientos: movs.length, nuevos };
}

const sincronizar = async (req, res) => {
  try {
    const key = await secretKey();
    if (!key) return fail(res, 'Configura primero la API key de Fintoc.', 409);
    const [[c]] = await pool.query('SELECT * FROM banco_conexiones WHERE id=? LIMIT 1', [req.params.id]);
    if (!c) return fail(res, 'Conexión no encontrada', 404);
    const r = await sincronizarConexion(c, key);
    ok(res, r);
  } catch (e) { fail(res, 'Fintoc: ' + e.message); }
};

const sincronizarTodo = async (req, res) => {
  try {
    const key = await secretKey();
    if (!key) return fail(res, 'Configura primero la API key de Fintoc.', 409);
    const [conns] = await pool.query('SELECT * FROM banco_conexiones WHERE activo=1 AND account_id IS NOT NULL');
    const res_ = [];
    for (const c of conns) {
      try { const r = await sincronizarConexion(c, key); res_.push({ id: c.id, banco: c.banco, ...r }); }
      catch (e) { res_.push({ id: c.id, banco: c.banco, error: e.message }); }
    }
    ok(res, { cuentas: res_.length, detalle: res_ });
  } catch (e) { fail(res, e.message); }
};

/* ── Cartola (lee de la BD; no llama a Fintoc) ──────────────────────────────── */
const movimientos = async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    const cond = ['id_conexion=?']; const args = [req.params.id];
    if (desde) { cond.push('fecha>=?'); args.push(desde); }
    if (hasta) { cond.push('fecha<=?'); args.push(hasta); }
    const [rows] = await pool.query(
      `SELECT * FROM banco_movimientos WHERE ${cond.join(' AND ')} ORDER BY fecha DESC, id DESC LIMIT 1000`, args);
    ok(res, rows);
  } catch (e) { fail(res, e.message); }
};

module.exports = { getConfig, setConfig, listar, crear, eliminar, sincronizar, sincronizarTodo, movimientos };
