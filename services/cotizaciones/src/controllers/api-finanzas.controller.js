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
   acotadas al mes pedido y a las columnas del detalle. */
const COLS_RENT = ['num_op', 'id_financiera', 'mes', 'fecha_otorgado', 'financiera', 'producto', 'ejecutivo', 'automotora', 'rut_dealer', 'parque',
  'nombre_cliente', 'rut_cliente', 'valor_vehiculo', 'pie', 'saldo_precio', 'monto_financiado', 'plazo', 'tasa_mensual', 'mayor_menor', 'institucion',
  'ingreso_autofacil', 'ingreso_neto_total', 'comision_dealer', 'comdea_real', 'com_parque', 'seguro_rdh', 'seguro_cesantia', 'seguro_rep_menor', 'seguros',
  'comision_seguros', 'ingreso_bruto', 'estado', 'estado_credito'];
const rentabilidad = envolver((req, res) => dash().getDatos(req, res), {
  transformar(cuerpo, req) {
    if (!cuerpo || !Array.isArray(cuerpo.raw)) return cuerpo;
    const mes = /^\d{4}-\d{2}$/.test(String(req.query.mes || '')) ? req.query.mes : null;
    const filas = cuerpo.raw
      .filter(r => String(r.estado || r.estado_credito || '').toUpperCase() === 'OTORGADO')
      .filter(r => !mes || String(r.mes || r.fecha_otorgado || '').slice(0, 7) === mes)
      .map(r => { const o = {}; for (const k of COLS_RENT) if (k in r) o[k] = r[k]; return o; });
    return { success: true, data: { mes: mes || 'todos', total: filas.length, generado_en: cuerpo.generado_en, operaciones: filas }, error: null };
  },
});

module.exports = { libroMayor, libroMayorCompleto, balance, libroCompras, libroVentas, ordenesPago, rentabilidad, saldoProcesoPago };
