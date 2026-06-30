'use strict';
/* ════════════════════════════════════════════════════════════════════════
   Módulo Certificados (constancias) — Fase 2.
   Genera los certificados estándar que piden los clientes, tomando los datos
   del sistema (creditos, cuotas_credito, clientes) y registrando cada uno en
   el núcleo de verificación (shared/verificacion.js) → cada certificado lleva
   un QR público que confirma su autenticidad.
   Tipos: CERT_CREDITO_VIGENTE, CERT_PREPAGO, CERT_ALZAMIENTO, CERT_PAGO_CUOTA,
          CERT_PREAPROBADO.
   ════════════════════════════════════════════════════════════════════════ */
const pool = require('../../../../shared/config/database');
const { registrarVerificable, anularVerificable } = require('../../../../shared/verificacion');
const { auditar } = require('../../../../shared/audit');
// Lógica canónica de cobranza (interés por mora + gastos de cobranza, parametrizables).
const { _calc: COB } = require('../../../cobranza/src/controllers/cobranza.controller');
// Motor único de cuota francesa (isomorfo) — máxima: un solo motor por cálculo.
const core = require('../../../../api-gateway/public/js/rentabilidad-core');

/* ── Schema + auto-registro del módulo (sin hardcode en el frontend) ─────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS certificados (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        codigo      VARCHAR(40)  NOT NULL,
        tipo        VARCHAR(40)  NOT NULL,
        num_op      INT          NULL,
        rut         VARCHAR(20)  NULL,
        nombre      VARCHAR(200) NULL,
        datos_json  LONGTEXT     NULL,
        emitido_por VARCHAR(200) NULL,
        id_usuario  INT          NULL,
        anulado     TINYINT(1)   DEFAULT 0,
        created_at  DATETIME     DEFAULT NOW(),
        INDEX idx_codigo (codigo),
        INDEX idx_numop  (num_op),
        INDEX idx_tipo   (tipo)
      )`);

    await pool.query(
      `INSERT IGNORE INTO modulos (id_modulo, nombre, descripcion, icono, ruta, orden, estado)
       VALUES (410001, 'Certificados', 'Emisión de certificados (constancias) con código QR de verificación: crédito vigente, prepago, alzamiento de prenda, pago de cuota y crédito preaprobado', 'bi-patch-check', '/certificados/', 108, 'activo')`);
    const funcs = [
      ['Emitir Certificados',  'certificados_emitir',  '/certificados/', 'bi-patch-check'],
      ['Anular Certificado',   'certificados_anular',  null,             'bi-x-octagon'],
    ];
    const idFunc = {};
    for (const [nombre, codigo, href, icono] of funcs) {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [codigo]);
      if (ex) { idFunc[codigo] = ex.id_funcionalidad; continue; }
      const [r] = await pool.query(
        `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (410001,?,?,?,?)`,
        [nombre, codigo, href, icono]);
      idFunc[codigo] = r.insertId;
    }
    for (const codigo of Object.keys(idFunc)) {
      const idf = idFunc[codigo];
      const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=1 AND id_funcionalidad=? LIMIT 1', [idf]);
      if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idf]);
    }

    // Textos editables de los certificados (mantenedor)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS certificados_textos (
        tipo        VARCHAR(40) PRIMARY KEY,
        titulo      VARCHAR(120) NULL,
        cuerpo      TEXT NULL,
        updated_at  DATETIME DEFAULT NOW() ON UPDATE NOW(),
        updated_por VARCHAR(120) NULL
      )`);
    for (const [tipo, cuerpo] of Object.entries(DEFAULT_TEXTOS)) {
      // Siembra; y re-sincroniza el texto por defecto solo si el admin no lo ha editado.
      await pool.query(
        `INSERT INTO certificados_textos (tipo, titulo, cuerpo) VALUES (?,?,?)
         ON DUPLICATE KEY UPDATE cuerpo = IF(updated_por IS NULL, VALUES(cuerpo), cuerpo), titulo = VALUES(titulo)`,
        [tipo, TIPOS[tipo] || 'Párrafo de cierre (común)', cuerpo]);
    }
    // Mantenedor de textos → funcionalidad bajo Mantenedores (módulo 30001)
    const [[exm]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='certificados_textos' LIMIT 1");
    let idm = exm && exm.id_funcionalidad;
    if (!idm) {
      const [rr] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (30001,?,?,?,?)",
        ['Textos de Certificados', 'certificados_textos', '/mantenedores/certificados-textos/', 'bi-file-earmark-text']);
      idm = rr.insertId;
    }
    const [[ppm]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=1 AND id_funcionalidad=? LIMIT 1', [idm]);
    if (!ppm) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idm]);

    console.log('✓ certificados: módulo + tabla + textos listos');
  } catch (e) { console.error('[certificados migration]', e.message); }
})();

/* ── Helpers ────────────────────────────────────────────────────────────── */
const N = v => (v == null || v === '') ? 0 : Number(v);
const iso = d => d ? new Date(d).toISOString().slice(0, 10) : null;

const TIPOS = {
  CERT_CREDITO_VIGENTE: 'Certificado de Crédito Vigente',
  CERT_PREPAGO:         'Certificado de Prepago',
  CERT_ALZAMIENTO:      'Certificado de Alzamiento de Prenda',
  CERT_PAGO_CUOTA:      'Certificado de Pago de Cuota',
  CERT_DEUDA_VIGENTE:   'Certificado de Deuda Vigente',
  CERT_DEUDA_PREPAGO:   'Certificado de Deuda Vigente para Prepago',
  CERT_PREAPROBADO:     'Certificado de Crédito Preaprobado',
};
// Estos certificados son SOLO para clientes AutoFácil (cartera propia), no Brokerage.
const SOLO_AUTOFACIL = new Set(['CERT_CREDITO_VIGENTE', 'CERT_PREPAGO', 'CERT_PAGO_CUOTA', 'CERT_DEUDA_VIGENTE', 'CERT_DEUDA_PREPAGO']);

