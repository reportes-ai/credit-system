/* ─────────────────────────────────────────────────────────────────────────────
   SANEAMIENTO — créditos con la etapa partida en las tres columnas

   Qué arregla: filas donde `estado`, `estado_credito` y `estado_eval` están las
   TRES pobladas pero en desacuerdo, porque algún proceso escribió solo dos.
   Desde ahora eso no puede volver a pasar: la etapa se escribe por el motor
   único `shared/etapa-credito.js`. Esto limpia lo que quedó de antes.

   Hacia dónde se alinea: hacia `estado`, porque es la columna que MANDA al leer
   (ETAPA_SQL la evalúa primero). Alinear hacia ella deja la BD diciendo lo que
   el sistema ya mostraba — no cambia ni un número en pantalla, solo elimina la
   contradicción que hacía que cada consumidor viera una verdad distinta.

   Se EXCLUYEN las filas cuyo `estado` guarda una palabra de CARTERA
   (VIGENTE / EN MORA / VENCIDO / PREPAGADO / CASTIGADO): ahí `estado` no está
   diciendo la etapa sino la situación de pago, y copiarla a las otras dos
   destruiría la etapa real.

   Reversible: valores previos en scripts/respaldo-etapas-desalineadas-2026-07-31.json
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const pool = require('../shared/config/database');
const { PALABRAS_CARTERA } = require('../shared/etapa-credito');

(async () => {
  const [filas] = await pool.query(`
    SELECT id, num_op, financiera, estado, estado_credito, estado_eval
      FROM creditos
     WHERE COALESCE(estado,'') <> ''
       AND estado NOT IN (?)
       AND (UPPER(COALESCE(estado,'')) <> UPPER(COALESCE(estado_credito,''))
         OR UPPER(COALESCE(estado,'')) <> UPPER(COALESCE(estado_eval,'')))`,
    [PALABRAS_CARTERA]);

  console.log('A sanear:', filas.length);
  if (!filas.length) { console.log('Nada que hacer ✔'); process.exit(0); }

  const patrones = {};
  filas.forEach(f => { const k = `${f.estado}/${f.estado_credito}/${f.estado_eval}`; patrones[k] = (patrones[k]||0)+1; });
  console.log(patrones);

  fs.writeFileSync(path.join(__dirname, 'respaldo-etapas-desalineadas-2026-07-31.json'),
    JSON.stringify(filas, null, 2));

  let n = 0;
  for (let i = 0; i < filas.length; i += 200) {
    const lote = filas.slice(i, i + 200);
    // Cada fila se alinea a SU propio `estado`, así que va una a una dentro del lote.
    for (const f of lote) {
      const [r] = await pool.query(
        'UPDATE creditos SET estado_credito = ?, estado_eval = ? WHERE id = ?',
        [f.estado, f.estado, f.id]);
      n += r.affectedRows;
    }
    console.log(`  … ${Math.min(i + 200, filas.length)}/${filas.length}`);
  }
  console.log('Alineados:', n);

  const [[q]] = await pool.query(`
    SELECT COUNT(*) n FROM creditos
     WHERE COALESCE(estado,'') <> '' AND estado NOT IN (?)
       AND (UPPER(COALESCE(estado,'')) <> UPPER(COALESCE(estado_credito,''))
         OR UPPER(COALESCE(estado,'')) <> UPPER(COALESCE(estado_eval,'')))`, [PALABRAS_CARTERA]);
  console.log('Quedan desalineados:', q.n);
  process.exit(0);
})();
