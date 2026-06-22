'use strict';
/**
 * Evaluación crediticia asistida por IA (Política V3.0).
 * Cruza: antecedentes del cliente + informes DealerNet (repositorio) +
 * documentos cargados (los analiza como imágenes/PDF para detectar
 * inconsistencias) + cotización + las tablas de la Política V3.0 (scorecard,
 * quintiles, condiciones, reglas). Devuelve: validación de documentos +
 * inconsistencias, scoring por bloque, puntaje total, quintil, decisión,
 * cuánto se le puede prestar y un resumen explicativo.
 */
const pool = require('../../../../shared/config/database');
const ia = require('../../../../shared/ia');
const { analizar } = require('../../../../shared/anthropic');
const { auditar } = require('../../../../shared/audit');

const CODIGO = 'evaluacion_consistencia';

(async () => {
  try {
    await ia.registrarFuncionalidad({
      codigo: CODIGO,
      nombre: 'Evaluación de consistencia / scoring',
      descripcion: 'Cruza todos los documentos del cliente y entrega alertas y scoring asistido (Política V3.0)',
      modelo: 'claude-opus-4-8',
    });
    await pool.query(`CREATE TABLE IF NOT EXISTS ia_evaluaciones_credito (
      id            BIGINT AUTO_INCREMENT PRIMARY KEY,
      fecha         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      id_usuario    INT NULL,
      rut           VARCHAR(20) NULL,
      puntaje       INT NULL,
      quintil       VARCHAR(8) NULL,
      decision      VARCHAR(20) NULL,
      monto_maximo  BIGINT NULL,
      resumen       TEXT NULL,
      resultado     JSON NULL,
      modelo        VARCHAR(60) NULL,
      tokens_in     INT NULL,
      tokens_out    INT NULL,
      costo_usd     DECIMAL(12,6) NULL,
      INDEX idx_fecha (fecha), INDEX idx_rut (rut) )`);
  } catch (e) { console.error('[ia eval-credito init]', e.message); }
})();

const normCli = v => v ? String(v).replace(/\./g, '').toUpperCase().trim() : null;     // NNNNNNN-DV (tabla clientes / documentos)
const rutNum  = v => { const c = String(v || '').replace(/[.\s-]/g, '').toUpperCase(); return c.length > 1 ? c.slice(0, -1) : c; }; // solo dígitos (dealernet)
const num = v => { const n = Number(v); return isNaN(n) ? 0 : n; };

// Formatea un cuadro de la Política V3.0 como tabla de texto para el prompt
function tablaTexto(t) {
  const cols = (t.columnas || []).filter(Boolean);
  const head = cols.join(' | ');
  const rows = (t.filas || []).map(f => cols.map((_, i) => (f[i] != null ? f[i] : '')).join(' | ')).join('\n');
  return `### ${t.titulo} [${t.tipo}]\n${head}\n${rows}`;
}

const SYSTEM = `Eres un analista experto de riesgo crediticio automotriz en Chile, que evalúa según la POLÍTICA DE CRÉDITO AUTOFÁCIL V3.0 para autos usados. Tu trabajo:
1) Revisar los DOCUMENTOS adjuntos (liquidaciones, cédula, AFP, etc.) y validarlos contra los datos declarados: detecta inconsistencias (nombres/RUT/montos/fechas que no calzan, documentos vencidos, ilegibles, alterados o faltantes). No es verificación forense.
2) Puntuar al cliente con el SCORECARD V3.0 (1000 pts en 4 bloques A/B/C/D), usando los tramos y puntos de las tablas que se te entregan. Si falta un dato para un tramo, usa el supuesto más conservador y decláralo.
3) Aplicar primero las REGLAS EXCLUYENTES (K1–K11): si alguna se gatilla con la evidencia, es RECHAZO automático.
4) Asignar el QUINTIL según el puntaje, la decisión según la matriz, y calcular CUÁNTO SE LE PUEDE PRESTAR (el menor entre: el monto máximo de las condiciones base por tipo/origen, y la capacidad de pago = cuota máx. 30% de la renta líquida menos cargas actuales, llevada a monto según plazo y tasa de la cotización).
Reglas: sé CONSERVADOR y objetivo; NO inventes datos; si algo no aparece, decláralo como faltante en vez de asumir a favor. Tu análisis ASISTE al analista, no reemplaza su decisión.`;

