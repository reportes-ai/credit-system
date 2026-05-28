/**
 * Volcado de base de datos → docker/init/dump.sql
 * Usa la misma conexión configurada en .env (TiDB / MySQL)
 * Ejecutar: node scripts/volcar-bd.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const fs    = require('fs');
const path  = require('path');

const OUT = path.join(__dirname, '..', 'docker', 'init', 'dump.sql');

async function main() {
  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST,
    port:     parseInt(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl:      { rejectUnauthorized: false },
    multipleStatements: true,
  });

  console.log(`Conectado a ${process.env.DB_HOST} / ${process.env.DB_NAME}`);

  const lines = [];
  lines.push('-- Volcado generado por scripts/volcar-bd.js');
  lines.push(`-- Fecha: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('SET FOREIGN_KEY_CHECKS=0;');
  lines.push('SET SQL_MODE="NO_AUTO_VALUE_ON_ZERO";');
  lines.push('');

  // Obtener todas las tablas
  const [tables] = await conn.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = ? AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
    [process.env.DB_NAME]
  );

  for (const { table_name } of tables) {
    process.stdout.write(`  → ${table_name} ... `);

    // CREATE TABLE
    const [[row]] = await conn.query(`SHOW CREATE TABLE \`${table_name}\``);
    const createSql = row['Create Table']
      .replace(/AUTO_INCREMENT=\d+/g, '')  // quitar auto_increment offset
      .replace(/\n/g, '\n');

    lines.push(`-- ─── ${table_name} ───────────────────────────────`);
    lines.push(`DROP TABLE IF EXISTS \`${table_name}\`;`);
    lines.push(createSql + ';');
    lines.push('');

    // Datos
    const [rows] = await conn.query(`SELECT * FROM \`${table_name}\``);
    if (rows.length === 0) {
      console.log('vacía');
      continue;
    }

    // INSERT en lotes de 500
    const cols = Object.keys(rows[0]).map(c => `\`${c}\``).join(', ');
    const chunks = [];
    for (let i = 0; i < rows.length; i += 500) chunks.push(rows.slice(i, i + 500));

    for (const chunk of chunks) {
      const vals = chunk.map(r =>
        '(' + Object.values(r).map(v => {
          if (v === null) return 'NULL';
          if (typeof v === 'number') return v;
          if (v instanceof Date) return `'${v.toISOString().slice(0, 19).replace('T', ' ')}'`;
          return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
        }).join(', ') + ')'
      ).join(',\n');
      lines.push(`INSERT INTO \`${table_name}\` (${cols}) VALUES`);
      lines.push(vals + ';');
      lines.push('');
    }

    console.log(`${rows.length} filas`);
  }

  lines.push('SET FOREIGN_KEY_CHECKS=1;');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join('\n'), 'utf8');

  await conn.end();

  const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
  console.log(`\nVuelto exitoso: ${OUT}  (${kb} KB)`);
  console.log('\nAhora ejecuta:  docker-compose up -d --build');
}

main().catch(e => { console.error('\nERROR:', e.message); process.exit(1); });
