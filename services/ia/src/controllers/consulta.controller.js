'use strict';
/**
 * "Pregúntale a AutoFácil" — BI conversacional (texto → SQL → respuesta).
 * Claude genera UNA consulta SELECT sobre un esquema acotado (allowlist de tablas);
 * se ejecuta en modo SOLO LECTURA blindado (transacción READ ONLY + timeout + sin
 * palabras peligrosas) y Claude redacta la respuesta en lenguaje natural.
 */
const pool = require('../../../../shared/config/database');
const ia = require('../../../../shared/ia');
const { analizarTools } = require('../../../../shared/anthropic');
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

// Glosario de negocio: mapea conceptos del usuario a columnas/consultas reales y
// evita que la IA responda "no existe" ante métricas que se CALCULAN (no son columnas).
const GLOSARIO = [
  'GLOSARIO DE NEGOCIO (usa esto para mapear lo que pide el usuario a columnas reales):',
  '- "Otorgado / colocado / cursado" = creditos con estado=\'OTORGADO\'. El MES CONTABLE es la columna creditos.mes (NUNCA fecha_otorgado). Ej. otorgados de este mes: WHERE estado=\'OTORGADO\' AND DATE_FORMAT(mes,\'%Y-%m\')=DATE_FORMAT(CURDATE(),\'%Y-%m\').',
  '- ESTADOS DEL PIPELINE: la columna con el estado REAL es creditos.estado_credito (DIGITADO, APROBADO, RECHAZADO, DESISTIDO, OTORGADO, ANULADO, PENDIENTE) — la columna estado está NULL en casi todo lo no otorgado; úsala SOLO para estado=\'OTORGADO\'. Para aprobados/rechazados/desistidos/digitados usa SIEMPRE UPPER(estado_credito)=\'...\' (hay valores en mixto como \'Digitado\'). Clave del negocio = creditos.num_op.',
  '- "Financiera / canal / institución" = creditos.financiera. Valores REALES: \'AUTOFIN\', \'UNIDAD DE CREDITO\' (así, NO \'UNIDAD\'), \'AUTOFACIL\', \'AFA\' (cartera comprada a AFA), \'NO APLICA\'. Si piden "Unidad" filtra financiera=\'UNIDAD DE CREDITO\'.',
  '- "Saldo precio" = creditos.saldo_precio. "Monto financiado" = creditos.monto_financiado. "Plazo (cuotas)" = creditos.plazo. "Tasa" = creditos.tasa.',
  '- "Comisión dealer" = creditos.com_dealer. "Comisión parque" = creditos.com_parque. "Arriendo parque" = creditos.arriendo_parque. "Ingreso por colocación / UAC" = creditos.monto_comision_fin.',
  '- "Dealer / patio" = creditos.rut_dealer → dealers por rut. El NOMBRE del dealer es dealers.nombre_razon (o nombre_indexa) — NO existe dealers.nombre. El parque es dealers.ccs_parque (PARQUE OESTE, CALLE = dealers de calle, PARQUE LONQUEN, AUTOMALL…). "Ejecutivo" = creditos.ejecutivo. "Cliente" = clientes por rut.',
  '- "Carta de aprobación VIGENTE" = cartas_aprobacion sin desenlace: fecha_otorgado, fecha_desistimiento, fecha_anulacion, fecha_eliminacion y fecha_rechazo todas NULL (no hay columna estado en esa tabla).',
  '- "Cuotas / calendario de pago" = cuotas_credito (numero_cuota, fecha_vencimiento, valor_cuota, saldo_insoluto, estado_cuota, fecha_pago) — es la cartera propia.',
  '- "Cobranza / gestiones" = cobranza_gestiones (canal, resultado, monto_promesa, confirmado, created_at). "Promesa de pago" = resultado=\'PROMESA_PAGO\'. "Recuperación / recaudación" = promesas y gestiones confirmadas de cobranza_gestiones.',
  '',
  'MÉTRICAS QUE SE CALCULAN EN EL MÓDULO COBRANZA (NO son columnas de estas tablas; NO inventes SQL para ellas):',
  '- "Mora / cartera en mora / monto en mora", "saldo insoluto / capital adeudado", "provisión / castigo" → usa la herramienta mora_provision (stock vivo por tramo con % paramétricos).',
  '- "Listado de morosos / peores deudores" → herramienta cartera_mora. "Recuperación / recaudación / promesas" → herramienta recuperacion_cartera. "Rendimiento / productividad de ejecutivos de cobranza" → herramienta rendimiento_ejecutivos.',
  'Nunca afirmes que estos datos no existen: existen vía herramientas.',
  '',
  'BÚSQUEDA POR NOMBRES DE PERSONAS (ejecutivos, clientes, dealers): NUNCA compares con = exacto. La BD es CASE-SENSITIVE (utf8mb4_bin) y los nombres están en MAYÚSCULAS SIN TILDES: usa siempre UPPER(columna) LIKE \'%PALABRA%\' por cada palabra, con el patrón en mayúsculas y sin tildes (ej. UPPER(ejecutivo) LIKE \'%ALVARO%\' AND UPPER(ejecutivo) LIKE \'%VARGAS%\'). Si no hay match, intenta con solo el apellido antes de concluir que no existe.',
  '- "Comisión / cuánto gana un EJECUTIVO" = las comisiones de venta se calculan en el módulo Comisiones; en creditos están los insumos por operación (com_dealer, com_parque, monto_comision_fin son comisiones del DEALER/parque/financiera, NO el sueldo del ejecutivo). Si preguntan la comisión ganada por un ejecutivo, entrega sus operaciones del período (conteo y montos) y aclara que la liquidación exacta está en Comisiones → Revisión (/comisiones/revision/).',
  '',
  'ÁMBITO PROHIBIDO (aunque insistan, NUNCA lo respondas aquí):',
  '- FINANZAS DE LA EMPRESA (resultados, gastos, ingresos contables, presupuesto, balance, EBITDA, caja/bancos, proveedores, remuneraciones de la empresa, deuda con la matriz): NO es tu ámbito y esas tablas no están disponibles. Responde amablemente que eso se pregunta en "Pregúntale a Finanzas" (Contabilidad → Pregúntale a Finanzas) y NO intentes aproximarlo con las tablas de créditos.',
  '- INFORMACIÓN PERSONAL DE EMPLEADOS/COLABORADORES (sueldo, liquidaciones, RUT, teléfono, correo, edad, dirección, salud, AFP, licencias, evaluaciones): NUNCA la entregues, ni siquiera a un gerente. Solo puedes hablar de su PRODUCCIÓN COMERCIAL (operaciones, montos, ranking). Si la piden, dilo: los datos de personas se gestionan en RRHH con sus propios permisos.',
  '',
  'CURSO ACELERADO (entrenado con 12.000 preguntas de 4 perfiles — hechos verificados contra la BD):',
  '- ADAPTA EL TONO: pregunta simple o "con peras y manzanas" → explica sin jerga, con analogía y un ejemplo con números reales. Pregunta de gestión → 2-3 cifras clave + tendencia + comparación y, si piden, recomendación. Pregunta técnica → precisión de columnas.',
  '- LA BASE: ~14.000 operaciones históricas desde dic-2016 (incluye la cartera migrada de INDEXA) y ~16.000 clientes. El ritmo actual de colocación es ~55-95 otorgadas/mes. El mes EN CURSO está incompleto: adviértelo.',
  '- El mes contable de la operación es creditos.mes; los estados del pipeline en estado_credito (con UPPER). Tasa de aprobación = aprobados+otorgados / digitados del período; conversión = otorgados / aprobados. Explica el denominador que uses.',
  '- cobranza_gestiones y pagos_credito están VACÍAS hoy (módulos nuevos): si preguntan por gestiones o recuperación, dilo honestamente en vez de mostrar 0 como si fuera un dato. La mora REAL vive en cuotas_credito vía las herramientas mora_provision/cartera_mora.',
  '- "Ticket promedio" = AVG(monto_financiado) de OTORGADOS. "Colocación" = COUNT + SUM(monto_financiado). Participación = entidad / total del período. Trimestres: Q1=ene-mar, Q2=abr-jun, Q3=jul-sep, Q4=oct-dic.',
  '- Al proyectar el cierre de mes: otorgadas al día ÷ días corridos × días del mes, declarado como proyección simple.',
  '- Penetración de seguros = operaciones con seguro / operaciones elegibles del período (columnas seguro_* en creditos); el cálculo oficial está en el módulo Penetración.',
  '- No haces simulaciones hipotéticas ("qué pasaría si...") ni evalúas/apruebas créditos ni das consejos de inversión: dilo y ofrece el dato real más cercano.',
  '- Cifras en formato es-CL (punto miles), montos grandes en millones con un decimal. Nunca inventes: si un dato no existe, dilo y sugiere dónde podría estar.',
].join('\n');