/* ── Motor de plantillas (textos editables desde el mantenedor) ─────────── */
const escH = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtMoney = v => '$' + String(Math.round(N(v))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
function rutPuntos(r) {
  const s = String(r || '').replace(/[^0-9kK]/g, '').toUpperCase();
  if (s.length < 2) return r || '';
  return s.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + '-' + s.slice(-1);
}
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function fechaLargaES(isoStr) { if (!isoStr) return '—'; const [y, m, d] = String(isoStr).slice(0, 10).split('-').map(Number); return `${d} de ${MESES[m - 1]} de ${y}`; }
function addDiasLargo(isoStr, n) { const dt = new Date(String(isoStr).slice(0, 10) + 'T00:00:00'); dt.setDate(dt.getDate() + (n || 0)); return fechaLargaES(dt.toISOString().slice(0, 10)); }
function renderTpl(tpl, vars) { return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars) ? String(vars[k] == null ? '' : vars[k]) : m); }

// Plantillas por defecto (se siembran; el admin las edita en el mantenedor).
const DEFAULT_TEXTOS = {
  CERT_CREDITO_VIGENTE: 'AutoFácil Chile certifica que <b>{nombre}</b>, RUT <b>{rut}</b>, mantiene <b>vigente</b> el crédito automotriz N° <b>{num_op}</b>, otorgado con fecha {fecha_otorgado}, asociado al vehículo <b>{vehiculo}</b>. A la fecha registra <b>{cuotas_pagadas}</b> de <b>{cuotas_total}</b> cuotas pagadas, con un saldo insoluto de <b>{saldo}</b> y una cuota mensual de <b>{cuota_mensual}</b>.',
  CERT_PREPAGO:         'AutoFácil Chile certifica que el crédito automotriz N° <b>{num_op}</b>, de <b>{nombre}</b>, RUT <b>{rut}</b>, asociado al vehículo <b>{vehiculo}</b>, fue <b>PREPAGADO</b> (pagado en su totalidad) con fecha <b>{fecha_prepago}</b>. El cliente <b>no registra saldos pendientes</b> por este crédito.',
  CERT_ALZAMIENTO:      'Habiéndose pagado íntegramente el crédito automotriz N° <b>{num_op}</b> de <b>{nombre}</b>, RUT <b>{rut}</b>, AutoFácil Chile autoriza y certifica el <b>ALZAMIENTO DE LA PRENDA</b> que afecta al vehículo <b>{vehiculo}</b>. Fecha del pago final: <b>{fecha_prepago}</b>.',
  CERT_PAGO_CUOTA:      'AutoFácil Chile certifica que, respecto del crédito automotriz N° <b>{num_op}</b> de <b>{nombre}</b>, RUT <b>{rut}</b>, la <b>cuota N° {numero_cuota}</b> (vencimiento {fecha_vencimiento}) fue <b>pagada</b> con fecha <b>{fecha_pago}</b> por un monto de <b>{monto_cuota}</b>.',
  CERT_DEUDA_VIGENTE:   'AutoFácil Chile certifica que <b>{nombre}</b>, RUT <b>{rut}</b>, mantiene una <b>deuda vigente</b> de <b>{saldo}</b> por el crédito automotriz N° <b>{num_op}</b>, asociado al vehículo <b>{vehiculo}</b>, correspondiente a <b>{cuotas_pendientes}</b> cuotas pendientes de un total de <b>{cuotas_total}</b>.',
  CERT_DEUDA_PREPAGO:   'AutoFácil Chile certifica que, al día de hoy, el monto requerido para <b>prepagar (saldar)</b> íntegramente el crédito automotriz N° <b>{num_op}</b> de <b>{nombre}</b>, RUT <b>{rut}</b>, asociado al vehículo <b>{vehiculo}</b>, asciende a <b>{saldo}</b>, de acuerdo al siguiente detalle:',
  CERT_PREAPROBADO:     'AutoFácil Chile certifica que <b>{nombre}</b>, RUT <b>{rut}</b>, cuenta con un crédito automotriz <b>PREAPROBADO</b>{fin_parens} según la carta de aprobación N° <b>{op_carta}</b>, bajo las siguientes condiciones: vehículo <b>{vehiculo}</b>{patente_txt}; precio del vehículo <b>{precio}</b>; pie <b>{pie}</b>; saldo precio a financiar <b>{saldo_precio}</b>; plazo <b>{plazo}</b> cuotas{tasa_txt}{monto_txt}. La presente oferta tiene una <b>vigencia de {vigencia} días corridos</b> a contar de la fecha de emisión (vence el <b>{vence}</b>).',
  CIERRE:               'Se emite el presente certificado a solicitud de <b>{nombre}</b> para los fines que estime convenientes, sin ulterior responsabilidad para Auto Fácil SpA.',
};

