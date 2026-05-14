const mysql = require('mysql2/promise');
require('dotenv').config();

const isCloud = process.env.DB_HOST && process.env.DB_HOST !== 'localhost';

const pool = mysql.createPool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     process.env.DB_PORT     || 3306,
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'credit_system',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ...(isCloud && {
    ssl: { rejectUnauthorized: false }
  })
});

module.exports = pool;
