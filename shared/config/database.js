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
  timezone: '-03:00',   // Hora Chile (America/Santiago estándar)
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ...(needsSSL && { ssl: { rejectUnauthorized: false } })
});

module.exports = pool;