// Arma el mapa de placeholders (todo pre-formateado: RUT con puntos, montos $#.###).
function buildVars(out, fechaEmisionISO) {
  const c = out.credito || {}, x = out.datos || {};
  const fin = String(x.financiera || c.financiera || '').toUpperCase();
  const finParens = (fin && fin !== 'AUTOFACIL') ? ` (${escH(fin)})` : '';
  const fe = fechaEmisionISO || iso(new Date());
  return {
    nombre: escH(out.nombre), rut: rutPuntos(out.rut), num_op: out.num_op || '',
    financiera: escH(fin), vehiculo: escH(c.vehiculo || x.vehiculo || ''),
    fecha_otorgado: c.fecha_otorgado || '—',
    cuotas_pagadas: x.cuotas_pagadas != null ? x.cuotas_pagadas : '', cuotas_total: x.cuotas_total != null ? x.cuotas_total : '',
    cuotas_pendientes: x.cuotas_pendientes != null ? x.cuotas_pendientes : '',
    saldo: fmtMoney(x.saldo_insoluto), cuota_mensual: fmtMoney(x.cuota_mensual),
    fecha_prepago: x.fecha_prepago || x.fecha_pago_final || '—', monto_financiado: fmtMoney(x.monto_financiado),
    numero_cuota: x.numero_cuota || '', fecha_vencimiento: x.fecha_vencimiento || '—', fecha_pago: x.fecha_pago || '—', monto_cuota: fmtMoney(x.monto),
    op_carta: escH(x.op_carta || ''), precio: fmtMoney(x.precio_venta), pie: fmtMoney(x.pie), saldo_precio: fmtMoney(x.saldo_precio),
    plazo: x.plazo != null ? x.plazo : '', tasa: x.tasa != null ? x.tasa : '', monto_credito: fmtMoney(x.monto_credito),
    fin_parens: finParens,
    patente_txt: x.patente ? `, patente <b>${escH(x.patente)}</b>` : '',
    tasa_txt: x.tasa != null ? `; tasa <b>${x.tasa}%</b> mensual` : '',
    monto_txt: x.monto_credito ? `; monto del crédito <b>${fmtMoney(x.monto_credito)}</b>` : '',
    vigencia: x.vigencia_dias || 5, vence: addDiasLargo(fe, x.vigencia_dias || 5),
    // desglose de la liquidación de prepago
    capital_vigente: fmtMoney(x.capital_vigente), mora_cuotas: fmtMoney(x.mora_cuotas),
    interes_mora: fmtMoney(x.interes_mora), gastos_cobranza: fmtMoney(x.gastos_cobranza),
    interes_corriente: fmtMoney(x.interes_corriente), comision_prepago: fmtMoney(x.comision_prepago),
  };
}

// Próximos N días hábiles (salta fines de semana y feriados de la tabla).
async function proxDiasHabiles(fromISO, n) {
  let feriados = new Set();
  try { const [f] = await pool.query("SELECT DATE_FORMAT(fecha,'%Y-%m-%d') f FROM feriados"); feriados = new Set(f.map(x => x.f)); } catch (_) {}
  const out = []; const d = new Date(fromISO + 'T00:00:00');
  while (out.length < n) {
    d.setDate(d.getDate() + 1);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dow = d.getDay();
    if (dow === 0 || dow === 6 || feriados.has(iso)) continue;
    out.push(iso);
  }
  return out;
}

// Bloque del desglose de prepago: solo ítems con saldo + recuadro de 3 días hábiles.
function detallePrepagoHTML(x) {
  if (!x) return '';
  const items = [
    ['Capital de cuotas vigentes', x.capital_vigente],
    ['Cuotas en mora', x.mora_cuotas],
    ['Interés por mora', x.interes_mora],
    ['Gastos de cobranza', x.gastos_cobranza],
    ['Intereses corrientes', x.interes_corriente],
    ['Comisión de prepago', x.comision_prepago],
  ].filter(([, v]) => N(v) > 0);
  const filas = items.map(([k, v]) => `<tr><td style="padding:4px 0;color:#475569">${k}</td><td style="padding:4px 0;text-align:right;font-weight:600">${fmtMoney(v)}</td></tr>`).join('');
  const proy = (x.proyeccion || []).map(p => `<tr><td style="padding:3px 12px;color:#475569">${fechaLargaES(p.fecha)}</td><td style="padding:3px 12px;text-align:right;font-weight:700;color:#0141A2">${fmtMoney(p.total)}</td></tr>`).join('');
  return `
    <table style="width:100%;max-width:470px;margin:14px 0 4px;font-size:.9rem;border-collapse:collapse">
      ${filas}
      <tr><td style="padding:7px 0;border-top:1.5px solid #0141A2;font-weight:800;color:#0f172a">Total a prepagar</td><td style="padding:7px 0;border-top:1.5px solid #0141A2;text-align:right;font-weight:800;color:#0141A2">${fmtMoney(x.saldo_insoluto)}</td></tr>
    </table>
    ${proy ? `<div style="margin-top:16px;border:1px solid #cbd5e1;border-radius:10px;padding:12px 16px;max-width:470px;background:#f8fafc">
      <div style="font-weight:700;font-size:.82rem;color:#0141A2;margin-bottom:6px">Monto a prepagar — próximos 3 días hábiles</div>
      <table style="width:100%;border-collapse:collapse;font-size:.87rem">${proy}</table>
    </div>` : ''}`;
}

