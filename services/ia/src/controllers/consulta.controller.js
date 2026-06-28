'use strict';
/**
 * "Pregúntale a AutoFácil" — BI conversacional (texto → SQL → respuesta).
 * Claude genera UNA consulta SELECT sobre un esquema acotado (allowlist de tablas);
 * se ejecuta en modo SOLO LECTURA blindado (transacción READ ONLY + timeout + sin
 * palabras peligrosas) y Claude redacta la respuesta en lenguaje natural.
 */
const pool = require('../../../../shared/config/database');
const ia = require('../../../../shared/ia');
const { analizar } = require('../../../../shared/anthropic');
const { auditar } = require('../../../../shared/audit');

const CODIGO_IA = 'bi_consulta';           // feature IA (on/off + modelo + costo)
const MOD_BI    = 510001;                  // módulo Home "Pregúntale a AutoFácil"

// Tablas de negocio expuestas a la IA (allowlist). Solo lectura; columnas sensibles se filtran.
const TABLAS_BI = [
  'creditos', 'clientes', 'antecedentes_laborales', 'informacion_comercial', 'dealers',
  'cartas_aprobacion', 'cuotas_credito', 'pagos_credito', 'comisiones_variables',
  'uf', 'utm', 'dolar', 'ipc', 'tasas', 'parques_comisiones', 'estados_credito',
  'usuarios', 'perfiles', 'cotizaciones', 'postventa_seguimiento', 'cobranza_gestiones',
  'compras_pedidos', 'compras_articulos', 'visitas_dealers',
];
const ALLOW = new Set(TABLAS_BI);

(async () => {
  try {
    await ia.registrarFuncionalidad({
      codigo: CODIGO_IA,
      nombre: 'Pregúntale a AutoFácil (BI conversacional)',
      descripcion: 'Responde preguntas en lenguaje natural sobre los datos del sistema (texto → SQL de solo lectura)',
      modelo: 'claude-sonnet-4-6',
    });
    // Módulo Home + funcionalidad/permiso de acceso (idempotente)
    await pool.query(
      `INSERT IGNORE INTO modulos (id_modulo, nombre, descripcion, icono, ruta, orden, estado)
       VALUES (?, 'Pregúntale a AutoFácil', 'Pregunta en lenguaje natural sobre tus datos y obtén la respuesta al instante', 'bi-chat-dots', '/ia/pregunta/', 6, 'activo')`,
      [MOD_BI]);
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='ia_consulta' LIMIT 1");
    let idf = ex && ex.id_funcionalidad;
    if (!idf) {
      const [r] = await pool.query(
        `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
         VALUES (?, 'Pregúntale a AutoFácil', 'ia_consulta', '/ia/pregunta/', 'bi-chat-dots')`, [MOD_BI]);
      idf = r.insertId;
    }
    for (const idp of [1, 2, 90008, 90009]) {   // Admin · Gerente · Gte Op y Crédito · Gte General
      const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=? AND id_funcionalidad=? LIMIT 1', [idp, idf]);
      if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
    }
    console.log('[ia consulta] registrado');
  } catch (e) { console.error('[ia consulta init]', e.message); }
})();

