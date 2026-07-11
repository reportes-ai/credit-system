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
    await pool.query("ALTER TABLE facturacion_af_check ADD COLUMN IF NOT EXISTS anticipo DECIMAL(15,0) NULL");
    await pool.query(`CREATE TABLE IF NOT EXISTS facturacion_af_uac (
      mes CHAR(7) PRIMARY KEY,
      anticipo DECIMAL(15,0) NULL,            -- pagado ~día 15 (tier al liquidar)
      pagado_real DECIMAL(15,0) NULL,         -- total realmente pagado por UAC en el mes
      notas VARCHAR(400) NULL,
      usuario VARCHAR(150) NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS facturacion_af_solicitudes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      mes CHAR(7) NOT NULL,
      financiera VARCHAR(30) NOT NULL,
      concepto VARCHAR(12) NOT NULL,          -- COLOCACION | SEGUROS | ANTICIPO
      monto DECIMAL(15,0) NOT NULL,
      ops INT NOT NULL DEFAULT 0,
      usuario VARCHAR(150) NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_sol (mes, financiera, concepto)
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

    const [checks] = await pool.query('SELECT num_op, monto_facturado, anticipo, ok FROM facturacion_af_check WHERE mes=? AND concepto=? AND financiera=?', [mes, concepto, fin]);
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
        anticipo: chk && chk.anticipo != null ? +chk.anticipo : null,
      };
    });
    // UAC: cuadro anticipo / por facturar
    let uac = null;
    if (esUAC) {
      // Cuadros calculados en vivo desde el detalle: anticipo por operación (día ~15,
      // tier al liquidar) + facturado al cierre. Se actualizan a medida que avanza el mes.
      const total = data.reduce((a, r) => a + (+r.comision || 0), 0);
      const antTot = data.reduce((a, r) => a + (+r.anticipo || 0), 0);
      const factTot = data.reduce((a, r) => a + (+r.monto_facturado || 0), 0);
      uac = { total_nuestro: total, anticipo_total: antTot, por_facturar: total - antTot,
              pagado_real: antTot + factTot, diferencia: antTot + factTot - total };
    }
    const [sols] = await pool.query('SELECT concepto, monto, usuario, created_at FROM facturacion_af_solicitudes WHERE mes=? AND financiera=?', [mes, fin]);
    const solicitudes = {}; sols.forEach(x => solicitudes[x.concepto] = x);
    res.json({ success: true, data: { ops: data, uac, solicitudes }, error: null });
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
    // Anticipo bloqueado tras solicitar su facturación (UAC)
    if (b.anticipo !== undefined && fin.includes('UNIDAD')) {
      const [[sol]] = await pool.query("SELECT id FROM facturacion_af_solicitudes WHERE mes=? AND financiera=? AND concepto='ANTICIPO'", [mes, fin]);
      if (sol) return res.status(409).json({ success: false, data: null, error: 'El anticipo ya fue enviado a facturar: no se puede modificar' });
    }
    const usuario = ((req.usuario.nombre || '') + ' ' + (req.usuario.apellido || '')).trim() || req.usuario.email || '';
    await pool.query(`
      INSERT INTO facturacion_af_check (mes, financiera, concepto, num_op, monto_calculado, monto_facturado, anticipo, ok, usuario)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE monto_calculado=VALUES(monto_calculado), monto_facturado=VALUES(monto_facturado), anticipo=VALUES(anticipo), ok=VALUES(ok), usuario=VALUES(usuario)`,
      [mes, fin, concepto, numOp, b.monto_calculado != null ? Math.round(+b.monto_calculado) : null,
       b.monto_facturado != null && b.monto_facturado !== '' ? Math.round(+b.monto_facturado) : null,
       b.anticipo != null && b.anticipo !== '' ? Math.round(+b.anticipo) : null, b.ok ? 1 : 0, usuario]);
    res.json({ success: true, data: null, error: null });
  } catch (e) { errSrv(res, e, 'factAF check'); }
};

/* ── POST /api/facturacion-af/solicitar — mail a Contabilidad para facturar ──
   AutoFin (COLOCACION/SEGUROS): requiere TODAS las ops con monto facturado.
   UAC (ANTICIPO): una sola vez; tras solicitar, los anticipos quedan bloqueados. */
exports.solicitar = async (req, res) => {
  try {
    const b = req.body || {};
    const mes = String(b.mes || '').slice(0, 7);
    const fin = String(b.financiera || '').toUpperCase();
    const concepto = ['COLOCACION', 'SEGUROS', 'ANTICIPO'].includes(String(b.concepto).toUpperCase()) ? String(b.concepto).toUpperCase() : null;
    if (!/^\d{4}-\d{2}$/.test(mes) || !concepto || !['AUTOFIN', 'UNIDAD DE CREDITO'].includes(fin))
      return res.status(400).json({ success: false, data: null, error: 'Parámetros inválidos' });
    const [[ya]] = await pool.query('SELECT id, created_at, usuario FROM facturacion_af_solicitudes WHERE mes=? AND financiera=? AND concepto=?', [mes, fin, concepto]);
    if (ya) return res.status(409).json({ success: false, data: null, error: 'Ya se solicitó facturar este concepto (' + ya.usuario + ')' });

    // Detalle a facturar
    const conceptoChk = concepto === 'ANTICIPO' ? 'COLOCACION' : concepto;
    const [rows] = await pool.query(`
      SELECT k.num_op, k.monto_facturado, k.anticipo, COALESCE(cl.nombre_completo,'') cliente
      FROM facturacion_af_check k
      LEFT JOIN creditos c ON c.num_op = k.num_op
      LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
      WHERE k.mes=? AND k.financiera=? AND k.concepto=?
      ORDER BY k.num_op`, [mes, fin, conceptoChk]);
    const [[{ totalOps }]] = await pool.query(
      `SELECT COUNT(*) totalOps FROM creditos WHERE ${BASE} AND DATE_FORMAT(mes,'%Y-%m')=? AND financiera=?`, [mes, fin]);

    let detalle, total;
    if (concepto === 'ANTICIPO') {
      detalle = rows.filter(r => r.anticipo != null && +r.anticipo > 0).map(r => ({ num_op: r.num_op, cliente: r.cliente, monto: +r.anticipo }));
      if (!detalle.length) return res.status(400).json({ success: false, data: null, error: 'No hay anticipos digitados' });
    } else {
      detalle = rows.filter(r => r.monto_facturado != null).map(r => ({ num_op: r.num_op, cliente: r.cliente, monto: +r.monto_facturado }));
      if (detalle.length < totalOps)
        return res.status(400).json({ success: false, data: null, error: `Faltan operaciones por revisar (${detalle.length}/${totalOps})` });
    }
    total = detalle.reduce((a, r) => a + r.monto, 0);

    const CLP = n => '$' + Math.round(+n || 0).toLocaleString('es-CL');
    const MESN = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const mesTxt = MESN[+mes.slice(5, 7)] + ' ' + mes.slice(0, 4);
    const finTxt = fin === 'AUTOFIN' ? 'AutoFin' : 'Unidad de Crédito';
    const CONC = { COLOCACION: 'comisiones por colocación de créditos', SEGUROS: 'comisión por colocación de seguros', ANTICIPO: 'ANTICIPO de comisiones por colocación de créditos (liquidación día 15)' };
    const usuario = ((req.usuario.nombre || '') + ' ' + (req.usuario.apellido || '')).trim() || req.usuario.email || '';

    const filas = detalle.map(d => `<tr><td style="padding:4px 8px;border:1px solid #e5e7eb">${d.num_op}</td><td style="padding:4px 8px;border:1px solid #e5e7eb">${d.cliente}</td><td style="padding:4px 8px;border:1px solid #e5e7eb;text-align:right">${CLP(d.monto)}</td></tr>`).join('');
    const cuerpo = `
      <p>Estimados,</p>
      <p>Solicitamos <b>facturar el monto de ${CLP(total)}</b> por concepto de <b>${CONC[concepto]}</b> a <b>${finTxt}</b> del mes de <b>${mesTxt}</b>.</p>
      <p style="font-size:13px">Detalle de las ${detalle.length} operaciones:</p>
      <table style="border-collapse:collapse;font-size:12px;width:100%">
        <tr style="background:#f1f5f9"><th style="padding:4px 8px;border:1px solid #e5e7eb;text-align:left">N° Operación</th><th style="padding:4px 8px;border:1px solid #e5e7eb;text-align:left">Cliente</th><th style="padding:4px 8px;border:1px solid #e5e7eb;text-align:right">Monto</th></tr>
        ${filas}
        <tr style="background:#f8fafc;font-weight:700"><td colspan="2" style="padding:4px 8px;border:1px solid #e5e7eb">TOTAL</td><td style="padding:4px 8px;border:1px solid #e5e7eb;text-align:right">${CLP(total)}</td></tr>
      </table>
      <p style="margin-top:14px;font-size:11px;color:#94a3b8">Solicitado por ${usuario} — Business Suite</p>`;
    const { enviarCorreo, envolverHTML } = require('../../../../shared/mailer');
    await enviarCorreo({
      to: 'grupo.contabilidad@autofacilchile.cl',
      subject: `Solicitud de facturación — ${CONC[concepto]} ${finTxt} · ${mesTxt} · ${CLP(total)}`,
      html: envolverHTML(cuerpo),
    });

    await pool.query('INSERT INTO facturacion_af_solicitudes (mes, financiera, concepto, monto, ops, usuario) VALUES (?,?,?,?,?,?)',
      [mes, fin, concepto, total, detalle.length, usuario]);
    res.json({ success: true, data: { total, ops: detalle.length }, error: null });
  } catch (e) { errSrv(res, e, 'factAF solicitar'); }
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
