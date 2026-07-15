'use strict';
/**
 * "Pregúntale a Finanzas" — BI conversacional acotado al ámbito financiero-contable
 * (mismo patrón que Pregúntale a AutoFácil: herramientas + glosario, que fue lo que
 * lo hizo funcionar bien): Claude usa los MOTORES del módulo (balance, EERR, P&G por
 * rubros con presupuesto, presupuesto anual) como herramientas de primera clase y
 * SQL SELECT blindado sobre una allowlist de tablas contables para el detalle fino.
 */
const pool = require('../../../../shared/config/database');
const ia = require('../../../../shared/ia');
const { analizarTools } = require('../../../../shared/anthropic');
const { auditar } = require('../../../../shared/audit');
const ctb = require('./contabilidad.controller');

const CODIGO_IA = 'finanzas_ia';

// Tablas contables expuestas a la IA (allowlist, solo lectura)
const TABLAS = [
  'ctb_cuentas', 'ctb_comprobantes', 'ctb_movimientos', 'ctb_presupuesto',
  'ctb_compras_aux', 'ctb_honorarios_aux', 'ctb_ventas_aux', 'ctb_remun_aux',
  'ctb_dir_rubros', 'ctb_meses_cerrados', 'uf', 'utm', 'dolar',
  'usuarios',   // SOLO columnas laborales no sensibles (ver filtro en getEsquema)
  'rh_fichas',  // SOLO columnas de remuneración (sueldo_base, contrato) — resto filtrado
];
const ALLOW = new Set(TABLAS);

