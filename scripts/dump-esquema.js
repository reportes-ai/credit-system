// Vuelca el esquema completo de la BD (tablas + columnas) a JSON, para el Diccionario de Datos.
// Uso: node scripts/dump-esquema.js > salida.json
const pool = require('../shared/config/database');

(async () => {
  const [tablas] = await pool.query(`
    SELECT TABLE_NAME nombre, TABLE_COMMENT comentario, TABLE_ROWS filas
      FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
     ORDER BY TABLE_NAME`);
  const [cols] = await pool.query(`
    SELECT TABLE_NAME tabla, COLUMN_NAME nombre, COLUMN_TYPE tipo,
           IS_NULLABLE nulo, COLUMN_KEY llave, COLUMN_DEFAULT defecto, COLUMN_COMMENT comentario
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
     ORDER BY TABLE_NAME, ORDINAL_POSITION`);
  const porTabla = {};
  for (const c of cols) {
    (porTabla[c.tabla] = porTabla[c.tabla] || []).push(c);
  }
  const out = tablas.map(t => ({ ...t, columnas: porTabla[t.nombre] || [] }));
  console.log(JSON.stringify(out));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
