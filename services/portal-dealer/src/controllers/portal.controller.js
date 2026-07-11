'use strict';
/**
 * Portal del Dealer — backend read-only.
 * Cada handler usa SIEMPRE el dealer de la sesión (req.dealer del JWT, vía
 * verifyDealer de atención-remota). Un dealer JAMÁS ve datos de otro: todo
 * SELECT se acota por id_dealer / rut_dealer normalizado del token.
 * Fase 1: resumen (KPIs) + operaciones (listado).
 */
const pool = require('../../../../shared/config/database');
const anthropic = require('../../../../shared/anthropic');
const ia = require('../../../../shared/ia');
const { clientIp } = require('../../../../shared/middleware/rate-limit');

const CODIGO_IA = 'dealer_ia';

// ── Migración: feature IA del portal (nace DESACTIVADA) + log de uso ────────
require('../../../../shared/migrate').enFila('portal', async () => {
  try {
    await ia.registrarFuncionalidad({
      codigo: CODIGO_IA,
      nombre: 'Portal Dealer — Asistente IA',
      descripcion: 'Responde al dealer sobre SUS propias operaciones (datos acotados a su id_dealer; sin acceso a otros dealers).',
      modelo: 'claude-haiku-4-5',
    });
  } catch (_) {}
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS portal_ia_uso (
      id        INT AUTO_INCREMENT PRIMARY KEY,
      id_dealer INT NULL,
      id_cuenta INT NULL,
      rut       VARCHAR(20) NULL,
      pregunta  VARCHAR(500) NULL,
      ts        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_dealer_ts (id_dealer, ts),
      INDEX idx_cuenta_ts (id_cuenta, ts)
    )`);
    // Bitácora de acciones del dealer en el portal (qué hacen). Los accesos
    // (login/link/ws) viven en ar_auth_logs; la IA en portal_ia_uso.
    await pool.query(`CREATE TABLE IF NOT EXISTS portal_dealer_log (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      id_dealer  INT NULL,
      id_cuenta  INT NULL,
      accion     VARCHAR(40) NOT NULL,
      detalle    VARCHAR(200) NULL,
      ip         VARCHAR(64) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_cuenta (id_cuenta),
      INDEX idx_fecha (created_at)
    )`);
  } catch (e) { console.error('[portal-dealer] migracion ia:', e.message); }

  // Índices para el filtro por dealer. La expresión RUT es IDÉNTICA a la de
  // dealerScope/cartolas → el optimizador puede usar estos índices (index merge
  // sobre el OR id_dealer/rut). Idempotente y tolerante a fallos: si el índice
  // ya existe el ALTER falla y se ignora; si fallara, las queries siguen OK
  // (solo sin acelerar). Barato ahora con poco volumen.
  const RUTNORM_EXPR = "(REPLACE(REPLACE(REPLACE(UPPER(COALESCE(rut_dealer,'')),'.',''),'-',''),' ',''))";
  await pool.query('ALTER TABLE creditos ADD INDEX idx_creditos_id_dealer (id_dealer)').catch(() => {});
  await pool.query(`ALTER TABLE creditos ADD INDEX idx_creditos_rutnorm (${RUTNORM_EXPR})`).catch(() => {});
  await pool.query(`ALTER TABLE cartolas_enviadas ADD INDEX idx_cartenv_rutnorm (${RUTNORM_EXPR})`).catch(() => {});
});

// ── Helpers ──────────────────────────────────────────────────────────────
const rutNorm = (r) =>
  String(r || '').replace(/[.\-\s]/g, '').toUpperCase();

// Cláusula WHERE que acota a las operaciones del dealer de la sesión.
// Match por id_dealer (si el JWT lo trae) O por rut_dealer normalizado.
function dealerScope(req) {
  const idd = req.dealer && req.dealer.id_dealer ? Number(req.dealer.id_dealer) : null;
  const rut = rutNorm(req.dealer && req.dealer.rut);
  const where = `(
    (? IS NOT NULL AND ob.id_dealer = ?)
    OR (? <> '' AND REPLACE(REPLACE(REPLACE(UPPER(COALESCE(ob.rut_dealer,'')),'.',''),'-',''),' ','') = ?)
  )`;
  return { where, params: [idd, idd, rut, rut], hasScope: !!(idd || rut) };
}

// Expresión SQL de ETAPA (misma lógica que SELECT_GESTION de creditos).
const ESTADO_SQL = `
  CASE
    WHEN ob.estado IN ('VIGENTE','EN MORA','VENCIDO','PREPAGADO','CASTIGADO') THEN 'OTORGADO'
    WHEN ob.estado IS NOT NULL AND ob.estado <> '' THEN ob.estado
    WHEN ob.financiera IN ('AUTOFIN','UNIDAD DE CREDITO') AND ob.estado_eval = 'OTORGADO' THEN 'OTORGADO'
    WHEN ob.estado_credito = 'OTORGADO' OR ob.estado_eval = 'OTORGADO' THEN 'OTORGADO'
    WHEN ob.estado_eval IN ('RECHAZADO','ANULADO') THEN 'CANCELADO'
    ELSE COALESCE(ob.estado_credito, ob.estado_eval)
  END`;

const ESTADO_CARTERA_SQL = `
  COALESCE(ob.estado_cartera, CASE
    WHEN ob.estado = 'EN MORA' THEN 'MORA'
    WHEN ob.estado IN ('VIGENTE','VENCIDO','PREPAGADO','CASTIGADO') THEN ob.estado
    WHEN (ob.financiera IS NULL OR ob.financiera NOT IN ('AUTOFIN','UNIDAD DE CREDITO'))
         AND ob.estado = 'OTORGADO' THEN 'VIGENTE'
    ELSE NULL
  END)`;

// Filtro común: no anuladas.
const NO_ANULADA = `ob.estado_eval <> 'ANULADO' AND (ob.estado_credito IS NULL OR ob.estado_credito <> 'ANULADO')`;

// Catálogos de estados (para que el frontend muestre nombre + color).
// Cacheados en memoria (TTL 5 min): cambian poquísimo y los pega cada request.
let _catCache = null, _catExp = 0;
async function catalogos() {
  if (_catCache && _catExp > Date.now()) return _catCache;
  const out = { etapa: {}, cartera: {} };
  try {
    const [e] = await pool.query('SELECT codigo, nombre, color FROM estados_credito');
    for (const r of e) out.etapa[r.codigo] = { nombre: r.nombre, color: r.color };
  } catch (_) {}
  try {
    const [c] = await pool.query('SELECT codigo, nombre, color FROM estados_cartera');
    for (const r of c) out.cartera[r.codigo] = { nombre: r.nombre, color: r.color };
  } catch (_) {}
  _catCache = out; _catExp = Date.now() + 5 * 60 * 1000;
  return out;
}

// Lee un plazo (días) desde cartas_parametros (key-value); default si falta. Cache 60s.
const _paramCache = new Map();
async function paramNum(key, def) {
  const hit = _paramCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.v;
  let v = def;
  try {
    const [[r]] = await pool.query('SELECT `value` AS v FROM cartas_parametros WHERE `key` = ?', [key]);
    const n = r ? parseInt(r.v, 10) : NaN;
    v = Number.isFinite(n) ? n : def;
  } catch (_) { v = def; }
  _paramCache.set(key, { v, exp: Date.now() + 60 * 1000 });
  return v;
}

// RUT efectivo del dealer de la sesión: el del JWT, o si viene vacío, el de la
// tabla dealers por id_dealer (cuentas con id_dealer pero sin rut poblado).
async function rutEfectivo(req) {
  let rut = rutNorm(req.dealer && req.dealer.rut);
  if (!rut && req.dealer && req.dealer.id_dealer) {
    try {
      const [[d]] = await pool.query('SELECT rut FROM dealers WHERE id_dealer = ?', [req.dealer.id_dealer]);
      if (d && d.rut) rut = rutNorm(d.rut);
    } catch (_) {}
  }
  return rut;
}

// Devuelve la operación SOLO si pertenece al dealer de la sesión; si no, null.
// Es el guardia anti fuga cross-dealer de todos los endpoints /operaciones/:id.
async function opDelDealer(req, id) {
  const sc = dealerScope(req);
  if (!sc.hasScope || !id) return null;
  const [[row]] = await pool.query(
    `SELECT ob.*, ${ESTADO_SQL} AS _estado, ${ESTADO_CARTERA_SQL} AS _estado_cartera
       FROM creditos ob WHERE ob.id = ? AND ${sc.where} AND ${NO_ANULADA}`,
    [id, ...sc.params]);
  return row || null;
}

const contratado = (v) => { const s = String(v == null ? '' : v).trim(); return s !== '' && s !== '0' && Number(s) !== 0; };
const addDiasISO = (fecha, dias) => {
  if (!fecha) return null;
  const x = new Date(fecha); if (isNaN(x)) return null;
  x.setDate(x.getDate() + dias); return x.toISOString();
};

// Bitácora de acciones del dealer (fire-and-forget, nunca rompe el request).
function logDealer(req, accion, detalle) {
  try {
    const d = req.dealer || {};
    pool.query('INSERT INTO portal_dealer_log (id_dealer, id_cuenta, accion, detalle, ip) VALUES (?,?,?,?,?)',
      [d.id_dealer || null, d.id_cuenta || null, accion, String(detalle || '').slice(0, 200), clientIp(req)]).catch(() => {});
  } catch (_) {}
}

// ── GET /api/portal-dealer/resumen ─────────────────────────────────────────
exports.resumen = async (req, res) => {
  try {
    const sc = dealerScope(req);
    if (!sc.hasScope) {
      return res.json({ success: true, data: { vinculado: false, total: 0, por_estado: {}, catalogos: { etapa: {}, cartera: {} } }, error: null });
    }
    const [rows] = await pool.query(
      `SELECT t.estado, COUNT(*) AS cnt FROM (
         SELECT ${ESTADO_SQL} AS estado
         FROM creditos ob
         WHERE ${sc.where} AND ${NO_ANULADA}
       ) t GROUP BY t.estado`, sc.params);

    const por_estado = {};
    let total = 0, otorgadas = 0, canceladas = 0, en_proceso = 0;
    for (const r of rows) {
      const e = r.estado || 'SIN ESTADO';
      por_estado[e] = Number(r.cnt);
      total += Number(r.cnt);
      if (e === 'OTORGADO') otorgadas += Number(r.cnt);
      else if (['RECHAZADO', 'CANCELADO', 'DESISTIDO', 'ANULADO'].includes(e)) canceladas += Number(r.cnt);
      else en_proceso += Number(r.cnt);
    }
    return res.json({
      success: true,
      data: { vinculado: true, total, otorgadas, en_proceso, canceladas, por_estado, catalogos: await catalogos() },
      error: null,
    });
  } catch (err) {
    console.error('[portal-dealer] resumen:', err.message);
    return res.status(500).json({ success: false, data: null, error: 'No se pudo cargar el resumen.' });
  }
};

// ── GET /api/portal-dealer/operaciones?estado=&page=&limit= ─────────────────
exports.operaciones = async (req, res) => {
  try {
    const sc = dealerScope(req);
    if (!sc.hasScope) {
      return res.json({ success: true, data: { vinculado: false, rows: [], total: 0, page: 1, pages: 0 }, error: null });
    }
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const off   = (page - 1) * limit;
    const filtroEstado = String(req.query.estado || '').trim().toUpperCase();

    // El estado es una columna derivada (ESTADO_SQL); se filtra con WHERE sobre
    // la subconsulta aliada `t`, no con HAVING.
    // total (mismo scope, sin paginar) — sobre subconsulta para poder filtrar por estado calculado
    const [[cnt]] = await pool.query(
      `SELECT COUNT(*) AS total FROM (
         SELECT ${ESTADO_SQL} AS estado
         FROM creditos ob
         WHERE ${sc.where} AND ${NO_ANULADA}
       ) t ${filtroEstado ? 'WHERE t.estado = ?' : ''}`,
      filtroEstado ? [...sc.params, filtroEstado] : sc.params);

    const [rows] = await pool.query(
      `SELECT * FROM (
        SELECT
          ob.id                                                AS id,
          COALESCE(ob.numero_credito, CAST(ob.num_op AS CHAR)) AS num_op,
          ob.id_financiera,
          COALESCE(cl.nombre_completo, '')                     AS cliente_nombre,
          COALESCE(cl.rut, '')                                 AS cliente_rut,
          COALESCE(ob.financiera, 'AUTOFACIL')                 AS financiera,
          ob.tipo_vehiculo, ob.marca, ob.modelo, ob.anio, ob.patente,
          ob.fecha_otorgado, ob.monto_financiado, ob.plazo, ob.cuota,
          ob.comdea_real                                       AS comision_dealer,
          ${ESTADO_SQL}                                        AS estado,
          ${ESTADO_CARTERA_SQL}                                AS estado_cartera,
          COALESCE(ob.fecha_otorgado, ob.created_at)           AS fecha_orden
        FROM creditos ob
        LEFT JOIN clientes cl ON cl.id_cliente = ob.id_cliente
        WHERE ${sc.where} AND ${NO_ANULADA}
      ) t ${filtroEstado ? 'WHERE t.estado = ?' : ''}
      ORDER BY fecha_orden DESC, id DESC
      LIMIT ? OFFSET ?`,
      filtroEstado ? [...sc.params, filtroEstado, limit, off] : [...sc.params, limit, off]);

    return res.json({
      success: true,
      data: {
        vinculado: true,
        rows,
        total: Number(cnt.total),
        page,
        pages: Math.ceil(Number(cnt.total) / limit),
        catalogos: await catalogos(),
      },
      error: null,
    });
  } catch (err) {
    console.error('[portal-dealer] operaciones:', err.message);
    return res.status(500).json({ success: false, data: null, error: 'No se pudieron cargar las operaciones.' });
  }
};

// ── GET /api/portal-dealer/operaciones/:id ─────────────────────────────────
exports.detalle = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const ob = await opDelDealer(req, id);
    if (!ob) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada.' });
    logDealer(req, 'ver_operacion', 'Op #' + (ob.numero_credito || ob.num_op || ob.id));

    let cli = { nombre: '', rut: '' };
    if (ob.id_cliente) {
      const [[c]] = await pool.query('SELECT nombre_completo, rut FROM clientes WHERE id_cliente = ?', [ob.id_cliente]);
      if (c) cli = { nombre: c.nombre_completo || '', rut: c.rut || '' };
    }
    return res.json({
      success: true,
      data: {
        id: ob.id,
        num_op: ob.numero_credito || ob.num_op,
        id_financiera: ob.id_financiera,
        financiera: ob.financiera || 'AUTOFACIL',
        cliente_nombre: cli.nombre,
        cliente_rut: cli.rut,
        vehiculo: { tipo: ob.tipo_vehiculo, marca: ob.marca, modelo: ob.modelo, anio: ob.anio, patente: ob.patente },
        estado: ob._estado,
        estado_cartera: ob._estado_cartera,
        fecha_ingreso: ob.created_at,
        fecha_otorgado: ob.fecha_otorgado,
        fecha_primera_cuota: ob.fecha_primera_cuota,
        valor_vehiculo: ob.valor_vehiculo,
        pie: ob.pie,
        monto_financiado: ob.monto_financiado,
        plazo: ob.plazo,
        cuota: ob.cuota,
        tasa: ob.tascli_real,
        comision_dealer: ob.comdea_real,
        ejecutivo: ob.ejecutivo,
        vendedor: ob.vendedor,
        catalogos: await catalogos(),
      },
      error: null,
    });
  } catch (err) {
    console.error('[portal-dealer] detalle:', err.message);
    return res.status(500).json({ success: false, data: null, error: 'No se pudo cargar la operación.' });
  }
};

// ── GET /api/portal-dealer/operaciones/:id/fundantes ───────────────────────
// Qué antecedentes faltan y cuándo llegó cada uno (reusa el modelo de fundantes-seg).
exports.fundantes = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const ob = await opDelDealer(req, id);
    if (!ob) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada.' });

    const fin = String(ob.financiera || '').toUpperCase();
    const [tipos] = await pool.query(
      'SELECT codigo, nombre, obligatorio, requiere_contrato, orden FROM fundantes_seg_tipos WHERE UPPER(financiera) = ? ORDER BY orden', [fin]);
    const [[fs]] = await pool.query('SELECT estado, fecha_envio, fecha_validacion FROM fundantes_seg WHERE id_credito = ?', [id]);
    const [docs] = await pool.query('SELECT codigo, archivo_nombre, created_at FROM fundantes_seg_docs WHERE id_credito = ?', [id]);
    const subidos = {}; docs.forEach(d => { subidos[d.codigo] = d; });

    const lista = tipos.map(t => {
      const oblig = t.requiere_contrato ? contratado(ob[t.requiere_contrato]) : !!t.obligatorio;
      const d = subidos[t.codigo];
      return { codigo: t.codigo, nombre: t.nombre, obligatorio: oblig, recibido: !!d, fecha: d ? d.created_at : null };
    });
    const faltan = lista.filter(x => x.obligatorio && !x.recibido).length;

    return res.json({
      success: true,
      data: {
        aplica: tipos.length > 0,
        estado: (fs && fs.estado) || 'PENDIENTE',
        fecha_envio: fs ? fs.fecha_envio : null,
        fecha_validacion: fs ? fs.fecha_validacion : null,
        docs: lista,
        faltan,
      },
      error: null,
    });
  } catch (err) {
    console.error('[portal-dealer] fundantes:', err.message);
    return res.status(500).json({ success: false, data: null, error: 'No se pudieron cargar los antecedentes.' });
  }
};

// ── GET /api/portal-dealer/operaciones/:id/pago ────────────────────────────
exports.pago = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const ob = await opDelDealer(req, id);
    if (!ob) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada.' });

    const [[seg]] = await pool.query('SELECT id, saldo_precio, comision FROM postventa_seguimiento WHERE id_credito = ?', [id]);
    if (!seg) {
      return res.json({ success: true, data: { tiene: false, comision: ob.comdea_real || null, saldo_precio: ob.saldo_precio || null }, error: null });
    }
    const [et] = await pool.query(
      'SELECT track, etapa, fecha FROM postventa_etapas WHERE id_seguimiento = ? ORDER BY fecha DESC, id DESC', [seg.id]);
    const ult = {};
    for (const e of et) { if (!ult[e.track]) ult[e.track] = { etapa: e.etapa, fecha: e.fecha }; }

    return res.json({
      success: true,
      data: {
        tiene: true,
        saldo_precio: seg.saldo_precio,
        comision: seg.comision,
        saldo: ult['SALDO'] || null,
        comision_pago: ult['COMISION'] || null,
      },
      error: null,
    });
  } catch (err) {
    console.error('[portal-dealer] pago:', err.message);
    return res.status(500).json({ success: false, data: null, error: 'No se pudo cargar el estado de pago.' });
  }
};

// ── GET /api/portal-dealer/cartolas ────────────────────────────────────────
// Cartolas enviadas al dealer + plazos calculados (reparos / factura).
exports.cartolas = async (req, res) => {
  try {
    const sc = dealerScope(req);
    if (!sc.hasScope) return res.json({ success: true, data: { vinculado: false, rows: [], plazos: {} }, error: null });
    logDealer(req, 'ver_cartolas', '');

    const rut = await rutEfectivo(req);
    const [rows] = await pool.query(
      `SELECT id, mes, total_bruto, fecha_envio, nombre_dealer
       FROM cartolas_enviadas
       WHERE ? <> '' AND REPLACE(REPLACE(REPLACE(UPPER(COALESCE(rut_dealer,'')),'.',''),'-',''),' ','') = ?
       ORDER BY fecha_envio DESC LIMIT 200`, [rut, rut]);

    const plazoRep = await paramNum('plazo_reparos_dias', 5);
    const plazoFac = await paramNum('plazo_factura_dias', 10);
    const out = rows.map(r => ({
      id: r.id, mes: r.mes, total_bruto: r.total_bruto, fecha_envio: r.fecha_envio, nombre_dealer: r.nombre_dealer,
      limite_reparos: addDiasISO(r.fecha_envio, plazoRep),
      limite_factura: addDiasISO(r.fecha_envio, plazoFac),
    }));
    return res.json({ success: true, data: { vinculado: true, rows: out, plazos: { reparos: plazoRep, factura: plazoFac } }, error: null });
  } catch (err) {
    console.error('[portal-dealer] cartolas:', err.message);
    return res.status(500).json({ success: false, data: null, error: 'No se pudieron cargar las cartolas.' });
  }
};

// ── Contexto del dealer para la IA — SOLO sus datos (acotado por dealerScope) ─
async function datosDelDealer(req) {
  const sc = dealerScope(req);
  if (!sc.hasScope) return null;
  const [ops] = await pool.query(
    `SELECT COALESCE(ob.numero_credito, CAST(ob.num_op AS CHAR)) AS num_op,
            COALESCE(cl.nombre_completo,'') AS cliente, COALESCE(cl.rut,'') AS rut_cliente,
            ob.financiera, ob.marca, ob.modelo, ob.anio, ob.patente,
            DATE(ob.fecha_otorgado) AS fecha_otorgado, ob.monto_financiado, ob.plazo,
            ob.comdea_real AS comision,
            ${ESTADO_SQL} AS estado, ${ESTADO_CARTERA_SQL} AS estado_cartera
     FROM creditos ob LEFT JOIN clientes cl ON cl.id_cliente = ob.id_cliente
     WHERE ${sc.where} AND ${NO_ANULADA}
     ORDER BY COALESCE(ob.fecha_otorgado, ob.created_at) DESC LIMIT 120`, sc.params);

  const rut = await rutEfectivo(req);
  let cart = [];
  try {
    const [c] = await pool.query(
      `SELECT mes, total_bruto, DATE(fecha_envio) AS fecha_envio FROM cartolas_enviadas
       WHERE ? <> '' AND REPLACE(REPLACE(REPLACE(UPPER(COALESCE(rut_dealer,'')),'.',''),'-',''),' ','') = ?
       ORDER BY fecha_envio DESC LIMIT 24`, [rut, rut]);
    cart = c;
  } catch (_) {}
  return { dealer: (req.dealer && req.dealer.nombre) || 'Dealer', operaciones: ops, cartolas: cart };
}

// ── POST /api/portal-dealer/ia ─────────────────────────────────────────────
// Asistente conversacional acotado: NO genera SQL; Claude solo ve los datos
// del propio dealer (ya filtrados). Imposible exponer datos de otro dealer.
exports.ia = async (req, res) => {
  try {
    const pregunta = String((req.body && req.body.pregunta) || '').trim();
    if (!pregunta) return res.status(400).json({ success: false, data: null, error: 'Escribe tu pregunta.' });
    if (pregunta.length > 500) return res.status(400).json({ success: false, data: null, error: 'La pregunta es muy larga.' });

    if (!(await ia.iaActiva(CODIGO_IA))) {
      return res.json({ success: true, data: { disponible: false, respuesta: 'El asistente con IA no está disponible por ahora. Puedes escribirle a tu ejecutivo desde la pestaña Chat.' }, error: null });
    }
    const sc = dealerScope(req);
    if (!sc.hasScope) {
      return res.json({ success: true, data: { disponible: true, respuesta: 'Tu cuenta está en validación; aún no puedo consultar tus operaciones.' }, error: null });
    }

    // Cuota diaria por dealer (configurable; 0 = sin límite). Clamp defensivo.
    const limite = Math.max(0, Math.min(200, await paramNum('dealer_ia_limite_dia', 15)));
    const idd = req.dealer.id_dealer || null;
    const idc = req.dealer.id_cuenta || null;
    const [[u]] = await pool.query(
      `SELECT COUNT(*) AS c FROM portal_ia_uso
       WHERE DATE(ts)=CURDATE() AND ((? IS NOT NULL AND id_dealer=?) OR (? IS NOT NULL AND id_cuenta=?))`,
      [idd, idd, idc, idc]);
    if (limite > 0 && Number(u.c) >= limite) {
      return res.json({ success: true, data: { disponible: true, respuesta: `Llegaste al máximo de ${limite} preguntas por hoy. Puedes seguir mañana o escribirle a tu ejecutivo.`, restantes: 0 }, error: null });
    }

    // Reservar el cupo ANTES de llamar a la IA: cierra la ventana de carrera
    // (dos requests paralelas) y controla costo aunque la llamada falle.
    await pool.query('INSERT INTO portal_ia_uso (id_dealer, id_cuenta, rut, pregunta) VALUES (?,?,?,?)',
      [idd, idc, await rutEfectivo(req), pregunta.slice(0, 500)]);
    const restantes = limite > 0 ? Math.max(0, limite - Number(u.c) - 1) : null;

    const ctx = await datosDelDealer(req);
    const system = `Eres el asistente virtual de AutoFácil para el dealer "${ctx.dealer}". Respondes ÚNICAMENTE con la información provista (las operaciones y cartolas de ESTE dealer). Si la respuesta no está en los datos, dilo con claridad y sugiere escribir al ejecutivo. Nunca inventes datos ni menciones a otros dealers ni a otros clientes. Responde en español, en tono cercano, breve y claro. Los montos están en pesos chilenos.`;
    const prompt = `Datos del dealer (JSON):\n${JSON.stringify(ctx)}\n\nPregunta del dealer: ${pregunta}`;

    let r;
    try {
      r = await anthropic.analizar({ codigo: CODIGO_IA, system, prompt, max_tokens: 900, id_usuario: null });
    } catch (e) {
      if (e.code === 'IA_OFF') return res.json({ success: true, data: { disponible: false, respuesta: 'El asistente con IA no está disponible por ahora.' }, error: null });
      throw e;
    }

    return res.json({ success: true, data: { disponible: true, respuesta: r.texto || 'No tengo una respuesta para eso.', restantes }, error: null });
  } catch (err) {
    console.error('[portal-dealer] ia:', err.message);
    return res.status(500).json({ success: false, data: null, error: 'No pude responder en este momento.' });
  }
};

/* ── GET /api/portal-dealer/simulador?monto=X — simulador rápido de cuotas ──
   Motor único shared/cotizador.js (mismo cálculo del módulo Cotizaciones). */
exports.simulador = async (req, res) => {
  try {
    const { simuladorRapido } = require('../../../../shared/cotizador');
    const data = await simuladorRapido(req.query.monto);
    if (!data) return res.status(400).json({ success: false, data: null, error: 'Monto inválido (entre $1.000.000 y $300.000.000)' });
    return res.json({ success: true, data, error: null });
  } catch (err) {
    console.error('[portal-dealer] simulador:', err.message);
    return res.status(500).json({ success: false, data: null, error: 'Error al simular' });
  }
};

/* ═══════════════════════════════════════════════════════════════════════════
   PRE-APROBACIÓN — el dealer evalúa a su cliente en línea.
   Evalúa con las MISMAS fuentes internas (renta líquida de antecedentes,
   informes comerciales, política por año de vehículo, elegibilidad AutoFin
   del Cuadro Preferencia Financiera) y el MOTOR ÚNICO de cuota
   (shared/cotizador.cotizarCuota). Al dealer NUNCA se le exponen los datos
   del cliente: solo el veredicto y las cuotas. El detalle interno viaja por
   correo al Jefe Comercial cuando el dealer pide contacto.
   ═══════════════════════════════════════════════════════════════════════════ */
const AF_RUT = require('../../../../api-gateway/public/js/rut-core');

require('../../../../shared/migrate').enFila('portal', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS portal_preaprobaciones (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_dealer INT NULL,
        rut_dealer VARCHAR(15) NULL,
        dealer_nombre VARCHAR(200) NULL,
        rut_cliente VARCHAR(15) NOT NULL,
        precio BIGINT NOT NULL,
        pie BIGINT NOT NULL,
        anio SMALLINT NOT NULL,
        resultado VARCHAR(12) NOT NULL,
        motivos TEXT NULL,
        opciones TEXT NULL,
        contacto TINYINT(1) NOT NULL DEFAULT 0,
        renta BIGINT NULL,
        fuente_renta VARCHAR(10) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_dealer (id_dealer), INDEX idx_rut (rut_cliente)
      )`);
    await pool.query('ALTER TABLE portal_preaprobaciones ADD COLUMN IF NOT EXISTS renta BIGINT NULL, ADD COLUMN IF NOT EXISTS fuente_renta VARCHAR(10) NULL');
    // Repositorio único de preaprobaciones (v100.9): correlativo PREaammxxx + canal +
    // checklist de parámetros + informe IA + informes DealerNet usados
    await pool.query(`ALTER TABLE portal_preaprobaciones
      ADD COLUMN IF NOT EXISTS codigo VARCHAR(12) NULL,
      ADD COLUMN IF NOT EXISTS canal VARCHAR(10) NOT NULL DEFAULT 'PORTAL',
      ADD COLUMN IF NOT EXISTS checklist JSON NULL,
      ADD COLUMN IF NOT EXISTS ia_informe_id INT NULL,
      ADD COLUMN IF NOT EXISTS ia_nivel_riesgo VARCHAR(10) NULL,
      ADD COLUMN IF NOT EXISTS informes JSON NULL`);
    await pool.query('ALTER TABLE portal_preaprobaciones ADD UNIQUE INDEX idx_codigo (codigo)').catch(() => {});
    // WhatsApp puede no traer precio/pie/año (preevaluación por RUT) — MODIFY una vez (migrarAuto)
    require('../../../../shared/migrate').migrarAuto('preaprob_nullable_fix', async () => {
      await pool.query('ALTER TABLE portal_preaprobaciones MODIFY precio BIGINT NULL, MODIFY pie BIGINT NULL, MODIFY anio SMALLINT NULL').catch(() => {});
    });
    // Funcionalidad del repositorio (página interna /preaprobaciones/, bajo Evaluación Crediticia)
    const [[exF]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='preaprob_repo' LIMIT 1");
    let idF = exF?.id_funcionalidad;
    if (!idF) {
      const [insF] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (390001,'Repositorio de Preaprobaciones','preaprob_repo','/preaprobaciones/','bi-journal-check')");
      idF = insF.insertId;
    }
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    if (adm) await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [adm.id_perfil, idF]);
  } catch (e) { console.error('[preaprobacion migration]', e.message); }
});

