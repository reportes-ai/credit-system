'use strict';
/* ───────────────────────────────────────────────────────────────────────────
 * VENTA DE CARTERA — venta de créditos AUTOFÁCIL (cartera propia) a otra
 * financiera (típicamente CFC).
 *
 * Reglas de negocio:
 *  - Universo vendible: creditos financiera='AUTOFACIL' otorgados y no vendidos.
 *  - Precio propuesto = capital vigente (suma de amortizaciones impagas de la
 *    tabla de desarrollo congelada en cuotas_credito) — motor único de saldo.
 *    El usuario puede ajustar el precio final de venta.
 *  - Marcas por operación: con_administracion (seguimos a cargo de cobranza y
 *    recaudación) y con_responsabilidad (recourse: si el cliente no paga una
 *    cuota del mes, se la pagamos nosotros al comprador).
 *  - Al vender se estampa creditos.credito_vendido_a = comprador (columna ya
 *    existente — una sola fuente).
 * ─────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');

require('../../../../shared/migrate').enFila('venta-cartera', async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS cartera_ventas (
      id                  INT AUTO_INCREMENT PRIMARY KEY,
      id_credito          INT NOT NULL,
      num_op              BIGINT NULL,
      comprador           VARCHAR(80) NOT NULL,
      fecha_venta         DATE NOT NULL,
      capital_venta       DECIMAL(15,0) NULL,
      precio_motor        DECIMAL(15,0) NULL,
      precio_venta        DECIMAL(15,0) NOT NULL,
      con_administracion  TINYINT NOT NULL DEFAULT 0,
      con_responsabilidad TINYINT NOT NULL DEFAULT 0,
      usuario             VARCHAR(150) NULL,
      created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_credito (id_credito),
      INDEX idx_fecha (fecha_venta), INDEX idx_comprador (comprador)
    )`);
    // Card en Tesorería (anti-hardcode: vive en BD)
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='venta_cartera' LIMIT 1");
    if (!ex) {
      await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (60001,'Venta de Cartera','venta_cartera','/tesoreria/venta-cartera.html','bi-bag-check')");
      const [[nf]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='venta_cartera' LIMIT 1");
      // Solo Administrador por defecto (la matriz de Perfiles decide el resto)
      await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
                        SELECT id_perfil, ?, 1 FROM perfiles WHERE nombre='Administrador'`, [nf.id_funcionalidad]);
    }
  } catch (e) { console.error('[venta-cartera migration]', e.message); }
});

/* ── Parámetros de precio (Pato 21-09-2026) ───────────────────────────────
   Precio = VP de las cuotas pendientes descontadas a (tasa del crédito − spread), igual que
   AutoFin nos paga la colocación (motor único rentabilidad-core.precioVentaCartera). Un spread
   distinto según venda con o sin responsabilidad. Referencia: lo que pagaría AutoFin SIN
   responsabilidad = VP al costo de fondo del mantenedor Tasas (tasa tramo − spread tramo). */