/* ── Esquema acotado para el prompt (desde information_schema, cacheado 10 min) ── */
let _esq = null, _esqAt = 0;
async function getEsquema() {
  if (_esq && (Date.now() - _esqAt) < 600000) return _esq;
  const [rows] = await pool.query(
    `SELECT TABLE_NAME t, COLUMN_NAME c, DATA_TYPE d FROM information_schema.columns
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [TABLAS_BI]);
  const byT = {};
  for (const r of rows) {
    if (/password|hash|token|secret|clave/i.test(r.c)) continue;   // nunca exponer columnas sensibles
    (byT[r.t] = byT[r.t] || []).push(`${r.c}:${r.d}`);
  }
  _esq = Object.entries(byT).map(([t, cs]) => `${t}(${cs.join(', ')})`).join('\n');
  _esqAt = Date.now();
  return _esq;
}

/* ── Blindaje SQL (solo lectura) ── */
const PROHIB = /\b(insert|update|delete|drop|alter|truncate|create|replace|grant|revoke|rename|merge|call|load|outfile|dumpfile|set|lock|unlock|handler|do|prepare|execute|sleep|benchmark|information_schema|performance_schema|mysql)\b/i;

function limpiarSQL(s) {
  return String(s || '').replace(/```sql/gi, '').replace(/```/g, '').replace(/;+\s*$/, '').trim();
}
function validarSQL(s) {
  const low = s.toLowerCase();
  if (!/^select\b/.test(low)) throw new Error('Solo se permiten consultas SELECT.');
  if (s.includes(';')) throw new Error('Solo se permite una consulta.');
  if (PROHIB.test(low)) throw new Error('La consulta contiene operaciones no permitidas.');
  if (/password|hash|token|secret|clave/i.test(low)) throw new Error('No se pueden consultar columnas sensibles.');
  const tablas = [...s.matchAll(/\b(?:from|join)\s+`?([a-z_][a-z0-9_]*)`?/gi)].map(m => m[1].toLowerCase());
  for (const t of tablas) if (!ALLOW.has(t)) throw new Error('Tabla no permitida: ' + t);
}
function forzarLimit(s) { return /\blimit\b/i.test(s) ? s : (s + ' LIMIT 500'); }

async function ejecutarSeguro(sqlRaw) {
  const sql = forzarLimit(limpiarSQL(sqlRaw));
  validarSQL(sql);   // guard real: solo SELECT, allowlist, sin palabras peligrosas
  const conn = await pool.getConnection();
  let tx = false;
  try {
    try { await conn.query('SET @@session.max_execution_time = 8000'); } catch (_) {}
    // READ ONLY es defensa extra; si la BD no lo soporta, igual corre (el SELECT-only ya protege)
    try { await conn.query('START TRANSACTION READ ONLY'); tx = true; } catch (_) { tx = false; }
    const [rows, fields] = await conn.query(sql);
    if (tx) { try { await conn.query('COMMIT'); } catch (_) {} }
    return { sql, rows: Array.isArray(rows) ? rows.slice(0, 500) : [], columns: (fields || []).map(f => f.name) };
  } catch (e) {
    if (tx) { try { await conn.query('ROLLBACK'); } catch (_) {} }
    throw e;
  } finally { conn.release(); }
}

/* ── IA: generar SQL desde la pregunta ── */
async function generarSQL(pregunta, esquema, errPrevio, id_usuario) {
  const system =
    'Eres un analista de datos experto en SQL (MySQL/TiDB) para AutoFácil, una automotora de crédito en Chile. ' +
    'Genera UNA sola consulta SELECT (sin punto y coma) que responda la pregunta, usando SOLO estas tablas y columnas:\n' +
    esquema +
    '\n\nReglas: solo SELECT (jamás modificar datos); usa JOIN/agregaciones según convenga; agrega LIMIT cuando devuelvas listas; ' +
    'montos en pesos; las fechas son tipo DATE/DATETIME. Si la pregunta NO se puede responder con estas tablas, marca no_aplica=true y explica en motivo. ' +
    'Devuelve JSON: {"sql": "...", "intencion": "...", "grafico": {"tipo":"bar|line|pie", "etiqueta":"<columna categórica>", "valor":"<columna numérica>", "titulo":"..."} | null, "no_aplica": false, "motivo": ""}.';
  let prompt = `Pregunta del usuario: "${pregunta}"`;
  if (errPrevio) prompt += `\n\nTu consulta SQL anterior falló con este error: ${errPrevio}\nCorrígela.`;
  const { datos } = await analizar({ codigo: CODIGO_IA, system, prompt, json: true, id_usuario, max_tokens: 1000 });
  return datos;
}

// POST /api/ia/consulta { pregunta }
const preguntar = async (req, res) => {
  try {
    const pregunta = String(req.body.pregunta || '').trim().slice(0, 500);
    if (!pregunta) return res.status(400).json({ success: false, data: null, error: 'Escribe una pregunta' });
    const uid = req.usuario.id_usuario;
    const esquema = await getEsquema();

    let gen = await generarSQL(pregunta, esquema, null, uid);
    if (!gen || (!gen.sql && !gen.no_aplica)) return res.json({ success: true, data: { pregunta, respuesta: 'No pude interpretar la pregunta. ¿Puedes reformularla?', sql: null, columns: [], rows: [], grafico: null }, error: null });
    if (gen.no_aplica) return res.json({ success: true, data: { pregunta, respuesta: gen.motivo || 'No puedo responder eso con los datos disponibles.', sql: null, columns: [], rows: [], grafico: null }, error: null });

    let resultado;
    try { resultado = await ejecutarSeguro(gen.sql); }
    catch (e1) {
      // Un reintento: le devolvemos el error a la IA para que corrija
      gen = await generarSQL(pregunta, esquema, e1.message || String(e1), uid);
      if (!gen || !gen.sql) throw e1;
      resultado = await ejecutarSeguro(gen.sql);
    }

    const muestra = resultado.rows.slice(0, 50);
    const { texto } = await analizar({
      codigo: CODIGO_IA, id_usuario: uid, max_tokens: 600,
      system: 'Eres un analista que explica resultados a un gerente, en español, breve y claro (1 a 3 frases). Usa SOLO los datos entregados; no inventes. Formatea montos en pesos chilenos.',
      prompt: `Pregunta: ${pregunta}\nColumnas: ${resultado.columns.join(', ')}\nResultado (JSON, máx 50 filas): ${JSON.stringify(muestra)}`,
    });

    auditar({ req, accion: 'CONSULTA', modulo: 'ia', entidad: 'bi_consulta', detalle: `Pregunta: ${pregunta}`, meta: { sql: resultado.sql, filas: resultado.rows.length } });
    res.json({ success: true, data: { pregunta, respuesta: texto, sql: resultado.sql, columns: resultado.columns, rows: resultado.rows, grafico: gen.grafico || null }, error: null });
  } catch (e) {
    if (e.code === 'IA_OFF') return res.status(400).json({ success: false, data: null, error: 'La IA para esta función está desactivada. Actívala en Mantenedores → Inteligencia Artificial.' });
    if (e.code === 'NO_KEY') return res.status(400).json({ success: false, data: null, error: 'Falta configurar la IA en el servidor.' });
    console.error('[ia consulta]', e.message);
    // 422 (no 500) para que el gateway no enmascare el detalle: ayuda a diagnosticar.
    return res.status(422).json({ success: false, data: null, error: 'No pude responder: ' + String(e.message || 'error').slice(0, 200) });
  }
};

module.exports = { preguntar };
