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

const CODIGO_IA = 'dealer_ia';

// ── Migración: feature IA del portal (nace DESACTIVADA) + log de uso ────────
(async () => {
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
  } catch (e) { console.error('[portal-dealer] migracion ia:', e.message); }
})();

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