const core = require('../../../../api-gateway/public/js/rentabilidad-core');
const PARAM_DEF = { spread_sin_resp: 0.67, spread_con_adm: 0.67, spread_con_resp: 0.67, gastos_venta: 0 };   // spreads % mensual (default = AutoFin); gastos $ por operación que se SUMAN al precio
require('../../../../shared/migrate').enFila('venta-cartera-param', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS venta_cartera_param (
    clave VARCHAR(40) PRIMARY KEY, valor DECIMAL(8,4) NOT NULL, updated_by VARCHAR(150) NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
  for (const [k, v] of Object.entries(PARAM_DEF)) await pool.query('INSERT IGNORE INTO venta_cartera_param (clave, valor) VALUES (?,?)', [k, v]);
  for (const col of ['tasa_descuento DECIMAL(8,4) NULL', 'precio_ref_autofin DECIMAL(15,0) NULL', 'gastos_venta DECIMAL(15,0) NULL', 'interes_dev_venta DECIMAL(15,0) NULL',
                     'fecha_cobro DATE NULL', 'monto_cobrado DECIMAL(15,0) NULL', 'id_cuenta_bancaria INT NULL', 'cobrado_por VARCHAR(150) NULL'])
    await pool.query(`ALTER TABLE cartera_ventas ADD COLUMN ${col}`).catch(() => {});
});
async function parametros() {
  const [rows] = await pool.query('SELECT clave, valor, updated_by, updated_at FROM venta_cartera_param');
  const p = { ...PARAM_DEF };
  for (const r of rows) p[r.clave] = +r.valor;
  return p;
}
exports.preciosDe = (ops, fecha) => preciosDe(ops, fecha);   // lo usa el contrato de cesión (Anexo 2: precio de recompra)
exports.getParametros = async (req, res) => {
  try { res.json({ success: true, data: await parametros(), error: null }); } catch (e) { errSrv(res, e, 'venta-cartera parametros'); }
};
exports.putParametros = async (req, res) => {
  try {
    const b = req.body || {}, antes = await parametros();
    const usuario = ((req.usuario.nombre || '') + ' ' + (req.usuario.apellido || '')).trim() || req.usuario.email || '';
    for (const k of Object.keys(PARAM_DEF)) {
      const v = parseFloat(b[k]);
      if (k === 'gastos_venta') { if (!isFinite(v) || v < 0) return res.status(400).json({ success: false, data: null, error: 'Gastos de venta: monto en pesos ≥ 0' }); }
      else if (!isFinite(v) || v < 0 || v > 10) return res.status(400).json({ success: false, data: null, error: `${k}: debe ser un % mensual entre 0 y 10` });
      await pool.query('INSERT INTO venta_cartera_param (clave, valor, updated_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor), updated_by=VALUES(updated_by)', [k, v, usuario]);
    }
    const desp = await parametros();
    require('../../../../shared/audit').auditar({ req, accion: 'EDITAR', modulo: 'tesoreria', entidad: 'venta_cartera_param',
      detalle: `Venta de cartera: spread sin resp. ${antes.spread_sin_resp}% → ${desp.spread_sin_resp}% · con adm. ${antes.spread_con_adm}% → ${desp.spread_con_adm}% · con resp.+adm. ${antes.spread_con_resp}% → ${desp.spread_con_resp}% · gastos $${antes.gastos_venta} → $${desp.gastos_venta}` });
    res.json({ success: true, data: desp, error: null });
  } catch (e) { errSrv(res, e, 'venta-cartera parametros'); }
};

