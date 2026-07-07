'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   DISEÑO DE CONSULTA (Reportería) — constructor visual estilo Access:
   se arrastran tablas al lienzo, se relacionan campos (JOIN), se agrupa,
   se filtra con criterios y se ejecuta. SOLO LECTURA, SQL construido y
   validado en el servidor (identificadores contra el schema real, criterios
   saneados, LIMIT duro). Consultas guardadas en consultas_diseno.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });

// Tablas del sistema que NO se exponen ni se consultan
const TABLAS_OCULTAS = new Set(['usuarios_tokens', 'sesiones']);
// Columnas sensibles que nunca viajan
const COLS_OCULTAS = /pass|clave|token|secret|hash|otp/i;

/* ── Migración ──────────────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS consultas_diseno (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_usuario INT NOT NULL,
        nombre VARCHAR(200) NOT NULL,
        modelo JSON NOT NULL,
        publica TINYINT(1) DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_usr (id_usuario)
      )`);
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre LIKE 'Reporter%' OR ruta LIKE '/reporteria%' LIMIT 1");
    if (mod) {
      const f = { codigo: 'reporteria_diseno', nombre: 'Diseño de Consulta', href: '/reporteria/diseno-consulta', icono: 'bi-diagram-3' };
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [f.codigo]);
      let idF = ex && ex.id_funcionalidad;
      if (!idF) {
        const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
          [mod.id_modulo, f.nombre, f.codigo, f.href, f.icono]);
        idF = r.insertId;
      }
      await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idF]);
    }
    console.log('[diseno-consulta] módulo listo');
  } catch (e) { console.error('[diseno-consulta migration]', e.message); }
})();

/* ── Schema en caché (60s) ──────────────────────────────────────────────── */
let SCHEMA = null, SCHEMA_TS = 0;
async function getSchema() {
  if (SCHEMA && Date.now() - SCHEMA_TS < 60000) return SCHEMA;
  const [tbls] = await pool.query('SHOW TABLES');
  const nombres = tbls.map(r => Object.values(r)[0]).filter(t => !TABLAS_OCULTAS.has(t));
  const s = {};
  // DESCRIBE en paralelo controlado
  for (let i = 0; i < nombres.length; i += 20) {
    await Promise.all(nombres.slice(i, i + 20).map(async t => {
      const [cols] = await pool.query(`DESCRIBE \`${t}\``);
      s[t] = cols.filter(c => !COLS_OCULTAS.test(c.Field)).map(c => ({ col: c.Field, tipo: c.Type, pk: c.Key === 'PRI' }));
    }));
  }
  SCHEMA = s; SCHEMA_TS = Date.now();
  return s;
}

