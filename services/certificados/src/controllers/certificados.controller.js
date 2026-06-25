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
    console.log('✓ certificados: módulo + tabla listos');
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
  CERT_PREAPROBADO:     'Certificado de Crédito Preaprobado',
};

// Contexto del crédito + su calendario real (cuotas_credito si existe).
async function ctxCredito(num_op) {
  const [[c]] = await pool.query(
    `SELECT c.id, c.num_op, c.numero_credito, c.financiera, c.estado, c.estado_cartera,
            c.plazo, DATE_FORMAT(c.fecha_otorgado,'%Y-%m-%d') fecha_otorgado,
            c.monto_financiado, c.cuota, c.marca, c.modelo, c.anio, c.tipo_vehiculo, c.valor_vehiculo,
            cl.rut, cl.nombre_completo nombre, cl.direccion
       FROM creditos c JOIN clientes cl ON cl.id_cliente=c.id_cliente
      WHERE c.num_op=? LIMIT 1`, [num_op]);
  if (!c) return null;
  const [cuotas] = await pool.query(
    `SELECT numero_cuota, DATE_FORMAT(fecha_vencimiento,'%Y-%m-%d') venc, valor_cuota,
            estado_cuota, DATE_FORMAT(fecha_pago,'%Y-%m-%d') fpago, saldo_insoluto
       FROM cuotas_credito WHERE id_credito=? ORDER BY numero_cuota`, [c.id]);
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
  throw { code: 400, msg: 'Tipo no soportado.' };
}

const preview = async (req, res) => {
  try {
    const out = await armar(req.body.tipo, req.body);
    res.json({ success: true, data: { ...out, tipo_label: TIPOS[out.tipo] }, error: null });
  } catch (e) {
    if (e && e.code) return res.status(e.code).json({ success: false, data: null, error: e.msg });
    console.error('[certificados preview]', e);
    res.status(500).json({ success: false, data: null, error: 'Error armando el certificado' });
  }
};

/* ── Generar: arma + registra verificable + guarda ──────────────────────── */
const generar = async (req, res) => {
  try {
    const out = await armar(req.body.tipo, req.body);
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
    res.json({ success: true, data: { ...out, codigo, tipo_label: TIPOS[out.tipo], emitido_por: emisor, fecha_emision: iso(new Date()) }, error: null });
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
      `SELECT codigo, tipo, datos_json, emitido_por, anulado,
              DATE_FORMAT(created_at,'%Y-%m-%d') fecha_emision
         FROM certificados WHERE codigo=? LIMIT 1`, [req.params.codigo]);
    if (!r) return res.status(404).json({ success: false, data: null, error: 'Certificado no encontrado' });
    let snap = {}; try { snap = r.datos_json ? JSON.parse(r.datos_json) : {}; } catch (_) {}
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

module.exports = { buscar, buscarCarta, preview, generar, historial, ver, anular };