const promptDe = (ctx) => `Evalúa al cliente con la Política V3.0. Usa SOLO la evidencia entregada y las tablas paramétricas. Responde EXACTAMENTE este JSON:
{
  "knockouts": [ { "codigo": "K1..K11", "gatillado": true|false, "motivo": "por qué" } ],
  "rechazo_por_knockout": true|false,
  "documentos": {
    "revisados": [ { "documento": "nombre", "estado": "ok|alerta|ilegible|vencido|falta", "comentario": "qué se validó o qué falla" } ],
    "inconsistencias": [ "frase concreta de cada inconsistencia detectada entre documentos y datos declarados" ]
  },
  "bloques": [
    { "bloque": "A|B|C|D", "nombre": "string", "puntos_max": number, "puntos": number,
      "variables": [ { "variable": "string", "tramo_asignado": "string", "puntos": number, "comentario": "string" } ] }
  ],
  "puntaje_total": number,         // 0 a 1000 (suma de bloques)
  "quintil": "Q1|Q2|Q3|Q4|Q5",
  "etiqueta": "string",            // de la tabla de quintiles
  "decision": "aprobar|condicionado|analisis|rechazar",
  "capacidad": {
    "renta_liquida": number, "cargas_actuales": number,
    "cuota_maxima": number, "carga_cuota_pct": number, "carga_total_pct": number,
    "monto_maximo_prestar": number, "explicacion_monto": "cómo se obtuvo el monto máximo y qué lo limita"
  },
  "resumen": "4 a 7 frases: panorama, factores que más sumaron/restaron, y la recomendación final",
  "alertas": [ "banderas rojas relevantes para la decisión" ],
  "datos_faltantes": [ "datos que faltaron y conviene capturar para afinar la evaluación" ]
}
Montos en pesos chilenos como enteros sin puntos. El puntaje de cada bloque no puede superar su puntos_max y el total no puede superar 1000.

══════ EVIDENCIA DEL CLIENTE ══════
${ctx.cliente}

══════ INFORMES DEALERNET (repositorio) ══════
${ctx.dealernet || 'Sin informes DealerNet en el repositorio.'}

══════ COTIZACIÓN ══════
${ctx.cotizacion || 'Sin cotización seleccionada.'}

══════ DOCUMENTOS ADJUNTOS ══════
${ctx.docsLista || 'Sin documentos cargados.'} (las imágenes/PDF de estos documentos van adjuntos; revísalos)

══════ TABLAS POLÍTICA V3.0 ══════
${ctx.politica}`;