// Grilla por defecto del Cuadro Preferencia Financiera (misma semilla del
// mantenedor de Cartas; si existe en cartas_parametros, manda la BD).
const PREF_DEFAULT = [
  { cd: 12, ch: 15, sd: '2000000', sh: '3999999', af: 'NO' }, { cd: 12, ch: 15, sd: '4000000', sh: '200 UF', af: 'SI' },
  { cd: 12, ch: 15, sd: '200 UF', sh: '18000000', af: 'NO' }, { cd: 16, ch: 24, sd: '2000000', sh: '3999999', af: 'NO' },
  { cd: 16, ch: 24, sd: '4000000', sh: '200 UF', af: 'SI' }, { cd: 16, ch: 24, sd: '200 UF', sh: '18000000', af: 'NO' },
  { cd: 25, ch: 36, sd: '2000000', sh: '18000000', af: 'SI' }, { cd: 25, ch: 36, sd: '18000001', sh: 'SIN TOPE', af: 'SI' },
  { cd: 37, ch: 48, sd: '2000000', sh: 'SIN TOPE', af: 'SI' },
];
function limitePref(tok, uf, esPiso) {
  const s = String(tok || '').trim().toUpperCase();
  if (!s) return esPiso ? 0 : Infinity;
  if (s === 'SIN TOPE') return Infinity;
  if (s.endsWith('UF')) { const n = parseFloat(s); return uf ? n * uf : (esPiso ? 0 : Infinity); }
  const n = parseFloat(s.replace(/\./g, ''));
  return isNaN(n) ? (esPiso ? 0 : Infinity) : n;
}
async function autofinElegible(plazo, saldo, uf) {
  let grilla = PREF_DEFAULT;
  try {
    const [[row]] = await pool.query("SELECT `value` FROM cartas_parametros WHERE `key`='preferencia_financiera' LIMIT 1");
    if (row) { const g = JSON.parse(row.value); if (Array.isArray(g) && g.length) grilla = g; }
  } catch (e) { /* grilla default */ }
  const fila = grilla.find(f => plazo >= f.cd && plazo <= f.ch
    && saldo >= limitePref(f.sd, uf, true) && saldo <= limitePref(f.sh, uf, false));
  return fila ? String(fila.af).toUpperCase() === 'SI' : false;
}