// Renderiza el cuerpo + el párrafo de cierre desde las plantillas de BD.
async function renderCuerpo(out, fechaEmisionISO) {
  const [[t]] = await pool.query('SELECT cuerpo FROM certificados_textos WHERE tipo=? LIMIT 1', [out.tipo]);
  const [[cierre]] = await pool.query("SELECT cuerpo FROM certificados_textos WHERE tipo='CIERRE' LIMIT 1");
  const v = buildVars(out, fechaEmisionISO);
  return {
    cuerpo_html: renderTpl((t && t.cuerpo) || DEFAULT_TEXTOS[out.tipo] || '', v),
    cierre_html: renderTpl((cierre && cierre.cuerpo) || DEFAULT_TEXTOS.CIERRE, v),
    detalle_html: out.tipo === 'CERT_DEUDA_PREPAGO' ? detallePrepagoHTML(out.datos) : '',
  };
}

// Calendario francés sintético cuando el crédito no tiene filas en cuotas_credito.
// Mismos parámetros que /creditos/pagar-cuotas: monto_financiado, tascli_real (% mensual),
// plazo y fecha_primera_cuota → calza con lo que ve el usuario en Pago de Cuotas.
function calendarioFrancesSintetico(c) {
  const plazo = N(c.plazo), r = (N(c.tascli_real) || 0) / 100;
  const f0  = c.fecha_primera_cuota ? new Date(c.fecha_primera_cuota + 'T00:00:00') : null;
  // Tabla de desarrollo desde el motor único; acá solo se decoran fecha/estado.
  return core.tablaDesarrollo(N(c.monto_financiado), r, plazo).map(row => {
    const venc = f0 ? new Date(f0.getFullYear(), f0.getMonth() + (row.numero_cuota - 1), f0.getDate()) : null;
    return {
      numero_cuota: row.numero_cuota,
      venc: venc ? venc.toISOString().slice(0, 10) : null,
      valor_cuota: row.valor_cuota, interes: row.interes, amortizacion: row.amortizacion,
      tasa: r * 100, estado_cuota: 'PENDIENTE', fpago: null, saldo_insoluto: row.saldo_insoluto,
    };
  });
}

// Contexto del crédito + su calendario real (cuotas_credito si existe).
async function ctxCredito(num_op) {
  const [[c]] = await pool.query(
    `SELECT c.id, c.num_op, c.numero_credito, c.financiera, c.estado, c.estado_cartera,
            c.plazo, DATE_FORMAT(c.fecha_otorgado,'%Y-%m-%d') fecha_otorgado,
            c.monto_financiado, c.saldo_precio, c.tascli_real, c.cuota, c.marca, c.modelo, c.anio, c.tipo_vehiculo, c.valor_vehiculo,
            DATE_FORMAT(c.fecha_primera_cuota,'%Y-%m-%d') fecha_primera_cuota,
            cl.rut, cl.nombre_completo nombre, cl.direccion
       FROM creditos c JOIN clientes cl ON cl.id_cliente=c.id_cliente
      WHERE c.num_op=? LIMIT 1`, [num_op]);
  if (!c) return null;
  let [cuotas] = await pool.query(
    `SELECT numero_cuota, DATE_FORMAT(fecha_vencimiento,'%Y-%m-%d') venc, valor_cuota,
            interes, amortizacion, tasa,
            estado_cuota, DATE_FORMAT(fecha_pago,'%Y-%m-%d') fpago, saldo_insoluto
       FROM cuotas_credito WHERE id_credito=? ORDER BY numero_cuota`, [c.id]);
  // Sin calendario real → calendario francés sintético (mismos parámetros que
  // /creditos/pagar-cuotas) + pagos reales registrados en pagos_credito.
  if (!cuotas.length) {
    cuotas = calendarioFrancesSintetico(c);
    if (cuotas.length) {
      const [pgs] = await pool.query(
        `SELECT numero_cuota, DATE_FORMAT(fecha_pago,'%Y-%m-%d') fpago
           FROM pagos_credito WHERE id_credito=? AND estado_pago='PAGADO'`, [c.id]);
      const pagMap = new Map(pgs.map(p => [N(p.numero_cuota), p.fpago]));
      cuotas.forEach(q => { if (pagMap.has(q.numero_cuota)) { q.estado_cuota = 'PAGADA'; q.fpago = pagMap.get(q.numero_cuota) || null; } });
    }
  }
  // métricas de cartera
  const total    = cuotas.length || N(c.plazo);
  const pagadas  = cuotas.filter(q => q.estado_cuota === 'PAGADA').length;
  const impagas  = cuotas.length ? cuotas.filter(q => q.estado_cuota !== 'PAGADA').length : Math.max(total - pagadas, 0);
  const ultPagada = [...cuotas].reverse().find(q => q.fpago);
  const ultPagadaSaldo = [...cuotas].reverse().find(q => q.estado_cuota === 'PAGADA');
  const prepagado = (c.estado_cartera || '').toUpperCase() === 'PREPAGADO';
  const pagado    = prepagado || (cuotas.length > 0 && impagas === 0);
  const saldo     = pagado ? 0 : (ultPagadaSaldo ? N(ultPagadaSaldo.saldo_insoluto) : N(c.monto_financiado));
  return { c, cuotas, total, pagadas, impagas, ultPagada, prepagado, pagado, saldo };
}

const baseCredito = c => ({
  num_op: c.num_op, numero_credito: c.numero_credito, financiera: c.financiera,
  vehiculo: [c.marca, c.modelo, c.anio].filter(Boolean).join(' '),
  marca: c.marca, modelo: c.modelo, anio: c.anio, tipo_vehiculo: c.tipo_vehiculo,
  fecha_otorgado: c.fecha_otorgado, monto_financiado: N(c.monto_financiado), plazo: N(c.plazo),
});