/* Precios por op a una fecha: VP sin/con responsabilidad + referencia AutoFin sin responsabilidad. */
async function preciosDe(ops, fechaISO) {
  if (!ops.length) return {};
  const p = await parametros();
  const { cargarTasas, getTasaByFecha } = require('../../../creditos/src/utils/recalcular-mes');
  const tasas = await cargarTasas();
  const tv = getTasaByFecha(fechaISO, tasas);
  const [[um]] = await pool.query("SELECT valor FROM parametros_credito WHERE clave='umbral_uf_tramo'");
  const umbral = um ? +um.valor || 200 : 200;
  let uf = null; try { uf = await require('../../../../shared/uf').getUF(new Date(fechaISO + 'T12:00:00')); } catch (_) {}
  const [cuotas] = await pool.query(
    `SELECT num_op, valor_cuota, DATE_FORMAT(fecha_vencimiento,'%Y-%m-%d') fecha_vencimiento FROM cuotas_credito
      WHERE num_op IN (?) AND fecha_pago IS NULL AND estado_cuota<>'PAGADA' ORDER BY num_op, numero_cuota`, [ops.map(o => o.num_op)]);
  const out = {};
  for (const o of ops) {
    const qs = cuotas.filter(q => q.num_op === o.num_op);
    const tc = core.normTasaMensualPct(o.tascli_real) / 100;                    // fracción mensual
    const tSin = Math.max(0, tc - p.spread_sin_resp / 100), tAdm = Math.max(0, tc - p.spread_con_adm / 100), tCon = Math.max(0, tc - p.spread_con_resp / 100);
    let ref = null, tRef = null;
    if (tv) {
      const mayor = core.esMayor200({ montoCap: o.monto_financiado, uf, umbralUf: umbral });
      tRef = ((mayor ? +tv.tasa_mensual_mayor - +tv.spread_mayor : +tv.tasa_mensual_menor - +tv.spread_menor) || 0) / 100;
      ref = core.precioVentaCartera(qs, tRef, fechaISO);
    }
    // Precio = VP + gastos de venta de la operación (parámetro)
    const g = Math.round(+p.gastos_venta || 0);
    out[o.num_op] = { tasa_credito: +(tc * 100).toFixed(4), tasa_sin_resp: +(tSin * 100).toFixed(4), tasa_con_adm: +(tAdm * 100).toFixed(4), tasa_con_resp: +(tCon * 100).toFixed(4),
      gastos_venta: g,
      precio_sin_resp: tc > 0 ? core.precioVentaCartera(qs, tSin, fechaISO) + g : null,
      precio_con_adm: tc > 0 ? core.precioVentaCartera(qs, tAdm, fechaISO) + g : null,
      precio_con_resp: tc > 0 ? core.precioVentaCartera(qs, tCon, fechaISO) + g : null,
      ref_autofin: ref, tasa_ref: tRef != null ? +(tRef * 100).toFixed(4) : null, suma_cuotas: qs.reduce((s, q) => s + (+q.valor_cuota || 0), 0) };
  }
  return out;
}

/* Montos del asiento de venta: precio (por cobrar), capital (sale de 1104010), interés devengado
   pendiente de cobro (sale de 1104120 — ctb_devengo_intereses menos lo ya aplicado), y la diferencia
   como utilidad o pérdida (el motor no acepta negativos: van en campos separados). */
async function montosAsientoVenta(idCredito, precio, capital) {
  const [[d]] = await pool.query('SELECT COALESCE(SUM(interes),0) m FROM ctb_devengo_intereses WHERE id_credito=?', [idCredito]);
  const [[a]] = await pool.query("SELECT COALESCE(SUM(monto),0) m FROM ctb_devengo_aplicaciones WHERE id_credito=? AND tipo='DEV' AND reversado=0", [idCredito]);
  const interes_dev = Math.max(0, Math.round(Number(d.m) - Number(a.m)));
  const p = Math.round(+precio || 0), c = Math.round(+capital || 0);
  const dif = p - c - interes_dev;
  return { precio: p, capital: c, interes_dev, utilidad: Math.max(0, dif), perdida: Math.max(0, -dif) };
}

const errSrv = (res, e, tag) => { console.error(`[${tag}]`, e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); };
const catDe = v => v.con_responsabilidad && v.con_administracion ? 'RESP_ADM' : v.con_responsabilidad ? 'RESP' : v.con_administracion ? 'ADM' : 'SIN_MARCAS';

/* Capital vigente por op: suma de amortizaciones IMPAGAS de la tabla congelada. */
async function capitalesVigentes(numOps) {
  if (!numOps.length) return {};
  const [rows] = await pool.query(`
    SELECT num_op, ROUND(SUM(CASE WHEN fecha_pago IS NULL THEN COALESCE(amortizacion,0) ELSE 0 END)) capital,
           SUM(fecha_pago IS NULL) cuotas_pend, COUNT(*) cuotas_tot
    FROM cuotas_credito WHERE num_op IN (?) GROUP BY num_op`, [numOps]);
  return Object.fromEntries(rows.map(r => [r.num_op, r]));
}

