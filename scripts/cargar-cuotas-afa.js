'use strict';
/* Etapa 2 CARTERA AFA — carga la TABLA DE DESARROLLO real (cuotas + pagos) de las
   216 ops ya migradas y calcula la mora desde el vencimiento de la primera cuota
   impaga. NO crea operaciones nuevas: solo completa las existentes.
   - cuotas_credito: calendario congelado (origen CARTERA_AFA), mismo contrato que
     la migración INDEXA (PAGADA/COBRANZA/VIGENTE) → lo lee el motor único
     recalcular-estado-cartera + certificados/prepago.
   - creditos: plazo, tascli_real, cuota, fecha_primera_cuota (fecha_otorgado sigue
     en blanco: no viene en esta base).
   - cobranza_judicial: dias_mora + fecha_ingreso_mora reales del calendario.
   Uso: node scripts/cargar-cuotas-afa.js [--aplicar]   (sin flag = simulación)   */

const XLSX = require('xlsx');
const pool = require('../shared/config/database');

const ARCHIVO = 'C:/Users/patri/OneDrive/Documentos/01 AUTOFACIL/02 SOFTWARE PROPIO/tabla de desarrollo cartera afa 20260707.xlsx';
const HOJA = 'TablaDesarrollo2026070712';
const APLICAR = process.argv.includes('--aplicar');
const DIA = 86400000;

// Serial Excel → 'YYYY-MM-DD'
const fx = s => {
  if (typeof s !== 'number' || !Number.isFinite(s)) return null;
  return new Date((s - 25569) * DIA).toISOString().slice(0, 10);
};
const hoy = Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
const ymd = s => { const [a, m, d] = s.split('-').map(Number); return Date.UTC(a, m - 1, d); };

