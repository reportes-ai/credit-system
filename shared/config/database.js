const mysql = require('mysql2/promise');
require('dotenv').config();

const host = process.env.DB_HOST || 'localhost';
const needsSSL = host !== 'localhost' && !host.includes('railway.internal');

// Zona con la que mysql2 INTERPRETA los DATETIME al leerlos. DEBE coincidir con el SET time_zone
// de la conexión (Chile); si no, todas las horas se desfasan. getChileAutoOffset() está hoisted.
const MYSQL2_TZ = getChileAutoOffset();

const pool = mysql.createPool({
  host,
  port:     parseInt(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'credit_system',
  timezone: MYSQL2_TZ,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 15000,        // conexión nueva: máx 15s (evita colgarse si TiDB no responde)
  enableKeepAlive: true,        // detecta conexiones muertas tras reinicio de TiDB
  keepAliveInitialDelay: 10000,
  ...(needsSSL && { ssl: { rejectUnauthorized: false } })
});

// ── Offset automático (calcula DST de America/Santiago en tiempo real) ──
function getChileAutoOffset() {
  try {
    const now     = new Date();
    const utcStr  = now.toLocaleString('en-US', { timeZone: 'UTC' });
    const clStr   = now.toLocaleString('en-US', { timeZone: 'America/Santiago' });
    const diffMin = (new Date(clStr) - new Date(utcStr)) / 60000;
    if (!isFinite(diffMin)) throw new Error('NaN offset');
    const h = Math.floor(Math.abs(diffMin) / 60).toString().padStart(2, '0');
    const m = (Math.abs(diffMin) % 60).toString().padStart(2, '0');
    return (diffMin >= 0 ? '+' : '-') + h + ':' + m;
  } catch(e) {
    // Fallback seguro: Chile invierno UTC-4, verano UTC-3
    // Usamos nombre de zona que TiDB Cloud soporta directamente
    return '-04:00';
  }
}

// ── Override manual (vacío = automático) ──
let _tzOverride = null;

async function loadTZOverride() {
  try {
    const [rows] = await pool.query(
      "SELECT valor FROM parametros_credito WHERE clave = 'db_tz_override' LIMIT 1"
    );
    const val = String(rows[0]?.valor ?? '').trim();
    // Solo aceptar formatos de TZ válidos ('+HH:MM'/'-HH:MM' o 'Region/City') — la columna
    // valor es DECIMAL y puede traer basura numérica ('0.000000') que rompería el offset
    const valido = /^[+-]\d{2}:\d{2}$/.test(val) || /^[A-Za-z_]+\/[A-Za-z_]+/.test(val);
    _tzOverride = valido ? val : null;
    console.log(`✓ TZ BD: ${_tzOverride || 'automático (' + getChileAutoOffset() + ')'}`);
  } catch(e) { _tzOverride = null; }
}

// Forzar timezone en cada conexión nueva
pool.on('connection', conn => {
  /* SIEMPRE el mismo offset con el que mysql2 interpreta (MYSQL2_TZ, fijado al arrancar),
     no el offset "vivo": el 06-09-2026 Chile pasó a UTC-3 a medianoche, el proceso venía
     de la víspera con MYSQL2_TZ=-04:00 y las conexiones nuevas se abrían con -03:00 →
     pool mezclado, cada DATETIME leído corría 1 h y el vigía alertó 15 veces. El cambio
     de hora se resuelve reiniciando el proceso (ver vigilarCambioHora). */
  let tz = _tzOverride || MYSQL2_TZ;
  // Validar formato: debe ser '+HH:MM', '-HH:MM' o nombre de zona ('Region/City')
  const validOffset = /^[+-]\d{2}:\d{2}$/.test(tz);
  const validNamed  = /^[A-Za-z_]+\/[A-Za-z_]+/.test(tz);
  if (!validOffset && !validNamed) {
    console.warn(`[DB] TZ inválido '${tz}', usando fallback UTC-4`);
    tz = '-04:00';
  }
  conn.query(`SET time_zone = '${tz}'`, err => {
    if (err) console.warn(`[DB] SET time_zone '${tz}' falló:`, err.message);
  });
});

// Funciones accesibles desde controllers (adjuntas al pool para no romper imports)
pool.getTZOverride     = () => _tzOverride;
pool.setTZOverride     = (val) => { _tzOverride = (val && val.trim() !== '') ? val.trim() : null; };
pool.getActiveTZ       = () => _tzOverride || getChileAutoOffset();
pool.getChileAutoOffset  = getChileAutoOffset;
pool.getMysql2TZ       = () => MYSQL2_TZ;
pool.loadTZOverride    = loadTZOverride;

// Cargar override al arrancar (2s para que la BD esté lista)
setTimeout(loadTZOverride, 2000);

/* ── Cambio de hora en Chile → reinicio limpio ──────────────────────────────
   El offset de mysql2 (`timezone`) se fija al crear el pool y no se puede cambiar en
   caliente. Cuando el offset real de Chile deja de coincidir (primer domingo de
   septiembre y de abril), el proceso sale con código 0 y Render/Cloud Run lo levantan
   de nuevo con el offset correcto. Pasa dos veces al año, a medianoche, y tarda lo que
   un deploy. Sin override manual (ahí el Admin decide). */
function vigilarCambioHora() {
  if (_tzOverride) return;
  const actual = getChileAutoOffset();
  if (actual === MYSQL2_TZ) return;
  console.error(`[DB] Chile cambió de hora (${MYSQL2_TZ} → ${actual}): reiniciando el proceso para que el pool tome el offset nuevo.`);
  setTimeout(() => process.exit(0), 1500);
}
require('../scheduler').programar('vigia-cambio-hora', vigilarCambioHora, 60 * 1000, { infra: true, enStaging: true, arranqueMs: 60 * 1000 });

module.exports = pool;
