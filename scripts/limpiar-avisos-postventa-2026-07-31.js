/* ─────────────────────────────────────────────────────────────────────────────
   LIMPIEZA — avisos de Post Venta que pedían algo YA HECHO

   Los flujos de Saldo Precio y Comisión avisan en cada paso, pero ningún paso
   retiraba el aviso del paso anterior. Resultado: la campanita mostraba a la vez
   "Fondos recibidos — emitir Orden de Pago" y "Orden de Pago emitida" de la MISMA
   operación; el segundo aviso es justamente la prueba de que el primero ya se
   atendió. Además `fondos_cargados` se emite uno por día y los de días viejos
   nunca se iban.

   Desde v167.3 eso no vuelve a pasar (campo `sucede` / `porPeriodo` en
   postventa.controller). Este script limpia lo que quedó de antes, con las
   MISMAS reglas, para no dejar el arreglo a medias.

   Reversible: lo borrado queda en scripts/respaldo-avisos-postventa-2026-07-31.json
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const pool = require('../shared/config/database');

// Paso → paso anterior que queda obsoleto cuando el primero existe.
const SUCEDE = {
  orden_emitida:        'fondos_recibidos',
  enviado_pago:         'orden_emitida',
  pago_realizado:       'enviado_pago',
  com_orden_emitida:    'com_factura_recibida',
  com_enviado_pago:     'com_orden_emitida',
  com_pago_realizado:   'com_enviado_pago',
  parque_pago_realizado:'parque_orden_emitida',
};
const POR_PERIODO = ['fondos_cargados', 'com_fondos_cargados'];

(async () => {
  const borradas = [];
  const borrar = async (clave, motivo) => {
    const [filas] = await pool.query('SELECT * FROM notificaciones WHERE clave = ?', [clave]);
    if (!filas.length) return 0;
    filas.forEach(f => borradas.push({ ...f, _motivo: motivo }));
    const [r] = await pool.query('DELETE FROM notificaciones WHERE clave = ?', [clave]);
    return r.affectedRows;
  };

  // 1) Pasos superados: existe el aviso del paso siguiente para la misma operación.
  let nSup = 0;
  for (const [posterior, previo] of Object.entries(SUCEDE)) {
    const [ops] = await pool.query(
      `SELECT DISTINCT SUBSTRING(clave, ?) AS suf FROM notificaciones WHERE clave LIKE ?`,
      [`pvalert:${posterior}:`.length + 1, `pvalert:${posterior}:%`]);
    for (const { suf } of ops) {
      const n = await borrar(`pvalert:${previo}:${suf}`, `superado por ${posterior}`);
      if (n) { nSup += n; console.log(`  ✂ ${previo}:${suf} (${n}) — ya está ${posterior}`); }
    }
  }

  // 2) Avisos por período: solo sobrevive el más reciente.
  let nPer = 0;
  for (const ev of POR_PERIODO) {
    const [cs] = await pool.query(
      `SELECT DISTINCT clave FROM notificaciones WHERE clave LIKE ? ORDER BY clave DESC`,
      [`pvalert:${ev}:%`]);
    for (const c of cs.slice(1)) {   // slice(1): se conserva el último (clave mayor = fecha mayor)
      const n = await borrar(c.clave, `período anterior de ${ev}`);
      if (n) { nPer += n; console.log(`  ✂ ${c.clave} (${n}) — período anterior`); }
    }
    if (cs.length) console.log(`  ✔ se conserva ${cs[0].clave}`);
  }

  if (borradas.length)
    fs.writeFileSync(path.join(__dirname, 'respaldo-avisos-postventa-2026-07-31.json'),
      JSON.stringify(borradas, null, 2));

  const [[t]] = await pool.query("SELECT COUNT(*) n, SUM(leida=0) sin_leer FROM notificaciones WHERE clave LIKE 'pvalert:%'");
  console.log(`\nRetirados: ${nSup} por paso superado + ${nPer} por período = ${borradas.length}`);
  console.log(`Quedan ${t.n} avisos de Post Venta (${t.sin_leer} sin leer).`);
  process.exit(0);
})();
