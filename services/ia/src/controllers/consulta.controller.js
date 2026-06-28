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
    // La card vive DENTRO de Reportería (no es módulo propio del Home): la funcionalidad
    // ia_consulta cuelga del módulo Reportería; la card se pinta gateada en /reporteria/.
    const [[modRep]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta='/reporteria/' LIMIT 1");
    const idModRep = modRep ? modRep.id_modulo : null;
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='ia_consulta' LIMIT 1");
    let idf = ex && ex.id_funcionalidad;
    if (idf) {
      if (idModRep) await pool.query('UPDATE funcionalidades SET id_modulo=?, href=?, icono=? WHERE id_funcionalidad=?', [idModRep, '/ia/pregunta/', 'bi-chat-dots', idf]);
    } else if (idModRep) {
      const [r] = await pool.query(
        `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
         VALUES (?, 'Pregúntale a AutoFácil', 'ia_consulta', '/ia/pregunta/', 'bi-chat-dots')`, [idModRep]);
      idf = r.insertId;
    }
    if (idf) for (const idp of [1, 2, 90008, 90009]) {   // Admin · Gerente · Gte Op y Crédito · Gte General
      const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=? AND id_funcionalidad=? LIMIT 1', [idp, idf]);
      if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
    }
    // Limpieza: quitar el módulo propio del Home (ya no se usa) una vez re-apuntada la func.
    if (idModRep) { try { await pool.query('DELETE FROM modulos WHERE id_modulo=?', [MOD_BI]); } catch (_) {} }
    // Límite de preguntas por perfil (configurable) + log de uso
    await pool.query(`CREATE TABLE IF NOT EXISTS ia_consulta_uso (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, id_usuario INT NOT NULL,
      ts DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_u (id_usuario, ts))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ia_consulta_limites (
      id_perfil INT PRIMARY KEY, cantidad INT NOT NULL DEFAULT 5, periodo VARCHAR(10) NOT NULL DEFAULT 'semana')`);
    await pool.query("INSERT IGNORE INTO ia_consulta_limites (id_perfil, cantidad, periodo) VALUES (0, 5, 'semana')");  // por defecto
    await pool.query("INSERT IGNORE INTO ia_consulta_limites (id_perfil, cantidad, periodo) VALUES (1, 0, 'semana')");  // Administrador: ilimitado (0)
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

/* ── Cuota de preguntas por perfil (configurable) ── */
const num = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const err = (res, e) => { console.error('[ia consulta]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); };
const PERIODOS = { dia: 'día', semana: 'semana', mes: 'mes' };
const ddmmaaaa = s => { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(s || ''); };
function periodoSQL(periodo) {
  if (periodo === 'dia') return { cond: 'DATE(ts)=CURDATE()', hasta: "DATE_FORMAT(CURDATE(),'%Y-%m-%d')" };
  if (periodo === 'mes') return { cond: "DATE_FORMAT(ts,'%Y-%m')=DATE_FORMAT(CURDATE(),'%Y-%m')", hasta: "DATE_FORMAT(LAST_DAY(CURDATE()),'%Y-%m-%d')" };
  return { cond: 'YEARWEEK(ts,1)=YEARWEEK(CURDATE(),1)', hasta: "DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL (6-WEEKDAY(CURDATE())) DAY),'%Y-%m-%d')" };
}
async function perfilDe(uid) { const [[u]] = await pool.query('SELECT id_perfil FROM usuarios WHERE id_usuario=? LIMIT 1', [uid]); return u ? u.id_perfil : 0; }
async function getLimite(id_perfil) {
  const ip = id_perfil || 0;
  const [[row]] = await pool.query('SELECT cantidad, periodo FROM ia_consulta_limites WHERE id_perfil IN (?,0) ORDER BY (id_perfil=?) DESC, id_perfil DESC LIMIT 1', [ip, ip]);
  return row || { cantidad: 5, periodo: 'semana' };
}
async function cuotaDe(id_usuario, id_perfil) {
  const lim = await getLimite(id_perfil);
  const p = periodoSQL(lim.periodo);
  const [[r]] = await pool.query(`SELECT (SELECT COUNT(*) FROM ia_consulta_uso WHERE id_usuario=? AND ${p.cond}) usados, ${p.hasta} hasta`, [id_usuario]);
  const usados = Number(r.usados) || 0;
  const ilimitado = !lim.cantidad || lim.cantidad <= 0;
  return { cantidad: lim.cantidad, periodo: lim.periodo, usados, restantes: ilimitado ? null : Math.max(0, lim.cantidad - usados), ilimitado, hasta: r.hasta };
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
function forzarLimit(s) {
  if (/\blimit\b/i.test(s)) return s;
  // Con UNION no se puede pegar LIMIT al final (MySQL lo rechaza): se envuelve.
  if (/\bunion\b/i.test(s)) return `SELECT * FROM (\n${s}\n) AS _sub LIMIT 500`;
  return s + ' LIMIT 500';
}

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
async function generarSQL(pregunta, esquema, errPrevio, id_usuario, historial) {
  const system =
    'Eres un analista de datos experto en SQL (MySQL/TiDB) para AutoFácil, una automotora de crédito en Chile. ' +
    'Genera UNA sola consulta SELECT (sin punto y coma) que responda la pregunta, usando SOLO estas tablas y columnas:\n' +
    esquema +
    '\n\nReglas: solo SELECT (jamás modificar datos); usa JOIN/agregaciones según convenga; agrega LIMIT cuando devuelvas listas; ' +
    'montos en pesos; las fechas son tipo DATE/DATETIME. Si la pregunta NO se puede responder con estas tablas (ej. pide una simulación o un escenario "qué pasaría si"), marca no_aplica=true y explica en motivo. ' +
    'Devuelve JSON: {"sql": "...", "intencion": "...", "grafico": {"tipo":"bar|line|pie", "etiqueta":"<columna categórica>", "valor":"<columna numérica>", "titulo":"..."} | null, "no_aplica": false, "motivo": ""}.';
  let prompt = '';
  if (historial && historial.length) {
    prompt += 'Contexto de la conversación (preguntas previas y el SQL usado). La nueva pregunta puede ser una REPREGUNTA que se apoya en estas (ej. "y por dealer", "pero solo los morosos", "ahora del mes pasado"); reescribe la consulta COMPLETA considerando ese contexto:\n' +
      historial.map((h, i) => `${i + 1}) Pregunta: ${h.pregunta}\n   SQL: ${h.sql}`).join('\n') + '\n\n';
  }
  prompt += `Pregunta del usuario: "${pregunta}"`;
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
    const idp = await perfilDe(uid);
    const cuotaPre = await cuotaDe(uid, idp);
    if (!cuotaPre.ilimitado && cuotaPre.restantes <= 0)
      return res.json({ success: false, data: { cuota: cuotaPre }, error: `Alcanzaste tu límite de ${cuotaPre.cantidad} pregunta(s) por ${PERIODOS[cuotaPre.periodo] || cuotaPre.periodo}. Se renueva el ${ddmmaaaa(cuotaPre.hasta)}.` });
    if (!cuotaPre.ilimitado) { try { await pool.query('INSERT INTO ia_consulta_uso (id_usuario) VALUES (?)', [uid]); } catch (_) {} }
    const esquema = await getEsquema();
    const historial = (Array.isArray(req.body.historial) ? req.body.historial : [])
      .filter(h => h && h.pregunta && h.sql)
      .slice(-3)
      .map(h => ({ pregunta: String(h.pregunta).slice(0, 300), sql: String(h.sql).slice(0, 1500) }));

    let gen = await generarSQL(pregunta, esquema, null, uid, historial);
    if (!gen || (!gen.sql && !gen.no_aplica)) return res.json({ success: true, data: { pregunta, respuesta: 'No pude interpretar la pregunta. ¿Puedes reformularla?', sql: null, columns: [], rows: [], grafico: null, cuota: await cuotaDe(uid, idp) }, error: null });
    if (gen.no_aplica) return res.json({ success: true, data: { pregunta, respuesta: gen.motivo || 'No puedo responder eso con los datos disponibles.', sql: null, columns: [], rows: [], grafico: null, cuota: await cuotaDe(uid, idp) }, error: null });

    let resultado;
    try { resultado = await ejecutarSeguro(gen.sql); }
    catch (e1) {
      // Un reintento: le devolvemos el error a la IA para que corrija
      gen = await generarSQL(pregunta, esquema, e1.message || String(e1), uid, historial);
      if (!gen || !gen.sql) throw e1;
      resultado = await ejecutarSeguro(gen.sql);
    }

    const muestra = resultado.rows.slice(0, 50);
    const { texto } = await analizar({
      codigo: CODIGO_IA, id_usuario: uid, max_tokens: 600,
      system: 'Eres un analista que explica resultados a un gerente de AutoFácil, en español, breve y claro (1 a 3 frases). Los datos provienen de la BASE DE DATOS INTERNA de AutoFácil (sus propias operaciones de crédito), NO del mercado: redacta en ese marco (ej. "según los datos de AutoFácil…"). Usa SOLO los datos entregados; no inventes. Formatea montos en pesos chilenos.',
      prompt: `Pregunta: ${pregunta}\nColumnas: ${resultado.columns.join(', ')}\nResultado (JSON, máx 50 filas): ${JSON.stringify(muestra)}`,
    });

    auditar({ req, accion: 'CONSULTA', modulo: 'ia', entidad: 'bi_consulta', detalle: `Pregunta: ${pregunta}`, meta: { sql: resultado.sql, filas: resultado.rows.length } });
    res.json({ success: true, data: { pregunta, respuesta: texto, sql: resultado.sql, columns: resultado.columns, rows: resultado.rows, grafico: gen.grafico || null, cuota: await cuotaDe(uid, idp) }, error: null });
  } catch (e) {
    if (e.code === 'IA_OFF') return res.status(400).json({ success: false, data: null, error: 'La IA para esta función está desactivada. Actívala en Mantenedores → Inteligencia Artificial.' });
    if (e.code === 'NO_KEY') return res.status(400).json({ success: false, data: null, error: 'Falta configurar la IA en el servidor.' });
    console.error('[ia consulta]', e.message);
    // 422 (no 500) para que el gateway no enmascare el detalle: ayuda a diagnosticar.
    return res.status(422).json({ success: false, data: null, error: 'No pude responder: ' + String(e.message || 'error').slice(0, 200) });
  }
};

// GET /api/ia/consulta/cuota → cuota del usuario logueado
const cuota = async (req, res) => {
  try { const idp = await perfilDe(req.usuario.id_usuario); res.json({ success: true, data: await cuotaDe(req.usuario.id_usuario, idp), error: null }); }
  catch (e) { err(res, e); }
};

// GET /api/ia/consulta/limites → límites por perfil (para el config admin)
const getLimites = async (req, res) => {
  try {
    const [perfiles] = await pool.query(
      `SELECT p.id_perfil, p.nombre, l.cantidad, l.periodo
       FROM perfiles p LEFT JOIN ia_consulta_limites l ON l.id_perfil = p.id_perfil
       WHERE p.estado='activo' ORDER BY p.nombre`);
    const [[def]] = await pool.query('SELECT cantidad, periodo FROM ia_consulta_limites WHERE id_perfil=0');
    res.json({ success: true, data: { porDefecto: def || { cantidad: 5, periodo: 'semana' }, perfiles }, error: null });
  } catch (e) { err(res, e); }
};

// PUT /api/ia/consulta/limites { limites:[{id_perfil, cantidad, periodo}] } (id_perfil 0 = por defecto)
const setLimites = async (req, res) => {
  try {
    const items = Array.isArray(req.body.limites) ? req.body.limites : [];
    const OKP = new Set(['dia', 'semana', 'mes']);
    let n = 0;
    for (const it of items) {
      const idp = num(it.id_perfil); if (idp == null) continue;
      const cant = Math.max(0, parseInt(it.cantidad, 10) || 0);
      const per = OKP.has(it.periodo) ? it.periodo : 'semana';
      await pool.query('INSERT INTO ia_consulta_limites (id_perfil, cantidad, periodo) VALUES (?,?,?) ON DUPLICATE KEY UPDATE cantidad=VALUES(cantidad), periodo=VALUES(periodo)', [idp, cant, per]);
      n++;
    }
    auditar({ req, accion: 'EDITAR', modulo: 'ia', entidad: 'bi_consulta_limites', detalle: `Actualizó límites de preguntas por perfil (${n})` });
    res.json({ success: true, data: { ok: true, n }, error: null });
  } catch (e) { err(res, e); }
};

module.exports = { preguntar, cuota, getLimites, setLimites };
