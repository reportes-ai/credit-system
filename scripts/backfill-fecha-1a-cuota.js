/* Barrido UNA VEZ: rellena creditos.fecha_primera_cuota leyendo el CUADRO DE PAGO
   de las cartas Autofin YA SUBIDAS.

   Por qué: hasta hoy subir la carta al módulo Cartas no guardaba este dato en el
   crédito (el parser solo contaba las fechas del cuadro para deducir el plazo), y
   el Informe Canal no lo trae. Resultado: operaciones con la carta arriba caían
   igual a "Datos faltantes" (op 2608036). Desde este commit las nuevas se llenan
   solas; este script cierra el histórico.

   FILL-ONLY: solo toca créditos con fecha_primera_cuota NULL. Nunca pisa lo digitado.

   Necesita acceso al bucket (los PDF ya no viven en la base):
     GCS_BUCKET=autofacil-docs  y  GCS_CREDENCIALES o ADC de gcloud

   Uso:  node scripts/backfill-fecha-1a-cuota.js           → simula (no escribe)
         node scripts/backfill-fecha-1a-cuota.js --aplicar → escribe
*/
/* OJO: NO definir global.window acá — pdf-parse (pdfjs) se cree en un navegador
   y se cuelga esperando un worker ("No PDFJS.workerSrc specified"). */
const pool = require('../shared/config/database');
const almacen = require('../shared/almacen-docs');
const pdf = require('pdf-parse');
const { parseCartaAutofin } = require('../services/cartas/src/controllers/cartas.controller');

const APLICAR = process.argv.includes('--aplicar');

(async () => {
  /* Documento CARTA_AUTOFIN → su carta → el crédito enlazado (FK explícita o
     num_op = id_financiera, el mismo doble enlace que usa el módulo Cartas),
     quedándonos SOLO con los créditos que aún no tienen la fecha. */
  const [todos] = await pool.query(`
    SELECT d.id AS id_doc, d.doc_ruta, d.data, d.extracted,
           ca.id AS id_carta, ca.op_carta, cr.id AS id_credito, cr.num_op
      FROM cartas_documentos d
      JOIN cartas_aprobacion ca ON ca.id = d.id_carta
      JOIN creditos cr ON (cr.id = ca.id_credito_creado OR cr.num_op = ca.id_financiera)
     WHERE d.tipo = 'CARTA_AUTOFIN'
       AND cr.fecha_primera_cuota IS NULL
     ORDER BY cr.id, d.id DESC`);
  // Un crédito puede matchear por FK y por num_op, o tener cartas corregidas:
  // se queda el documento más reciente de cada crédito (dedup en JS, no GROUP BY,
  // que con ONLY_FULL_GROUP_BY no acepta las demás columnas).
  const vistos = new Set();
  const rows = todos.filter(r => !vistos.has(r.id_credito) && vistos.add(r.id_credito));

  console.log(rows.length, 'crédito(s) sin fecha de 1ª cuota con carta Autofin subida.',
    APLICAR ? 'APLICANDO.' : 'SIMULACIÓN (usa --aplicar para escribir).');
  if (rows.length && !almacen.activo()) {
    console.error('Sin acceso al bucket:', almacen.estado().motivo || 'define GCS_BUCKET y credenciales');
    process.exit(1);
  }

  let ok = 0, sinFecha = 0, errores = 0;
  for (const r of rows) {
    let iso = null;
    // 1) Si el extracted ya trae la fecha (documentos subidos desde este commit), se usa.
    try {
      const ext = typeof r.extracted === 'string' ? JSON.parse(r.extracted) : r.extracted;
      if (ext && ext.fechaPrimeraCuota) iso = ext.fechaPrimeraCuota;
    } catch (_) {}
    // 2) Si no, se relee el PDF y se re-guarda el extracted completo de paso.
    if (!iso) {
      try {
        const buf = await almacen.obtener({ ruta: r.doc_ruta, blob: r.data });
        if (!buf) throw new Error('sin archivo (ni blob ni ruta)');
        const txt = (await pdf(buf)).text;
        if (String(txt || '').replace(/\s/g, '').length < 40) throw new Error('carta escaneada (sin texto)');
        const ext = parseCartaAutofin(txt);
        iso = ext.fechaPrimeraCuota || null;
        if (APLICAR && iso) await pool.query('UPDATE cartas_documentos SET extracted = ? WHERE id = ?',
          [JSON.stringify(ext), r.id_doc]);
      } catch (e) { errores++; console.log('  ✗', r.num_op || r.op_carta, '—', e.message); continue; }
    }
    if (!iso) { sinFecha++; console.log('  –', r.num_op || r.op_carta, '— la carta no trae cuadro de pago legible'); continue; }
    console.log('  ✓', r.num_op || r.op_carta, '→', iso);
    if (APLICAR) await pool.query(
      'UPDATE creditos SET fecha_primera_cuota = ?, updated_at = NOW() WHERE id = ? AND fecha_primera_cuota IS NULL',
      [iso, r.id_credito]);
    ok++;
  }
  console.log(`Listo: ${ok} con fecha, ${sinFecha} sin cuadro legible, ${errores} con error.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