require('../../../../shared/migrate').enFila('consulta', async () => {
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
      const [[exP]] = await pool.query('SELECT 1 ok FROM perfiles WHERE id_perfil=? LIMIT 1', [idp]);
      if (!exP) continue;                                // perfil eliminado (ej. id 2 Gerente) → saltar, no romper FK
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
});

/* ── Lecciones aprendidas: educación PARAMÉTRICA de la IA (mismo patrón que
   Pregúntale a Finanzas): un 👎 con corrección queda como REGLA permanente que
   se inyecta en el prompt de todas las preguntas siguientes — sin programador. */
require('../../../../shared/migrate').enFila('consulta-lecciones', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ia_consulta_lecciones (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        regla      TEXT NOT NULL,
        pregunta   VARCHAR(500) NULL,
        creada_por VARCHAR(160) NULL,
        activa     TINYINT NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
  } catch (e) { console.error('[consulta-lecciones migration]', e.message); }
});

async function leccionesActivas() {
  try {
    const [rows] = await pool.query('SELECT regla FROM ia_consulta_lecciones WHERE activa=1 ORDER BY id DESC LIMIT 80');
    return rows.map(r => '- ' + String(r.regla).replace(/\s+/g, ' ').trim());
  } catch (_) { return []; }
}

const getLecciones = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, regla, pregunta, creada_por, activa, created_at FROM ia_consulta_lecciones ORDER BY id DESC LIMIT 200');
    res.json({ success: true, data: rows, error: null });
  } catch (e) { err(res, e); }
};

