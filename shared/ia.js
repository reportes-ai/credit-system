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

// Precios USD por 1.000.000 de tokens (entrada/salida). Tabla ia_modelos (paramétrica).
const DEFAULT_PRECIOS = {
  'claude-opus-4-8':   { nombre: 'Claude Opus 4.8',   in: 5,  out: 25 },
  'claude-sonnet-4-6': { nombre: 'Claude Sonnet 4.6', in: 3,  out: 15 },
  'claude-haiku-4-5':  { nombre: 'Claude Haiku 4.5',  in: 1,  out: 5  },
  'claude-fable-5':    { nombre: 'Claude Fable 5',    in: 10, out: 50 },
};

// Catálogo de análisis con IA (roadmap) + modelo recomendado por defecto (editable
// en el mantenedor). Criterio: extracción/clasificación/resumen → Haiku (barato);
// análisis/redacción/interpretación → Sonnet; dictamen/cruce crítico → Opus.
const CATALOGO = [
  { codigo: 'liq_sueldo',             nombre: 'Análisis de liquidaciones de sueldo',     descripcion: 'Extrae líquido/imponible, AFP/Isapre y los cruza con la renta declarada', modelo: 'claude-haiku-4-5' },
  { codigo: 'informe_crediticio',     nombre: 'Análisis de informe crediticio (DealerNet)', descripcion: 'Analiza los antecedentes que trae DealerNet (deudas, morosidades) y resume el nivel de riesgo', modelo: 'claude-sonnet-4-6' },
  { codigo: 'carpeta_tributaria',     nombre: 'Análisis de carpeta tributaria (SII)',    descripcion: 'Extrae rentas e IVA y valida consistencia (documento largo)',             modelo: 'claude-sonnet-4-6' },
  { codigo: 'declaracion_f22',        nombre: 'Análisis de declaración de impuestos (F22)', descripcion: 'Extrae rentas y datos clave del Formulario 22',                         modelo: 'claude-haiku-4-5' },
  { codigo: 'firmas',                 nombre: 'Revisión de firmas',                       descripcion: 'Compara firmas y marca diferencias o documentos alterados (no es verificación forense)', modelo: 'claude-sonnet-4-6' },
  { codigo: 'cobranza_copiloto',      nombre: 'Copiloto de cobranza',                     descripcion: 'Prioriza cartera, redacta la gestión/carta y clasifica el resultado',     modelo: 'claude-sonnet-4-6' },
  { codigo: 'crm_resumen',            nombre: 'Resumen de gestiones CRM',                 descripcion: 'Resume hilos largos y extrae compromisos de pago',                        modelo: 'claude-haiku-4-5' },
  { codigo: 'carga_validador',        nombre: 'Validador inteligente de carga masiva',    descripcion: 'Detecta anomalías en el Excel antes de insertar (RUT, montos, dealer, fechas)', modelo: 'claude-haiku-4-5' },
  { codigo: 'evaluacion_consistencia', nombre: 'Evaluación de consistencia / scoring',    descripcion: 'Cruza todos los documentos del cliente y entrega alertas y scoring asistido', modelo: 'claude-opus-4-8' },
];