const fmtCLP = n => '$' + Math.round(+n || 0).toLocaleString('es-CL');

// POST /api/portal-dealer/preaprobacion  { rut, precio, pie, anio }
exports.preaprobar = async (req, res) => {
  try {
    // Políticas paramétricas (mantenedor Políticas de Preaprobación) — motor único
    const { getPoliticas } = require('../../../../shared/preaprobacion-politicas');
    const POL = await getPoliticas();
    const rut = AF_RUT.normalizar(req.body.rut);
    const precio = Math.round(+req.body.precio || 0);
    const pie = Math.round(+req.body.pie || 0);
    const anio = parseInt(req.body.anio) || 0;
    const hoyAnio = new Date().getFullYear();
    if (!rut || AF_RUT.validar(rut) !== true) return res.status(400).json({ success: false, data: null, error: 'RUT inválido' });
    if (!(precio >= POL.precio_min && precio <= POL.precio_max)) return res.status(400).json({ success: false, data: null, error: 'Precio inválido' });
    if (!(pie >= 0 && pie < precio)) return res.status(400).json({ success: false, data: null, error: 'Pie inválido' });
    if (!(anio >= 1990 && anio <= hoyAnio + 1)) return res.status(400).json({ success: false, data: null, error: 'Año inválido' });

    const motivos = [];        // privados (datos del cliente — solo correo interno)
    const motivosPub = [];     // públicos (condiciones de la operación — se muestran al dealer)
    const saldo = precio - pie;
    const rutLimpio = rut.replace(/[.\-\s]/g, '');

    // 1) Antigüedad del vehículo — política de aprobación (sin marca: criterio general USADO)
    const antig = hoyAnio - anio;
    let antigMax = POL.antiguedad_max_default;
    try {
      const [pm] = await pool.query("SELECT MAX(antiguedad_vehiculo_max) mx FROM politica_aprobacion_matriz WHERE condicion='USADO'");
      if (pm[0] && pm[0].mx != null) antigMax = parseInt(pm[0].mx) || POL.antiguedad_max_default;
    } catch (e) { /* default del mantenedor */ }
    if (antig > antigMax) motivosPub.push('El vehículo año ' + anio + ' supera la antigüedad máxima financiable (' + antigMax + ' años)');

    // 2) Renta líquida: para el ANÁLISIS manda SIEMPRE la que informa el dealer
    //    (regla de negocio 2026-07-06); la interna es respaldo si no declara y
    //    referencia para el Jefe Comercial cuando difieren.
    const rentaDeclarada = Math.round(+req.body.renta || 0);
    const [[ant]] = await pool.query(
      "SELECT renta_fija_liquida FROM antecedentes_laborales WHERE REPLACE(REPLACE(REPLACE(rut_cliente,'.',''),'-',''),' ','')=? LIMIT 1", [rutLimpio]);
    const rentaInterna = ant ? +ant.renta_fija_liquida || 0 : 0;
    const renta = rentaDeclarada || rentaInterna;
    const fuenteRenta = rentaDeclarada ? 'DECLARADA' : (rentaInterna ? 'INTERNA' : null);
    if (!renta) motivos.push('Sin renta líquida (ni declarada por el dealer ni antecedentes internos)');
    // Nota informativa (NO bloquea): declarada vs interna difieren >20%
    const notas = [];
    if (rentaDeclarada && rentaInterna && Math.abs(rentaDeclarada - rentaInterna) > rentaInterna * (POL.tolerancia_renta_pct / 100))
      notas.push('Nota: renta declarada (' + fmtCLP(rentaDeclarada) + ') difiere de la interna (' + fmtCLP(rentaInterna) + ') — verificar liquidaciones');

    // 3) Informes comerciales limpios — el informe DealerNet ES la fuente:
    //    primero se traen los informes (paso 5 adelantado: informesEIA), se sincroniza
    //    informacion_comercial desde el informe cód. 16 (motor único de evaluación
    //    crediticia) y los protestos se leen de los informes. "El informe dice que no
    //    hay protestos" = 0 protestos (cumple), no "sin dato".
    const { guardarPreaprobacion, informesEIA, protestosDealernet } = require('../../../../shared/preaprobacion-repo');
    const dn = await informesEIA(rut, POL);
    try { await require('../../../evaluacion-crediticia/src/controllers/evaluacion.controller').sincronizarComercialDealernet(rut); } catch (_) {}
    let protDN = null;
    try { const pd = await protestosDealernet(rut); if (pd) protDN = pd.cantidad; } catch (_) {}

    const [[ic]] = await pool.query(
      "SELECT protestos_vigentes_q, deuda_morosa, deuda_vencida, deuda_castigada FROM informacion_comercial WHERE REPLACE(REPLACE(REPLACE(rut_cliente,'.',''),'-',''),' ','')=? LIMIT 1", [rutLimpio]);
    // Valores efectivos: interno si existe, si no el derivado del informe DealerNet.
    const protestos = (ic && ic.protestos_vigentes_q != null) ? +ic.protestos_vigentes_q : protDN;
    const dMorosa   = (ic && ic.deuda_morosa    != null) ? +ic.deuda_morosa    : null;
    const dVencida  = (ic && ic.deuda_vencida   != null) ? +ic.deuda_vencida   : null;
    const dCastig   = (ic && ic.deuda_castigada != null) ? +ic.deuda_castigada : null;
    if (protestos != null && protestos > POL.max_protestos) motivos.push('Protestos vigentes: ' + protestos);
    if (dMorosa  != null && dMorosa  > POL.max_deuda_morosa)    motivos.push('Deuda morosa: ' + fmtCLP(dMorosa));
    if (dVencida != null && dVencida > POL.max_deuda_vencida)   motivos.push('Deuda vencida: ' + fmtCLP(dVencida));
    if (dCastig  != null && dCastig  > POL.max_deuda_castigada) motivos.push('Deuda castigada: ' + fmtCLP(dCastig));

    // 4) Cuotas con el MOTOR ÚNICO + elegibilidad AutoFin + carga ≤30% renta
    const { cotizarCuota } = require('../../../../shared/cotizador');
    const { getUF } = require('../../../../shared/uf');
    const uf = await getUF(new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' }));
    const opciones = [];
    if (!motivos.length && !motivosPub.length) {
      const topeCuota = renta * (POL.carga_max_pct / 100);
      let algunaElegible = false;
      for (const n of POL.plazosArr) {
        const c = await cotizarCuota(precio, pie, n);
        if (!c) continue;
        if (!(await autofinElegible(n, saldo, uf))) continue;
        algunaElegible = true;
        if (c.cuota <= topeCuota) opciones.push({ plazo: n, cuota: c.cuota });
      }
      if (!algunaElegible) motivosPub.push('El monto a financiar (' + fmtCLP(saldo) + ') está fuera del rango elegible para esta línea');
      else if (!opciones.length) motivos.push('Cuota supera el ' + POL.carga_max_pct + '% de la renta líquida en todos los plazos elegibles (tope ' + fmtCLP(topeCuota) + ')');
    }

    // 5) REPORTE IA (regla: SIN INFORME IA NO HAY APROBACIÓN) + severidad DealerNet
    //    contra el umbral — mismos criterios que WhatsApp. (dn ya se trajo en el paso 3.)
    const SEV = ['bueno', 'regular', 'malo', 'grave'];
    if (!dn.ia_informe_id) motivos.push('Sin informe IA: ' + (dn.error || 'no disponible') + ' — no hay aprobación sin análisis crediticio');
    if (dn.peorSeveridad && SEV.indexOf(dn.peorSeveridad) > Math.max(0, SEV.indexOf(POL.wsp_severidad_max)))
      motivos.push('Severidad DealerNet ' + dn.peorSeveridad + ' supera el máximo permitido (' + POL.wsp_severidad_max + ')');

    const resultado = (!motivos.length && !motivosPub.length && opciones.length) ? 'PREAPROBADO' : 'REVISION';
    const motivosTodos = motivosPub.concat(motivos, notas);

    // Checklist de cumplimiento de CADA parámetro (queda en el repositorio)
    const checklist = [
      { criterio: 'Precio dentro de rango', valor: precio, limite: POL.precio_min + '–' + POL.precio_max, cumple: precio >= POL.precio_min && precio <= POL.precio_max },
      { criterio: 'Antigüedad del vehículo', valor: antig + ' años', limite: antigMax + ' años', cumple: antig <= antigMax },
      { criterio: 'Renta líquida disponible', valor: renta || 0, limite: '> 0 (' + (fuenteRenta || 'sin fuente') + ')', cumple: !!renta },
      // Valores efectivos (interno → informe DealerNet). null = de verdad sin dato, no falla.
      { criterio: 'Protestos vigentes', valor: protestos, limite: '≤ ' + POL.max_protestos, cumple: protestos == null || protestos <= POL.max_protestos },
      { criterio: 'Deuda morosa', valor: dMorosa, limite: '≤ ' + POL.max_deuda_morosa, cumple: dMorosa == null || dMorosa <= POL.max_deuda_morosa },
      { criterio: 'Deuda vencida', valor: dVencida, limite: '≤ ' + POL.max_deuda_vencida, cumple: dVencida == null || dVencida <= POL.max_deuda_vencida },
      { criterio: 'Deuda castigada', valor: dCastig, limite: '≤ ' + POL.max_deuda_castigada, cumple: dCastig == null || dCastig <= POL.max_deuda_castigada },
      { criterio: 'Cuota ≤ ' + POL.carga_max_pct + '% de la renta', valor: opciones.length + ' plazos caben', limite: 'al menos 1', cumple: opciones.length > 0 },
      { criterio: 'Severidad DealerNet', valor: dn.peorSeveridad, limite: '≤ ' + POL.wsp_severidad_max, cumple: !!dn.peorSeveridad && SEV.indexOf(dn.peorSeveridad) <= Math.max(0, SEV.indexOf(POL.wsp_severidad_max)) },
      { criterio: 'Informe IA generado', valor: dn.ia_nivel_riesgo || null, limite: 'obligatorio', cumple: !!dn.ia_informe_id },
    ];

    const { id, codigo } = await guardarPreaprobacion({
      canal: 'PORTAL',
      id_dealer: req.dealer && req.dealer.id_dealer || null, rut_dealer: req.dealer && req.dealer.rut || null,
      dealer_nombre: (req.dealer && (req.dealer.nombre || req.dealer.dealer)) || null,
      rut_cliente: rut, precio, pie, anio, resultado,
      motivos: motivosTodos.join(' | ') || null, opciones, renta: renta || null, fuente_renta: fuenteRenta,
      checklist, ia_informe_id: dn.ia_informe_id, ia_nivel_riesgo: dn.ia_nivel_riesgo, informes: dn.informes,
    });

    // Al dealer: SOLO veredicto, cuotas y correlativo — nunca el detalle del cliente
    return res.json({ success: true, data: { id, codigo, resultado, opciones, motivos: motivosPub }, error: null });
  } catch (err) {
    console.error('[portal-dealer] preaprobar:', err.message);
    return res.status(500).json({ success: false, data: null, error: 'No pude evaluar en este momento' });
  }
};

// POST /api/portal-dealer/preaprobacion/:id/contactar — pide ejecutivo:
// responde disponibilidad real y avisa por correo al Jefe Comercial.
exports.preaprobacionContactar = async (req, res) => {
  try {
    const [[pre]] = await pool.query('SELECT * FROM portal_preaprobaciones WHERE id=? LIMIT 1', [parseInt(req.params.id) || 0]);
    if (!pre) return res.status(404).json({ success: false, data: null, error: 'Evaluación no encontrada' });
    // Pertenencia: solo el dealer que la creó puede pedir contacto
    const dj = req.dealer || {};
    const mia = (pre.id_dealer && dj.id_dealer && Number(pre.id_dealer) === Number(dj.id_dealer))
             || (pre.rut_dealer && dj.rut && String(pre.rut_dealer) === String(dj.rut));
    if (!mia) return res.status(403).json({ success: false, data: null, error: 'Evaluación de otro dealer' });
    await pool.query('UPDATE portal_preaprobaciones SET contacto=1 WHERE id=?', [pre.id]);

    // Disponibilidad real: presencia (heartbeat) + conversaciones de chat activas
    const { conectadosIds } = require('../../../../shared/presencia');
    const vivos = conectadosIds();
    const [ejes] = await pool.query(
      `SELECT u.id_usuario FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
       WHERE u.estado='activo' AND p.nombre IN ('Ejecutivo','Ejecutivo Comercial')`);
    const conectados = ejes.filter(e => vivos.has(Number(e.id_usuario)));
    let ocupados = new Set();
    try {
      const [act] = await pool.query("SELECT id_ejecutivo, COUNT(*) c FROM ar_conversaciones WHERE estado='ACTIVA' GROUP BY id_ejecutivo");
      ocupados = new Set(act.filter(a => +a.c >= 3).map(a => Number(a.id_ejecutivo)));
    } catch (e) { /* sin chat activo */ }
    const desocupados = conectados.filter(e => !ocupados.has(Number(e.id_usuario)));

    // Correo al Jefe Comercial con el DETALLE COMPLETO (uso interno)
    try {
      const { enviarCorreo, envolverHTML } = require('../../../../shared/mailer');
      const [jefes] = await pool.query(
        `SELECT u.email FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
         WHERE u.estado='activo' AND p.nombre='Jefe Comercial' AND u.email IS NOT NULL`);
      if (jefes.length) {
        const ops = JSON.parse(pre.opciones || '[]');
        const html = envolverHTML(`
          <h2 style="margin:0 0 8px">Pre-aprobación desde el Portal del Dealer</h2>
          <p>El dealer pidió contacto con un ejecutivo. Detalle para seguimiento:</p>
          <table cellpadding="6" style="border-collapse:collapse;font-size:14px">
            <tr><td><b>Dealer</b></td><td>${pre.dealer_nombre || pre.rut_dealer || '—'}</td></tr>
            <tr><td><b>RUT cliente</b></td><td>${pre.rut_cliente}</td></tr>
            <tr><td><b>Precio vehículo</b></td><td>${fmtCLP(pre.precio)} (año ${pre.anio})</td></tr>
            <tr><td><b>Pie</b></td><td>${fmtCLP(pre.pie)}</td></tr>
            <tr><td><b>Saldo a financiar</b></td><td>${fmtCLP(pre.precio - pre.pie)}</td></tr>
            ${pre.renta ? '<tr><td><b>Renta líquida</b></td><td>' + fmtCLP(pre.renta) + ' (' + (pre.fuente_renta === 'INTERNA' ? 'antecedentes internos' : 'DECLARADA por el dealer — verificar') + ')</td></tr>' : ''}
            <tr><td><b>Resultado</b></td><td><b>${pre.resultado}</b></td></tr>
            ${ops.length ? '<tr><td><b>Cuotas ofrecidas</b></td><td>' + ops.map(o => o.plazo + ' cuotas de ' + fmtCLP(o.cuota)).join(' · ') + '</td></tr>' : ''}
            ${pre.motivos ? '<tr><td><b>Motivos revisión</b></td><td>' + pre.motivos + '</td></tr>' : ''}
            <tr><td><b>Ejecutivos conectados</b></td><td>${conectados.length} (${desocupados.length} desocupados)</td></tr>
          </table>`);
        await enviarCorreo({
          to: jefes.map(j => j.email).join(','),
          subject: 'Pre-aprobación ' + pre.resultado + ' — dealer ' + (pre.dealer_nombre || pre.rut_dealer || '') + ' pide ejecutivo',
          html,
        });
      }
    } catch (e) { console.error('[preaprobacion mail]', e.message); }

    return res.json({ success: true, data: { conectados: conectados.length, desocupados: desocupados.length }, error: null });
  } catch (err) {
    console.error('[portal-dealer] preaprobacionContactar:', err.message);
    return res.status(500).json({ success: false, data: null, error: 'No pude gestionar el contacto' });
  }
};

/* ── GET /api/portal-dealer/preaprobaciones?q= — repositorio (uso interno) ──
   Busca por correlativo PREaammxxx, RUT del cliente o nombre del dealer. */
exports.listarPreaprobaciones = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toUpperCase().replace(/\./g, '');
    let where = '1=1'; const params = [];
    if (q) {
      where = `(UPPER(COALESCE(codigo,'')) LIKE ? OR REPLACE(UPPER(rut_cliente),'.','') LIKE ?
                OR UPPER(COALESCE(dealer_nombre,'')) LIKE ? OR REPLACE(UPPER(COALESCE(rut_dealer,'')),'.','') LIKE ?)`;
      const like = '%' + q + '%';
      params.push(like, like, like, like);
    }
    // Filtros del repositorio: rango de fechas, resultado, RUT cliente y N° PREaammxxx
    const desde = String(req.query.desde || '').slice(0, 10);
    const hasta = String(req.query.hasta || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(desde)) { where += ' AND created_at >= ?'; params.push(desde); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(hasta)) { where += ' AND created_at < DATE_ADD(?, INTERVAL 1 DAY)'; params.push(hasta); }
    if (req.query.resultado) { where += ' AND resultado = ?'; params.push(String(req.query.resultado).toUpperCase().trim()); }
    if (req.query.rut) { where += " AND REPLACE(UPPER(rut_cliente),'.','') LIKE ?"; params.push('%' + String(req.query.rut).toUpperCase().replace(/\./g, '') + '%'); }
    if (req.query.codigo) { where += " AND UPPER(COALESCE(codigo,'')) LIKE ?"; params.push('%' + String(req.query.codigo).toUpperCase().trim() + '%'); }
    const [rows] = await pool.query(
      `SELECT p.id, p.codigo, p.canal, p.created_at, p.id_dealer, p.rut_dealer, p.dealer_nombre, p.rut_cliente,
              p.precio, p.pie, p.anio, p.resultado, p.motivos, p.opciones, p.renta, p.fuente_renta, p.contacto,
              p.checklist, p.ia_informe_id, p.ia_nivel_riesgo, p.informes,
              cl.nombre_completo AS cliente_nombre
         FROM portal_preaprobaciones p
         LEFT JOIN clientes cl ON cl.rut = p.rut_cliente
        WHERE ${where}
        ORDER BY p.id DESC LIMIT 300`, params);
    res.json({ success: true, data: rows, error: null });
  } catch (err) {
    console.error('[portal-dealer] listarPreaprobaciones:', err.message);
    return res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};