const GLOSARIO = [
  'GLOSARIO CONTABLE-FINANCIERO (mapea lo que pregunta el usuario a las fuentes reales):',
  "- La contabilidad vive en ctb_movimientos (m) JOIN ctb_comprobantes c ON c.id=m.id_comprobante JOIN ctb_cuentas k ON k.codigo=m.cuenta. SIEMPRE filtra c.estado='CONTABILIZADO'.",
  "- Tipos de cuenta (ctb_cuentas.tipo): ACTIVO, PASIVO, PATRIMONIO, INGRESO, GASTO. Códigos: 1=activo, 2=pasivo/patrimonio, 3=ingresos, 4=gastos.",
  "- SIGNOS: saldo de balance = SUM(m.debe - m.haber) acumulado hasta la fecha (activo queda +; pasivo/patrimonio salen negativos: multiplícalos por -1 para mostrarlos). Resultado: INGRESO = SUM(m.haber - m.debe), GASTO = SUM(m.debe - m.haber) en el rango de fechas.",
  "- En consultas de RESULTADO excluye SIEMPRE el asiento de cierre: c.origen <> 'CIERRE_EJERCICIO'.",
  "- \"Mes contable\" = c.fecha (DATE_FORMAT(c.fecha,'%Y-%m')). Libros disponibles desde 2025-01.",
  "- \"Presupuesto / PPTO\" = ctb_presupuesto (anio, mes 1..12, cuenta, monto) en sentido NATURAL: ingresos y gastos POSITIVOS. Hoy hay presupuesto cargado para 2026. Desviación = real − presupuesto.",
  "- \"Gastos de personal / remuneraciones\" = cuentas 400106%-400109% (sueldos, gratificación, colación, etc.) o el auxiliar ctb_remun_aux (líquidos e imposiciones pagadas por mes).",
  "- \"Compras / facturas de proveedores\" = ctb_compras_aux (mes, rut, razon_social, neto, iva, total). \"Honorarios / boletas\" = ctb_honorarios_aux (bruto, retencion, liquido). \"Ventas / facturación\" = ctb_ventas_aux.",
  "- \"Canal / financiera\" de una operación = creditos.financiera (AUTOFIN, UNIDAD, AUTOFACIL): usa produccion_mensual con por_financiera/financiera para operaciones por canal. Los ingresos contables por canal se ven en ctb_ventas_aux (razon_social AUTOFIN S.A. / UNIDAD CREDITOS S.A.).",
  "- \"Deuda con la matriz / CFC\" = cuentas de documentos por pagar en dólares (busca k.nombre LIKE '%DOLAR%' o '%EXTRANJERO%'). La capitalización de jun-2026 llevó el patrimonio de -$43,6MM a $1.080MM.",
  "- \"Rubros gerenciales\" (Ingresos Operativos, Gastos de Personal, Margen Operativo…) = ctb_dir_rubros: cada cuenta se asigna al primer rubro cuyo prefijo calce. Para P&G por rubros usa la herramienta pyg_rubros (NO lo armes a mano).",
  '',
  'MÉTRICAS CON MOTOR PROPIO (usa las herramientas, NUNCA SQL propio para esto):',
  '- Balance general a una fecha → herramienta balance_general. Estado de resultados entre fechas → estado_resultados.',
  '- P&G gerencial por rubros con comparación contra AÑO ANTERIOR y PRESUPUESTO (mes y acumulado) → pyg_rubros. Es LA herramienta para "cómo vamos contra el presupuesto", márgenes y desviaciones.',
  '- Presupuesto anual completo cuenta a cuenta → presupuesto_anual.',
  '- NÚMERO DE OPERACIONES / producción / colocación → herramienta produccion_mensual (créditos OTORGADOS reales por mes, con montos). NUNCA cuentes asientos o movimientos contables como "operaciones": un asiento agrupa muchas operaciones y el conteo sale ~10 veces menor que la realidad.',
  'Nunca digas que estos datos no existen: existen vía herramientas.',
  '',
  "Montos en PESOS CHILENOS. En las respuestas usa millones con un decimal cuando el monto sea grande (ej. $207,6 Millones) y formato es-CL.",
  '',
  'CURSO ACELERADO (entrenado con 10.000 preguntas reales de 3 perfiles — hechos verificados contra la BD):',
  "- ADAPTA EL REGISTRO AL USUARIO: si la pregunta es simple o pide 'con peras y manzanas', explica SIN jerga y con analogías, usando cifras nuestras como ejemplo. Si es de gestión (directorio), da 2-3 cifras clave + tendencia + comparación (ppto y año anterior) + una recomendación concreta. Si es técnica, sé preciso con códigos de cuenta.",
  "- Valores REALES de creditos.financiera: 'AUTOFIN', 'UNIDAD DE CREDITO', 'AUTOFACIL', 'AFA' (cartera comprada), 'NO APLICA'. En produccion_mensual pide UNIDAD y el sistema lo traduce.",
  "- Libros contables: 2025-01 a hoy. NO existe contabilidad 2024 ni anterior (dilo, no inventes). El mes EN CURSO está incompleto: adviértelo al comparar.",
  "- HITOS que explican anomalías: jun-2025 ingresos extraordinarios (~$279M, no repetible); dic-2025 gastos ~$314M por ajustes de cierre anual; jun-2026 capitalización de la deuda con la matriz (CFC) llevó el patrimonio de -$43,6M a ~$1.080M — antes era negativo (pérdidas acumuladas superaban el capital).",
  "- REALIDAD 2026: los ingresos reales vienen muy por debajo del presupuesto (ej. may-26 real ~$69M vs ppto ~$221M) y la empresa opera con pérdida mensual (gastos ~$110-215M vs ingresos ~$55-100M). No lo maquilles: repórtalo con la brecha y su tendencia.",
  "- Cuenta a cuenta: busca por nombre con LIKE en ctb_cuentas (ej. 'arriendos' → 4002100). Si no existe cuenta específica, dilo y ofrece la más cercana. Los nombres pueden traer caracteres corruptos (CONDONACIàN) — usa LIKE con la raíz.",
  "- ctb_honorarios_aux usa la columna nombre (NO razon_social). ctb_compras_aux y ctb_ventas_aux sí usan razon_social.",
  "- Un banco con saldo NEGATIVO (ej. BICE) = línea de crédito girada/sobregiro, no un error. Caja consolidada = SUM sobre cuentas 1101%. 'Meses de caja' = caja ÷ gasto mensual promedio.",
  "- Ventas facturadas: ~93% a AUTOFIN S.A. — es la comisión de producción del canal brokerage, no venta de autos.",
  "- Dotación: ~25-29 personas pagadas/mes (ctb_remun_aux, COUNT DISTINCT rut). Sueldos individuales: da agregados o promedios, no expongas el detalle por persona salvo que lo pidan explícitamente con nombre.",
  "- PUNTO DE EQUILIBRIO en operaciones = gasto mensual promedio ÷ ingreso promedio por operación (ingresos contables del mes ÷ operaciones OTORGADAS del mes vía produccion_mensual). Nunca uses conteo de asientos.",
  "- EBITDA aproximado = resultado + depreciaciones (cuentas 4003%) + estimación incobrables (4001190). Dilo como aproximación.",
  "- La UF tiene valores futuros cargados (se publica por adelantado): para 'UF de hoy' usa fecha <= CURDATE().",
  "- ANTIGÜEDAD / fecha de ingreso de los colaboradores = usuarios.fecha_ingreso (empleado más antiguo = MIN con estado='activo'; antigüedad en años = TIMESTAMPDIFF). También tienes usuarios.cargo y rh_fichas.sueldo_base (+ colación/movilización/tipo_contrato) para análisis de planilla. NO tienes acceso a sus datos personales (rut, teléfono, nacimiento, dirección, banco, AFP, salud): si los piden, derívalo a RRHH.",
  "- VERIFICAR UNA PROVISIÓN = comparar el saldo contable (cuentas 2106%) contra el cálculo teórico y explicar la base. Provisiones EXISTENTES en el libro: vacaciones (2106030), comisiones dealer (2106011) y parque (2106012), comisiones ejecutivos (2106060), gastos (2106020/2106050), cesión de operaciones (2106022) y finiquitos por pagar (2106070). NO existe cuenta de provisión por INDEMNIZACIÓN DE AÑOS DE SERVICIO (IAS): si preguntan por ella, dilo explícitamente; el teórico si se pactara a todo evento sería sueldo_base mensual (tope 90 UF) × años de servicio (tope 11 años, TIMESTAMPDIFF desde usuarios.fecha_ingreso) por empleado activo — puedes calcularlo con rh_fichas.sueldo_base y ofrecerlo como referencia de pasivo no contabilizado. Vacaciones teórico ≈ días pendientes × (sueldo_base/30) — los días pendientes no están en estas tablas (dilo).",
  "- Trimestres: Q1=ene-mar, Q2=abr-jun, Q3=jul-sep, Q4=oct-dic (año calendario).",
  "- NO puedes modificar ni borrar datos (solo lectura) — si lo piden, dilo. No des consejos de inversión personal. Preguntas de negocio no contable (producción comercial fina, clientes, cobranza) → sugiere 'Pregúntale a AutoFácil'.",
  "- Al proyectar el año, usa el promedio de los últimos 3 meses reales × meses restantes + acumulado, y decláralo como proyección simple.",
].join('\n');

