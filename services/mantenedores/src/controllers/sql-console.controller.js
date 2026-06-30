'use strict';
// Consola SQL de SOLO LECTURA dentro de la app. Gateada a nivel Dios (mantenedores_solo_dios).
// Permite SELECT / SHOW / DESCRIBE / EXPLAIN / WITH. Una sentencia a la vez, tope de filas y timeout.
// Las MODIFICACIONES siguen yendo por los editores BD — esta consola nunca escribe.
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

const ROW_CAP = 2000;          // tope de filas devueltas al cliente
const TIMEOUT_MS = 20000;      // mata la query si tarda más de 20s
const READONLY = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH'];

const ejecutar = async (req, res) => {
  let sql = String((req.body || {}).sql || '').trim();
  sql = sql.replace(/;+\s*$/, '');           // permite ; final suelto
  if (!sql) return res.status(400).json({ success: false, data: null, error: 'Escribe una consulta' });
  if (sql.includes(';')) return res.status(400).json({ success: false, data: null, error: 'Solo una sentencia a la vez (sin ;)' });

  const fw = sql.replace(/^[(\s]+/, '').split(/\s+/)[0].toUpperCase();
  if (!READONLY.includes(fw)) {
    return res.status(403).json({ success: false, data: null,
      error: 'Solo consultas de lectura: SELECT, SHOW, DESCRIBE, EXPLAIN. Las modificaciones van por los editores BD.' });
  }

  try {
    const t0 = Date.now();
    const [rows, fields] = await pool.query({ sql, timeout: TIMEOUT_MS });
    const ms = Date.now() - t0;
    const arr = Array.isArray(rows) ? rows : [];
    const truncado = arr.length > ROW_CAP;
    const filas = truncado ? arr.slice(0, ROW_CAP) : arr;
    const columnas = (fields && fields.length)
      ? fields.map(f => f.name)
      : (filas[0] ? Object.keys(filas[0]) : []);

    auditar({ req, accion: 'CONSULTA', modulo: 'sql-console', entidad: 'sql',
      detalle: `Consulta SQL (${arr.length} filas, ${ms}ms): ${sql.slice(0, 300)}` });

    res.json({ success: true, error: null,
      data: { columnas, filas, total: arr.length, truncado, ms } });
  } catch (e) {
    res.json({ success: false, data: null, error: e.sqlMessage || e.message });
  }
};

module.exports = { ejecutar };