exports.tablas = async (req, res) => {
  try {
    const s = await getSchema();
    // conteo de filas aproximado para orientar (information_schema, barato)
    const [st] = await pool.query(
      'SELECT TABLE_NAME t, TABLE_ROWS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
    const filas = {}; st.forEach(r => { filas[r.t] = +r.n || 0; });
    ok(res, Object.entries(s).map(([nombre, cols]) => ({ nombre, filas: filas[nombre] ?? null, columnas: cols })));
  } catch (e) { fail(res, e.message); }
};

/* ── Construcción segura del SELECT ─────────────────────────────────────── */
const AGGS = { SUM: 'SUM', COUNT: 'COUNT', AVG: 'AVG', MIN: 'MIN', MAX: 'MAX' };
const PROHIBIDO = /;|--|\/\*|\b(insert|update|delete|drop|alter|create|grant|union|select|sleep|benchmark|load_file|outfile|into)\b/i;

// Criterio estilo Access sobre UNA columna: >=100, <>'X', LIKE "a*", IN (1,2),
// BETWEEN a AND b, IS NULL, texto pelado = igualdad. Devuelve SQL o lanza.
function criterioSQL(colExpr, cri) {
  let c = String(cri || '').trim();
  if (!c) return null;
  if (PROHIBIDO.test(c)) throw new Error(`Criterio no permitido: ${cri}`);
  c = c.replace(/\*/g, '%');                       // comodín Access
  if (/^(is\s+(not\s+)?null)$/i.test(c)) return `${colExpr} ${c.toUpperCase()}`;
  if (/^(not\s+)?like\s+/i.test(c)) {
    const m = c.match(/^(not\s+)?like\s+["']?([^"']*)["']?$/i);
    if (!m) throw new Error(`LIKE inválido: ${cri}`);
    return `${colExpr} ${m[1] ? 'NOT ' : ''}LIKE ${pool.escape(m[2])}`;
  }
  if (/^(not\s+)?in\s*\(/i.test(c)) {
    const m = c.match(/^(not\s+)?in\s*\(([^)]*)\)$/i);
    if (!m) throw new Error(`IN inválido: ${cri}`);
    const vals = m[2].split(',').map(v => pool.escape(v.trim().replace(/^["']|["']$/g, '')));
    if (!vals.length) throw new Error(`IN vacío: ${cri}`);
    return `${colExpr} ${m[1] ? 'NOT ' : ''}IN (${vals.join(',')})`;
  }
  if (/^between\s+/i.test(c)) {
    const m = c.match(/^between\s+["']?([^"']+?)["']?\s+(?:and|y)\s+["']?([^"']+?)["']?$/i);
    if (!m) throw new Error(`BETWEEN inválido: ${cri}`);
    return `${colExpr} BETWEEN ${pool.escape(m[1].trim())} AND ${pool.escape(m[2].trim())}`;
  }
  const m = c.match(/^(<>|>=|<=|=|>|<)\s*["']?(.*?)["']?$/);
  if (m) {
    if (m[2].includes('%')) return `${colExpr} ${m[1] === '=' ? 'LIKE' : m[1] === '<>' ? 'NOT LIKE' : m[1]} ${pool.escape(m[2])}`;
    return `${colExpr} ${m[1]} ${pool.escape(m[2])}`;
  }
  // texto pelado → igualdad (con comodín → LIKE)
  const v = c.replace(/^["']|["']$/g, '');
  return v.includes('%') ? `${colExpr} LIKE ${pool.escape(v)}` : `${colExpr} = ${pool.escape(v)}`;
}

async function construirSQL(modelo) {
  const s = await getSchema();
  const tablas = Array.isArray(modelo.tablas) ? modelo.tablas : [];
  const joins  = Array.isArray(modelo.joins) ? modelo.joins : [];
  const campos = Array.isArray(modelo.campos) ? modelo.campos : [];
  if (!tablas.length) throw new Error('Agrega al menos una tabla');
  if (!campos.length) throw new Error('Agrega al menos un campo a la grilla');

  // alias → tabla real, validados
  const aliasDe = {};
  tablas.forEach((t, i) => {
    if (!s[t.nombre]) throw new Error(`Tabla no permitida: ${t.nombre}`);
    const al = /^[A-Za-z]\w{0,20}$/.test(String(t.alias || '')) ? t.alias : 'T' + i;
    aliasDe[al] = t.nombre;
    t._alias = al;
  });
  const colOk = (alias, col) => {
    const tb = aliasDe[alias];
    if (!tb) throw new Error(`Alias desconocido: ${alias}`);
    if (!s[tb].some(c => c.col === col)) throw new Error(`Columna no existe: ${alias}.${col}`);
    return `\`${alias}\`.\`${col}\``;
  };

  // FROM + JOINs (las tablas sin join entran como CROSS solo si es la primera)
  const usadas = new Set([tablas[0]._alias]);
  let fromSQL = `\`${aliasDe[tablas[0]._alias]}\` AS \`${tablas[0]._alias}\``;
  let pend = joins.slice();
  let avance = true;
  while (pend.length && avance) {
    avance = false;
    for (let i = 0; i < pend.length; i++) {
      const j = pend[i];
      const tipo = j.tipo === 'LEFT' ? 'LEFT JOIN' : 'INNER JOIN';
      const aIn = usadas.has(j.a.alias), bIn = usadas.has(j.b.alias);
      if (aIn === bIn) continue;                       // ambos o ninguno: después
      const nuevo = aIn ? j.b : j.a;
      fromSQL += `\n  ${tipo} \`${aliasDe[nuevo.alias]}\` AS \`${nuevo.alias}\` ON ${colOk(j.a.alias, j.a.col)} = ${colOk(j.b.alias, j.b.col)}`;
      usadas.add(nuevo.alias);
      pend.splice(i, 1); avance = true; break;
    }
  }
  // joins entre tablas ya presentes → condiciones extra en WHERE
  const extraOn = pend.filter(j => usadas.has(j.a.alias) && usadas.has(j.b.alias))
    .map(j => `${colOk(j.a.alias, j.a.col)} = ${colOk(j.b.alias, j.b.col)}`);
  // tablas sueltas sin relación (producto cartesiano) — prohibido salvo 1 tabla
  const sueltas = tablas.filter(t => !usadas.has(t._alias));
  if (sueltas.length) throw new Error(`Tabla sin relación: ${sueltas.map(t => t.nombre).join(', ')} — arrastra un campo para unirla`);

  const hayAgg = campos.some(f => AGGS[f.total]);
  const sel = [], groupBy = [], orderBy = [], where = [...extraOn], having = [];

  campos.forEach((f, i) => {
    const expr = colOk(f.alias, f.col);
    const aliasOut = String(f.nombre || `${f.col}${AGGS[f.total] ? '_' + f.total.toLowerCase() : ''}`).replace(/[^\w áéíóúñÁÉÍÓÚÑ.-]/g, '').slice(0, 60) || 'c' + i;
    let exprSel = expr;
    if (AGGS[f.total]) exprSel = `${AGGS[f.total]}(${expr})`;
    if (f.mostrar !== false) sel.push(`${exprSel} AS \`${aliasOut}\``);
    if (hayAgg && !AGGS[f.total] && f.total !== 'WHERE') groupBy.push(expr);
    if (f.orden === 'ASC' || f.orden === 'DESC') orderBy.push(`${exprSel} ${f.orden}`);
    // criterios (fila "Criterios" y fila "o")
    for (const [cri, esO] of [[f.criterio, false], [f.o, true]]) {
      const sqlCri = criterioSQL(AGGS[f.total] ? exprSel : expr, cri);
      if (!sqlCri) continue;
      const destino = AGGS[f.total] ? having : where;
      if (esO && destino.length) destino[destino.length - 1] = `(${destino[destino.length - 1]} OR ${sqlCri})`;
      else destino.push(sqlCri);
    }
  });
  if (!sel.length) throw new Error('Ningún campo tiene Mostrar activado');

  const limit = Math.min(5000, Math.max(1, parseInt(modelo.limit) || 1000));
  let sql = `SELECT ${sel.join(', ')}\nFROM ${fromSQL}`;
  if (where.length)   sql += `\nWHERE ${where.join(' AND ')}`;
  if (groupBy.length) sql += `\nGROUP BY ${[...new Set(groupBy)].join(', ')}`;
  if (having.length)  sql += `\nHAVING ${having.join(' AND ')}`;
  if (orderBy.length) sql += `\nORDER BY ${orderBy.join(', ')}`;
  sql += `\nLIMIT ${limit}`;
  return sql;
}

exports.ejecutar = async (req, res) => {
  try {
    const sql = await construirSQL(req.body || {});
    const t0 = Date.now();
    const [rows] = await pool.query({ sql, timeout: 30000 });
    auditar({ req, accion: 'CONSULTAR', modulo: 'reporteria', entidad: 'diseno_consulta', entidad_id: '-',
      detalle: `Ejecutó consulta diseñada (${rows.length} filas)`, meta: { sql: sql.slice(0, 1000) } });
    ok(res, { sql, rows, n: rows.length, ms: Date.now() - t0 });
  } catch (e) { fail(res, e.message, 400); }
};

exports.sqlPreview = async (req, res) => {
  try { ok(res, { sql: await construirSQL(req.body || {}) }); }
  catch (e) { fail(res, e.message, 400); }
};

/* ── Consultas guardadas ────────────────────────────────────────────────── */
exports.listar = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.id, c.nombre, c.publica, c.id_usuario, c.updated_at, u.nombre autor
       FROM consultas_diseno c LEFT JOIN usuarios u ON u.id_usuario=c.id_usuario
       WHERE c.id_usuario=? OR c.publica=1 ORDER BY c.updated_at DESC LIMIT 200`, [req.user.id_usuario]);
    ok(res, rows);
  } catch (e) { fail(res, e.message); }
};
exports.obtener = async (req, res) => {
  try {
    const [[r]] = await pool.query(
      'SELECT * FROM consultas_diseno WHERE id=? AND (id_usuario=? OR publica=1)', [req.params.id, req.user.id_usuario]);
    if (!r) return fail(res, 'No existe', 404);
    ok(res, { ...r, modelo: typeof r.modelo === 'string' ? JSON.parse(r.modelo) : r.modelo });
  } catch (e) { fail(res, e.message); }
};
exports.guardar = async (req, res) => {
  try {
    const { id, nombre, modelo, publica } = req.body || {};
    if (!nombre || !modelo) return fail(res, 'nombre y modelo requeridos', 400);
    if (id) {
      const [r] = await pool.query('UPDATE consultas_diseno SET nombre=?, modelo=?, publica=? WHERE id=? AND id_usuario=?',
        [String(nombre).slice(0, 200), JSON.stringify(modelo), publica ? 1 : 0, id, req.user.id_usuario]);
      if (!r.affectedRows) return fail(res, 'No existe o no es tuya', 404);
      return ok(res, { id });
    }
    const [r] = await pool.query('INSERT INTO consultas_diseno (id_usuario, nombre, modelo, publica) VALUES (?,?,?,?)',
      [req.user.id_usuario, String(nombre).slice(0, 200), JSON.stringify(modelo), publica ? 1 : 0]);
    ok(res, { id: r.insertId });
  } catch (e) { fail(res, e.message); }
};
exports.eliminar = async (req, res) => {
  try {
    await pool.query('DELETE FROM consultas_diseno WHERE id=? AND id_usuario=?', [req.params.id, req.user.id_usuario]);
    ok(res, { eliminado: true });
  } catch (e) { fail(res, e.message); }
};
