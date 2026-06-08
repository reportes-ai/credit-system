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

// Forzar timezone Chile en cada sesión de BD
// → CURRENT_TIMESTAMP y NOW() devuelven hora Chile, no UTC
pool.on('connection', conn => {
  conn.query("SET time_zone = '-04:00'");
});

module.exports = pool;
