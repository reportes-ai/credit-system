'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   MONITOR DE UPTIME POR SERVICIO — motor único (Máxima 1)

   Cada 5 minutos pinguea los servicios de los que depende la Suite (BD TiDB,
   API CMF, DealerNet, WhatsApp/Meta, Workera, Brevo) y registra el resultado
   en `uptime_checks`. El informe de Salud del Sistema (correos programados)
   muestra el % de uptime 24h / 7d / 30d por servicio.

   La APLICACIÓN misma (Render) se mide por OMISIÓN: si el proceso está caído,
   no registra checks — los huecos en la serie son su downtime. Eso hace al
   monitor honesto: no puede reportarse "arriba" a sí mismo estando muerto.

   Paramétrico (tabla `uptime_servicios`): agregar un servicio nuevo = un
   INSERT (codigo, nombre, tipo BD|HTTP, url). Sin tocar código.
   ───────────────────────────────────────────────────────────────────────────── */
const { programar } = require('./scheduler.js');
const pool = require('./config/database');

const CADA_MIN = 5;                 // frecuencia de chequeo
const RETENCION_DIAS = 90;          // historial que se conserva
const TIMEOUT_MS = 8000;

/* Seed: los servicios externos que la Suite usa hoy (editable en BD) */
const SEED = [
  ['bd',        'Base de datos (TiDB Cloud)', 'BD',   null],
  ['cmf',       'API CMF (UF/TMC/dólar)',     'HTTP', 'https://api.cmfchile.cl'],
  ['dealernet', 'DealerNet WS',               'HTTP', 'https://infows.dealernet.cl'],
  ['whatsapp',  'WhatsApp (Meta Graph API)',  'HTTP', 'https://graph.facebook.com'],
  ['workera',   'Workera (reloj control)',    'HTTP', 'https://workera.com'],
  ['brevo',     'Brevo (correo SMTP/API)',    'HTTP', 'https://api.brevo.com'],
];

require('./migrate').enFila('uptime-monitor', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS uptime_servicios (
    codigo VARCHAR(30) PRIMARY KEY,
    nombre VARCHAR(120) NOT NULL,
    tipo   VARCHAR(10)  NOT NULL DEFAULT 'HTTP',
    url    VARCHAR(300) NULL,
    activo TINYINT NOT NULL DEFAULT 1)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS uptime_checks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    codigo VARCHAR(30) NOT NULL,
    ok TINYINT NOT NULL,
    ms INT NULL,
    fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_cf (codigo, fecha))`);
  for (const s of SEED)
    await pool.query('INSERT IGNORE INTO uptime_servicios (codigo, nombre, tipo, url) VALUES (?,?,?,?)', s);
});

async function pingHTTP(url) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // Cualquier respuesta HTTP < 500 = el servicio está arriba (401/404 incluidos:
    // significa que SU servidor respondió; lo que medimos es alcanzabilidad).
    const r = await fetch(url, { method: 'GET', signal: ctrl.signal, redirect: 'manual' });
    return { ok: r.status < 500, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

async function chequear() {
  let servicios = [];
  try { [servicios] = await pool.query('SELECT * FROM uptime_servicios WHERE activo=1'); }
  catch (e) { return; }   // sin BD no hay dónde anotar (el hueco cuenta como downtime de BD igual)
  for (const s of servicios) {
    let ok = 0, ms = null;
    if (s.tipo === 'BD') {
      const t0 = Date.now();
      try { await pool.query('SELECT 1'); ok = 1; ms = Date.now() - t0; } catch (_) { ms = Date.now() - t0; }
    } else if (s.url) {
      const r = await pingHTTP(s.url); ok = r.ok ? 1 : 0; ms = r.ms;
    } else continue;
    await pool.query('INSERT INTO uptime_checks (codigo, ok, ms) VALUES (?,?,?)', [s.codigo, ok, ms]).catch(() => {});
  }
  // Poda del historial viejo (por tandas para no bloquear)
  await pool.query('DELETE FROM uptime_checks WHERE fecha < NOW() - INTERVAL ? DAY LIMIT 500', [RETENCION_DIAS]).catch(() => {});
}

/* Resumen para el informe de Salud: % uptime 24h/7d/30d por servicio + app (Render) */
async function resumen() {
  const [servicios] = await pool.query('SELECT * FROM uptime_servicios WHERE activo=1 ORDER BY nombre');
  const [stats] = await pool.query(`
    SELECT codigo,
      ROUND(100*AVG(CASE WHEN fecha >= NOW() - INTERVAL 1 DAY  THEN ok END), 2) p24,
      ROUND(100*AVG(CASE WHEN fecha >= NOW() - INTERVAL 7 DAY  THEN ok END), 2) p7,
      ROUND(100*AVG(ok), 2) p30,
      AVG(CASE WHEN ok=1 AND fecha >= NOW() - INTERVAL 1 DAY THEN ms END) ms24,
      MAX(CASE WHEN ok=0 THEN fecha END) ultima_falla,
      COUNT(*) checks
    FROM uptime_checks WHERE fecha >= NOW() - INTERVAL 30 DAY GROUP BY codigo`);
  const por = Object.fromEntries(stats.map(s => [s.codigo, s]));

  // Uptime de la APLICACIÓN (Render): checks registrados vs esperados desde el primer check.
  // Si el proceso estuvo caído, faltan filas — eso ES su downtime.
  const [[rango]] = await pool.query(
    `SELECT MIN(fecha) primera, COUNT(DISTINCT FLOOR(UNIX_TIMESTAMP(fecha)/${CADA_MIN * 60})) hechos
     FROM uptime_checks WHERE fecha >= NOW() - INTERVAL 30 DAY`);
  const app = { codigo: 'app', nombre: 'Aplicación (Render)' };
  if (rango && rango.primera) {
    const minutos = Math.max(CADA_MIN, (Date.now() - new Date(rango.primera).getTime()) / 60000);
    const esperados = Math.max(1, Math.floor(minutos / CADA_MIN));
    app.p30 = Math.min(100, Math.round(10000 * rango.hechos / esperados) / 100);
  }

  return {
    cada_min: CADA_MIN,
    app,
    servicios: servicios.map(s => ({
      codigo: s.codigo, nombre: s.nombre,
      p24: por[s.codigo] ? por[s.codigo].p24 : null,
      p7: por[s.codigo] ? por[s.codigo].p7 : null,
      p30: por[s.codigo] ? por[s.codigo].p30 : null,
      ms24: por[s.codigo] && por[s.codigo].ms24 != null ? Math.round(por[s.codigo].ms24) : null,
      ultima_falla: por[s.codigo] ? por[s.codigo].ultima_falla : null,
    })),
  };
}

programar('uptime', () => chequear().catch(() => {}), CADA_MIN * 60 * 1000, { infra: true, enStaging: true, arranqueMs: 90 * 1000 });

module.exports = { resumen };