/* ── Buscar crédito por N° Op, RUT o nombre ─────────────────────────────── */
const buscar = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ success: true, data: [], error: null });
    const rutN = q.replace(/[^0-9kK]/g, '').toUpperCase();
    const isNum = /^\d+$/.test(q);
    const [rows] = await pool.query(
      `SELECT c.num_op, c.numero_credito, c.financiera, c.estado_cartera,
              cl.rut, cl.nombre_completo nombre, c.marca, c.modelo, c.anio
         FROM creditos c JOIN clientes cl ON cl.id_cliente=c.id_cliente
        WHERE (c.num_op = ?
            OR REPLACE(REPLACE(REPLACE(cl.rut,'.',''),'-',''),' ','') LIKE ?
            OR UPPER(cl.nombre_completo) LIKE ?)
        ORDER BY c.num_op DESC LIMIT 25`,
      [isNum ? Number(q) : 0, `%${rutN}%`, `%${q.toUpperCase()}%`]);
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    console.error('[certificados buscar]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error en la búsqueda' });
  }
};

/* ── Buscar carta de aprobación (enviada/APROBADA) para preaprobado ─────── */
const buscarCarta = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ success: true, data: [], error: null });
    const rutN = q.replace(/[^0-9kK]/g, '').toUpperCase();
    const [rows] = await pool.query(
      `SELECT op_carta, cliente, rut_cliente rut, marca, modelo, anio, tipo_vehiculo,
              precio_venta, pie, saldo, plazo, acreedor
         FROM cartas_aprobacion
        WHERE status='APROBADA'
          AND (op_carta LIKE ?
            OR REPLACE(REPLACE(REPLACE(rut_cliente,'.',''),'-',''),' ','') LIKE ?
            OR UPPER(cliente) LIKE ?)
        ORDER BY id DESC LIMIT 25`,
      [`%${q}%`, `%${rutN}%`, `%${q.toUpperCase()}%`]);
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    console.error('[certificados buscarCarta]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error buscando cartas' });
  }
};

/* ── Vista previa: arma los datos del certificado SIN registrarlo ────────── */
/* ── Motor ÚNICO de prepago ─────────────────────────────────────────────────
   Calcula el monto a prepagar (saldar) de un crédito AutoFácil a la fecha de hoy:
   capital vigente + cuotas en mora + interés por mora + gastos de cobranza +
   interés corriente + comisión de prepago. Devuelve también el DETALLE por cuota
   (para que el pago en caja registre cuota por cuota). Lo usan el certificado
   CERT_DEUDA_PREPAGO y el endpoint de prepago en caja — NO duplicar (máxima #1). */
async function calcularPrepago(num_op) {
  const ctx = await ctxCredito(num_op);
  if (!ctx) throw { code: 404, msg: 'No se encontró el crédito.' };
  const { c, cuotas, pagado } = ctx;
  if (pagado) throw { code: 400, msg: 'El crédito ya está pagado/prepagado; no hay monto de prepago.' };
  if (!cuotas.length) throw { code: 400, msg: 'El crédito no tiene calendario de cuotas para calcular el prepago.' };
  const noPag = cuotas.filter(q => q.estado_cuota !== 'PAGADA');
  const tasaMes = N((noPag[0] || cuotas[0]).tasa) || N(c.tascli_real) || 0;  // % mensual
  const tasaDia = (tasaMes / 100) / 30;
  const cfg = await COB.getCobranzaConfig();
  const gastosDias = Number(cfg.gastos_dias) || 21;
  let tramosUF = []; try { tramosUF = JSON.parse(cfg.tramos_uf); } catch (_) {}
  const [tasasMora] = await pool.query("SELECT DATE_FORMAT(fecha_desde,'%Y-%m-%d') fecha_desde, DATE_FORMAT(fecha_hasta,'%Y-%m-%d') fecha_hasta, tasa_mensual_menor, tasa_mensual_mayor FROM tasas");
  let tramo = 'menor';
  try {
    const [[um]] = await pool.query("SELECT valor FROM parametros_credito WHERE clave='umbral_uf_tramo'");
    const umbral = um ? (parseFloat(um.valor) || 200) : 200;
    const ufOt = await COB.getUFporFecha(c.fecha_otorgado);
    const baseTramo = N(c.saldo_precio) || N(c.monto_financiado) || 0;
    if (ufOt > 0 && baseTramo > umbral * ufOt) tramo = 'mayor';
  } catch (_) {}

  const liquidar = async (fechaISO) => {
    const ref = new Date(fechaISO + 'T00:00:00');
    let capV = 0, moraC = 0, intMora = 0, gastos = 0, ultPasado = null, nM = 0, nV = 0;
    const detalle = [];
    for (const q of noPag) {
      const venc = q.venc ? new Date(q.venc + 'T00:00:00') : null;
      const amort = N(q.amortizacion);
      let cuMora = 0, cuGasto = 0;
      const enMora = !!(venc && venc < ref);
      if (enMora) {                                   // en mora
        nM++; moraC += N(q.valor_cuota);
        const diasMora = Math.floor((ref - venc) / 86400000);
        cuMora = (COB.calcularInteresMora(N(q.valor_cuota), q.venc, fechaISO, tramo, tasasMora).interes || 0);
        intMora += cuMora;
        if (diasMora >= gastosDias) {
          const uf = await COB.getUFporFecha(COB.addDias(q.venc, gastosDias));
          cuGasto = (COB.calcularGastoCobranza(N(q.valor_cuota), uf, tramosUF).gasto_pesos || 0);
          gastos += cuGasto;
        }
        if (!ultPasado || venc > ultPasado) ultPasado = venc;
      } else { nV++; capV += amort; }                 // vigente (futura)
      detalle.push({ numero_cuota: q.numero_cuota, fecha_vencimiento: q.venc || null,
        valor_cuota: Math.round(N(q.valor_cuota)), amortizacion: Math.round(amort),
        interes_mora: Math.round(cuMora), gastos_cobranza: Math.round(cuGasto), en_mora: enMora });
    }
    const diasCorr = ultPasado ? Math.max(0, Math.floor((ref - ultPasado) / 86400000)) : 0;
    const intCorr = capV * tasaDia * diasCorr;
    const comision = capV * (tasaMes / 100);          // un mes de interés sobre el capital vigente
    const total = capV + moraC + intMora + gastos + intCorr + comision;
    return {
      fecha: fechaISO, saldo_insoluto: Math.round(total),
      capital_vigente: Math.round(capV), mora_cuotas: Math.round(moraC),
      interes_mora: Math.round(intMora), gastos_cobranza: Math.round(gastos),
      interes_corriente: Math.round(intCorr), comision_prepago: Math.round(comision),
      dias_corrientes: diasCorr, cuotas_mora: nM, cuotas_vigentes: nV, detalle,
    };
  };
  const hoyISO = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
  const liq = await liquidar(hoyISO);
  const proyeccion = [];
  for (const f of await proxDiasHabiles(hoyISO, 3)) proyeccion.push({ fecha: f, total: (await liquidar(f)).saldo_insoluto });
  return { rut: c.rut, nombre: c.nombre, num_op, credito: c, datos: { ...liq, tasa_mensual: tasaMes, proyeccion } };
}