require('../../../../shared/migrate').enFila('contabilidad-finanzas-ia', async () => {
  try {
    await ia.registrarFuncionalidad({
      codigo: CODIGO_IA,
      nombre: 'Pregúntale a Finanzas (BI conversacional)',
      descripcion: 'Responde preguntas de finanzas, gastos, ingresos y presupuesto sobre la contabilidad (herramientas de motores + SQL de solo lectura)',
      modelo: 'claude-opus-4-8',
    });
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='ctb_finanzas_ia' LIMIT 1");
    let idf = ex?.id_funcionalidad;
    if (!idf) {
      const [r] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (500003,'Pregúntale a Finanzas','ctb_finanzas_ia','/contabilidad/finanzas-ia/','bi-chat-dots')");
      idf = r.insertId;
    }
    for (const idp of [1, 90003, 90007, 90009])
      await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
    console.log('[contabilidad] pregúntale a finanzas listo');
  } catch (e) { console.error('[contabilidad-finanzas-ia migration]', e.message); }
});

/* ── Lecciones aprendidas: la educación de la IA es PARAMÉTRICA ────────────────
   Cada vez que una respuesta sale mala, el usuario la corrige con 👎 y la
   corrección queda como REGLA permanente que se inyecta en el prompt de todas
   las preguntas siguientes — sin tocar código (misma filosofía que el resto
   de los mantenedores). */
