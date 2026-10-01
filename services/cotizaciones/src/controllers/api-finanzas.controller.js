'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   API PÚBLICA "Suite Financiera" (Pato, 10-09-2026) — solo lectura, X-API-Key.

   Juan Manuel (Gerente de Finanzas) mantiene una app propia de finanzas y la
   conecta ACÁ en vez de reconstruir los informes: cada endpoint envuelve el MISMO
   handler que usa la pantalla de la Suite (un solo motor), así el balance que ve
   JM por API es idéntico al de Contabilidad → Balance.

   Endpoints (todos GET, base /api/publica/v1/finanzas):
     /libro-mayor?cuenta=&desde=&hasta=        → Contabilidad → Libro Mayor (una cuenta)
     /libro-mayor-completo?desde=&hasta=       → todas las cuentas del período
     /balance?desde=&hasta=                    → Balance 8 columnas
     /libro-compras?desde=&hasta=[&q=&cuenta=] → auxiliar de compras (facturas recibidas)
     /libro-ventas?desde=&hasta=[&q=&cuenta=]  → auxiliar de ventas (facturas emitidas)
     /ordenes-pago?[desde=&hasta=&estado=&origen=&q=] → historial de Órdenes de Pago
     /rentabilidad?mes=YYYY-MM                 → detalle por operación otorgada (Dashboard → Rentabilidades)
     /saldo-proceso-pago?[q=&estado=&todo=1]   → Tesorería → Saldo Precio en Proceso de Pago
     /comisiones-facturas?desde=&hasta=        → factura/boleta de comisión ↔ operaciones que cubre + ODP (informe propio)
     /provisiones-liberaciones?desde=&hasta=[&concepto=] → provisiones liberadas: motivo, fecha, contra qué, comprobante

   El handler original se invoca con un `req.usuario` sintético (perfil API) y un
   `res` interceptado, para que la respuesta salga con el sobre uniforme y quede
   trazada la empresa que consultó. Nunca escribe nada.
   ═══════════════════════════════════════════════════════════════════════════ */

/* Ejecuta un handler (req,res) existente y devuelve lo que respondió, sin tocar la BD. */
function envolver(handler, opts = {}) {
  return async function (req, res) {
    const cli = req.apiCliente || {};
    req.usuario = { id_usuario: null, nombre: 'API', apellido: cli.empresa || '', email: null, perfil: 'API', perfil_nombre: 'API' };
    let status = 200, cuerpo = null;
    const fake = {
      status(c) { status = c; return fake; },
      json(o) { cuerpo = o; return fake; },
      send(o) { cuerpo = typeof o === 'string' ? { success: false, data: null, error: o } : o; return fake; },
      set() { return fake; }, setHeader() { return fake; }, end() { return fake; },
    };
    try {
      await handler(req, fake);
      if (cuerpo && opts.transformar) cuerpo = opts.transformar(cuerpo, req);
      return res.status(status).json(cuerpo == null ? { success: false, data: null, error: 'Sin respuesta' } : cuerpo);
    } catch (e) {
      console.error('[api finanzas]', e.message);
      return res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
    }
  };
}

const ctb = () => require('../../../contabilidad/src/controllers/contabilidad.controller');
const odp = () => require('../../../ordenes-pago/src/controllers/ordenes-pago.controller');
const dash = () => require('../../../dashboard/src/controllers/dashboard.controller');
const teso = () => require('../../../tesoreria/src/controllers/saldo-proceso-pago.controller');

const libroMayor         = envolver((req, res) => ctb().libroMayor(req, res));
const libroMayorCompleto = envolver((req, res) => ctb().libroMayorCompleto(req, res));
const balance            = envolver((req, res) => ctb().balance(req, res));
const libroCompras       = envolver((req, res) => ctb().listaComprasAux(req, res));
const libroVentas        = envolver((req, res) => ctb().listaVentasAux(req, res));
const ordenesPago        = envolver((req, res) => odp().listarOrdenes(req, res));
const saldoProcesoPago   = envolver((req, res) => teso().listar(req, res));