async function armar(tipo, body) {
  if (!TIPOS[tipo]) throw { code: 400, msg: 'Tipo de certificado inválido.' };

  // Preaprobado = sale de una CARTA DE APROBACIÓN enviada (status APROBADA),
  // con todas las condiciones del crédito. Vigencia de la oferta: 5 días.
  if (tipo === 'CERT_PREAPROBADO') {
    const op_carta = String(body.op_carta || '').trim();
    if (!op_carta) throw { code: 400, msg: 'Selecciona la carta de aprobación.' };
    const [[k]] = await pool.query(
      `SELECT op_carta, cliente, rut_cliente, tipo_vehiculo, marca, modelo, anio, patente,
              precio_venta, pie, saldo, plazo, acreedor, tasa_credito, monto_credito_clp, status
         FROM cartas_aprobacion WHERE op_carta=? LIMIT 1`, [op_carta]);
    if (!k) throw { code: 404, msg: 'No se encontró la carta de aprobación.' };
    if (k.status !== 'APROBADA') throw { code: 400, msg: 'La carta debe estar aprobada/enviada para preaprobar.' };
    const vehiculo = [k.marca, k.modelo, k.anio].filter(Boolean).join(' ');
    const datos = {
      op_carta: k.op_carta, financiera: k.acreedor,
      tipo_vehiculo: k.tipo_vehiculo, marca: k.marca, modelo: k.modelo, anio: k.anio, patente: k.patente,
      precio_venta: N(k.precio_venta), pie: N(k.pie), saldo_precio: N(k.saldo),
      plazo: N(k.plazo), tasa: k.tasa_credito != null ? Number(k.tasa_credito) : null,
      monto_credito: N(k.monto_credito_clp), vigencia_dias: 5,
    };
    return { tipo, rut: k.rut_cliente, nombre: k.cliente, num_op: null,
             datos, credito: { op_carta: k.op_carta, vehiculo, financiera: k.acreedor } };
  }

  const num_op = N(body.num_op);
  if (!num_op) throw { code: 400, msg: 'Falta el N° de Operación.' };
  const ctx = await ctxCredito(num_op);
  if (!ctx) throw { code: 404, msg: 'No se encontró el crédito.' };
  const { c, cuotas, total, pagadas, impagas, ultPagada, prepagado, pagado, saldo } = ctx;
  const cred = baseCredito(c);
  const base = { tipo, rut: c.rut, nombre: c.nombre, num_op, credito: cred };

  // Solo clientes AutoFácil (cartera propia), no Brokerage (AUTOFIN/UNIDAD).
  if (SOLO_AUTOFACIL.has(tipo) && String(c.financiera || '').toUpperCase() !== 'AUTOFACIL')
    throw { code: 400, msg: 'Este certificado es solo para clientes AutoFácil (no Brokerage).' };

  if (tipo === 'CERT_CREDITO_VIGENTE') {
    if (pagado) throw { code: 400, msg: 'El crédito no está vigente (está pagado/prepagado). Usa Prepago o Alzamiento.' };
    return { ...base, datos: { estado: 'VIGENTE', plazo: N(c.plazo), cuotas_total: total, cuotas_pagadas: pagadas, cuotas_pendientes: impagas, saldo_insoluto: saldo, cuota_mensual: N(c.cuota), fecha_otorgado: c.fecha_otorgado } };
  }
  if (tipo === 'CERT_PREPAGO') {
    if (!pagado) throw { code: 400, msg: 'El crédito no está prepagado/pagado (aún tiene cuotas pendientes).' };
    return { ...base, datos: { fecha_prepago: ultPagada ? ultPagada.fpago : null, monto_financiado: N(c.monto_financiado), plazo: N(c.plazo), cuotas_pagadas: pagadas } };
  }
  if (tipo === 'CERT_ALZAMIENTO') {
    if (!pagado) throw { code: 400, msg: 'Solo se alza la prenda de un crédito totalmente pagado.' };
    return { ...base, datos: { vehiculo: cred.vehiculo, tipo_vehiculo: c.tipo_vehiculo, fecha_pago_final: ultPagada ? ultPagada.fpago : null, valor_vehiculo: N(c.valor_vehiculo) } };
  }
  if (tipo === 'CERT_PAGO_CUOTA') {
    const ncuota = N(body.numero_cuota);
    if (!ncuota) throw { code: 400, msg: 'Indica el número de cuota.' };
    const cu = cuotas.find(q => N(q.numero_cuota) === ncuota);
    if (!cu) throw { code: 404, msg: `El crédito no tiene la cuota N° ${ncuota}.` };
    if (cu.estado_cuota !== 'PAGADA' || !cu.fpago) throw { code: 400, msg: `La cuota N° ${ncuota} no figura pagada.` };
    return { ...base, datos: { numero_cuota: ncuota, fecha_vencimiento: cu.venc, fecha_pago: cu.fpago, monto: N(cu.valor_cuota) } };
  }
  if (tipo === 'CERT_DEUDA_VIGENTE') {
    if (pagado) throw { code: 400, msg: 'El crédito no tiene deuda vigente (está pagado/prepagado).' };
    return { ...base, datos: { saldo_insoluto: saldo, cuotas_pendientes: impagas, cuotas_total: total } };
  }
  if (tipo === 'CERT_DEUDA_PREPAGO') {
    const pp = await calcularPrepago(num_op);   // motor único compartido
    return { ...base, datos: pp.datos };
  }
  throw { code: 400, msg: 'Tipo no soportado.' };
}

