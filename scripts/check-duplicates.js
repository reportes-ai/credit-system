'use strict';
const XLSX = require('xlsx');
const pool = require('../shared/config/database');
function normRut(v) { return String(v||'').replace(/\./g,'').trim().toUpperCase(); }

(async () => {
  const archivos = process.argv.slice(2);
  const rutOpMap = {};
  for (const a of archivos) {
    const wb = XLSX.readFile(a);
    const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    const keys = Object.keys(data[0]);
    const colOP  = keys.find(k => k.trim().toUpperCase() === 'OP');
    const colRUT = keys.find(k => k.trim().toUpperCase() === 'RUT');
    for (const r of data) {
      const op = parseInt(r[colOP]), rut = normRut(r[colRUT]);
      if (!isNaN(op) && op > 0 && rut) {
        if (!rutOpMap[rut]) rutOpMap[rut] = [];
        if (!rutOpMap[rut].includes(op)) rutOpMap[rut].push(op);
      }
    }
  }

  const [sinOp] = await pool.query(`
    SELECT id, rut_cliente, saldo_precio, monto_financiado, plazo,
           DATE_FORMAT(fecha_otorgado,'%Y-%m-%d') AS fecha,
           estado_eval, DATE_FORMAT(mes,'%Y-%m') AS mes
    FROM operaciones_brokerage WHERE num_op IS NULL
  `);

  const iguales = [], distintos = [];

  for (const row of sinOp) {
    const ops = rutOpMap[normRut(row.rut_cliente)];
    if (!ops || ops.length !== 1) continue;
    const [existe] = await pool.query(`
      SELECT id, num_op, saldo_precio, monto_financiado, plazo,
             DATE_FORMAT(fecha_otorgado,'%Y-%m-%d') AS fecha,
             estado_eval, DATE_FORMAT(mes,'%Y-%m') AS mes
      FROM operaciones_brokerage WHERE num_op = ? LIMIT 1
    `, [ops[0]]);
    if (!existe.length) continue;
    const e = existe[0];
    const mismo = String(e.saldo_precio) === String(row.saldo_precio)
               && String(e.monto_financiado) === String(row.monto_financiado)
               && String(e.plazo) === String(row.plazo)
               && e.fecha === row.fecha;
    const entry = { id_null: row.id, num_op: ops[0], id_con_op: e.id, mismo,
      null_datos: { sp: row.saldo_precio, mf: row.monto_financiado, pl: row.plazo, f: row.fecha, estado: row.estado_eval, mes: row.mes },
      op_datos:   { sp: e.saldo_precio,   mf: e.monto_financiado,   pl: e.plazo,   f: e.fecha,   estado: e.estado_eval,   mes: e.mes } };
    if (mismo) iguales.push(entry); else distintos.push(entry);
  }

  console.log('Mismos datos (duplicados exactos):', iguales.length);
  console.log('Datos distintos (creditos diferentes):', distintos.length);

  if (distintos.length) {
    console.log('\nDISTINTOS (mismo RUT, diferente credito):');
    distintos.forEach(c => {
      console.log(' OP', c.num_op, '| NULL[sp=' + c.null_datos.sp + ' mf=' + c.null_datos.mf + ' pl=' + c.null_datos.pl + ' f=' + c.null_datos.f + ' ' + c.null_datos.mes + ']');
      console.log('          | BD  [sp=' + c.op_datos.sp   + ' mf=' + c.op_datos.mf   + ' pl=' + c.op_datos.pl   + ' f=' + c.op_datos.f   + ' ' + c.op_datos.mes + ']');
    });
  }
  if (iguales.length) {
    console.log('\nIGUALES (duplicados a eliminar):');
    iguales.forEach(c => console.log(' id_null=' + c.id_null, '-> op=' + c.num_op, '(id=' + c.id_con_op + ')'));
  }

  pool.end();
})().catch(e => { console.error(e.message); pool.end(); });
