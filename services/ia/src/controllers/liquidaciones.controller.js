'use strict';
const ia = require('../../../../shared/ia');
const { analizar } = require('../../../../shared/anthropic');
const { auditar } = require('../../../../shared/audit');

const CODIGO = 'liq_sueldo';

// Auto-registro: marca la funcionalidad como disponible (habilita su switch en el mantenedor).
(async () => {
  try {
    await ia.registrarFuncionalidad({
      codigo: CODIGO,
      nombre: 'Análisis de liquidaciones de sueldo',
      descripcion: 'Extrae líquido/imponible, AFP/Isapre y los cruza con la renta declarada',
      modelo: 'claude-haiku-4-5',
    });
  } catch (e) { console.error('[ia liquidaciones registro]', e.message); }
})();

const SYSTEM = `Eres un analista de crédito chileno experto en liquidaciones de sueldo.
Extrae los datos con precisión. Los montos van en pesos chilenos como números ENTEROS, sin puntos, comas ni símbolos.
Si un dato no aparece en el documento, devuélvelo como null. NUNCA inventes valores.`;

const PROMPT = `Extrae los datos de esta liquidación de sueldo y responde EXACTAMENTE con este JSON:
{
  "trabajador": "string|null",
  "rut_trabajador": "string|null",
  "empleador": "string|null",
  "periodo": "string|null",
  "sueldo_base": "number|null",
  "total_imponible": "number|null",
  "total_haberes": "number|null",
  "afp_nombre": "string|null",
  "afp_monto": "number|null",
  "salud_nombre": "string|null",
  "salud_monto": "number|null",
  "total_descuentos": "number|null",
  "sueldo_liquido": "number|null",
  "observaciones": "string|null"
}
"periodo" en formato "Mes Año" (ej "Mayo 2026"). "observaciones": una nota BREVE relevante para evaluar crédito (ej. sueldo variable, descuentos por préstamos), o null.`;

/* POST /api/ia/liquidacion  (multipart: archivo) */
exports.analizar = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, data: null, error: 'Falta el archivo de la liquidación.' });
    const mt = req.file.mimetype || '';
    const esPdf = mt.includes('pdf');
    const esImg = mt.startsWith('image/');
    if (!esPdf && !esImg) return res.status(400).json({ success: false, data: null, error: 'Formato no soportado. Sube un PDF o una imagen (JPG/PNG).' });

    const doc = esPdf
      ? { tipo: 'pdf', data: req.file.buffer.toString('base64') }
      : { tipo: 'image', media_type: mt, data: req.file.buffer.toString('base64') };

    const r = await analizar({
      codigo: CODIGO, id_usuario: req.usuario?.id_usuario,
      system: SYSTEM, prompt: PROMPT, documentos: [doc], json: true, max_tokens: 1200,
    });

    if (!r.datos) return res.status(422).json({ success: false, data: { texto: r.texto }, error: 'No se pudo interpretar la liquidación. Prueba con una imagen más nítida o un PDF.' });

    auditar({ req, accion: 'ANALIZAR', modulo: 'ia', entidad: 'liquidacion',
      detalle: `Analizó una liquidación de sueldo con IA (${r.modelo})`, meta: { tokens_in: r.tokens_in, tokens_out: r.tokens_out } });

    res.json({ success: true, data: { extraccion: r.datos, modelo: r.modelo, tokens_in: r.tokens_in, tokens_out: r.tokens_out, costo: r.costo }, error: null });
  } catch (e) {
    if (e.code === 'NO_KEY') return res.status(503).json({ success: false, data: null, error: 'La IA no está configurada en el servidor (falta ANTHROPIC_API_KEY).' });
    if (e.code === 'IA_OFF') return res.status(403).json({ success: false, data: null, error: 'La IA para liquidaciones está desactivada. Actívala en Mantenedores → Inteligencia Artificial.' });
    console.error('[ia liquidaciones]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error al analizar: ' + e.message });
  }
};