/* POST /api/ia/evaluacion-credito  { rut, cotizacion_id? } */
exports.evaluar = async (req, res) => {
  try {
    const rutDash = normCli(req.body?.rut);
    const rutD = rutNum(req.body?.rut);
    if (!rutDash) return res.status(400).json({ success: false, data: null, error: 'RUT requerido.' });
    const cotizacionId = req.body?.cotizacion_id || null;

    // 1) Cliente + antecedentes + información comercial
    const [[cli]]  = await pool.query('SELECT rut, nombre_completo, nombres, apellido_paterno, apellido_materno, fecha_nacimiento, comuna, region FROM clientes WHERE rut=? LIMIT 1', [rutDash]).catch(() => [[null]]);
    const [[ant]]  = await pool.query('SELECT tipo_trabajador, empleador, antiguedad_meses, renta_fija_liquida, renta_var_mes1, renta_var_mes2, renta_var_mes3, updated_at FROM antecedentes_laborales WHERE rut_cliente=? LIMIT 1', [rutDash]).catch(() => [[null]]);
    const [[com]]  = await pool.query('SELECT deuda_vigente_total, deuda_morosa, deuda_castigada, monto_protestos, protestos_vigentes_q FROM informacion_comercial WHERE rut_cliente=? LIMIT 1', [rutDash]).catch(() => [[null]]);
    const clienteTxt = JSON.stringify({ cliente: cli || null, antecedentes_laborales: ant || null, informacion_comercial: com || null }, null, 1);

    // 2) Cotización
    let cotizacionTxt = null;
    if (cotizacionId) {
      const [[q]] = await pool.query('SELECT valor_vehiculo, pie, monto_financiado, plazo, tasa_mensual, cuota FROM cotizaciones WHERE id_cotizacion=? LIMIT 1', [cotizacionId]).catch(() => [[null]]);
      if (q) cotizacionTxt = JSON.stringify({ ...q, saldo_precio: num(q.valor_vehiculo) - num(q.pie) }, null, 1);
    }

    // 3) Informes DealerNet (último por producto, contenido truncado)
    const [dnRows] = await pool.query(
      `SELECT codigo_producto, nombre_producto, contenido FROM dealernet_informes
       WHERE rut=? AND retcode='0' ORDER BY created_at DESC`, [rutD]).catch(() => [[]]);
    const seen = new Set(); const dnUlt = [];
    for (const r of (dnRows || [])) { if (seen.has(r.codigo_producto)) continue; seen.add(r.codigo_producto); dnUlt.push(r); }
    const dealernetTxt = dnUlt.map(i => {
      let c = i.contenido; if (typeof c === 'string') { try { c = JSON.parse(c); } catch {} }
      let s = (typeof c === 'string') ? c : JSON.stringify(c);
      if (s.length > 5000) s = s.slice(0, 5000) + '…';
      return `### ${i.nombre_producto || i.codigo_producto}\n${s}`;
    }).join('\n\n');

    // 4) Documentos cargados → adjuntos para visión (pdf/imagen)
    const [docsRows] = await pool.query(
      'SELECT documento, archivo_nombre, mime_type, archivo_data, archivo_size FROM evaluacion_documentos WHERE rut_cliente=? ORDER BY id', [rutDash]).catch(() => [[]]);
    const documentos = []; const docsLista = [];
    for (const d of (docsRows || [])) {
      docsLista.push(`- ${d.documento} (${d.archivo_nombre || 's/n'})`);
      const mt = (d.mime_type || '').toLowerCase();
      if (!d.archivo_data || d.archivo_size > 5 * 1024 * 1024 || documentos.length >= 6) continue;
      if (mt.includes('pdf')) documentos.push({ tipo: 'pdf', data: Buffer.from(d.archivo_data).toString('base64') });
      else if (mt.startsWith('image/')) documentos.push({ tipo: 'image', media_type: mt, data: Buffer.from(d.archivo_data).toString('base64') });
    }

    // 5) Tablas Política V3.0
    const [polRows] = await pool.query(
      `SELECT clave, titulo, tipo, columnas, filas FROM politica_v3_tablas
       WHERE clave IN ('reglas_excluyentes','scorecard_bloques','scorecard_variables','quintiles','matriz_decision','condiciones_base','parametros_generales','reglas_migratorias')
       ORDER BY orden`).catch(() => [[]]);
    const parse = v => { try { return typeof v === 'object' ? v : JSON.parse(v); } catch { return v; } };
    const politicaTxt = (polRows || []).map(t => tablaTexto({ titulo: t.titulo, tipo: t.tipo, columnas: parse(t.columnas), filas: parse(t.filas) })).join('\n\n');

    const ctx = { cliente: clienteTxt, dealernet: dealernetTxt, cotizacion: cotizacionTxt, docsLista: docsLista.join('\n'), politica: politicaTxt };

    // 6) Llamada a la IA
    const r = await analizar({
      codigo: CODIGO, id_usuario: req.usuario?.id_usuario, system: SYSTEM, prompt: promptDe(ctx),
      documentos, json: true, max_tokens: 6000, thinking: true,
    });
    const x = r.datos;
    if (!x) return res.status(422).json({ success: false, data: { texto: r.texto }, error: 'No se pudo generar la evaluación. Intenta de nuevo.' });

    // 7) Persistir
    let id = null;
    try {
      const [ins] = await pool.query(
        `INSERT INTO ia_evaluaciones_credito (id_usuario, rut, puntaje, quintil, decision, monto_maximo, resumen, resultado, modelo, tokens_in, tokens_out, costo_usd)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [req.usuario?.id_usuario || null, rutDash, num(x.puntaje_total), String(x.quintil || '').slice(0, 8),
         String(x.decision || '').slice(0, 20), num(x.capacidad?.monto_maximo_prestar), x.resumen || null,
         JSON.stringify(x), r.modelo, r.tokens_in, r.tokens_out, r.costo]);
      id = ins.insertId;
    } catch (e) { console.error('[ia eval-credito insert]', e.message); }

    auditar({ req, accion: 'EVALUAR', modulo: 'ia', entidad: 'evaluacion_credito', entidad_id: id,
      detalle: `Evaluó crédito con IA RUT ${rutDash} → ${x.puntaje_total} pts ${x.quintil} (${x.decision})`, rut: rutDash });

    res.json({ success: true, data: { id, rut: rutDash, ...x, n_documentos: documentos.length, modelo: r.modelo, tokens_in: r.tokens_in, tokens_out: r.tokens_out, costo: r.costo }, error: null });
  } catch (e) {
    if (e.code === 'NO_KEY') return res.status(503).json({ success: false, data: null, error: 'La IA no está configurada (falta ANTHROPIC_API_KEY).' });
    if (e.code === 'IA_OFF') return res.status(403).json({ success: false, data: null, error: 'La IA de evaluación está desactivada. Actívala en Mantenedores → Inteligencia Artificial (Evaluación de consistencia / scoring).' });
    console.error('[ia eval-credito]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error al evaluar: ' + e.message });
  }
};

/* GET /api/ia/evaluacion-credito/:rut → última evaluación guardada */
exports.ultima = async (req, res) => {
  try {
    const rut = normCli(req.params.rut);
    const [[row]] = await pool.query('SELECT id, fecha, puntaje, quintil, decision, monto_maximo, resultado, modelo FROM ia_evaluaciones_credito WHERE rut=? ORDER BY fecha DESC LIMIT 1', [rut]);
    if (!row) return res.json({ success: true, data: null, error: null });
    let resultado = row.resultado; try { resultado = typeof resultado === 'object' ? resultado : JSON.parse(resultado); } catch {}
    res.json({ success: true, data: { ...row, resultado }, error: null });
  } catch (e) {
    console.error('[ia eval-credito ultima]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};
