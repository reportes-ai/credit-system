const mysql = require('mysql2/promise');
require('dotenv').config();

const host = process.env.DB_HOST || 'localhost';
const needsSSL = host !== 'localhost' && !host.includes('railway.internal');

const pool = mysql.createPool({
  host,
  port:     parseInt(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'credit_system',
  timezone: getChileAutoOffset(),   // DEBE coincidir con el SET time_zone de la conexión (Chile); si no, las horas se desfasan
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
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
    const val = rows[0]?.valor?.trim();
    _tzOverride = (val && val !== '') ? val : null;
    console.log(`✓ TZ BD: ${_tzOverride || 'automático (' + getChileAutoOffset() + ')'}`);
  } catch(e) { _tzOverride = null; }
}

// Forzar timezone en cada conexión nueva
pool.on('connection', conn => {
  let tz = _tzOverride || getChileAutoOffset();
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
pool.loadTZOverride    = loadTZOverride;

// Cargar override al arrancar (2s para que la BD esté lista)
setTimeout(loadTZOverride, 2000);

module.exports = pool;
