'use strict';
/* ───────────────────────────────────────────────────────────────────────────
 * FACTURACIÓN AUTOFÁCIL (Post Venta) — control de lo que las financieras nos
 * pagan vs lo que calculan nuestros motores.
 *
 * Jerarquía: MES → FINANCIERA → CONCEPTO (Ingreso por Colocación / Ingreso por
 * Seguros solo AutoFin) → detalle por operación (monto, plazo, comisión
 * calculada, %). En cada op: checkbox "facturado correcto" (replica el monto) o
 * digitación manual si pagaron menos → diferencia en $ y %.
 *
 * UNIDAD paga 2 veces al mes: ANTICIPO ~día 15 (según tier al liquidar) y
 * recálculo al CIERRE del mes → cuadros de anticipo y por facturar, total
 * nuestro vs real pagado y diferencias.
 * ─────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');

require('../../../../shared/migrate').enFila('facturacion-af', async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS facturacion_af_check (
      id INT AUTO_INCREMENT PRIMARY KEY,
      mes CHAR(7) NOT NULL,
      financiera VARCHAR(30) NOT NULL,
      concepto VARCHAR(12) NOT NULL,          -- COLOCACION | SEGUROS
      num_op BIGINT NOT NULL,
      monto_calculado DECIMAL(15,0) NULL,
      monto_facturado DECIMAL(15,0) NULL,
      ok TINYINT(1) NOT NULL DEFAULT 0,
      usuario VARCHAR(150) NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_op (mes, concepto, num_op),
      INDEX idx_mes (mes)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS facturacion_af_uac (
      mes CHAR(7) PRIMARY KEY,
      anticipo DECIMAL(15,0) NULL,            -- pagado ~día 15 (tier al liquidar)
      pagado_real DECIMAL(15,0) NULL,         -- total realmente pagado por UAC en el mes
      notas VARCHAR(400) NULL,
      usuario VARCHAR(150) NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='postventa_facturacion_af' LIMIT 1");
    if (!ex) {
      await pool.query("INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (330001,'Facturación AutoFácil','postventa_facturacion_af','/postventa/facturacion-af/','bi-receipt-cutoff')");
      const [[nf]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='postventa_facturacion_af' LIMIT 1");
      await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
                        SELECT id_perfil, ?, 1 FROM perfiles WHERE nombre='Administrador'`, [nf.id_funcionalidad]);
    }
  } catch (e) { console.error('[facturacion-af migration]', e.message); }
});

const errSrv = (res, e, tag) => { console.error(`[${tag}]`, e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); };
const BASE = `financiera IN ('AUTOFIN','UNIDAD DE CREDITO') AND estado_credito='OTORGADO' AND mes IS NOT NULL`;

/* ── GET /api/facturacion-af/resumen — meses → financieras con totales ───── */
exports.resumen = async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT DATE_FORMAT(mes,'%Y-%m') mes, financiera, COUNT(*) ops,
             ROUND(SUM(COALESCE(monto_comision_fin,0))) colocacion,
             ROUND(SUM(CASE WHEN financiera='AUTOFIN' THEN COALESCE(com_rdh,0)+COALESCE(com_cesantia,0)+COALESCE(com_reparaciones,0) ELSE 0 END)) seguros
      FROM creditos WHERE ${BASE}
      GROUP BY 1, 2 ORDER BY 1 DESC, 2
      LIMIT 100`);
    // Estado de revisión: cuántas ops del mes/financiera ya están chequeadas OK
    const [chk] = await pool.query(`
      SELECT mes, financiera, SUM(ok=1) oks, COUNT(*) revisadas, ROUND(SUM(COALESCE(monto_facturado,0))) facturado
      FROM facturacion_af_check GROUP BY 1,2`);
    const chkMap = {}; chk.forEach(c => chkMap[c.mes + '|' + c.financiera] = c);
    const data = rows.map(r => ({ ...r, check: chkMap[r.mes + '|' + r.financiera] || null }));
    res.json({ success: true, data, error: null });
  } catch (e) { errSrv(res, e, 'factAF resumen'); }
};

/* ── GET /api/facturacion-af/detalle?mes=&financiera=&concepto= ──────────── */
exports.detalle = async (req, res) => {
  try {
    const mes = String(req.query.mes || '').slice(0, 7);
    const fin = String(req.query.financiera || '').toUpperCase();
    const concepto = String(req.query.concepto || 'COLOCACION').toUpperCase();
    if (!/^\d{4}-\d{2}$/.test(mes) || !['AUTOFIN', 'UNIDAD DE CREDITO'].includes(fin))
      return res.status(400).json({ success: false, data: null, error: 'Parámetros inválidos' });

    const esUAC = fin.includes('UNIDAD');
    const [ops] = await pool.query(`
      SELECT c.num_op, c.monto_financiado, c.saldo_precio, c.plazo,
             ROUND(COALESCE(c.monto_comision_fin,0)) colocacion,
             ROUND(COALESCE(c.com_rdh,0)+COALESCE(c.com_cesantia,0)+COALESCE(c.com_reparaciones,0)) seguros,
             ROUND(COALESCE(c.seguro_rdh,0)+COALESCE(c.seguro_cesantia,0)+COALESCE(c.seguro_rep_menor,0)) primas,
             COALESCE(cl.nombre_completo,'') cliente
      FROM creditos c LEFT JOIN clientes cl ON cl.id_cliente=c.id_cliente
      WHERE ${BASE} AND DATE_FORMAT(c.mes,'%Y-%m')=? AND c.financiera=?
      ORDER BY c.num_op`, [mes, fin]);

    const [checks] = await pool.query('SELECT num_op, monto_facturado, ok FROM facturacion_af_check WHERE mes=? AND concepto=? AND financiera=?', [mes, concepto, fin]);
    const chkMap = {}; checks.forEach(c => chkMap[c.num_op] = c);

    const data = ops.map(o => {
      const base = esUAC ? +o.saldo_precio : +o.monto_financiado;      // UAC: % sobre saldo precio
      const comision = concepto === 'SEGUROS' ? +o.seguros : +o.colocacion;
      const pctBase = concepto === 'SEGUROS' ? +o.primas : base;       // seguros: % sobre primas
      const chk = chkMap[o.num_op] || null;
      return {
        num_op: o.num_op, cliente: o.cliente, plazo: o.plazo,
        monto: base, primas: +o.primas,
        comision, pct: pctBase > 0 ? Math.round(10000 * comision / pctBase) / 100 : null,
        ok: chk ? !!chk.ok : false,
        monto_facturado: chk && chk.monto_facturado != null ? +chk.monto_facturado : null,
      };
    });
    // UAC: cuadro anticipo / por facturar
    let uac = null;
    if (esUAC) {
      const [[u]] = await pool.query('SELECT anticipo, pagado_real, notas FROM facturacion_af_uac WHERE mes=?', [mes]);
      const total = data.reduce((a, r) => a + (+r.comision || 0), 0);
      uac = { anticipo: u ? +u.anticipo || 0 : 0, pagado_real: u ? +u.pagado_real || 0 : 0, notas: u ? u.notas : null,
              total_nuestro: total, por_facturar: total - (u ? +u.anticipo || 0 : 0) };
    }
    res.json({ success: true, data: { ops: data, uac }, error: null });
  } catch (e) { errSrv(res, e, 'factAF detalle'); }
};

/* ── POST /api/facturacion-af/check — marca/digita el monto facturado ────── */
exports.check = async (req, res) => {
  try {
    const b = req.body || {};
    const mes = String(b.mes || '').slice(0, 7);
    const concepto = ['COLOCACION', 'SEGUROS'].includes(String(b.concepto).toUpperCase()) ? String(b.concepto).toUpperCase() : 'COLOCACION';
    const fin = String(b.financiera || '').toUpperCase();
    const numOp = parseInt(b.num_op);
    if (!/^\d{4}-\d{2}$/.test(mes) || !numOp) return res.status(400).json({ success: false, data: null, error: 'Datos inválidos' });
    const usuario = ((req.usuario.nombre || '') + ' ' + (req.usuario.apellido || '')).trim() || req.usuario.email || '';
    await pool.query(`
      INSERT INTO facturacion_af_check (mes, financiera, concepto, num_op, monto_calculado, monto_facturado, ok, usuario)
      VALUES (?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE monto_calculado=VALUES(monto_calculado), monto_facturado=VALUES(monto_facturado), ok=VALUES(ok), usuario=VALUES(usuario)`,
      [mes, fin, concepto, numOp, b.monto_calculado != null ? Math.round(+b.monto_calculado) : null,
       b.monto_facturado != null && b.monto_facturado !== '' ? Math.round(+b.monto_facturado) : null, b.ok ? 1 : 0, usuario]);
    res.json({ success: true, data: null, error: null });
  } catch (e) { errSrv(res, e, 'factAF check'); }
};

/* ── PUT /api/facturacion-af/uac — anticipo y pagado real del mes UAC ────── */
exports.uacSet = async (req, res) => {
  try {
    const b = req.body || {};
    const mes = String(b.mes || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ success: false, data: null, error: 'Mes inválido' });
    const usuario = ((req.usuario.nombre || '') + ' ' + (req.usuario.apellido || '')).trim() || req.usuario.email || '';
    await pool.query(`
      INSERT INTO facturacion_af_uac (mes, anticipo, pagado_real, notas, usuario) VALUES (?,?,?,?,?)
      ON DUPLICATE KEY UPDATE anticipo=VALUES(anticipo), pagado_real=VALUES(pagado_real), notas=VALUES(notas), usuario=VALUES(usuario)`,
      [mes, b.anticipo != null && b.anticipo !== '' ? Math.round(+b.anticipo) : null,
       b.pagado_real != null && b.pagado_real !== '' ? Math.round(+b.pagado_real) : null,
       b.notas ? String(b.notas).slice(0, 400) : null, usuario]);
    res.json({ success: true, data: null, error: null });
  } catch (e) { errSrv(res, e, 'factAF uacSet'); }
};
