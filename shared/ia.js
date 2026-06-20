/**
 * shared/ia.js
 * Núcleo del subsistema de Inteligencia Artificial (Anthropic).
 *  - Config PARAMÉTRICA: activar/desactivar la IA global + textos de branding.
 *  - Registro de funcionalidades de IA: cada feature se auto-registra al arrancar
 *    (arranca DESACTIVADA) para que el Administrador la prenda desde el mantenedor.
 *  - Helper iaActiva(codigo) para gatear cualquier llamada a IA en el backend.
 * Crea sus tablas al arrancar. Lectura cacheada 60s (invalida al guardar).
 *
 * Uso (gatear una feature):
 *   const ia = require('../../../../shared/ia');
 *   ia.registrarFuncionalidad({ codigo:'liq_sueldo', nombre:'Análisis de liquidaciones',
 *                               descripcion:'Extrae líquido/imponible de la liquidación de sueldo' });
 *   if (!(await ia.iaActiva('liq_sueldo'))) return res.status(403)...;
 */
const pool = require('./config/database');

const DEFAULTS = {
  activa:           '0',
  texto_analizando: 'Analizando con Inteligencia Artificial de Anthropic…',
  texto_analizado:  'Analizado con Inteligencia Artificial de Anthropic',
  mostrar_logo:     '1',
};

(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS ia_config (
      clave VARCHAR(40) PRIMARY KEY, valor TEXT )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ia_funcionalidades (
      codigo      VARCHAR(60)  PRIMARY KEY,
      nombre      VARCHAR(160) NOT NULL,
      descripcion VARCHAR(400) NULL,
      activa      TINYINT      NOT NULL DEFAULT 0,
      creado      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP )`);
    for (const [k, v] of Object.entries(DEFAULTS))
      await pool.query('INSERT IGNORE INTO ia_config (clave, valor) VALUES (?,?)', [k, v]);
  } catch (e) { if (e.errno !== 1050) console.error('[ia migration]', e.message); }
})();

let _cache = null, _cacheAt = 0;
const TTL = 60000;

async function getConfig(force = false) {
  if (!force && _cache && (Date.now() - _cacheAt) < TTL) return _cache;
  const cfg = { ...DEFAULTS };
  try {
    const [rows] = await pool.query('SELECT clave, valor FROM ia_config');
    rows.forEach(r => { cfg[r.clave] = r.valor; });
  } catch (_) {}
  let funcs = [];
  try {
    const [fr] = await pool.query('SELECT codigo, nombre, descripcion, activa FROM ia_funcionalidades ORDER BY nombre');
    funcs = fr.map(f => ({ codigo: f.codigo, nombre: f.nombre, descripcion: f.descripcion || '', activa: f.activa === 1 }));
  } catch (_) {}
  _cache = {
    activa:           cfg.activa === '1',
    texto_analizando: cfg.texto_analizando || DEFAULTS.texto_analizando,
    texto_analizado:  cfg.texto_analizado  || DEFAULTS.texto_analizado,
    mostrar_logo:     cfg.mostrar_logo !== '0',
    funcionalidades:  funcs,
  };
  _cacheAt = Date.now();
  return _cache;
}

function invalidar() { _cache = null; _cacheAt = 0; }

/** ¿IA activa? (master) y, si se pasa código, también esa funcionalidad. */
async function iaActiva(codigo) {
  const cfg = await getConfig();
  if (!cfg.activa) return false;
  if (!codigo) return true;
  const f = cfg.funcionalidades.find(x => x.codigo === codigo);
  return !!(f && f.activa);
}

/** Auto-registro idempotente de una funcionalidad de IA (arranca DESACTIVADA). */
async function registrarFuncionalidad({ codigo, nombre, descripcion }) {
  if (!codigo || !nombre) return;
  try {
    await pool.query(
      `INSERT INTO ia_funcionalidades (codigo, nombre, descripcion, activa) VALUES (?,?,?,0)
       ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), descripcion = VALUES(descripcion)`,
      [codigo, nombre, descripcion || null]);
    invalidar();
  } catch (e) { console.error('[ia registrar]', e.message); }
}

/** Guardar config (master + textos + toggles por funcionalidad). Devuelve la config nueva. */
async function setConfig({ activa, texto_analizando, texto_analizado, mostrar_logo, funcionalidades } = {}) {
  const up = (k, v) => pool.query(
    'INSERT INTO ia_config (clave, valor) VALUES (?,?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)', [k, String(v)]);
  if (activa != null)           await up('activa', activa ? '1' : '0');
  if (texto_analizando != null) await up('texto_analizando', String(texto_analizando).slice(0, 200));
  if (texto_analizado != null)  await up('texto_analizado',  String(texto_analizado).slice(0, 200));
  if (mostrar_logo != null)     await up('mostrar_logo', mostrar_logo ? '1' : '0');
  if (Array.isArray(funcionalidades)) {
    for (const f of funcionalidades) {
      if (!f || !f.codigo) continue;
      await pool.query('UPDATE ia_funcionalidades SET activa = ? WHERE codigo = ?', [f.activa ? 1 : 0, f.codigo]);
    }
  }
  invalidar();
  return getConfig(true);
}

module.exports = { getConfig, setConfig, iaActiva, registrarFuncionalidad, invalidar };
