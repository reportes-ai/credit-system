#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
   Saldo inicial de la Indemnización por Años de Servicio (25-09-2026).

   Hasta ahora el pasivo por IAS nunca se había reconocido: el contador solo
   provisionaba, mes a mes, el caso de Ricardo Pino (con demanda laboral) dentro
   de 2106070 "Provisión Finiquitos por Pagar", reversándolo el día 1 y volviendo
   a constituirlo el último día del mes, siempre por el mismo monto desde 2025.

   Este script hace las dos cosas que faltaban, decididas por Pato:

     1. APERTURA (por trabajador indefinido vigente, al 31-08-2026)
        Lo devengado en ejercicios anteriores: base del finiquito topada a 90 UF
        × años de servicio (tope 11). Va DEBE 2703010 Resultados Acumulados /
        HABER 2106031, porque es gasto de años pasados, no del mes.

     2. RICARDO PINO (demanda laboral, ya no trabaja acá)
        Los $14.407.606 que ya venía provisionando el contador ($11.949.810 de
        años de servicio + $2.457.796 de aviso previo) se TRASPASAN de 2106070 a
        2106031. No toca resultado: es una reclasificación entre pasivos.

   ⚠ DESPUÉS DE CORRER ESTO hay que pedirle al contador que DEJE DE hacer en
     AVSOFT su asiento mensual de "PROVISION FINIQUITO R. PINO"; si no, el pasivo
     queda contado dos veces (él en 2106070 y nosotros en 2106031).

     node scripts/apertura-ias-2026-08.js           → simula
     node scripts/apertura-ias-2026-08.js --apply   → aplica
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../shared/config/database');
const prov = require('../services/contabilidad/src/provisiones');

const APLICAR = process.argv.includes('--apply');
const HASTA = '2026-08';                       // el saldo inicial se reconoce al cierre de agosto
const clp = n => '$' + Math.round(Number(n) || 0).toLocaleString('es-CL');

const PINO = {
  clave: 'RPINO',
  nombre: 'Ricardo Pino (demanda laboral)',
  rut: null,
  monto: 11949810 + 2457796,
  detalle: 'Años de servicio $11.949.810 + aviso previo $2.457.796 · venía provisionado por el contador en 2106070 desde 2025',
  fecha: '2026-08-31',
  mes: HASTA,
};

(async () => {
  await new Promise(r => setTimeout(r, 15000));          // que corran las migraciones
  console.log(APLICAR ? '=== APLICANDO ===\n' : '=== SIMULACIÓN (no escribe nada) ===\n');

  const [gente] = await pool.query(
    `SELECT u.id_usuario, TRIM(CONCAT(u.nombre,' ',COALESCE(u.apellido,''))) nombre
       FROM usuarios u JOIN rh_fichas f ON f.id_usuario=u.id_usuario
      WHERE UPPER(COALESCE(f.tipo_contrato,''))='INDEFINIDO' AND COALESCE(f.no_mostrar,0)=0 AND u.fecha_ingreso IS NOT NULL
      ORDER BY u.nombre`);

  let total = 0, n = 0;
  for (const g of gente) {
    const q = await prov.cuotaIas(g.id_usuario, HASTA);
    if (q.skip) { console.log(`  —  ${String(g.nombre).padEnd(26)} fuera: ${q.skip}`); continue; }
    const monto = Math.round(q.base_topada * q.anos);
    if (!(monto > 0)) { console.log(`  —  ${String(g.nombre).padEnd(26)} sin años completos`); continue; }
    n++; total += monto;
    console.log(`  ${String(g.nombre).padEnd(26)} ${String(q.anos).padStart(2)} año(s) × ${clp(q.base_topada).padStart(12)} = ${clp(monto).padStart(14)}`);
    if (APLICAR) {
      const r = await prov.constituirAperturaIas(g.id_usuario, HASTA, 'Apertura IAS (Pato)');
      if (r.error) console.log(`      ⚠ ${r.error}`);
      else if (r.skip) console.log(`      (${r.skip})`);
    }
  }

  console.log(`\n  APERTURA: ${n} trabajador(es) · ${clp(total)}  → DEBE 2703010 Resultados Acumulados / HABER 2106031`);
  console.log(`  DEMANDA · ${PINO.nombre}: ${clp(PINO.monto)}  → DEBE 2106070 / HABER 2106031 (traspaso, no es gasto)`);
  console.log(`  Pasivo total reconocido en 2106031: ${clp(total + PINO.monto)} + las cuotas mensuales desde septiembre`);

  if (APLICAR) {
    const r = await prov.traspasarDemandaIas(PINO, 'Apertura IAS (Pato)');
    console.log('\n  Pino:', JSON.stringify(r));
    const c = await prov.cuadro('2026-09', 'IAS');
    console.log(`\n  Cuenta 2106031 a septiembre: SF ${clp(c.saldo_final)} · detalle ${clp(c.motor_vigente)} en ${c.motor_n_vigente} fila(s) · diferencia ${clp(c.saldo_historico)}`);
    console.log('\n  ⚠ PENDIENTE: pedirle al contador que deje de hacer el asiento mensual de PROVISION FINIQUITO R. PINO en AVSOFT.');
  } else {
    console.log('\nSimulación: no se escribió nada.');
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