/* ── GET /api/venta-cartera/elegibles — créditos AUTOFÁCIL vendibles ─────── */
exports.elegibles = async (req, res) => {
  try {
    const [ops] = await pool.query(`
      SELECT c.id, c.num_op, DATE_FORMAT(c.mes,'%Y-%m') mes, c.monto_financiado, c.plazo, c.cuota,
             c.tascli_real, c.estado_cartera, c.cartera_original,
             COALESCE(cl.nombre_completo,'') cliente, COALESCE(cl.rut,'') rut
      FROM creditos c LEFT JOIN clientes cl ON cl.id_cliente=c.id_cliente
      WHERE c.financiera='AUTOFACIL'
        AND (c.estado_credito='OTORGADO' OR c.estado='OTORGADO')
        AND UPPER(COALESCE(c.estado_cartera,'')) NOT IN ('PREPAGADO','PAGADO','CASTIGADO','ANULADO')   -- sin saldo: nada que vender
        AND (c.credito_vendido_a IS NULL OR c.credito_vendido_a='' OR UPPER(c.credito_vendido_a)='NO VENDIDO')   -- marca de la migración = vendible
      ORDER BY c.num_op DESC LIMIT 2000`);
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.fecha)) ? req.query.fecha : require('../../../../shared/fecha-chile').hoyISO();
    const caps = await capitalesVigentes(ops.map(o => o.num_op));
    const precios = await preciosDe(ops, fecha);
    const data = ops.map(o => {
      const k = caps[o.num_op] || {}, pr = precios[o.num_op] || {};
      return { ...o, capital_vigente: +k.capital || null, cuotas_pendientes: k.cuotas_pend != null ? +k.cuotas_pend : null,
               ...pr, precio_motor: pr.precio_sin_resp ?? +k.capital ?? null };
    });
    res.json({ success: true, data, fecha, parametros: await parametros(), error: null });
  } catch (e) { errSrv(res, e, 'venta-cartera elegibles'); }
};

/* ── POST /api/venta-cartera/vender ───────────────────────────────────────
   { comprador, fecha_venta, con_administracion, con_responsabilidad,
     ventas: [{ id_credito, precio_venta }] } */