/* Rentabilidad por operación: mismas filas que el Dashboard → Rentabilidades (getDatos.raw),
   acotadas al mes pedido y a las columnas del detalle.
   Nombre publicado ← campo de getDatos.raw (antes se pedían nombres que raw no tiene
   y num_op, ingreso AutoFácil, comisiones dealer/seguros e ingreso bruto no salían — hilo 60001). */
const COLS_RENT = [['num_op', 'op'], 'id_financiera', 'mes', 'fecha_otorgado', 'financiera', 'producto', 'ejecutivo', 'automotora', 'rut_dealer', 'parque',
  'nombre_cliente', 'rut_cliente', 'saldo_precio', 'monto_financiado', 'plazo', ['tasa_mensual', 'tasa_cli'], 'mayor_menor', 'institucion',
  ['ingreso_autofacil', 'rentab_afa'], ['comision_dealer', 'com_dealer'], 'com_parque', ['comision_seguros', 'com_seguros'],
  'total_com_broke', 'ingreso_bruto', 'ingreso_neto_total', 'estado_credito'].map(c => Array.isArray(c) ? c : [c, c]);
const rentabilidad = envolver((req, res) => dash().getDatos(req, res), {
  transformar(cuerpo, req) {
    if (!cuerpo || !Array.isArray(cuerpo.raw)) return cuerpo;
    const mes = /^\d{4}-\d{2}$/.test(String(req.query.mes || '')) ? req.query.mes : null;
    const filas = cuerpo.raw
      .filter(r => String(r.estado || r.estado_credito || '').toUpperCase() === 'OTORGADO')
      .filter(r => !mes || String(r.mes || r.fecha_otorgado || '').slice(0, 7) === mes)
      .map(r => { const o = {}; for (const [k, src] of COLS_RENT) if (src in r) o[k] = r[src]; return o; });
    return { success: true, data: { mes: mes || 'todos', total: filas.length, generado_en: cuerpo.generado_en, operaciones: filas }, error: null };
  },
});

/* ── Informes propios de la API (Pato, 01-10-2026 — hilo 90001, cierre de provisiones dealer) ──────────
   No hay pantalla que los entregue tal cual: cruzan lo que ya registra Post Venta (factura titular +
   réplicas, orden de pago del correlativo) y lo que dejó escrito el motor de provisiones. Solo SELECT. */
const pool = require('../../../../shared/config/database');
const { hoyISO } = require('../../../../shared/fecha-chile');
const FECHA_RX = /^\d{4}-\d{2}-\d{2}$/;
const rango = (req, desdeDef) => {
  const desde = String(req.query.desde || desdeDef), hasta = String(req.query.hasta || hoyISO());
  if (!FECHA_RX.test(desde) || !FECHA_RX.test(hasta) || desde > hasta) return null;
  return { desde, hasta };
};
const estadoOdp = o => !o ? 'SIN_ODP' : Number(o.anulada) ? 'ANULADA' : Number(o.pagada) ? 'PAGADA' : 'EMITIDA';
/* Correlativo vigente de cada origen: el no anulado más reciente; si todos están anulados, el último. */
async function correlativos(origen, campo, ids) {
  const m = new Map();
  if (!ids.length) return m;
  const [rows] = await pool.query(
    `SELECT id, numero, origen_id, anulada, pagada, DATE_FORMAT(created_at,'%Y-%m-%d') f_emision, DATE_FORMAT(fecha_pagada,'%Y-%m-%d') f_pago
       FROM op_correlativos WHERE ${origen ? 'origen=? AND origen_id' : 'id'} IN (?) ORDER BY anulada DESC, id ASC`, origen ? [origen, ids] : [ids]);
  for (const r of rows) m.set(Number(r[campo]), r);   // el último que se escribe gana: no anulado y más reciente
  return m;
}

/* GET /comisiones-facturas?desde=&hasta= — una fila por operación cubierta por un documento de comisión.
   DEALER: factura/boleta registrada en Post Venta (la titular guarda montos; las réplicas son las otras OP de la
   misma factura), filtrado por fecha del documento. PARQUE: foto del pago mensual del parque, filtrado por mes. */
