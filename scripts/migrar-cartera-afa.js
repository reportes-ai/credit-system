'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   MIGRACIÓN CARTERA AFA (una vez) — node scripts/migrar-cartera-afa.js [--aplicar]
   Lee CARTERA AFA.xlsx (216 ops demandadas) e inserta:
   - creditos: origen CARTERA_AFA, financiera AFA, estado OTORGADO,
     estado_cartera: Demandado/Incobrable/Cobr.ExtraJudicial→VENCIDO,
     Cerrado→TERMINADO, Pagando→MORA (decisión Pato 2026-07-07:
     INCOBRABLE NO ES CASTIGADO — castigo es acción contable manual).
     fecha_otorgado/plazo/tasa/cuota EN BLANCO (vienen en otra base).
   - cobranza_judicial: datos judiciales + snapshot financiero + raw completo.
   Sin --aplicar solo simula y muestra la cuadratura.
   ───────────────────────────────────────────────────────────────────────── */
const XLSX = require('xlsx');
const pool = require('../shared/config/database');

const ARCHIVO = 'C:/Users/patri/OneDrive/Documentos/01 AUTOFACIL/02 SOFTWARE PROPIO/01 CORE AUTOFACIL/CARTERA AFA.xlsx';
const APLICAR = process.argv.includes('--aplicar');

const N = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const serialDate = v => (typeof v === 'number' && v > 20000 && v < 80000)
  ? new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10) : null;
const ddmmyyyy = v => { const m = String(v || '').match(/^(\d{1,2})-(\d{1,2})-(\d{4})/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; };

const MAPA_CARTERA = { 'Demandado': 'VENCIDO', 'Incobrable': 'VENCIDO', 'Cobr. Extra Judicial': 'VENCIDO', 'Cerrado': 'TERMINADO', 'Pagando': 'MORA' };
const normAbogado = v => {
  const s = String(v || '').trim().toUpperCase();
  if (!s || s === 'NO ASIGNADO' || s === 'PAGANDO' || s === 'PAGADO') return null;  // no son abogados
  return s;
};

(async () => {
  const rows = XLSX.utils.sheet_to_json(XLSX.readFile(ARCHIVO).Sheets['Hoja1'], { defval: null });
  console.log('Filas del Excel:', rows.length);

  // clientes por RUT (todos deberían existir)
  const [cls] = await pool.query("SELECT id_cliente, REPLACE(REPLACE(UPPER(rut),'.',''),' ','') r FROM clientes");
  const mCl = new Map(cls.map(c => [c.r, c.id_cliente]));

  let insCred = 0, insJud = 0, sinCliente = 0, yaExiste = 0, saldoTotal = 0;
  for (const r of rows) {
    const numOp = String(r['N° Operación']);
    const rut = String(r['RUT'] || '').trim().toUpperCase();
    const idCliente = mCl.get(rut.replace(/\./g, '')) || null;
    if (!idCliente) { sinCliente++; console.log('  ⚠ sin cliente:', numOp, rut); }
    const statusCred = String(r['Status\r\nCrédito'] || '').trim();
    const estadoCartera = MAPA_CARTERA[statusCred] || 'VENCIDO';
    const cartera = String(r['Cartera Original'] || '').trim().toUpperCase() || null;
    saldoTotal += N(r['Saldo Deuda']) || 0;

    const [[ya]] = await pool.query('SELECT id FROM creditos WHERE num_op=?', [numOp]);
    if (ya) { yaExiste++; console.log('  ⚠ num_op ya existe en creditos:', numOp); continue; }

    if (APLICAR) {
      await pool.query(
        `INSERT INTO creditos (num_op, numero_credito, id_financiera, financiera, origen, estado, estado_cartera,
           cartera_original, status_cobranza, id_cliente, patente, marca, modelo, anio_vehiculo, monto_financiado)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [numOp, numOp, numOp, 'AFA', 'CARTERA_AFA', 'OTORGADO', estadoCartera,
         cartera, statusCred.toUpperCase(), idCliente,
         String(r['Patente'] || '').trim().toUpperCase() || null,
         String(r['Marca'] || '').trim() || null, String(r['Modelo'] || '').trim() || null,
         N(r['Año']), N(r['Monto Original'])]);
      insCred++;
      await pool.query(
        `INSERT INTO cobranza_judicial (num_op, rut, cartera_original, status_credito, abogado, status_legal,
           juzgado, rol, fecha_ultimo_status, comentario, gastos_procesales, pagare, garantia_sistema,
           saldo_deuda, provision, reversos, no_provisionado, dias_mora, fecha_ingreso_mora,
           fecha_ultimo_pago, cuotas_pagadas, monto_original, cuotas, tasa, valor_cuota, raw, origen)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'CARTERA_AFA')
         ON DUPLICATE KEY UPDATE saldo_deuda=VALUES(saldo_deuda)`,
        [numOp, rut, cartera, statusCred.toUpperCase(), normAbogado(r['Abogado']),
         String(r['STATUS LEGAL'] || '').trim().toUpperCase() || null,
         r['JUZGADO'] != null ? String(r['JUZGADO']) : null,
         String(r['ROL'] || '').trim() || null,
         serialDate(r['FECHA ULTIMO\r\nSTATUS']),
         String(r['COMENTARIO'] || '').trim() || null,
         N(r['GASTOS PROCESALES']) || 0,
         String(r['PAGARE'] || '').trim() || null, N(r['Garantia\r\nSistema']),
         N(r['Saldo Deuda']), N(r['Provision ']), N(r['Reversos']), N(r['No provisionado']),
         N(r['dia mora']), serialDate(r['Ingreso\r\na mora']), ddmmyyyy(r['Fecha Ultimo Pago']),
         N(r['Cuotas Pagadas']), N(r['Monto Original']), N(r['Cuotas']), N(r['Tasa']), N(r['Valor Cuota']),
         JSON.stringify(r)]);
      insJud++;
    }
  }

  console.log('────── RESUMEN', APLICAR ? '(APLICADO)' : '(SIMULACIÓN — usa --aplicar)', '──────');
  console.log('creditos insertados:', insCred, '| judicial insertados:', insJud);
  console.log('sin cliente:', sinCliente, '| num_op ya existentes:', yaExiste);
  console.log('Saldo deuda total Excel: $' + saldoTotal.toLocaleString('es-CL'));

  if (APLICAR) {
    const [[c1]] = await pool.query("SELECT COUNT(*) n FROM creditos WHERE origen='CARTERA_AFA'");
    const [[c2]] = await pool.query('SELECT COUNT(*) n, IFNULL(SUM(saldo_deuda),0) s FROM cobranza_judicial');
    const [[c3]] = await pool.query("SELECT estado_cartera, COUNT(*) n FROM creditos WHERE origen='CARTERA_AFA' GROUP BY estado_cartera").then(r => [r]);
    console.log('CUADRATURA → creditos CARTERA_AFA:', c1.n, '| judicial:', c2.n, '| saldo BD: $' + Number(c2.s).toLocaleString('es-CL'));
    const [dist] = await pool.query("SELECT estado_cartera, COUNT(*) n FROM creditos WHERE origen='CARTERA_AFA' GROUP BY estado_cartera");
    console.log('estado_cartera:', JSON.stringify(dist));
    const cuadra = c1.n === rows.length - yaExiste && Math.round(Number(c2.s)) === Math.round(saldoTotal);
    console.log(cuadra ? '✅ CUADRA PERFECTO' : '❌ NO CUADRA — REVISAR');
  }
  process.exit(0);
})().catch(e => { console.error('FALLO:', e); process.exit(1); });
