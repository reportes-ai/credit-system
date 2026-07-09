/**
 * shared/anthropic.js
 * Motor compartido de IA (Anthropic). TODA llamada a Claude pasa por aquí:
 *  - respeta el switch maestro + la funcionalidad (ia.iaActiva),
 *  - usa el modelo configurado por funcionalidad (ia.modeloDe),
 *  - registra el consumo (tokens + USD) en "Uso IA" (ia.registrarUso).
 * Requiere la env var ANTHROPIC_API_KEY (se setea en Render; NUNCA en el código).
 *
 * Uso:
 *   const { analizar } = require('../../../../shared/anthropic');
 *   const { texto, datos } = await analizar({
 *     codigo: 'liq_sueldo', id_usuario: req.usuario.id_usuario,
 *     system: 'Eres un analista de crédito...',
 *     prompt: 'Extrae sueldo líquido e imponible',
 *     documentos: [{ tipo:'pdf', data: base64 }],
 *     json: true,
 *   });
 */
let Anthropic;                 // se carga perezosamente (solo al primer uso real)
const ia = require('./ia');

let _client = null;
function client() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { const e = new Error('IA no configurada: falta ANTHROPIC_API_KEY en el servidor.'); e.code = 'NO_KEY'; throw e; }
  if (!Anthropic) Anthropic = require('@anthropic-ai/sdk');
  _client = new Anthropic({ apiKey });
  return _client;
}

/** ¿El motor puede operar? (la key está presente en el servidor) */
function disponible() { return !!process.env.ANTHROPIC_API_KEY; }

/**
 * Ejecuta un análisis con IA.
 * @param {object} o
 *  - codigo       funcionalidad: gatea (iaActiva), elige modelo (modeloDe) y registra uso. Recomendado.
 *  - system       system prompt (rol / instrucciones)
 *  - prompt       texto del usuario
 *  - documentos   [{ tipo:'pdf'|'image', media_type?, data(base64) }]
 *  - max_tokens   (def 2048)
 *  - thinking     (def false) razonamiento adaptativo — sube costo; útil en análisis complejos
 *  - json         (def false) pide y parsea salida JSON → o.datos
 *  - id_usuario   para el registro de consumo
 *  - modelo       override del modelo (def: el configurado para la funcionalidad)
 * @returns {Promise<{texto, datos, modelo, tokens_in, tokens_out, costo}>}
 */
async function analizar({ codigo, system, prompt, documentos = [], max_tokens = 2048, thinking = false, json = false, id_usuario = null, modelo } = {}) {
  if (codigo && !(await ia.iaActiva(codigo))) {
    const e = new Error('La IA para esta funcionalidad está desactivada.'); e.code = 'IA_OFF'; throw e;
  }
  const model = modelo || (codigo ? await ia.modeloDe(codigo) : 'claude-haiku-4-5');

  const content = [];
  for (const d of (documentos || [])) {
    if (!d || !d.data) continue;
    if (d.tipo === 'pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: d.data } });
    else                  content.push({ type: 'image',    source: { type: 'base64', media_type: d.media_type || 'image/jpeg', data: d.data } });
  }
  let txt = prompt || '';
  if (json) txt += '\n\nResponde SOLO con JSON válido, sin explicación ni ```.';
  if (txt) content.push({ type: 'text', text: txt });

  const req = { model, max_tokens, messages: [{ role: 'user', content }] };
  if (system) req.system = system;
  if (thinking) req.thinking = { type: 'adaptive' };

  const resp = await client().messages.create(req);

  const tokens_in  = resp.usage?.input_tokens  || 0;
  const tokens_out = resp.usage?.output_tokens || 0;
  let costo = 0;
  try { costo = await ia.registrarUso({ codigo, modelo: model, tokens_in, tokens_out, id_usuario }); } catch (_) {}

  const texto = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  let datos = null;
  if (json) { try { datos = JSON.parse(texto.replace(/```json/gi, '').replace(/```/g, '').trim()); } catch (_) {} }

  return { texto, datos, modelo: model, tokens_in, tokens_out, costo };
}

/**
 * Ejecuta un análisis con IA usando HERRAMIENTAS (tool use / function calling).
 * Claude decide qué herramientas llamar; `ejecutarTool(nombre, input)` las resuelve
 * en el servidor y el loop continúa hasta la respuesta final (o max_iter).
 * Mismo gating/registro de consumo que analizar().
 * @param {object} o  { codigo, system, prompt, tools, ejecutarTool, max_tokens, id_usuario, modelo, max_iter }
 * @returns {Promise<{texto, iteraciones, tokens_in, tokens_out, costo}>}
 */
async function analizarTools({ codigo, system, prompt, tools = [], ejecutarTool, max_tokens = 2048, id_usuario = null, modelo, max_iter = 6 } = {}) {
  if (codigo && !(await ia.iaActiva(codigo))) {
    const e = new Error('La IA para esta funcionalidad está desactivada.'); e.code = 'IA_OFF'; throw e;
  }
  const model = modelo || (codigo ? await ia.modeloDe(codigo) : 'claude-haiku-4-5');
  const messages = [{ role: 'user', content: prompt }];
  let tokens_in = 0, tokens_out = 0, costo = 0, texto = '', it = 0;

  for (; it < max_iter; it++) {
    const req = { model, max_tokens, messages, tools };
    if (system) req.system = system;
    const resp = await client().messages.create(req);
    tokens_in  += resp.usage?.input_tokens  || 0;
    tokens_out += resp.usage?.output_tokens || 0;
    try { costo += await ia.registrarUso({ codigo, modelo: model, tokens_in: resp.usage?.input_tokens || 0, tokens_out: resp.usage?.output_tokens || 0, id_usuario }); } catch (_) {}

    const toolUses = (resp.content || []).filter(b => b.type === 'tool_use');
    texto = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (resp.stop_reason !== 'tool_use' || !toolUses.length) break;   // respuesta final

    messages.push({ role: 'assistant', content: resp.content });
    const results = [];
    for (const tu of toolUses) {
      let out, isErr = false;
      try { out = await ejecutarTool(tu.name, tu.input || {}); }
      catch (e) { out = 'Error: ' + String(e.message || e).slice(0, 300); isErr = true; }
      results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: isErr,
        content: typeof out === 'string' ? out : JSON.stringify(out).slice(0, 60000) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { texto, iteraciones: it + 1, modelo: model, tokens_in, tokens_out, costo };
}

module.exports = { analizar, analizarTools, client, disponible };
