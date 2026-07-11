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
        AND (c.credito_vendido_a IS NULL OR c.credito_vendido_a='')
      ORDER BY c.num_op DESC LIMIT 2000`);
    const caps = await capitalesVigentes(ops.map(o => o.num_op));
    const data = ops.map(o => {
      const k = caps[o.num_op] || {};
      return { ...o, capital_vigente: +k.capital || null, cuotas_pendientes: k.cuotas_pend != null ? +k.cuotas_pend : null,
               precio_motor: +k.capital || null };
    });
    res.json({ success: true, data, error: null });
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
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha_venta)) ? b.fecha_venta : new Date().toISOString().slice(0, 10);
    if (!comprador) return res.status(400).json({ success: false, data: null, error: 'Falta el comprador' });
    if (!ventas.length) return res.status(400).json({ success: false, data: null, error: 'Sin operaciones a vender' });
    const usuario = ((req.usuario.nombre || '') + ' ' + (req.usuario.apellido || '')).trim() || req.usuario.email || '';
    const adm = b.con_administracion ? 1 : 0, resp = b.con_responsabilidad ? 1 : 0;

    let vendidas = 0; const errores = [];
    for (const v of ventas) {
      const idc = parseInt(v.id_credito); const precio = Math.round(+v.precio_venta);
      if (!idc || !(precio > 0)) { errores.push(`Crédito ${v.id_credito}: precio inválido`); continue; }
      const [[cr]] = await pool.query(
        "SELECT id, num_op FROM creditos WHERE id=? AND financiera='AUTOFACIL' AND (credito_vendido_a IS NULL OR credito_vendido_a='')", [idc]);
      if (!cr) { errores.push(`Crédito ${v.id_credito}: no elegible o ya vendido`); continue; }
      const caps = await capitalesVigentes([cr.num_op]);
      const cap = caps[cr.num_op] ? +caps[cr.num_op].capital : null;
      try {
        await pool.query(`INSERT INTO cartera_ventas
          (id_credito, num_op, comprador, fecha_venta, capital_venta, precio_motor, precio_venta,
           con_administracion, con_responsabilidad, usuario)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [cr.id, cr.num_op, comprador, fecha, cap, cap, precio, adm, resp, usuario]);
        await pool.query("UPDATE creditos SET credito_vendido_a=? WHERE id=?", [comprador, cr.id]);
        vendidas++;
      } catch (e) { errores.push(`Op ${cr.num_op}: ${e.code === 'ER_DUP_ENTRY' ? 'ya vendida' : e.message}`); }
    }
    res.json({ success: true, data: { vendidas, errores }, error: null });
  } catch (e) { errSrv(res, e, 'venta-cartera vender'); }
};

/* ── DELETE /api/venta-cartera/:id — deshacer una venta ──────────────────── */
exports.deshacer = async (req, res) => {
  try {
    const [[v]] = await pool.query('SELECT id, id_credito FROM cartera_ventas WHERE id=?', [parseInt(req.params.id) || 0]);
    if (!v) return res.status(404).json({ success: false, data: null, error: 'Venta no encontrada' });
    await pool.query("UPDATE creditos SET credito_vendido_a=NULL WHERE id=?", [v.id_credito]);
    await pool.query('DELETE FROM cartera_ventas WHERE id=?', [v.id]);
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