exports.vender = async (req, res) => {
  try {
    const b = req.body || {};
    const comprador = String(b.comprador || '').trim().toUpperCase();
    const ventas = Array.isArray(b.ventas) ? b.ventas : [];
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha_venta)) ? b.fecha_venta : require('../../../../shared/fecha-chile').hoyISO(); // día de Chile: el UTC nocturno movía la venta al día (o mes) siguiente
    if (!comprador) return res.status(400).json({ success: false, data: null, error: 'Falta el comprador' });
    if (!ventas.length) return res.status(400).json({ success: false, data: null, error: 'Sin operaciones a vender' });
    const usuario = ((req.usuario.nombre || '') + ' ' + (req.usuario.apellido || '')).trim() || req.usuario.email || '';
    const resp = b.con_responsabilidad ? 1 : 0, adm = (b.con_administracion || resp) ? 1 : 0;   // con responsabilidad siempre es con administración

    let vendidas = 0; const errores = [];
    for (const v of ventas) {
      const idc = parseInt(v.id_credito); const precio = Math.round(+v.precio_venta);
      if (!idc || !(precio > 0)) { errores.push(`Crédito ${v.id_credito}: precio inválido`); continue; }
      const [[cr]] = await pool.query(
        "SELECT id, num_op, tascli_real, monto_financiado FROM creditos WHERE id=? AND financiera='AUTOFACIL' AND (credito_vendido_a IS NULL OR credito_vendido_a='' OR UPPER(credito_vendido_a)='NO VENDIDO') AND UPPER(COALESCE(estado_cartera,'')) NOT IN ('PREPAGADO','PAGADO','CASTIGADO','ANULADO')", [idc]);
      if (!cr) { errores.push(`Crédito ${v.id_credito}: no elegible o ya vendido`); continue; }
      const caps = await capitalesVigentes([cr.num_op]);
      const cap = caps[cr.num_op] ? +caps[cr.num_op].capital : null;
      // Precio del motor a la fecha de venta (según responsabilidad) y referencia AutoFin: quedan como snapshot
      const pr = (await preciosDe([cr], fecha))[cr.num_op] || {};
      const pm = resp ? pr.precio_con_resp : adm ? pr.precio_con_adm : pr.precio_sin_resp;
      const td = resp ? pr.tasa_con_resp : adm ? pr.tasa_con_adm : pr.tasa_sin_resp;
      try {
        await pool.query(`INSERT INTO cartera_ventas
          (id_credito, num_op, comprador, fecha_venta, capital_venta, precio_motor, precio_venta,
           con_administracion, con_responsabilidad, usuario, tasa_descuento, precio_ref_autofin, gastos_venta)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [cr.id, cr.num_op, comprador, fecha, cap, pm ?? cap, precio, adm, resp, usuario, td ?? null, pr.ref_autofin ?? null, pr.gastos_venta ?? null]);
        await pool.query("UPDATE creditos SET credito_vendido_a=? WHERE id=?", [comprador, cr.id]);
        vendidas++;
        // Máxima 4: asiento de la venta (nunca bloquea). Lo devengado y no cobrado de la op sale con ella.
        try {
          const [[idv]] = await pool.query('SELECT id FROM cartera_ventas WHERE id_credito=?', [cr.id]);
          const montos = await montosAsientoVenta(cr.id, precio, cap);
          await pool.query('UPDATE cartera_ventas SET interes_dev_venta=? WHERE id=?', [montos.interes_dev, idv.id]);
          require('../../../contabilidad/src/motor-asientos').contabilizar({
            evento: 'VENTA_CARTERA', fecha, ref: `VC-${idv.id}`, num_op: String(cr.num_op), montos,
            glosa: `Venta de cartera op ${cr.num_op} a ${comprador}${resp ? ' con responsabilidad' : adm ? ' con administración' : ''}`,
            detalle: `${comprador} · OP ${cr.num_op}`,
          }).catch(() => {});
        } catch (e) { console.error('[venta-cartera asiento]', e.message); }
      } catch (e) { errores.push(`Op ${cr.num_op}: ${e.code === 'ER_DUP_ENTRY' ? 'ya vendida' : e.message}`); }
    }
    res.json({ success: true, data: { vendidas, errores }, error: null });
  } catch (e) { errSrv(res, e, 'venta-cartera vender'); }
};

/* ── POST /api/venta-cartera/:id/cobrar { fecha, id_cuenta_bancaria, monto } ─
   Ingreso de fondos del comprador: DEBE banco real del depósito / HABER 1106020.
   Un cobro por venta (por el total); mismo banco que Caja (cuentas_bancarias.cuenta_contable). */
exports.cobrar = async (req, res) => {
  try {
    const b = req.body || {};
    const [[v]] = await pool.query('SELECT * FROM cartera_ventas WHERE id=?', [parseInt(req.params.id) || 0]);
    if (!v) return res.status(404).json({ success: false, data: null, error: 'Venta no encontrada' });
    if (v.fecha_cobro) return res.status(409).json({ success: false, data: null, error: 'Esta venta ya está cobrada' });
    const idCta = parseInt(b.id_cuenta_bancaria) || null;
    if (!idCta) return res.status(400).json({ success: false, data: null, error: 'Indica la cuenta bancaria donde entraron los fondos' });
    const monto = Math.round(+b.monto || 0);
    if (!(monto > 0)) return res.status(400).json({ success: false, data: null, error: 'Monto inválido' });
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha)) ? b.fecha : require('../../../../shared/fecha-chile').hoyISO();
    const usuario = ((req.usuario.nombre || '') + ' ' + (req.usuario.apellido || '')).trim() || req.usuario.email || '';
    const [u] = await pool.query('UPDATE cartera_ventas SET fecha_cobro=?, monto_cobrado=?, id_cuenta_bancaria=?, cobrado_por=? WHERE id=? AND fecha_cobro IS NULL', [fecha, monto, idCta, usuario, v.id]);
    if (u.affectedRows !== 1) return res.status(409).json({ success: false, data: null, error: 'La venta cambió; recarga' });
    const { reemplazoBanco } = require('../../../creditos/src/controllers/pagos-credito.controller');   // mismo banco real que Caja
    const bco = await reemplazoBanco(idCta);
    const id = await require('../../../contabilidad/src/motor-asientos').contabilizar({
      evento: 'COBRO_VENTA_CARTERA', fecha, ref: `CVC-${v.id}`, num_op: String(v.num_op), reemplazos: bco.reemplazos,
      montos: { monto }, glosa: `Cobro venta de cartera op ${v.num_op} — ${v.comprador}`,
      detalle: [v.comprador, 'OP ' + v.num_op, bco.banco].filter(Boolean).join(' · '),
    });
    require('../../../../shared/audit').auditar({ req, accion: 'PAGAR', modulo: 'tesoreria', entidad: 'cartera_ventas', entidad_id: v.id,
      detalle: `Cobro venta de cartera op ${v.num_op} (${v.comprador}): $${monto.toLocaleString('es-CL')} el ${fecha}${bco.banco ? ' en ' + bco.banco : ''}${id ? ' · asiento #' + id : ''}` });
    res.json({ success: true, data: { id: v.id, fecha, monto, id_comprobante: id, diferencia: monto - Math.round(+v.precio_venta || 0) }, error: null });
  } catch (e) { errSrv(res, e, 'venta-cartera cobrar'); }
};

/* ── DELETE /api/venta-cartera/:id — deshacer una venta ──────────────────── */
exports.deshacer = async (req, res) => {
  try {
    const [[v]] = await pool.query('SELECT id, id_credito, num_op, comprador, precio_venta, capital_venta, interes_dev_venta FROM cartera_ventas WHERE id=?', [parseInt(req.params.id) || 0]);
    if (!v) return res.status(404).json({ success: false, data: null, error: 'Venta no encontrada' });
    const [[cob]] = await pool.query('SELECT fecha_cobro FROM cartera_ventas WHERE id=?', [v.id]);
    if (cob && cob.fecha_cobro) return res.status(409).json({ success: false, data: null, error: 'La venta ya fue cobrada: no se puede deshacer' });
    await pool.query("UPDATE creditos SET credito_vendido_a=NULL WHERE id=?", [v.id_credito]);
    await pool.query('DELETE FROM cartera_ventas WHERE id=?', [v.id]);
    // Contra-asiento con los mismos montos que se asentaron al vender (foto en la fila)
    try {
      const precio = Math.round(+v.precio_venta || 0), capital = Math.round(+v.capital_venta || 0), interes_dev = Math.round(+v.interes_dev_venta || 0);
      const dif = precio - capital - interes_dev;
      require('../../../contabilidad/src/motor-asientos').contabilizar({
        evento: 'REVERSA_VENTA_CARTERA', ref: `RVC-${v.id}`, num_op: String(v.num_op),
        montos: { precio, capital, interes_dev, utilidad: Math.max(0, dif), perdida: Math.max(0, -dif) },
        glosa: `Reversa venta de cartera op ${v.num_op} (${v.comprador})`, detalle: `${v.comprador} · OP ${v.num_op}`,
      }).catch(() => {});
    } catch (e) { console.error('[venta-cartera reversa asiento]', e.message); }
    res.json({ success: true, data: { id: v.id }, error: null });
  } catch (e) { errSrv(res, e, 'venta-cartera deshacer'); }
};

/* ── GET /api/venta-cartera/stock — reporte del stock vendido ─────────────
   Casos y capitales separados por categoría (Responsabilidad / Administración /
   Resp+Adm / sin marcas), por comprador y por mes + ratios. */
exports.stock = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT v.*, DATE_FORMAT(v.fecha_venta,'%Y-%m') mes_venta,
             COALESCE(cl.nombre_completo,'') cliente, COALESCE(cl.rut,'') rut, c.plazo, c.cuota
      FROM cartera_ventas v
      JOIN creditos c ON c.id = v.id_credito
      LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
      ORDER BY v.fecha_venta DESC, v.id DESC`);
    // Capital VIGENTE hoy (stock real, va bajando con los pagos)
    const caps = await capitalesVigentes(rows.map(r => r.num_op).filter(Boolean));
    const data = rows.map(r => ({ ...r, categoria: catDe(r),
      capital_vigente: caps[r.num_op] ? +caps[r.num_op].capital : null,
      cuotas_pendientes: caps[r.num_op] ? +caps[r.num_op].cuotas_pend : null }));

    const agg = {};
    for (const r of data) {
      const k = r.categoria;
      agg[k] = agg[k] || { casos: 0, capital_venta: 0, precio_venta: 0, capital_vigente: 0 };
      agg[k].casos++; agg[k].capital_venta += +r.capital_venta || 0;
      agg[k].precio_venta += +r.precio_venta || 0; agg[k].capital_vigente += +r.capital_vigente || 0;
    }
    const porComprador = {}, porMes = {};
    for (const r of data) {
      porComprador[r.comprador] = porComprador[r.comprador] || { casos: 0, precio_venta: 0 };
      porComprador[r.comprador].casos++; porComprador[r.comprador].precio_venta += +r.precio_venta || 0;
      porMes[r.mes_venta] = porMes[r.mes_venta] || { casos: 0, precio_venta: 0 };
      porMes[r.mes_venta].casos++; porMes[r.mes_venta].precio_venta += +r.precio_venta || 0;
    }
    const tot = data.length;
    const ratios = {
      total_casos: tot,
      total_precio_venta: data.reduce((a, r) => a + (+r.precio_venta || 0), 0),
      total_capital_vigente: data.reduce((a, r) => a + (+r.capital_vigente || 0), 0),
      pct_con_responsabilidad: tot ? Math.round(100 * data.filter(r => r.con_responsabilidad).length / tot) : 0,
      pct_con_administracion: tot ? Math.round(100 * data.filter(r => r.con_administracion).length / tot) : 0,
      precio_promedio: tot ? Math.round(data.reduce((a, r) => a + (+r.precio_venta || 0), 0) / tot) : 0,
    };
    res.json({ success: true, data: { ventas: data, porCategoria: agg, porComprador, porMes, ratios }, error: null });
  } catch (e) { errSrv(res, e, 'venta-cartera stock'); }
};

