'use strict';
const XLSX = require('xlsx');
const pool = require('../shared/config/database');

function normRut(v) { return String(v || '').replace(/\./g, '').trim().toUpperCase(); }

(async () => {
  const archivos = process.argv.slice(2);
  if (!archivos.length) { console.error('Uso: node recover-num-op.js archivo1.xlsx archivo2.xlsx ...'); process.exit(1); }

  const rutOpMap = {};
  for (const archivo of archivos) {
    const wb = XLSX.readFile(archivo);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { defval: '' });
    const keys = Object.keys(data[0]);
    const colOP  = keys.find(k => k.trim().toUpperCase() === 'OP');
    const colRUT = keys.find(k => k.trim().toUpperCase() === 'RUT');
    for (const r of data) {
      const op = parseInt(r[colOP]);
      const rut = normRut(r[colRUT]);
      if (!isNaN(op) && op > 0 && rut) {
        if (!rutOpMap[rut]) rutOpMap[rut] = [];
        if (!rutOpMap[rut].includes(op)) rutOpMap[rut].push(op);
      }
    }
    console.log('Leido:', archivo, '| RUTs con OP:', Object.keys(rutOpMap).length);
  }

  const [sinOp] = await pool.query('SELECT id, rut_cliente FROM operaciones_brokerage WHERE num_op IS NULL');
  console.log('Registros sin num_op en BD:', sinOp.length);

  let actualizados = 0, duplicados = 0, multiples = 0, sinMatch = 0;
  for (const row of sinOp) {
    const rut = normRut(row.rut_cliente);
    const ops = rutOpMap[rut];
    if (!ops || !ops.length) { sinMatch++; continue; }
    if (ops.length > 1) { multiples++; continue; }

    const [existe] = await pool.query('SELECT id FROM operaciones_brokerage WHERE num_op = ? LIMIT 1', [ops[0]]);
    if (existe.length) { duplicados++; continue; }

    await pool.query('UPDATE operaciones_brokerage SET num_op = ? WHERE id = ?', [ops[0], row.id]);
    actualizados++;
  }

  console.log('Actualizados:', actualizados);
  console.log('Saltados - num_op ya existe en BD:', duplicados);
  console.log('Saltados - RUT con multiples OPs (ambiguo):', multiples);
  console.log('Sin match en Excel:', sinMatch);

  const [rest] = await pool.query('SELECT COUNT(*) AS cnt FROM operaciones_brokerage WHERE num_op IS NULL');
  console.log('Sin num_op restantes:', rest[0].cnt);
  pool.end();
})().catch(e => { console.error(e.message); pool.end(); });