const preview = async (req, res) => {
  try {
    const fe = iso(new Date());
    const out = await armar(req.body.tipo, req.body);
    const txt = await renderCuerpo(out, fe);
    res.json({ success: true, data: { ...out, ...txt, tipo_label: TIPOS[out.tipo], fecha_emision: fe }, error: null });
  } catch (e) {
    if (e && e.code) return res.status(e.code).json({ success: false, data: null, error: e.msg });
    console.error('[certificados preview]', e);
    res.status(500).json({ success: false, data: null, error: 'Error armando el certificado' });
  }
};

/* ── Generar: arma + registra verificable + guarda ──────────────────────── */
const generar = async (req, res) => {
  try {
    const feISO = iso(new Date());
    const out = await armar(req.body.tipo, req.body);
    const txt = await renderCuerpo(out, feISO);   // texto en duro al momento de emitir
    const emisor = (req.usuario && (`${req.usuario.nombre || ''} ${req.usuario.apellido || ''}`).trim()) || 'Sistema';
    // ref único por tipo+operación(+cuota): re-emitir devuelve el MISMO código/QR
    const refId = out.num_op
      ? `${out.tipo}:${out.num_op}${out.datos.numero_cuota ? ':' + out.datos.numero_cuota : ''}`
      : (out.datos && out.datos.op_carta ? `${out.tipo}:${out.datos.op_carta}` : `${out.tipo}:${out.rut}:${Date.now()}`);
    const codigo = await registrarVerificable({
      tipo: out.tipo, ref_tabla: 'certificados', ref_id: refId,
      num_op: out.num_op, rut: out.rut, nombre: out.nombre, datos: out.datos, emitido_por: emisor,
    });
    // Snapshot COMPLETO "en duro" (inmutable): se guarda todo lo necesario para
    // re-ver el documento idéntico aunque cambie el crédito después.
    const snapshot = {
      tipo: out.tipo, tipo_label: TIPOS[out.tipo], num_op: out.num_op,
      rut: out.rut, nombre: out.nombre, credito: out.credito, datos: out.datos, emitido_por: emisor,
      cuerpo_html: txt.cuerpo_html, cierre_html: txt.cierre_html,
    };
    // registro propio (idempotente por codigo)
    const [[ex]] = await pool.query('SELECT id FROM certificados WHERE codigo=? LIMIT 1', [codigo]);
    if (ex) {
      await pool.query('UPDATE certificados SET datos_json=?, anulado=0 WHERE codigo=?', [JSON.stringify(snapshot), codigo]);
    } else {
      await pool.query(
        `INSERT INTO certificados (codigo, tipo, num_op, rut, nombre, datos_json, emitido_por, id_usuario)
         VALUES (?,?,?,?,?,?,?,?)`,
        [codigo, out.tipo, out.num_op, out.rut, out.nombre, JSON.stringify(snapshot), emisor, req.usuario && req.usuario.id_usuario]);
    }
    try { auditar({ req, accion: 'EMITIR', modulo: 'certificados', entidad: out.tipo, entidad_id: codigo, detalle: `${TIPOS[out.tipo]} — ${out.nombre || ''} (op ${out.num_op || '—'})` }); } catch (_) {}
    res.json({ success: true, data: { ...out, ...txt, codigo, tipo_label: TIPOS[out.tipo], emitido_por: emisor, fecha_emision: feISO }, error: null });
  } catch (e) {
    if (e && e.code) return res.status(e.code).json({ success: false, data: null, error: e.msg });
    console.error('[certificados generar]', e);
    res.status(500).json({ success: false, data: null, error: 'Error generando el certificado' });
  }
};