/* ── GET /api/venta-cartera/cuotas-mes?mes=YYYY-MM ────────────────────────
   Cuotas con vencimiento en el mes de las ops vendidas CON RESPONSABILIDAD:
   lo que hay que pagarle al comprador si el cliente no paga. */
exports.cuotasMes = async (req, res) => {
  try {
    const mes = /^\d{4}-\d{2}$/.test(String(req.query.mes)) ? req.query.mes : new Date().toISOString().slice(0, 7);
    const [rows] = await pool.query(`
      SELECT v.comprador, v.num_op, cc.numero_cuota, cc.fecha_vencimiento, cc.valor_cuota,
             cc.amortizacion, cc.interes, cc.fecha_pago, cc.estado_cuota,
             COALESCE(cl.nombre_completo,'') cliente, COALESCE(cl.rut,'') rut
      FROM cartera_ventas v
      JOIN creditos c  ON c.id = v.id_credito
      JOIN cuotas_credito cc ON cc.num_op = v.num_op
      LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
      WHERE v.con_responsabilidad = 1 AND DATE_FORMAT(cc.fecha_vencimiento,'%Y-%m') = ?
      ORDER BY cc.fecha_vencimiento, v.num_op`, [mes]);
    const total = rows.reduce((a, r) => a + (+r.valor_cuota || 0), 0);
    const impagas = rows.filter(r => !r.fecha_pago);
    res.json({ success: true, data: { mes, cuotas: rows, total,
      total_impago: impagas.reduce((a, r) => a + (+r.valor_cuota || 0), 0), n_impagas: impagas.length }, error: null });
  } catch (e) { errSrv(res, e, 'venta-cartera cuotas-mes'); }
};
