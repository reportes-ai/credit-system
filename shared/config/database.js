const mysql = require('mysql2/promise');
require('dotenv').config();

const host = process.env.DB_HOST || 'localhost';

// SSL solo para conexiones públicas (proxy externo), no para red interna de Railway
const needsSSL = host !== 'localhost' && !host.includes('railway.internal');

const pool = mysql.createPool({
  host,
  port:     parseInt(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'credit_system',
  timezone: '+00:00',   // TiDB Cloud almacena en UTC — interpretar correctamente
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ...(needsSSL && { ssl: { rejectUnauthorized: false } })
});

// Calcula dinámicamente el offset UTC de Chile (maneja DST automáticamente)
function getChileTZOffset() {
  const now = new Date();
  // Diferencia en minutos entre UTC y America/Santiago
  const utcStr  = now.toLocaleString('en-US', { timeZone: 'UTC' });
  const clStr   = now.toLocaleString('en-US', { timeZone: 'America/Santiago' });
  const diffMin = (new Date(clStr) - new Date(utcStr)) / 60000;
  const h = Math.floor(Math.abs(diffMin) / 60).toString().padStart(2, '0');
  const m = (Math.abs(diffMin) % 60).toString().padStart(2, '0');
  return (diffMin >= 0 ? '+' : '-') + h + ':' + m;
}

// Forzar timezone Chile en cada sesión de BD — automático invierno/verano
pool.on('connection', conn => {
  const tz = getChileTZOffset(); // '-04:00' en invierno, '-03:00' en verano
  conn.query(`SET time_zone = '${tz}'`);
});

module.exports = pool;