require('../../../../shared/migrate').enFila('contabilidad-finia-lecciones', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ctb_finia_lecciones (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        regla      TEXT NOT NULL,               -- la lección, redactada como instrucción
        pregunta   VARCHAR(500) NULL,           -- pregunta que la originó (contexto)
        creada_por VARCHAR(160) NULL,
        activa     TINYINT NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
  } catch (e) { console.error('[contabilidad-finia-lecciones migration]', e.message); }
});

async function leccionesActivas() {
  try {
    const [rows] = await pool.query('SELECT regla FROM ctb_finia_lecciones WHERE activa=1 ORDER BY id DESC LIMIT 80');
    return rows.map(r => '- ' + String(r.regla).replace(/\s+/g, ' ').trim());
  } catch (_) { return []; }
}

exports.getLecciones = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, regla, pregunta, creada_por, activa, created_at FROM ctb_finia_lecciones ORDER BY id DESC LIMIT 200');
    res.json({ success: true, data: rows, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

exports.crearLeccion = async (req, res) => {
  try {
    const regla = String(req.body.regla || '').trim().slice(0, 2000);
    if (regla.length < 10) return res.status(400).json({ success: false, data: null, error: 'Describe la corrección (mínimo 10 caracteres)' });
    const pregunta = String(req.body.pregunta || '').trim().slice(0, 500) || null;
    const quien = (req.usuario || req.user || {}).nombre || (req.usuario || req.user || {}).correo || null;
    const [r] = await pool.query('INSERT INTO ctb_finia_lecciones (regla, pregunta, creada_por) VALUES (?,?,?)', [regla, pregunta, quien]);
    auditar({ req, accion: 'CREAR', modulo: 'contabilidad', entidad: 'finia_leccion', entidad_id: String(r.insertId), detalle: `Lección IA finanzas: ${regla.slice(0, 120)}` });
    res.json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

exports.toggleLeccion = async (req, res) => {
  try {
    await pool.query('UPDATE ctb_finia_lecciones SET activa=? WHERE id=?', [req.body.activa ? 1 : 0, Number(req.params.id)]);
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

/* ── Esquema acotado (cacheado 10 min) ── */
let _esq = null, _esqAt = 0;
async function getEsquema() {
  if (_esq && (Date.now() - _esqAt) < 600000) return _esq;
  const [rows] = await pool.query(
    `SELECT TABLE_NAME t, COLUMN_NAME c, DATA_TYPE d FROM information_schema.columns
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME, ORDINAL_POSITION`, [TABLAS]);
  const byT = {};
  // De usuarios (empleados) SOLO columnas laborales: nada de rut, teléfono, email,
  // fecha de nacimiento, etc. — la información personal de colaboradores queda fuera.
  const USUARIOS_OK = new Set(['id_usuario', 'nombre', 'apellido', 'cargo', 'fecha_ingreso', 'estado', 'centro_costo', 'id_perfil']);
  // De la ficha RRHH solo lo necesario para análisis de planilla/provisiones:
  // nada de dirección, banco, salud, AFP, contactos ni datos de emergencia.
  const RHFICHA_OK = new Set(['id_usuario', 'sueldo_base', 'colacion', 'movilizacion', 'tipo_contrato', 'jornada']);
  for (const r of rows) {
    if (/password|hash|token|secret|clave/i.test(r.c)) continue;
    if (r.t === 'usuarios' && !USUARIOS_OK.has(r.c)) continue;
    if (r.t === 'rh_fichas' && !RHFICHA_OK.has(r.c)) continue;
    (byT[r.t] = byT[r.t] || []).push(`${r.c}:${r.d}`);
  }
  _esq = Object.entries(byT).map(([t, cs]) => `${t}(${cs.join(', ')})`).join('\n');
  _esqAt = Date.now();
  return _esq;
}

/* ── Blindaje SQL solo lectura (mismo guard que Pregúntale a AutoFácil) ── */
const PROHIB = /\b(insert|update|delete|drop|alter|truncate|create|replace|grant|revoke|rename|merge|call|load|outfile|dumpfile|set|lock|unlock|handler|do|prepare|execute|sleep|benchmark|information_schema|performance_schema|mysql)\b/i;
const limpiarSQL = s => String(s || '').replace(/```sql/gi, '').replace(/```/g, '').replace(/;+\s*$/, '').trim();
function validarSQL(s) {
  const low = s.toLowerCase();
  if (!/^select\b/.test(low)) throw new Error('Solo se permiten consultas SELECT.');
  if (s.includes(';')) throw new Error('Solo se permite una consulta.');
  if (PROHIB.test(low)) throw new Error('La consulta contiene operaciones no permitidas.');
  // Datos personales de empleados fuera: si toca usuarios, solo columnas laborales
  if (/\busuarios\b/i.test(low) && /\b(email|telefono|fecha_nacimiento|sexo|apellido_materno|rut_cuerpo|rut_dv)\b/i.test(low))
    throw new Error('No se puede consultar información personal de colaboradores.');
  if (/\brh_fichas\b/i.test(low) && /\b(direccion|comuna|ciudad|email_personal|telefono_personal|emergencia_nombre|emergencia_fono|estado_civil|nacionalidad|afp|salud|plan_isapre_uf|banco_pago|tipo_cuenta_pago|num_cuenta_pago)\b/i.test(low))
    throw new Error('No se puede consultar información personal de colaboradores.');
  const tablas = [...s.matchAll(/\b(?:from|join)\s+`?([a-z_][a-z0-9_]*)`?/gi)].map(m => m[1].toLowerCase());
  for (const t of tablas) if (!ALLOW.has(t)) throw new Error('Tabla no permitida: ' + t);
}
const forzarLimit = s => /\blimit\b/i.test(s) ? s : (/\bunion\b/i.test(s) ? `SELECT * FROM (\n${s}\n) AS _sub LIMIT 500` : s + ' LIMIT 500');
async function ejecutarSeguro(sqlRaw) {
  const sql = forzarLimit(limpiarSQL(sqlRaw));
  validarSQL(sql);
  const conn = await pool.getConnection();
  let tx = false;
  try {
    try { await conn.query('SET @@session.max_execution_time = 8000'); } catch (_) {}
    try { await conn.query('START TRANSACTION READ ONLY'); tx = true; } catch (_) {}
    const [rows, fields] = await conn.query(sql);
    if (tx) { try { await conn.query('COMMIT'); } catch (_) {} }
    return { sql, rows: Array.isArray(rows) ? rows.slice(0, 500) : [], columns: (fields || []).map(f => f.name) };
  } catch (e) {
    if (tx) { try { await conn.query('ROLLBACK'); } catch (_) {} }
    throw e;
  } finally { conn.release(); }
}

/* ── Herramientas: los MOTORES del módulo como funciones de primera clase ── */
const interno = (fn, query) => new Promise((resolve, reject) => {
  const r2 = { status() { return this; }, json(j) { j.success ? resolve(j.data) : reject(new Error(j.error)); } };
  fn({ query, params: {}, body: {} }, r2).catch(reject);
});
const mesOk = s => (typeof s === 'string' && /^\d{4}-\d{2}$/.test(s)) ? s : null;
const fechaOk = s => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) ? s : null;

const TOOLS = [
  { name: 'consulta_sql',
    description: 'Ejecuta UNA consulta SELECT (MySQL/TiDB) de SOLO LECTURA sobre las tablas contables permitidas. Úsala para detalle fino: movimientos de una cuenta, facturas de un proveedor, evolución mensual de un gasto, etc. Sin punto y coma; agrega LIMIT en listas.',
    input_schema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] } },
  { name: 'pyg_rubros',
    description: 'P&G GERENCIAL por rubros de un mes: cada rubro (Ingresos Operativos, Gastos de Personal, márgenes…) con [acumulado año, acumulado año anterior, mes, mes año anterior] y ppto=[acumulado presupuesto, mes presupuesto]. LA herramienta para "cómo vamos", desviaciones contra presupuesto y comparaciones contra el año pasado. También trae el balance por rubros con columnas mensuales.',
    input_schema: { type: 'object', properties: { mes: { type: 'string', description: 'YYYY-MM' } }, required: ['mes'] } },
  { name: 'balance_general',
    description: 'Balance general cuenta a cuenta a una fecha de corte (activo, pasivo, patrimonio con saldos).',
    input_schema: { type: 'object', properties: { hasta: { type: 'string', description: 'YYYY-MM-DD (fecha de corte)' } }, required: ['hasta'] } },
  { name: 'estado_resultados',
    description: 'Estado de resultados cuenta a cuenta entre dos fechas: ingresos, gastos y resultado del período.',
    input_schema: { type: 'object', properties: { desde: { type: 'string' }, hasta: { type: 'string' } }, required: ['desde', 'hasta'] } },
  { name: 'produccion_mensual',
    description: 'Producción REAL del negocio por mes: número de créditos OTORGADOS, monto financiado total y promedio, desglosado POR FINANCIERA/canal (AUTOFIN, UNIDAD, AUTOFACIL) si pides agrupar. LA fuente para "cuántas operaciones", punto de equilibrio en operaciones, ingreso o margen por operación o por canal (divide los ingresos contables por estas operaciones, no por asientos).',
    input_schema: { type: 'object', properties: { desde: { type: 'string', description: 'YYYY-MM' }, hasta: { type: 'string', description: 'YYYY-MM' }, financiera: { type: 'string', enum: ['AUTOFIN', 'UNIDAD', 'AUTOFACIL'], description: 'filtra un canal' }, por_financiera: { type: 'boolean', description: 'true = una fila por mes y financiera' } } } },
  { name: 'presupuesto_anual',
    description: 'Presupuesto anual completo cuenta a cuenta: 12 meses por cuenta en sentido natural (ingresos y gastos positivos). Hoy existe 2026.',
    input_schema: { type: 'object', properties: { anio: { type: 'number' } }, required: ['anio'] } },
];

function crearDispatcher(ultimo) {
  const tabla = rows => {
    ultimo.rows = Array.isArray(rows) ? rows.slice(0, 500) : [];
    ultimo.columns = ultimo.rows.length ? Object.keys(ultimo.rows[0]) : [];
  };
  return async (name, input) => {
    if (name === 'consulta_sql') {
      const r = await ejecutarSeguro(input.sql);
      ultimo.sql = r.sql; ultimo.rows = r.rows; ultimo.columns = r.columns;
      return { filas: r.rows.length, columnas: r.columns, muestra: r.rows.slice(0, 50) };
    }
    if (name === 'pyg_rubros') {
      const mes = mesOk(input.mes); if (!mes) throw new Error('mes debe ser YYYY-MM');
      const d = await interno(ctb.directorioCuadros, { mes });
      tabla(d.eerr.map(r => ({ rubro: r.etiqueta, clase: r.clase, acum: r.valores[0], acum_anio_ant: r.valores[1], mes: r.valores[2], mes_anio_ant: r.valores[3], ppto_acum: r.ppto ? r.ppto[0] : null, ppto_mes: r.ppto ? r.ppto[1] : null })));
      return { mes, eerr: ultimo.rows, balance_rubros: d.balance };
    }
    if (name === 'balance_general') {
      const hasta = fechaOk(input.hasta); if (!hasta) throw new Error('hasta debe ser YYYY-MM-DD');
      const d = await interno(ctb.balanceGeneral, { hasta });
      tabla([
        ...(d.activo || []).map(x => ({ tipo: 'ACTIVO', ...x })),
        ...(d.pasivo || []).map(x => ({ tipo: 'PASIVO', ...x })),
        ...(d.patrimonio || []).map(x => ({ tipo: 'PATRIMONIO', ...x })),
      ]);
      return d;
    }
    if (name === 'estado_resultados') {
      const desde = fechaOk(input.desde), hasta = fechaOk(input.hasta);
      if (!desde || !hasta) throw new Error('desde/hasta deben ser YYYY-MM-DD');
      const d = await interno(ctb.estadoResultados, { desde, hasta });
      tabla([
        ...(d.ingresos || []).map(x => ({ tipo: 'INGRESO', ...x })),
        ...(d.gastos || []).map(x => ({ tipo: 'GASTO', ...x })),
      ]);
      return d;
    }
    if (name === 'produccion_mensual') {
      const desde = mesOk(input.desde) || '2025-01', hasta = mesOk(input.hasta) || new Date().toISOString().slice(0, 7);
      // En la BD el canal Unidad se llama 'UNIDAD DE CREDITO' (no 'UNIDAD')
      const MAPA_FIN = { AUTOFIN: 'AUTOFIN', UNIDAD: 'UNIDAD DE CREDITO', AUTOFACIL: 'AUTOFACIL' };
      const fin = MAPA_FIN[input.financiera] || null;
      const porFin = !!input.por_financiera || !!fin;
      const [rows] = await pool.query(
        `SELECT DATE_FORMAT(mes,'%Y-%m') mes${porFin ? ', financiera' : ''}, COUNT(*) operaciones,
                ROUND(SUM(monto_financiado)) monto_financiado, ROUND(AVG(monto_financiado)) monto_promedio
           FROM creditos WHERE estado='OTORGADO' AND DATE_FORMAT(mes,'%Y-%m') BETWEEN ? AND ?${fin ? ' AND financiera=?' : ''}
          GROUP BY 1${porFin ? ', financiera' : ''} ORDER BY 1`, fin ? [desde, hasta, fin] : [desde, hasta]);
      tabla(rows);
      return { desde, hasta, financiera: fin || (porFin ? 'todas (desglosado)' : 'todas'), meses: rows };
    }
    if (name === 'presupuesto_anual') {
      const anio = Number(input.anio); if (!anio) throw new Error('anio inválido');
      const d = await interno(ctb.getPresupuesto, { anio });
      const filas = (d.filas || []).filter(f => f.meses.some(v => v));
      tabla(filas.map(f => ({ cuenta: f.cuenta, nombre: f.nombre, tipo: f.tipo, total: f.meses.reduce((s, v) => s + Number(v), 0), ...Object.fromEntries(f.meses.map((v, i) => [`m${i + 1}`, v])) })));
      return { anio, cuentas: filas.length, filas: filas.slice(0, 120) };
    }
    throw new Error('Herramienta desconocida: ' + name);
  };
}

// POST /api/contabilidad/finanzas-ia { pregunta, historial }
exports.preguntar = async (req, res) => {
  try {
    const pregunta = String(req.body.pregunta || '').trim().slice(0, 500);
    if (!pregunta) return res.status(400).json({ success: false, data: null, error: 'Escribe una pregunta' });
    const uid = (req.usuario || req.user || {}).id_usuario || null;
    const esquema = await getEsquema();
    const lecciones = await leccionesActivas();
    const historial = (Array.isArray(req.body.historial) ? req.body.historial : [])
      .filter(h => h && h.pregunta && h.resumen).slice(-3)
      .map(h => ({ pregunta: String(h.pregunta).slice(0, 300), resumen: String(h.resumen).slice(0, 600) }));

    const hoy = new Date().toISOString().slice(0, 10);
    const system =
      'Eres el analista de finanzas de AutoFácil Chile (crédito automotriz). Respondes preguntas sobre la CONTABILIDAD ' +
      'propia: ingresos, gastos, presupuesto, márgenes, balance, caja, proveedores, honorarios, remuneraciones. ' +
      `Hoy es ${hoy}. Usa las HERRAMIENTAS: pyg_rubros para "cómo vamos"/presupuesto/márgenes; balance_general y ` +
      'estado_resultados para cifras oficiales; presupuesto_anual para el plan; consulta_sql para el detalle fino. ' +
      'Piensa qué herramienta responde mejor ANTES de escribir SQL a mano.\n\n' +
      'Esquema disponible para consulta_sql:\n' + esquema + '\n\n' + GLOSARIO + '\n\n' +
      (lecciones.length ? 'LECCIONES APRENDIDAS (correcciones dictadas por los usuarios en respuestas anteriores — OBEDÉCELAS SIEMPRE, tienen prioridad sobre tu criterio):\n' + lecciones.join('\n') + '\n\n' : '') +
      'ANTES DE CONCLUIR una cifra clave (punto de equilibrio, desviación, margen), verifica que las fuentes sean coherentes entre sí (ej. operaciones reales vs ingresos contables); si dos fuentes contradicen, dilo.\n\n' +
      'Al terminar responde SOLO con JSON (sin NINGÚN texto antes ni después, sin markdown, sin tablas, sin fórmulas: la tabla de datos se muestra sola bajo tu respuesta): ' +
      '{"respuesta":"2 a 5 frases en español para un gerente de finanzas, texto plano con las cifras clave", ' +
      '"grafico": {"tipo":"bar","etiqueta":"<columna categórica>","valor":"<columna numérica>","titulo":"..."} | null}. ' +
      'El gráfico debe referirse a columnas de la última tabla obtenida. Si algo no se puede responder, dilo sin inventar cifras. Si ya tienes datos suficientes, responde de inmediato: no anuncies pasos ni digas \"verifiquemos\" — ejecuta o concluye.';

    let prompt = '';
    if (historial.length)
      prompt += 'Contexto de la conversación (la nueva pregunta puede ser una repregunta):\n' +
        historial.map((h, i) => `${i + 1}) ${h.pregunta} → ${h.resumen}`).join('\n') + '\n\n';
    prompt += `Pregunta del usuario: "${pregunta}"`;

    const ultimo = { sql: null, rows: [], columns: [] };
    const { texto } = await analizarTools({
      codigo: CODIGO_IA, id_usuario: uid, system, prompt,
      tools: TOOLS, ejecutarTool: crearDispatcher(ultimo), max_tokens: 1500, max_iter: 10,
    });

    // Extracción robusta del JSON final: el modelo a veces antepone prosa con llaves
    // (fórmulas, tablas markdown) — se busca el ÚLTIMO objeto balanceado que tenga "respuesta".
    const limpio = String(texto || '').replace(/```json/gi, '').replace(/```/g, '');
    let fin = null;
    for (let i = limpio.lastIndexOf('{"respuesta"'); i >= 0 && !fin; i = limpio.lastIndexOf('{"respuesta"', i - 1)) {
      let depth = 0;
      for (let j = i; j < limpio.length; j++) {
        const ch = limpio[j];
        if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) {
          try { fin = JSON.parse(limpio.slice(i, j + 1)); } catch (_) {}
          break;
        }
      }
    }
    if (!fin) { const m = limpio.match(/\{[\s\S]*\}/); if (m) { try { fin = JSON.parse(m[0]); } catch (_) {} } }
    let respuesta = (fin && fin.respuesta) || '';
    if (!respuesta) {
      // Sin JSON válido: mostrar la prosa pero desnudada de markdown (##, **, |tablas|, $$fórmulas$$)
      respuesta = limpio.replace(/\{[\s\S]*\}/, '').replace(/\$\$[\s\S]*?\$\$/g, '').replace(/^#+\s*/gm, '')
        .replace(/\*\*/g, '').replace(/^\s*\|.*\|\s*$/gm, '').replace(/^-{3,}\s*$/gm, '')
        .replace(/\n{3,}/g, '\n\n').trim() || 'No pude interpretar la pregunta. ¿Puedes reformularla?';
    }

    auditar({ req, accion: 'CONSULTA', modulo: 'contabilidad', entidad: 'finanzas_ia', detalle: `Pregunta: ${pregunta}`, meta: { sql: ultimo.sql, filas: ultimo.rows.length } });
    res.json({ success: true, data: { pregunta, respuesta, sql: ultimo.sql, columns: ultimo.columns, rows: ultimo.rows, grafico: (fin && fin.grafico) || null }, error: null });
  } catch (e) {
    if (e.code === 'IA_OFF') return res.status(400).json({ success: false, data: null, error: 'La IA para esta función está desactivada. Actívala en Mantenedores → Inteligencia Artificial.' });
    if (e.code === 'NO_KEY') return res.status(400).json({ success: false, data: null, error: 'Falta configurar la IA en el servidor.' });
    console.error('[finanzas ia]', e.message);
    return res.status(422).json({ success: false, data: null, error: 'No pude responder: ' + String(e.message || 'error').slice(0, 200) });
  }
};
