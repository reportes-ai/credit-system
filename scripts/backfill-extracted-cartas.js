/* Barrido UNA VEZ: llena cartas_documentos.extracted en los documentos que
   quedaron con NULL (la columna nunca se pobló: el front no la mandaba y el
   backend recién la calcula solo desde el fix de 2026-08-08).

   Necesita acceso al bucket (los PDF ya no viven en la base):
     GCS_BUCKET=autofacil-docs  y  GCS_CREDENCIALES o ADC de gcloud
     (gcloud auth application-default login).

   Uso:  node scripts/backfill-extracted-cartas.js          → simula (no escribe)
         node scripts/backfill-extracted-cartas.js --aplicar → escribe
*/
/* OJO: NO definir global.window acá — pdf-parse (pdfjs) se cree en un navegador
   y se cuelga esperando un worker ("No PDFJS.workerSrc specified"). */
const pool = require('../shared/config/database');
const almacen = require('../shared/almacen-docs');
const pdf = require('pdf-parse');
const { parseCotizacion, parseCartaCompromiso, parseCartaAutofin } =
  require('../services/cartas/src/controllers/cartas.controller');

const APLICAR = process.argv.includes('--aplicar');

(async () => {
  if (!almacen.activo()) {
    console.error('Sin acceso al bucket:', almacen.estado().motivo || 'define GCS_BUCKET y credenciales');
    process.exit(1);
  }
  const [rows] = await pool.query(
    'SELECT id, tipo, nombre, data, doc_ruta FROM cartas_documentos WHERE extracted IS NULL ORDER BY id');
  console.log(rows.length, 'documento(s) sin extracted.', APLICAR ? 'APLICANDO.' : 'SIMULACIÓN (usa --aplicar para escribir).');
  let ok = 0, escaneados = 0, errores = 0;
  for (const r of rows) {
    let ext;
    try {
      const buf = await almacen.obtener({ ruta: r.doc_ruta, blob: r.data });
      if (!buf) throw new Error('sin archivo (ni blob ni ruta)');
      const txt = (await pdf(buf)).text;
      if (String(txt || '').replace(/\s/g, '').length < 40) { ext = { escaneado: true }; escaneados++; }
      else {
        ext = r.tipo === 'COTIZACION_UNIDAD' ? parseCotizacion(txt)
            : r.tipo === 'COMPROMISO_UNIDAD' ? parseCartaCompromiso(txt)
            : parseCartaAutofin(txt);
        ok++;
      }
    } catch (e) { ext = { error_lectura: e.message }; errores++; console.log('  ✗', r.id, r.nombre, '—', e.message); }
    if (APLICAR) await pool.query('UPDATE cartas_documentos SET extracted = ? WHERE id = ?', [JSON.stringify(ext), r.id]);
  }
  console.log(`Listo: ${ok} leídos, ${escaneados} escaneados (sin texto), ${errores} con error.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
