'use strict';
/**
 * Portal del Dealer — backend read-only.
 * Cada handler usa SIEMPRE el dealer de la sesión (req.dealer del JWT, vía
 * verifyDealer de atención-remota). Un dealer JAMÁS ve datos de otro: todo
 * SELECT se acota por id_dealer / rut_dealer normalizado del token.
 * Fase 1: resumen (KPIs) + operaciones (listado).
 */
const pool = require('../../../../shared/config/database');

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
async function catalogos() {
  const out = { etapa: {}, cartera: {} };
  try {
    const [e] = await pool.query('SELECT codigo, nombre, color FROM estados_credito');
    for (const r of e) out.etapa[r.codigo] = { nombre: r.nombre, color: r.color };
  } catch (_) {}
  try {
    const [c] = await pool.query('SELECT codigo, nombre, color FROM estados_cartera');
    for (const r of c) out.cartera[r.codigo] = { nombre: r.nombre, color: r.color };
  } catch (_) {}
  return out;
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

    let extra = '', extraParams = [];
    if (filtroEstado) { extra = ` HAVING estado = ?`; extraParams = [filtroEstado]; }

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
