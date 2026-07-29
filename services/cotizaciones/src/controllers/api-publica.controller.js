'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   API Pública — acceso de empresas externas al Simulador Rápido.
   - Cada empresa recibe una LLAVE (X-API-Key) creada desde el mantenedor APIs
     (/mantenedores/apis/). La llave se puede desactivar o regenerar sin tocar código.
   - El cálculo usa el MOTOR ÚNICO shared/cotizador.js (el mismo del Simulador
     Rápido interno y del portal dealer) — Máxima 1: un solo motor por cálculo.
   - Registro de uso por llave (llamadas, último uso) para monitoreo y cobro futuro.
   ───────────────────────────────────────────────────────────────────────────── */
const crypto = require('crypto');
const pool = require('../../../../shared/config/database');
const { simuladorRapido } = require('../../../../shared/cotizador');
const { enFila } = require('../../../../shared/migrate');

enFila('api_publica', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS api_clientes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    empresa VARCHAR(150) NOT NULL,
    contacto VARCHAR(150) NULL,
    correo VARCHAR(150) NULL,
    api_key VARCHAR(80) NOT NULL,
    activo TINYINT NOT NULL DEFAULT 1,
    llamadas INT NOT NULL DEFAULT 0,
    ultimo_uso DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_api_key (api_key)
  )`);
  // Cada llave pertenece a UNA API del catálogo (una card por API en el mantenedor)
  await pool.query(`ALTER TABLE api_clientes ADD COLUMN IF NOT EXISTS api VARCHAR(40) NOT NULL DEFAULT 'simulador_rapido'`);
  // Catálogo paramétrico de APIs publicadas: agregar una API nueva = INSERT aquí
  // (+ su ruta/handler); la card en /mantenedores/apis/ aparece sola.
  await pool.query(`CREATE TABLE IF NOT EXISTS apis_catalogo (
    codigo VARCHAR(40) PRIMARY KEY,
    nombre VARCHAR(120) NOT NULL,
    descripcion VARCHAR(300) NULL,
    icono VARCHAR(50) NOT NULL DEFAULT 'bi-plug',
    endpoint VARCHAR(200) NOT NULL,
    activo TINYINT NOT NULL DEFAULT 1,
    orden INT NOT NULL DEFAULT 100
  )`);
  await pool.query(`INSERT IGNORE INTO apis_catalogo (codigo, nombre, descripcion, icono, endpoint, orden) VALUES
    ('simulador_rapido', 'API Simulador Rápido', 'Un monto → cuotas a 12/24/36/48 meses con CAE, tasa y monto financiado. Motor único del Simulador Rápido.', 'bi-calculator-fill', '/api/publica/v1/simulador-rapido?monto=MONTO', 10)`);
});

const nuevaLlave = () => 'afk_' + crypto.randomBytes(24).toString('hex');

/* ── Middleware: valida X-API-Key contra el mantenedor, por API ──
   La llave sirve SOLO para la API a la que fue emitida (una card = una API). */
function validarApiKey(api) {
  return async function (req, res, next) {
    try {
      const key = String(req.headers['x-api-key'] || '').trim();
      if (!key) return res.status(401).json({ success: false, data: null, error: 'Falta el header X-API-Key' });
      const [[cli]] = await pool.query('SELECT id, empresa, api, activo FROM api_clientes WHERE api_key = ? LIMIT 1', [key]);
      if (!cli) return res.status(401).json({ success: false, data: null, error: 'API Key inválida' });
      if (!cli.activo) return res.status(403).json({ success: false, data: null, error: 'API Key desactivada — contacte a AutoFácil' });
      if (cli.api !== api) return res.status(403).json({ success: false, data: null, error: 'Esta API Key no tiene acceso a esta API' });
      req.apiCliente = cli;
      pool.query('UPDATE api_clientes SET llamadas = llamadas + 1, ultimo_uso = NOW() WHERE id = ?', [cli.id]).catch(() => {});
      next();
    } catch (e) {
      console.error('[api-publica] validar:', e.message);
      res.status(500).json({ success: false, data: null, error: 'Error interno' });
    }
  };
}

/* ── GET /api/publica/v1/simulador-rapido?monto=8000000 ── */
async function simular(req, res) {
  try {
    const data = await simuladorRapido(req.query.monto);
    if (!data) return res.status(400).json({ success: false, data: null, error: 'Monto inválido: debe ser un entero en CLP entre 1000000 y 300000000' });
    res.json({ success: true, data, error: null });
  } catch (e) {
    console.error('[api-publica] simular:', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error al simular' });
  }
}

/* ── Admin (mantenedor APIs) ── */
async function adminCatalogo(req, res) {
  try {
    const [apis] = await pool.query('SELECT codigo, nombre, descripcion, icono, endpoint, activo, orden FROM apis_catalogo WHERE activo = 1 ORDER BY orden, nombre');
    const [stats] = await pool.query('SELECT api, COUNT(*) llaves, SUM(activo) activas, SUM(llamadas) llamadas FROM api_clientes GROUP BY api');
    const m = {}; stats.forEach(s => { m[s.api] = s; });
    res.json({ success: true, data: apis.map(a => ({ ...a, stats: m[a.codigo] || { llaves: 0, activas: 0, llamadas: 0 } })), error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
}

async function adminListar(req, res) {
  try {
    const filtro = req.query.api ? ' WHERE api = ?' : '';
    const [rows] = await pool.query('SELECT id, empresa, contacto, correo, api, api_key, activo, llamadas, ultimo_uso, created_at FROM api_clientes' + filtro + ' ORDER BY created_at DESC',
      req.query.api ? [req.query.api] : []);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
}

async function adminCrear(req, res) {
  try {
    const { empresa, contacto, correo, api } = req.body || {};
    if (!empresa || !String(empresa).trim()) return res.status(400).json({ success: false, data: null, error: 'Falta la empresa' });
    const [[cat]] = await pool.query('SELECT codigo FROM apis_catalogo WHERE codigo = ? AND activo = 1', [api || '']);
    if (!cat) return res.status(400).json({ success: false, data: null, error: 'API desconocida' });
    const key = nuevaLlave();
    await pool.query('INSERT INTO api_clientes (empresa, contacto, correo, api, api_key) VALUES (?,?,?,?,?)',
      [String(empresa).trim(), contacto || null, correo || null, cat.codigo, key]);
    res.json({ success: true, data: { api_key: key }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
}

async function adminActivo(req, res) {
  try {
    const activo = req.body && req.body.activo ? 1 : 0;
    await pool.query('UPDATE api_clientes SET activo = ? WHERE id = ?', [activo, req.params.id]);
    res.json({ success: true, data: { activo }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
}

async function adminRegenerar(req, res) {
  try {
    const key = nuevaLlave();
    await pool.query('UPDATE api_clientes SET api_key = ? WHERE id = ?', [key, req.params.id]);
    res.json({ success: true, data: { api_key: key }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
}

module.exports = { validarApiKey, simular, adminCatalogo, adminListar, adminCrear, adminActivo, adminRegenerar };