(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS ia_config (
      clave VARCHAR(40) PRIMARY KEY, valor TEXT )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ia_funcionalidades (
      codigo      VARCHAR(60)  PRIMARY KEY,
      nombre      VARCHAR(160) NOT NULL,
      descripcion VARCHAR(400) NULL,
      modelo      VARCHAR(60)  NULL,
      activa      TINYINT      NOT NULL DEFAULT 0,
      disponible  TINYINT      NOT NULL DEFAULT 0,
      creado      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ia_modelos (
      modelo     VARCHAR(60)  PRIMARY KEY,
      nombre     VARCHAR(120) NOT NULL,
      precio_in  DECIMAL(10,4) NOT NULL DEFAULT 0,
      precio_out DECIMAL(10,4) NOT NULL DEFAULT 0,
      activo     TINYINT      NOT NULL DEFAULT 1 )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ia_uso (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      fecha      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      codigo     VARCHAR(60)  NULL,
      modelo     VARCHAR(60)  NULL,
      tokens_in  INT          NOT NULL DEFAULT 0,
      tokens_out INT          NOT NULL DEFAULT 0,
      costo_usd  DECIMAL(12,6) NOT NULL DEFAULT 0,
      id_usuario INT          NULL,
      meta       JSON         NULL,
      INDEX idx_fecha (fecha), INDEX idx_codigo (codigo), INDEX idx_modelo (modelo) )`);
    for (const [k, v] of Object.entries(DEFAULTS))
      await pool.query('INSERT IGNORE INTO ia_config (clave, valor) VALUES (?,?)', [k, v]);
    for (const [m, p] of Object.entries(DEFAULT_PRECIOS))
      await pool.query('INSERT IGNORE INTO ia_modelos (modelo, nombre, precio_in, precio_out) VALUES (?,?,?,?)', [m, p.nombre, p.in, p.out]);
    // Columnas nuevas en BD existentes (TiDB soporta IF NOT EXISTS; 1060 = ya existe)
    for (const col of ['ADD COLUMN IF NOT EXISTS modelo VARCHAR(60) NULL', 'ADD COLUMN IF NOT EXISTS disponible TINYINT NOT NULL DEFAULT 0']) {
      try { await pool.query('ALTER TABLE ia_funcionalidades ' + col); } catch (e) { if (e.errno !== 1060) console.error('[ia alter]', e.message); }
    }
    // Roadmap de análisis. Mantiene nombre/descripción al día; respeta el modelo/activa que el admin eligió.
    for (const f of CATALOGO)
      await pool.query(
        `INSERT INTO ia_funcionalidades (codigo, nombre, descripcion, modelo, activa, disponible) VALUES (?,?,?,?,0,0)
         ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), descripcion = VALUES(descripcion)`,
        [f.codigo, f.nombre, f.descripcion, f.modelo]);
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
    const [fr] = await pool.query('SELECT codigo, nombre, descripcion, modelo, activa, disponible FROM ia_funcionalidades ORDER BY disponible DESC, nombre');
    funcs = fr.map(f => ({ codigo: f.codigo, nombre: f.nombre, descripcion: f.descripcion || '', modelo: f.modelo || '', activa: f.activa === 1, disponible: f.disponible === 1 }));
  } catch (_) {}
  let modelos = [];
  try {
    const [mr] = await pool.query('SELECT modelo, nombre FROM ia_modelos WHERE activo = 1 ORDER BY precio_in');
    modelos = mr.map(m => ({ modelo: m.modelo, nombre: m.nombre }));
  } catch (_) {}
  _cache = {
    activa:           cfg.activa === '1',
    texto_analizando: cfg.texto_analizando || DEFAULTS.texto_analizando,
    texto_analizado:  cfg.texto_analizado  || DEFAULTS.texto_analizado,
    mostrar_logo:     cfg.mostrar_logo !== '0',
    funcionalidades:  funcs,
    modelos:          modelos,
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

/** Modelo configurado para una funcionalidad (fallback Haiku, el más barato). */
async function modeloDe(codigo) {
  const cfg = await getConfig();
  const f = cfg.funcionalidades.find(x => x.codigo === codigo);
  return (f && f.modelo) || 'claude-haiku-4-5';
}

/** Auto-registro idempotente de una funcionalidad de IA (arranca DESACTIVADA).
    Al registrarse marca disponible=1; conserva el modelo/activa elegidos por el admin. */
async function registrarFuncionalidad({ codigo, nombre, descripcion, modelo }) {
  if (!codigo || !nombre) return;
  try {
    await pool.query(
      `INSERT INTO ia_funcionalidades (codigo, nombre, descripcion, modelo, activa, disponible) VALUES (?,?,?,?,0,1)
       ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), descripcion = VALUES(descripcion), disponible = 1`,
      [codigo, nombre, descripcion || null, modelo || null]);
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
      if (f.modelo) await pool.query('UPDATE ia_funcionalidades SET activa = ?, modelo = ? WHERE codigo = ?', [f.activa ? 1 : 0, f.modelo, f.codigo]);
      else          await pool.query('UPDATE ia_funcionalidades SET activa = ? WHERE codigo = ?', [f.activa ? 1 : 0, f.codigo]);
    }
  }
  invalidar();
  return getConfig(true);
}

// ── Consumo (tokens + USD) ──────────────────────────────────────────────────
/** Precio USD/1M tokens de un modelo (tabla ia_modelos, fallback a DEFAULT_PRECIOS). */
async function precioModelo(modelo) {
  try {
    const [[r]] = await pool.query('SELECT precio_in, precio_out FROM ia_modelos WHERE modelo = ? LIMIT 1', [modelo]);
    if (r) return { in: Number(r.precio_in) || 0, out: Number(r.precio_out) || 0 };
  } catch (_) {}
  const d = DEFAULT_PRECIOS[modelo];
  return d ? { in: d.in, out: d.out } : { in: 0, out: 0 };
}

/** Registra una llamada a IA: calcula el costo con el precio vigente y lo guarda. */
async function registrarUso({ codigo, modelo, tokens_in = 0, tokens_out = 0, id_usuario = null, meta = null } = {}) {
  try {
    const p = await precioModelo(modelo);
    const ti = Number(tokens_in) || 0, to = Number(tokens_out) || 0;
    const costo = (ti / 1e6) * p.in + (to / 1e6) * p.out;
    await pool.query(
      `INSERT INTO ia_uso (codigo, modelo, tokens_in, tokens_out, costo_usd, id_usuario, meta)
       VALUES (?,?,?,?,?,?,?)`,
      [codigo || null, modelo || null, ti, to, costo, id_usuario, meta ? JSON.stringify(meta) : null]);
    return costo;
  } catch (e) { console.error('[ia registrarUso]', e.message); return 0; }
}

/** Métricas de consumo: ventanas 30/60/90 días + desglose por funcionalidad/modelo. */
async function getUso({ dias = 90 } = {}) {
  const d = [30, 60, 90].includes(+dias) ? +dias : 90;
  const num = x => Number(x || 0);

  const [[v]] = await pool.query(`
    SELECT
      SUM(CASE WHEN fecha >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN costo_usd ELSE 0 END)              AS c30,
      SUM(CASE WHEN fecha >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN tokens_in+tokens_out ELSE 0 END)   AS t30,
      SUM(CASE WHEN fecha >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN 1 ELSE 0 END)                      AS n30,
      SUM(CASE WHEN fecha >= DATE_SUB(NOW(), INTERVAL 60 DAY) THEN costo_usd ELSE 0 END)              AS c60,
      SUM(CASE WHEN fecha >= DATE_SUB(NOW(), INTERVAL 60 DAY) THEN tokens_in+tokens_out ELSE 0 END)   AS t60,
      SUM(CASE WHEN fecha >= DATE_SUB(NOW(), INTERVAL 60 DAY) THEN 1 ELSE 0 END)                      AS n60,
      SUM(CASE WHEN fecha >= DATE_SUB(NOW(), INTERVAL 90 DAY) THEN costo_usd ELSE 0 END)              AS c90,
      SUM(CASE WHEN fecha >= DATE_SUB(NOW(), INTERVAL 90 DAY) THEN tokens_in+tokens_out ELSE 0 END)   AS t90,
      SUM(CASE WHEN fecha >= DATE_SUB(NOW(), INTERVAL 90 DAY) THEN 1 ELSE 0 END)                      AS n90
    FROM ia_uso`);

  const [pf] = await pool.query(`
    SELECT u.codigo, COALESCE(f.nombre, u.codigo) AS nombre,
           COUNT(*) AS llamadas, SUM(u.tokens_in) AS tokens_in, SUM(u.tokens_out) AS tokens_out, SUM(u.costo_usd) AS costo
    FROM ia_uso u LEFT JOIN ia_funcionalidades f ON f.codigo = u.codigo
    WHERE u.fecha >= DATE_SUB(NOW(), INTERVAL ? DAY)
    GROUP BY u.codigo, nombre ORDER BY costo DESC`, [d]);

  const [pm] = await pool.query(`
    SELECT u.modelo, COALESCE(m.nombre, u.modelo) AS nombre,
           COUNT(*) AS llamadas, SUM(u.tokens_in) AS tokens_in, SUM(u.tokens_out) AS tokens_out, SUM(u.costo_usd) AS costo
    FROM ia_uso u LEFT JOIN ia_modelos m ON m.modelo = u.modelo
    WHERE u.fecha >= DATE_SUB(NOW(), INTERVAL ? DAY)
    GROUP BY u.modelo, nombre ORDER BY costo DESC`, [d]);

  const [[tot]] = await pool.query(`
    SELECT COUNT(*) AS llamadas, COALESCE(SUM(tokens_in),0) AS tokens_in,
           COALESCE(SUM(tokens_out),0) AS tokens_out, COALESCE(SUM(costo_usd),0) AS costo
    FROM ia_uso WHERE fecha >= DATE_SUB(NOW(), INTERVAL ? DAY)`, [d]);

  const [pr] = await pool.query('SELECT modelo, nombre, precio_in, precio_out FROM ia_modelos ORDER BY precio_in');

  const mapRow = r => ({ codigo: r.codigo, modelo: r.modelo, nombre: r.nombre, llamadas: num(r.llamadas),
    tokens_in: num(r.tokens_in), tokens_out: num(r.tokens_out), costo: num(r.costo) });
  return {
    dias: d,
    ventanas: {
      d30: { costo: num(v.c30), tokens: num(v.t30), llamadas: num(v.n30) },
      d60: { costo: num(v.c60), tokens: num(v.t60), llamadas: num(v.n60) },
      d90: { costo: num(v.c90), tokens: num(v.t90), llamadas: num(v.n90) },
    },
    por_funcionalidad: pf.map(mapRow),
    por_modelo: pm.map(mapRow),
    total: { llamadas: num(tot.llamadas), tokens_in: num(tot.tokens_in), tokens_out: num(tot.tokens_out), costo: num(tot.costo) },
    precios: pr.map(r => ({ modelo: r.modelo, nombre: r.nombre, precio_in: num(r.precio_in), precio_out: num(r.precio_out) })),
  };
}

module.exports = { getConfig, setConfig, iaActiva, modeloDe, registrarFuncionalidad, invalidar, precioModelo, registrarUso, getUso };