const comisionesFacturas = async (req, res) => {
  const r = rango(req, '2026-01-01');
  if (!r) return res.status(400).json({ success: false, data: null, error: 'desde/hasta deben ser AAAA-MM-DD y desde ≤ hasta' });
  try {
    const [dea] = await pool.query(
      `SELECT s.num_op, DATE_FORMAT(s.fecha_otorgado,'%Y-%m-%d') fecha_otorgado,
              COALESCE(ft.rut_dealer, s.rut_dealer) rut, COALESCE(ft.nombre_dealer, s.nombre_dealer) nombre,
              IF(COALESCE(ft.es_boleta,0)=1,'BOLETA','FACTURA') tipo_documento, ft.numero_factura numero_documento,
              DATE_FORMAT(ft.fecha_factura,'%Y-%m-%d') fecha_documento, ft.id_seguimiento id_titular, COALESCE(fc.es_replica,0) es_replica,
              ft.monto_bruto neto_documento, ft.impuesto_monto impuesto_documento, ft.monto_liquido total_documento,
              COALESCE(s.comision,0) comision_op, poc.id id_orden
         FROM postventa_facturas_comision fc
         JOIN postventa_seguimiento s ON s.id = fc.id_seguimiento
         JOIN postventa_facturas_comision ft ON ft.id_seguimiento = COALESCE(CASE WHEN fc.es_replica=1 THEN fc.id_titular END, fc.id_seguimiento)
         LEFT JOIN postventa_ordenes_comision poc ON poc.id_seguimiento = ft.id_seguimiento
        WHERE ft.fecha_factura BETWEEN ? AND ?
        ORDER BY ft.fecha_factura, ft.id_seguimiento, COALESCE(fc.es_replica,0), s.num_op LIMIT 20000`, [r.desde, r.hasta]);
    const odpD = await correlativos('COMISION', 'origen_id', [...new Set(dea.map(x => x.id_orden).filter(Boolean))]);
    // Neto de cada OP = neto del documento prorrateado por su comisión de cartola (la factura incluye ajustes de cartola)
    const sumas = new Map();
    for (const x of dea) sumas.set(x.id_titular, (sumas.get(x.id_titular) || 0) + Number(x.comision_op));
    const asignado = new Map(), quedan = new Map();
    for (const x of dea) quedan.set(x.id_titular, (quedan.get(x.id_titular) || 0) + 1);
    const filas = dea.map(x => {
      const o = odpD.get(Number(x.id_orden));
      const tot = sumas.get(x.id_titular), neto = x.neto_documento == null ? null : Number(x.neto_documento);
      let netoOp = null;
      if (neto != null && tot > 0) {
        const q = quedan.get(x.id_titular) - 1; quedan.set(x.id_titular, q);
        netoOp = q === 0 ? neto - (asignado.get(x.id_titular) || 0) : Math.round(neto * Number(x.comision_op) / tot);   // el último absorbe el redondeo
        asignado.set(x.id_titular, (asignado.get(x.id_titular) || 0) + netoOp);
      }
      return { tipo: 'DEALER', num_op: x.num_op, fecha_otorgado: x.fecha_otorgado, rut: x.rut, nombre: x.nombre,
        tipo_documento: x.tipo_documento, numero_documento: x.numero_documento, fecha_documento: x.fecha_documento,
        op_titular: !Number(x.es_replica), neto_documento: neto, total_documento: x.total_documento == null ? null : Number(x.total_documento),
        comision_op: Number(x.comision_op), comision_op_neta: netoOp,
        odp_numero: o ? o.numero : null, odp_estado: estadoOdp(o), odp_fecha_emision: o ? o.f_emision : null, odp_fecha_pago: o && Number(o.pagada) ? o.f_pago : null };
    });
    const [par] = await pool.query(
      `SELECT po.num_op, DATE_FORMAT(po.fecha_otorgado,'%Y-%m-%d') fecha_otorgado, po.parque, DATE_FORMAT(pm.mes,'%Y-%m') mes_pago,
              pm.etapa, pm.odp_id, pm.odp_numero, po.com_parque
         FROM parques_pagos_ops po JOIN parques_pagos_mes pm ON pm.parque = po.parque AND pm.mes = po.mes
        WHERE po.mes BETWEEN DATE_FORMAT(?,'%Y-%m-01') AND ? ORDER BY pm.mes, po.parque, po.num_op LIMIT 20000`, [r.desde, r.hasta]);
    const odpP = await correlativos(null, 'id', [...new Set(par.map(x => x.odp_id).filter(Boolean))]);
    for (const x of par) {
      const o = odpP.get(Number(x.odp_id));
      filas.push({ tipo: 'PARQUE', num_op: x.num_op, fecha_otorgado: x.fecha_otorgado, rut: null, nombre: x.parque,
        tipo_documento: null, numero_documento: null, fecha_documento: null, mes_cartola: x.mes_pago, etapa_pago: x.etapa,
        op_titular: null, neto_documento: null, total_documento: null,
        comision_op: Number(x.com_parque), comision_op_neta: Number(x.com_parque),
        odp_numero: o ? o.numero : x.odp_numero || null, odp_estado: x.odp_id ? estadoOdp(o) : 'SIN_ODP',
        odp_fecha_emision: o ? o.f_emision : null, odp_fecha_pago: o && Number(o.pagada) ? o.f_pago : null });
    }
    res.json({ success: true, data: { desde: r.desde, hasta: r.hasta, total: filas.length, filas }, error: null });
  } catch (e) {
    console.error('[api finanzas comisiones-facturas]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* GET /provisiones-liberaciones?desde=&hasta=[&concepto=DEALER] — provisiones ya liberadas por el motor (fecha de
   liberación en el rango): contra qué documento/pago, con qué motivo y en qué comprobante. */
const CONCEPTOS_PROV = ['DEALER', 'PARQUE', 'ARRIENDO', 'EJECUTIVO', 'JEFE', 'SUELDOS', 'OTROS', 'IAS', 'INGRESOS'];
const provisionesLiberaciones = async (req, res) => {
  const r = rango(req, '2025-01-01');
  if (!r) return res.status(400).json({ success: false, data: null, error: 'desde/hasta deben ser AAAA-MM-DD y desde ≤ hasta' });
  const concepto = req.query.concepto ? String(req.query.concepto).toUpperCase() : null;
  if (concepto && !CONCEPTOS_PROV.includes(concepto)) return res.status(400).json({ success: false, data: null, error: 'concepto inválido: ' + CONCEPTOS_PROV.join(', ') });
  try {
    const [rows] = await pool.query(
      `SELECT p.concepto, p.origen_tipo origen, p.num_op, p.tercero, p.mes mes_provision, DATE_FORMAT(p.fecha_constitucion,'%Y-%m-%d') fecha_constitucion,
              p.monto, p.motivo_liberacion motivo, DATE_FORMAT(p.fecha_liberacion,'%Y-%m-%d') fecha_liberacion, p.liberada_contra,
              CASE WHEN cl.id IS NOT NULL THEN CONCAT(cl.tipo,' ',cl.numero,'/',cl.anio) END comprobante_liberacion
         FROM ctb_provisiones p LEFT JOIN ctb_comprobantes cl ON cl.id = p.id_comprobante_liberacion
        WHERE p.estado='LIBERADA' AND p.fecha_liberacion BETWEEN ? AND ? ${concepto ? 'AND p.concepto=?' : ''}
        ORDER BY p.fecha_liberacion, p.concepto, p.num_op LIMIT 20000`, concepto ? [r.desde, r.hasta, concepto] : [r.desde, r.hasta]);
    for (const x of rows) x.monto = Number(x.monto);
    res.json({ success: true, data: { desde: r.desde, hasta: r.hasta, total: rows.length, filas: rows }, error: null });
  } catch (e) {
    console.error('[api finanzas provisiones-liberaciones]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

module.exports = { libroMayor, libroMayorCompleto, balance, libroCompras, libroVentas, ordenesPago, rentabilidad, saldoProcesoPago, comisionesFacturas, provisionesLiberaciones };