const crearLeccion = async (req, res) => {
  try {
    const regla = String(req.body.regla || '').trim().slice(0, 2000);
    if (regla.length < 10) return res.status(400).json({ success: false, data: null, error: 'Describe la corrección (mínimo 10 caracteres)' });
    const pregunta = String(req.body.pregunta || '').trim().slice(0, 500) || null;
    const quien = (req.usuario || req.user || {}).nombre || (req.usuario || req.user || {}).correo || null;
    const [r] = await pool.query('INSERT INTO ia_consulta_lecciones (regla, pregunta, creada_por) VALUES (?,?,?)', [regla, pregunta, quien]);
    auditar({ req, accion: 'CREAR', modulo: 'ia', entidad: 'consulta_leccion', entidad_id: String(r.insertId), detalle: `Lección BI: ${regla.slice(0, 120)}` });
    res.json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) { err(res, e); }
};

const toggleLeccion = async (req, res) => {
  try {
    await pool.query('UPDATE ia_consulta_lecciones SET activa=? WHERE id=?', [req.body.activa ? 1 : 0, Number(req.params.id)]);
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { err(res, e); }
};

/* ── Esquema acotado para el prompt (desde information_schema, cacheado 10 min) ── */
let _esq = null, _esqAt = 0;
async function getEsquema() {
  if (_esq && (Date.now() - _esqAt) < 600000) return _esq;
  const [rows] = await pool.query(
    `SELECT TABLE_NAME t, COLUMN_NAME c, DATA_TYPE d FROM information_schema.columns
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [TABLAS_BI]);
  const byT = {};
  // De usuarios (empleados) solo se exponen columnas NO personales: nada de rut,
  // email, teléfono, etc. — la información personal de colaboradores está fuera del BI.
  const USUARIOS_OK = new Set(['id_usuario', 'nombre', 'apellido', 'id_perfil', 'estado', 'id_supervisor', 'centro_costo']);
  for (const r of rows) {
    if (/password|hash|token|secret|clave/i.test(r.c)) continue;   // nunca exponer columnas sensibles
    if (r.t === 'usuarios' && !USUARIOS_OK.has(r.c)) continue;
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
  // Datos personales de empleados fuera del BI: si el SQL toca usuarios, solo columnas permitidas
  if (/\busuarios\b/i.test(low) && /\b(email|telefono|rut|apellido_materno|ultimo_acceso|fecha_creacion)\b/i.test(low))
    throw new Error('No se puede consultar información personal de colaboradores.');
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

/* ── IA con herramientas: SQL libre + motores de cobranza (mora/provisión/etc.) ── */
const TOOLS = [
  { name: 'consulta_sql',
    description: 'Ejecuta UNA consulta SELECT (MySQL/TiDB) de SOLO LECTURA sobre las tablas del esquema permitido. Úsala para preguntas generales de datos (créditos, clientes, dealers, comisiones, etc.). Sin punto y coma; agrega LIMIT en listas.',
    input_schema: { type: 'object', properties: { sql: { type: 'string', description: 'La consulta SELECT' } }, required: ['sql'] } },
  { name: 'mora_provision',
    description: 'Stock de cartera en mora HOY, agrupado por tramo de días de mora: casos, monto en mora, capital insoluto y PROVISIÓN calculada con los % paramétricos del mantenedor (181+ días = castigo). Incluye totales y split prejudicial/judicial. Úsala para: mora, provisión, castigo, cartera morosa por tramo.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'recuperacion_cartera',
    description: 'Recuperación/recaudación de cobranza por mes: promesas de pago, montos prometidos y montos confirmados. Fechas formato YYYY-MM-DD; por defecto últimos 6 meses.',
    input_schema: { type: 'object', properties: { desde: { type: 'string' }, hasta: { type: 'string' } } } },
  { name: 'rendimiento_ejecutivos',
    description: 'Rendimiento de los ejecutivos de COBRANZA en un rango de fechas: gestiones, contactos, tasa de contacto, promesas y montos. Fechas YYYY-MM-DD; por defecto últimos 6 meses.',
    input_schema: { type: 'object', properties: { desde: { type: 'string' }, hasta: { type: 'string' } } } },
  { name: 'cartera_mora',
    description: 'Listado de créditos en mora (peores primero): número de crédito, cliente, cuotas y días de mora, monto en mora y saldo insoluto. Filtros opcionales.',
    input_schema: { type: 'object', properties: {
      tipo: { type: 'string', enum: ['prejudicial', 'judicial'] },
      tramo: { type: 'string', enum: ['1-15', '16-30', '31-60', '61-90', '91+'] },
      limit: { type: 'number' } } } },
];

const fechaOk = s => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) ? s : null;
function rangoDef(input) {
  const hasta = fechaOk(input.hasta) || new Date().toISOString().slice(0, 10);
  let desde = fechaOk(input.desde);
  if (!desde) { const x = new Date(hasta); x.setMonth(x.getMonth() - 6); desde = x.toISOString().slice(0, 10); }
  return { desde, hasta };
}

// Despachador: resuelve cada herramienta y va guardando el último resultado tabular
// (para pintar la tabla en el frontend igual que antes).
function crearDispatcher(ultimo) {
  // Motor de datos de Reportería Cobranzas (un solo motor: mismos números que los reportes)
  const rep = require('../../../cobranza/src/controllers/reportes.controller')._datos;
  const tabla = (rows) => {
    ultimo.rows = Array.isArray(rows) ? rows.slice(0, 500) : [];
    ultimo.columns = ultimo.rows.length ? Object.keys(ultimo.rows[0]) : [];
  };
  return async (name, input) => {
    if (name === 'consulta_sql') {
      const r = await ejecutarSeguro(input.sql);
      ultimo.sql = r.sql; ultimo.rows = r.rows; ultimo.columns = r.columns;
      return { filas: r.rows.length, columnas: r.columns, muestra: r.rows.slice(0, 50) };
    }
    if (name === 'mora_provision')       { const d = await rep.datosMoraStock(); tabla(d.tramos); return d; }
    if (name === 'recuperacion_cartera') { const { desde, hasta } = rangoDef(input); const d = await rep.datosRecuperacion(desde, hasta); tabla(d.serie); return d; }
    if (name === 'rendimiento_ejecutivos') { const { desde, hasta } = rangoDef(input); const d = await rep.datosRendimiento(desde, hasta); tabla(d.ejecutivos); return d; }
    if (name === 'cartera_mora')         { const d = await rep.datosCartera({ tipo: input.tipo, tramo: input.tramo, limit: Math.min(Number(input.limit) || 200, 500) }); tabla(d.rows); return { total: d.total, rows: d.rows.slice(0, 100) }; }
    throw new Error('Herramienta desconocida: ' + name);
  };
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
    const lecciones = await leccionesActivas();
    const historial = (Array.isArray(req.body.historial) ? req.body.historial : [])
      .filter(h => h && h.pregunta && h.sql)
      .slice(-3)
      .map(h => ({ pregunta: String(h.pregunta).slice(0, 300), sql: String(h.sql).slice(0, 1500) }));

    const hoy = new Date().toLocaleDateString('es-CL', { timeZone: 'America/Santiago', day: '2-digit', month: '2-digit', year: 'numeric' });
    const system =
      'Eres un analista de datos de AutoFácil, una automotora de crédito en Chile. Respondes preguntas de negocio ' +
      'usando las HERRAMIENTAS disponibles: consulta_sql para SQL libre (SOLO SELECT) y las herramientas de cobranza ' +
      'para mora/provisión/recuperación/rendimiento (usa SIEMPRE esas para dichas métricas, jamás SQL propio). ' +
      'Los datos son la BASE INTERNA de AutoFácil (sus propias operaciones), no el mercado.\n\n' +
      'Esquema disponible para consulta_sql:\n' + esquema + '\n\n' + GLOSARIO + '\n\n' +
      (lecciones.length ? 'LECCIONES APRENDIDAS (correcciones dictadas por los usuarios — OBEDÉCELAS SIEMPRE, tienen prioridad sobre tu criterio):\n' + lecciones.join('\n') + '\n\n' : '') +
      `REGLAS DE REDACCIÓN (obligatorias, hoy es ${hoy}):\n` +
      '1) Afirma SOLO lo que se desprende directamente de las cifras obtenidas. NUNCA inventes promedios, cadencias, tendencias ni proyecciones que no calculaste con los datos.\n' +
      '2) Si mencionas un promedio mensual, calcúlalo sobre TODOS los meses del período (los meses SIN actividad cuentan como 0), no solo sobre los meses que tienen datos. Ej: 6 operaciones en un año son 0,5/mes, no "1 operación mensual".\n' +
      '3) NO uses "últimos N meses" salvo que el período consultado realmente lo sea respecto de hoy. Si te refieres a los meses que TIENEN datos, di "últimos meses con actividad" o nombra el mes/fecha exacta (ej. "su última operación fue en octubre 2025").\n' +
      '4) Si los datos muestran huecos (meses o períodos sin registros), MENCIÓNALOS explícitamente en vez de asumir continuidad.\n' +
      '5) No te contradigas: si dices "bajo volumen", los números y adjetivos deben ser coherentes con eso.\n\n' +
      'Al terminar, responde SOLO con JSON: {"respuesta":"1 a 3 frases en español, breve y claro para un gerente, montos en pesos chilenos con separador de miles", ' +
      '"grafico": {"tipo":"bar|line|pie","etiqueta":"<columna categórica>","valor":"<columna numérica>","titulo":"..."} | null}. ' +
      'El gráfico debe referirse a columnas de la última tabla obtenida. Si la pregunta no se puede responder (ej. simulaciones "qué pasaría si"), dilo en "respuesta" sin inventar datos.';

    let prompt = '';
    if (historial.length) {
      prompt += 'Contexto de la conversación (preguntas previas y el SQL usado). La nueva pregunta puede ser una REPREGUNTA que se apoya en estas (ej. "y por dealer", "ahora del mes pasado"):\n' +
        historial.map((h, i) => `${i + 1}) Pregunta: ${h.pregunta}\n   SQL: ${h.sql}`).join('\n') + '\n\n';
    }
    prompt += `Pregunta del usuario: "${pregunta}"`;

    const ultimo = { sql: null, rows: [], columns: [] };
    const { texto } = await analizarTools({
      codigo: CODIGO_IA, id_usuario: uid, system, prompt,
      tools: TOOLS, ejecutarTool: crearDispatcher(ultimo), max_tokens: 1500, max_iter: 6,
    });

    // El modelo a veces antepone prosa al JSON final: extraer el ÚLTIMO bloque {...}
    let fin = null;
    const limpio = String(texto || '').replace(/```json/gi, '').replace(/```/g, '');
    const m = limpio.match(/\{[\s\S]*\}/);
    if (m) { try { fin = JSON.parse(m[0]); } catch (_) {} }
    const respuesta = (fin && fin.respuesta) || limpio.replace(/\{[\s\S]*\}/, '').trim() || 'No pude interpretar la pregunta. ¿Puedes reformularla?';

    auditar({ req, accion: 'CONSULTA', modulo: 'ia', entidad: 'bi_consulta', detalle: `Pregunta: ${pregunta}`, meta: { sql: ultimo.sql, filas: ultimo.rows.length } });
    res.json({ success: true, data: { pregunta, respuesta, sql: ultimo.sql, columns: ultimo.columns, rows: ultimo.rows, grafico: (fin && fin.grafico) || null, cuota: await cuotaDe(uid, idp) }, error: null });
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

module.exports = { preguntar, cuota, getLimites, setLimites, getLecciones, crearLeccion, toggleLeccion };