/* ── Historial ──────────────────────────────────────────────────────────── */
const historial = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT codigo, tipo, num_op, rut, nombre, emitido_por, anulado,
              DATE_FORMAT(created_at,'%Y-%m-%d %H:%i') created_at
         FROM certificados ORDER BY id DESC LIMIT 200`);
    res.json({ success: true, data: rows.map(r => ({ ...r, tipo_label: TIPOS[r.tipo] || r.tipo })), error: null });
  } catch (e) {
    console.error('[certificados historial]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error cargando el historial' });
  }
};

/* ── Ver un certificado emitido (snapshot en duro, inmutable) ───────────── */
const ver = async (req, res) => {
  try {
    const [[r]] = await pool.query(
      `SELECT codigo, tipo, num_op, rut, nombre, datos_json, emitido_por, anulado,
              DATE_FORMAT(created_at,'%Y-%m-%d') fecha_emision
         FROM certificados WHERE codigo=? LIMIT 1`, [req.params.codigo]);
    if (!r) return res.status(404).json({ success: false, data: null, error: 'Certificado no encontrado' });
    let snap = {}; try { snap = r.datos_json ? JSON.parse(r.datos_json) : {}; } catch (_) {}
    // Registros viejos (sin snapshot completo): reconstruye desde el origen.
    if (!snap.nombre && !snap.credito) {
      try {
        const o = await armar(r.tipo, { num_op: r.num_op, op_carta: snap.op_carta, numero_cuota: snap.numero_cuota });
        snap = { ...o, tipo_label: TIPOS[o.tipo] };
      } catch (_) { snap = { ...snap, nombre: r.nombre, rut: r.rut, num_op: r.num_op }; }
    }
    // Si no tiene el texto renderizado (anterior al motor de plantillas), lo genera.
    if (!snap.cuerpo_html && snap.datos) {
      try {
        const txt = await renderCuerpo({ tipo: r.tipo, credito: snap.credito, datos: snap.datos, nombre: snap.nombre, rut: snap.rut, num_op: snap.num_op }, r.fecha_emision);
        snap.cuerpo_html = txt.cuerpo_html; snap.cierre_html = txt.cierre_html;
      } catch (_) {}
    }
    // El desglose del prepago se deriva del snapshot de datos (inmutable).
    if (r.tipo === 'CERT_DEUDA_PREPAGO' && snap.datos && !snap.detalle_html) snap.detalle_html = detallePrepagoHTML(snap.datos);
    res.json({ success: true, data: { ...snap, codigo: r.codigo, tipo: r.tipo, tipo_label: snap.tipo_label || TIPOS[r.tipo] || r.tipo, emitido_por: snap.emitido_por || r.emitido_por, fecha_emision: r.fecha_emision, anulado: !!r.anulado }, error: null });
  } catch (e) {
    console.error('[certificados ver]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error abriendo el certificado' });
  }
};

/* ── Anular ─────────────────────────────────────────────────────────────── */
const anular = async (req, res) => {
  try {
    const { codigo } = req.params;
    const motivo = (req.body && req.body.motivo) || 'Anulado por el emisor';
    await pool.query('UPDATE certificados SET anulado=1 WHERE codigo=?', [codigo]);
    await anularVerificable(codigo, motivo);
    try { auditar({ req, accion: 'ANULAR', modulo: 'certificados', entidad_id: codigo, detalle: motivo }); } catch (_) {}
    res.json({ success: true, data: { codigo, anulado: true }, error: null });
  } catch (e) {
    console.error('[certificados anular]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error anulando el certificado' });
  }
};

/* ── Mantenedor de textos ───────────────────────────────────────────────── */
const ORDEN_TEXTOS = ['CERT_CREDITO_VIGENTE', 'CERT_PREPAGO', 'CERT_ALZAMIENTO', 'CERT_PAGO_CUOTA', 'CERT_DEUDA_VIGENTE', 'CERT_DEUDA_PREPAGO', 'CERT_PREAPROBADO', 'CIERRE'];
const getTextos = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT tipo, titulo, cuerpo, DATE_FORMAT(updated_at,"%Y-%m-%d %H:%i") updated_at, updated_por FROM certificados_textos');
    rows.sort((a, b) => ORDEN_TEXTOS.indexOf(a.tipo) - ORDEN_TEXTOS.indexOf(b.tipo));
    res.json({ success: true, data: rows, error: null });
  } catch (e) { console.error('[certificados getTextos]', e.message); res.status(500).json({ success: false, data: null, error: 'Error cargando textos' }); }
};
const updateTexto = async (req, res) => {
  try {
    const tipo = req.params.tipo;
    const { cuerpo, titulo } = req.body || {};
    if (!cuerpo || !String(cuerpo).trim()) return res.status(400).json({ success: false, data: null, error: 'El texto no puede estar vacío.' });
    const emisor = (req.usuario && (`${req.usuario.nombre || ''} ${req.usuario.apellido || ''}`).trim()) || 'Sistema';
    const [r] = await pool.query('UPDATE certificados_textos SET cuerpo=?, titulo=COALESCE(?,titulo), updated_por=? WHERE tipo=?', [String(cuerpo), titulo || null, emisor, tipo]);
    if (!r.affectedRows) return res.status(404).json({ success: false, data: null, error: 'Tipo no encontrado.' });
    try { auditar({ req, accion: 'EDITAR', modulo: 'certificados', entidad: 'texto', entidad_id: tipo, detalle: `Editó texto ${tipo}` }); } catch (_) {}
    res.json({ success: true, data: { tipo }, error: null });
  } catch (e) { console.error('[certificados updateTexto]', e.message); res.status(500).json({ success: false, data: null, error: 'Error guardando el texto' }); }
};

module.exports = { buscar, buscarCarta, preview, generar, historial, ver, anular, getTextos, updateTexto, calcularPrepago };
