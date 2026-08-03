'use strict';
/* Baja de datos de PRUEBA del cliente RUT 21809836-3
   ("MARGARITA ISABEL SIN INFORMACION SIN INFORMACION", id_cliente 366959).
   Pedido de Pato el 03-08-2026: "borra estas cartas de aprobación y las operaciones
   relacionadas... eran pruebas".

   Respalda TODO a disco antes de tocar nada, y solo entonces borra.

   FASE 1 (sin efecto en cifras de negocio):
     · 5 cartas de aprobación (op_carta 26572576*) — todas apuntan a créditos que YA
       no existen (210102, 720001, 750001, 750153, 900001: verificado, 0 vivos).
     · Crédito 88139 — RECHAZADO, sin comisiones ni ingresos calculados.

   FASE 2 (NO se ejecuta sin confirmación explícita — ver aviso al final):
     · Crédito 88150 — OTORGADO $7.161.289 en MAYO 2026, que es un mes CERRADO con
       comisiones liquidadas. Borrarlo cambia las cifras ya reportadas de mayo.

   Uso:  node scripts/borrar-cartas-prueba-21809836-3.js              (simulación)
         node scripts/borrar-cartas-prueba-21809836-3.js --ejecutar   (fase 1)
         node scripts/borrar-cartas-prueba-21809836-3.js --ejecutar --incluir-88150  */
const pool = require('../shared/config/database');
const fs   = require('fs');
const path = require('path');

const EJECUTAR = process.argv.includes('--ejecutar');
const CON88150 = process.argv.includes('--incluir-88150');
const DESTINO  = 'C:\\Users\\patri\\Documents\\respaldos-bd\\cartas-prueba-21809836-3';

const RUT = '21809836-3';
const ID_CLIENTE = 366959;

(async () => {
  // ── Inventario ────────────────────────────────────────────────────────────
  const [cartas] = await pool.query(
    `SELECT * FROM cartas_aprobacion WHERE REPLACE(REPLACE(rut_cliente,'.',''),' ','')=?`, [RUT]);
  const [creditos] = await pool.query('SELECT * FROM creditos WHERE id_cliente=?', [ID_CLIENTE]);

  const idsCred = creditos.map(c => c.id);
  const rel = {};
  for (const [tabla, col] of [
    ['cuotas_credito', 'id_credito'], ['pagos_credito', 'id_credito'],
    ['auditoria_credito', 'id_credito'], ['cartolas_movimientos', 'num_op'],
    ['cuentas_transitorias', 'id_credito'], ['fundantes_brokerage', 'id_credito'],
  ]) {
    const vals = col === 'num_op' ? creditos.map(c => c.num_op) : idsCred;
    if (!vals.length) continue;
    const [r] = await pool.query(`SELECT * FROM \`${tabla}\` WHERE \`${col}\` IN (?)`, [vals])
      .catch(() => [[]]);
    if (r.length) rel[tabla] = r;
  }

  console.log(`\nCARTAS de prueba: ${cartas.length}`);
  cartas.forEach(c => console.log(`   id=${c.id} ${c.op_carta} ${c.status} · ${c.nombre_dealer}`));
  console.log(`\nCREDITOS del cliente: ${creditos.length}`);
  creditos.forEach(c => console.log(`   num_op=${c.num_op} ${String(c.mes).slice(0,7)} ${c.estado_credito} $${Number(c.monto_financiado).toLocaleString('es-CL')}`));
  console.log('\nFILAS RELACIONADAS:', Object.keys(rel).length
    ? Object.entries(rel).map(([t, r]) => `${t}:${r.length}`).join(' · ') : 'ninguna');

  // ── Respaldo a disco (siempre, aunque sea simulación) ─────────────────────
  if (!fs.existsSync(DESTINO)) fs.mkdirSync(DESTINO, { recursive: true });
  const dump = { fecha: '2026-08-03', rut: RUT, id_cliente: ID_CLIENTE, cartas, creditos, relacionadas: rel };
  const archivo = path.join(DESTINO, 'respaldo-completo.json');
  fs.writeFileSync(archivo, JSON.stringify(dump, null, 1), 'utf8');
  console.log(`\n✓ Respaldo escrito: ${archivo} (${Math.round(fs.statSync(archivo).size/1024)} KB)`);

  const cred88139 = creditos.find(c => Number(c.num_op) === 88139);
  const cred88150 = creditos.find(c => Number(c.num_op) === 88150);

  if (!EJECUTAR) {
    console.log('\n[SIMULACIÓN] Nada se borró. --ejecutar para aplicar la fase 1.\n');
    process.exit(0);
  }

  // ── Fase 1 ────────────────────────────────────────────────────────────────
  for (const c of cartas) {
    await pool.query('DELETE FROM cartas_aprobacion WHERE id=?', [c.id]);
    console.log(`✓ Carta eliminada ${c.op_carta} (id ${c.id})`);
  }
  if (cred88139) {
    await pool.query('DELETE FROM creditos WHERE id=?', [cred88139.id]);
    console.log(`✓ Crédito 88139 eliminado (RECHAZADO, sin efecto en cifras)`);
  }

  // ── Fase 2 (solo con bandera explícita) ───────────────────────────────────
  if (cred88150) {
    if (CON88150) {
      for (const [tabla, col] of [['cuotas_credito','id_credito'], ['pagos_credito','id_credito'],
                                  ['auditoria_credito','id_credito']]) {
        await pool.query(`DELETE FROM \`${tabla}\` WHERE \`${col}\`=?`, [cred88150.id]).catch(() => {});
      }
      await pool.query('DELETE FROM creditos WHERE id=?', [cred88150.id]);
      console.log(`✓ Crédito 88150 eliminado — MAYO 2026 baja $7.161.289 (mes cerrado)`);
    } else {
      console.log(`\n⚠ Crédito 88150 NO se tocó (OTORGADO $7.161.289 en mayo-2026, mes CERRADO).`);
      console.log(`   Para borrarlo: --ejecutar --incluir-88150`);
    }
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