(async () => {
  console.log(APLICAR ? '=== APLICANDO ===' : '=== SIMULACIÓN (usa --aplicar para escribir) ===');

  const wb = XLSX.readFile(ARCHIVO);
  const filas = XLSX.utils.sheet_to_json(wb.Sheets[HOJA]);
  const porOp = {};
  filas.forEach(r => { (porOp[r.ID_Credito] = porOp[r.ID_Credito] || []).push(r); });

  const [creds] = await pool.query(
    "SELECT id, num_op FROM creditos WHERE origen='CARTERA_AFA'");
  const [snap] = await pool.query(
    'SELECT num_op, cuotas, cuotas_pagadas, tasa FROM cobranza_judicial');
  const snapDe = {}; snap.forEach(s => { snapDe[s.num_op] = s; });

  // Idempotencia: ops que ya tienen cuotas AFA cargadas se saltan
  const [ya] = await pool.query(
    "SELECT DISTINCT id_credito FROM cuotas_credito WHERE origen='CARTERA_AFA'");
  const yaSet = new Set(ya.map(r => r.id_credito));

  let opsOk = 0, opsSalta = 0, cuotasIns = 0, sinTabla = 0, descuadres = [];
  const porEstadoMora = {}; let moraMin = Infinity, moraMax = -Infinity;

  for (const c of creds) {
    const cuotas = porOp[c.num_op];
    if (!cuotas) { sinTabla++; console.log(`  ⚠ OP ${c.num_op} sin tabla de desarrollo`); continue; }
    if (yaSet.has(c.id)) { opsSalta++; continue; }

    cuotas.sort((a, b) => a.Numero_Cuota - b.Numero_Cuota);
    const plazo = Math.max(...cuotas.map(q => q.Numero_Cuota));
    const tasa = cuotas[0].Tasa_Interes;
    const primera = fx(cuotas[0].Fecha_Vencimiento_Cuota);
    // Cuota francesa típica = valor más frecuente (la 1ª suele traer solo interés)
    const freq = {}; cuotas.forEach(q => { freq[q.Valor_Cuota] = (freq[q.Valor_Cuota] || 0) + 1; });
    const cuotaTip = +Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];

    // Cuadratura vs snapshot de la migración Etapa 1
    const s = snapDe[c.num_op];
    const pagadas = cuotas.filter(q => q.Estado_Cuota === 'PAGADA').length;
    if (s && s.cuotas != null && +s.cuotas !== plazo)
      descuadres.push(`OP ${c.num_op}: plazo tabla ${plazo} ≠ snapshot ${s.cuotas}`);
    if (s && s.cuotas_pagadas != null && +s.cuotas_pagadas !== pagadas)
      descuadres.push(`OP ${c.num_op}: pagadas tabla ${pagadas} ≠ snapshot ${s.cuotas_pagadas}`);

    // Mora real: primera cuota impaga vencida
    const impagas = cuotas.filter(q => q.Estado_Cuota !== 'PAGADA')
      .map(q => fx(q.Fecha_Vencimiento_Cuota)).filter(Boolean).sort();
    const ingresoMora = impagas[0] || null;
    const diasMora = ingresoMora ? Math.max(0, Math.floor((hoy - ymd(ingresoMora)) / DIA)) : 0;
    if (impagas.length) { moraMin = Math.min(moraMin, diasMora); moraMax = Math.max(moraMax, diasMora); }
    const est = !impagas.length ? 'AL DIA' : diasMora >= 91 ? 'VENCIDO' : diasMora >= 1 ? 'MORA' : 'VIGENTE';
    porEstadoMora[est] = (porEstadoMora[est] || 0) + 1;

    if (APLICAR) {
      const vals = cuotas.map(q => [
        c.id, c.num_op, q.Numero_Cuota, fx(q.Fecha_Vencimiento_Cuota),
        q.Interes_Cuota ?? 0, q.Amortizacion_Cuota ?? 0, q.Valor_Cuota ?? 0,
        q.Saldo_Insoluto_Cuota ?? 0, q.Estado_Cuota, fx(q.Fecha_Pago),
        tasa, q['Días desfase'] ?? null, 'CARTERA_AFA']);
      await pool.query(
        `INSERT INTO cuotas_credito (id_credito, num_op, numero_cuota, fecha_vencimiento,
          interes, amortizacion, valor_cuota, saldo_insoluto, estado_cuota, fecha_pago,
          tasa, dias_desfase, origen) VALUES ?`, [vals]);
      await pool.query(
        `UPDATE creditos SET plazo=?, tascli_real=?, cuota=?, fecha_primera_cuota=? WHERE id=?`,
        [plazo, tasa, cuotaTip, primera, c.id]);
      await pool.query(
        `UPDATE cobranza_judicial SET dias_mora=?, fecha_ingreso_mora=? WHERE num_op=?`,
        [diasMora, ingresoMora, c.num_op]);
    }
    opsOk++; cuotasIns += cuotas.length;
  }

  console.log(`\nOps procesadas: ${opsOk} | ya cargadas (saltadas): ${opsSalta} | sin tabla: ${sinTabla}`);
  console.log(`Cuotas ${APLICAR ? 'insertadas' : 'a insertar'}: ${cuotasIns}`);
  console.log(`Estado por mora real:`, porEstadoMora);
  if (moraMax >= 0) console.log(`Días mora: min ${moraMin} / max ${moraMax}`);
  if (descuadres.length) { console.log(`\n⚠ DESCUADRES vs snapshot (${descuadres.length}):`); descuadres.slice(0, 20).forEach(d => console.log('  ' + d)); }
  else console.log('✓ Cuadra con el snapshot de la Etapa 1 (cuotas y pagadas)');

  if (APLICAR) {
    // El motor único reclasifica estado_cartera con el calendario real recién cargado
    const { recalcularEstadoCartera } = require('../services/creditos/src/utils/recalcular-estado-cartera');
    const r = await recalcularEstadoCartera();
    console.log('\nMotor estado_cartera:', r.porEstado, `(${r.cambios} cambios)`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
