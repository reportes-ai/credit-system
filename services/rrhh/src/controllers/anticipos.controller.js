'use strict';
/* ── ANTICIPOS al personal: TEF Santander + ODP + correo — Pato, 16-09-2026 ────────────
   Todo pago al personal que sale ANTES de la liquidación (aguinaldo pagado como anticipo,
   anticipo de sueldo, préstamo/crédito corporativo, otro haber adelantado) se junta acá:
   · PENDIENTES se cargan solos desde su fuente: Adicionales marcados "pagado como
     anticipo" (rh_adicionales + su descuento ANTICIPO) y Descuentos de tipo ANTICIPO /
     PRESTAMO (rh_descuentos) que aún no salieron en un lote.
   · GENERAR arma el lote: archivo TEF Santander (Nómina Masiva OfficeBanking, 13
     columnas, formato del archivo real "TEF AGUINALDO SEPT 2026.xlsx"), marca las
     fuentes con tef_lote_id, crea la ODP "DE ACUERDO A NÓMINA ADJUNTA" cuando hay más
     de una persona (o se ata a una ODP ya emitida) con el Excel adjunto, y manda a cada
     beneficiario el correo de su tipo (plantillas paramétricas anticipo_* en Correos
     del Sistema: Fiestas Patrias, Navidad, anticipo de sueldo, préstamo, otro).
   · La cuenta de origen del TEF es paramétrica (rh_config tef_cta_origen). */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const XLSX = require('xlsx');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });
const nombreDe = u => `${u?.nombre || ''} ${u?.apellido || ''}`.trim() || u?.email || null;
const CLP = v => '$' + Math.round(Number(v) || 0).toLocaleString('es-CL');
const MESES = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const mesTxt = m => m ? `${MESES[Number(String(m).slice(5, 7))] || ''}-${String(m).slice(0, 4)}` : '';
const hoyISO = () => require('../../../../shared/fecha-chile').hoyISO();

/* Código de banco como lo pide el portal Santander (tomado del archivo real; MERCADO PAGO
   va con 875 ahí, no con el 730 de Previred). */
const COD_BANCO_TEF = { 'BANCO DE CHILE': 1, 'CHILE': 1, 'EDWARDS': 1, 'INTERNACIONAL': 9, 'BANCOESTADO': 12, 'BANCO ESTADO': 12, 'ESTADO': 12,
  'SCOTIABANK': 14, 'BCI': 16, 'BANCO BCI': 16, 'BICE': 28, 'HSBC': 31, 'SANTANDER': 37, 'ITAU': 39, 'ITAÚ': 39, 'SECURITY': 49,
  'FALABELLA': 51, 'RIPLEY': 53, 'CONSORCIO': 55, 'COOPEUCH': 672, 'TENPO': 730, 'MERCADO PAGO': 875 };
function codBanco(nombre) {
  const n = String(nombre || '').toUpperCase().trim();
  if (COD_BANCO_TEF[n] != null) return COD_BANCO_TEF[n];
  const k = Object.keys(COD_BANCO_TEF).sort((a, b) => b.length - a.length).find(k => n.includes(k));
  return k ? COD_BANCO_TEF[k] : null;
}

/* Tipo del anticipo → plantilla de correo y texto por defecto */
const TIPOS = {
  FIESTAS_PATRIAS: { plantilla: 'anticipo_fiestas_patrias', glosa: y => `Aguinaldo fiestas patrias ${y}` },
  NAVIDAD:         { plantilla: 'anticipo_navidad',         glosa: y => `Aguinaldo navidad ${y}` },
  ANTICIPO:        { plantilla: 'anticipo_sueldo',          glosa: () => 'Anticipo de sueldo' },
  PRESTAMO:        { plantilla: 'anticipo_prestamo',        glosa: () => 'Préstamo al personal' },
  OTRO:            { plantilla: 'anticipo_otro',            glosa: () => 'Pago anticipado' },
};
const tipoDeCausal = c => /FIESTAS PATRIAS/.test(c) ? 'FIESTAS_PATRIAS' : /NAVIDAD/.test(c) ? 'NAVIDAD' : 'OTRO';

require('../../../../shared/migrate').migrar('rrhh-anticipos-tef', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_tef_lotes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tipo VARCHAR(20) NOT NULL, glosa_tef VARCHAR(100) NOT NULL, glosa_correo VARCHAR(100) NOT NULL,
    cta_origen VARCHAR(30) NOT NULL, total DECIMAL(12,0) NOT NULL, personas INT NOT NULL,
    odp_id INT NULL, odp_numero VARCHAR(20) NULL, correos_enviados INT NOT NULL DEFAULT 0,
    archivo LONGBLOB NULL,
    generado_por VARCHAR(160) NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    anulado_por VARCHAR(160) NULL, anulado_at DATETIME NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_tef_items (
    id INT AUTO_INCREMENT PRIMARY KEY, id_lote INT NOT NULL, id_usuario INT NOT NULL,
    nombre VARCHAR(200) NULL, rut VARCHAR(15) NULL, email VARCHAR(150) NULL,
    banco VARCHAR(60) NULL, cod_banco INT NULL, cuenta VARCHAR(30) NULL,
    monto DECIMAL(12,0) NOT NULL, tipo VARCHAR(20) NOT NULL, concepto VARCHAR(200) NULL,
    origen VARCHAR(12) NOT NULL, origen_id INT NOT NULL, correo_ok TINYINT(1) NOT NULL DEFAULT 0,
    INDEX idx_lote (id_lote), INDEX idx_usuario (id_usuario))`);
  await pool.query('ALTER TABLE rh_adicionales ADD COLUMN IF NOT EXISTS tef_lote_id INT NULL');
  await pool.query('ALTER TABLE rh_descuentos ADD COLUMN IF NOT EXISTS tef_lote_id INT NULL');
  await pool.query("INSERT IGNORE INTO rh_config (clave, valor) VALUES ('tef_cta_origen', '70450747')");
});

async function ctaOrigen() {
  const [[r]] = await pool.query("SELECT valor FROM rh_config WHERE clave='tef_cta_origen'");
  return String(r?.valor || '').trim();
}

/* Pendientes: todo lo que se pagó/paga por fuera y aún no salió en un lote */
async function pendientes() {
  const [adic] = await pool.query(
    `SELECT a.id, a.id_usuario, a.mes, a.causal, a.causal_texto, d.valor_cuota monto,
            TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) nombre, u.rut, u.email, f.email_personal, f.banco_pago, f.tipo_cuenta_pago, f.num_cuenta_pago
       FROM rh_adicionales a JOIN rh_descuentos d ON d.id_adicional=a.id AND d.estado='VIGENTE'
       JOIN usuarios u ON u.id_usuario=a.id_usuario LEFT JOIN rh_fichas f ON f.id_usuario=u.id_usuario
      WHERE a.tef_lote_id IS NULL ORDER BY a.mes, u.apellido, u.nombre`);
  const [desc] = await pool.query(
    `SELECT d.id, d.id_usuario, d.tipo, d.detalle_texto, d.monto_total monto, d.cuotas, d.valor_cuota, d.mes_inicio, d.tasa_pct,
            TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) nombre, u.rut, u.email, f.email_personal, f.banco_pago, f.tipo_cuenta_pago, f.num_cuenta_pago
       FROM rh_descuentos d JOIN usuarios u ON u.id_usuario=d.id_usuario LEFT JOIN rh_fichas f ON f.id_usuario=u.id_usuario
      WHERE d.estado='VIGENTE' AND d.tipo IN ('ANTICIPO','PRESTAMO') AND d.id_adicional IS NULL AND d.tef_lote_id IS NULL
      ORDER BY d.created_at DESC`);
  const fila = (o, x) => ({ origen: o, origen_id: x.id, id_usuario: x.id_usuario, nombre: x.nombre, rut: x.rut,
    email: x.email_personal || x.email || null, banco: x.banco_pago, cod_banco: codBanco(x.banco_pago), tipo_cuenta: x.tipo_cuenta_pago,
    cuenta: String(x.num_cuenta_pago || '').replace(/\D/g, ''), monto: Math.round(Number(x.monto) || 0),
    aviso: [!x.num_cuenta_pago ? 'sin cuenta' : null, x.banco_pago && codBanco(x.banco_pago) == null ? 'banco sin código' : null, !(x.email_personal || x.email) ? 'sin correo' : null].filter(Boolean).join(', ') || null });
  return [
    ...adic.map(x => ({ ...fila('ADICIONAL', x), tipo: tipoDeCausal(x.causal), concepto: x.causal === 'OTRO' ? x.causal_texto : x.causal, mes: x.mes })),
    ...desc.map(x => ({ ...fila('DESCUENTO', x), tipo: x.tipo, concepto: x.tipo === 'PRESTAMO' ? `Préstamo${x.detalle_texto ? ' — ' + x.detalle_texto : ''}` : `Anticipo de sueldo${x.detalle_texto ? ' — ' + x.detalle_texto : ''}`,
      mes: x.mes_inicio, cuotas: x.cuotas, valor_cuota: Math.round(Number(x.valor_cuota) || 0), tasa_pct: x.tasa_pct })),
  ];
}

/* Archivo TEF Santander: mismas 13 columnas y hoja del archivo real */
function armarXlsx(items, cta, glosaTef, glosaCorreo) {
  const rows = items.map(i => ({
    'Cta_origen': Number(cta) || cta, 'Moneda_origen': 'CLP', 'Cta_destino': Number(i.cuenta) || i.cuenta, 'Moneda_destino': 'CLP',
    'Cod_banco': i.cod_banco, 'Rut_benef.': String(i.rut || '').replace(/[.\-]/g, '').toUpperCase(),
    'Nombre_benef.': i.nombre_tef, 'Monto_total': Math.round(Number(i.monto)), 'Glosa TEF': glosaTef, 'Correo': i.email || '',
    'Glosa correo': glosaCorreo, 'Glosa cartola cliente': glosaCorreo, 'Glosa cartola benef.': glosaCorreo }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Nomina Masiva OfficeBanking');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/* GET /remuneraciones/anticipos */
const getAll = async (req, res) => {
  try {
    const [lotes] = await pool.query(`SELECT id, tipo, glosa_tef, glosa_correo, cta_origen, total, personas, odp_numero, correos_enviados, generado_por, created_at, anulado_at
      FROM rh_tef_lotes ORDER BY id DESC LIMIT 100`);
    ok(res, { pendientes: await pendientes(), lotes, cta_origen: await ctaOrigen(), tipos: Object.fromEntries(Object.entries(TIPOS).map(([k, v]) => [k, v.glosa(new Date().getFullYear())])) });
  } catch (e) { console.error('[anticipos get]', e.message); fail(res, 'Error interno del servidor'); }
};

/* GET /remuneraciones/anticipos/:id — detalle de un lote */
const getLote = async (req, res) => {
  try {
    const [[l]] = await pool.query('SELECT id, tipo, glosa_tef, glosa_correo, cta_origen, total, personas, odp_numero, correos_enviados, generado_por, created_at, anulado_at FROM rh_tef_lotes WHERE id=?', [req.params.id]);
    if (!l) return fail(res, 'No existe', 404);
    const [items] = await pool.query('SELECT * FROM rh_tef_items WHERE id_lote=? ORDER BY nombre', [l.id]);
    ok(res, { lote: l, items });
  } catch (e) { fail(res, 'Error interno del servidor'); }
};

/* PUT /remuneraciones/anticipos/config {cta_origen} */
const putConfig = async (req, res) => {
  try {
    const cta = String(req.body?.cta_origen || '').replace(/\D/g, '');
    if (!cta) return fail(res, 'Cuenta de origen inválida', 400);
    await pool.query("INSERT INTO rh_config (clave, valor) VALUES ('tef_cta_origen', ?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)", [cta]);
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'tef_config', detalle: `Cuenta de origen TEF Santander → ${cta}` });
    ok(res, { cta_origen: cta });
  } catch (e) { fail(res, 'Error interno del servidor'); }
};

/* Correo a cada beneficiario según el tipo del ítem (plantilla paramétrica) */
async function enviarCorreos(lote, items) {
  const plant = require('../../../../shared/plantillas-correo');
  let n = 0;
  for (const it of items) {
    if (!it.email) continue;
    const t = TIPOS[it.tipo] || TIPOS.OTRO;
    const datos = { NOMBRE: String(it.nombre || '').split(' ')[0], NOMBRE_COMPLETO: it.nombre, MONTO: CLP(it.monto), CONCEPTO: it.concepto || '', GLOSA: lote.glosa_correo,
      FECHA: hoyISO().split('-').reverse().join('-'), MES_DESCUENTO: it.mes_descuento ? mesTxt(it.mes_descuento) : '', CUOTAS: it.cuotas || '', CUOTA: it.valor_cuota ? CLP(it.valor_cuota) : '',
      BANCO: it.banco || '', CUENTA: it.cuenta || '' };
    const r = await plant.enviar({ codigo: t.plantilla, to: [it.email], datos });
    if (r.enviado) { n++; await pool.query('UPDATE rh_tef_items SET correo_ok=1 WHERE id=?', [it.id]).catch(() => {}); }
  }
  await pool.query('UPDATE rh_tef_lotes SET correos_enviados=correos_enviados+? WHERE id=?', [n, lote.id]).catch(() => {});
  return n;
}

/* ODP "DE ACUERDO A NÓMINA ADJUNTA" (más de una persona) con el Excel adjunto */
async function crearOdp(req, lote, items, buffer) {
  const [[prov]] = await pool.query("SELECT id, nombre FROM proveedores WHERE UPPER(nombre) LIKE 'DE ACUERDO A N%MINA ADJUNTA%' LIMIT 1");
  let idProv = prov?.id, nomProv = prov?.nombre || 'DE ACUERDO A NÓMINA ADJUNTA';
  if (!idProv) {
    const [np] = await pool.query('INSERT INTO proveedores (nombre, activo, comentario) VALUES (?,1,?)', [nomProv, 'Beneficiario genérico para pagos masivos al personal (TEF con nómina adjunta). Creado por Anticipos.']);
    idProv = np.insertId;
  }
  const { calcularDoc } = require('../../../ordenes-pago/src/controllers/ordenes-pago.controller');
  const m = await calcularDoc('Otros', 'EXENTO', lote.total);
  const u = req.usuario || {}, hoy = hoyISO();
  const concepto = `${lote.glosa_correo} — anticipos al personal (${items.length} personas)`;
  const obs = `Generada desde Remuneraciones → Anticipos (lote #${lote.id}). Pagar según TEF Santander adjunta.\nDetalle:\n` +
    items.map(i => ` • ${i.nombre} (${i.rut || '—'}): ${i.concepto} — ${CLP(i.monto)}`).join('\n') + `\nTOTAL: ${CLP(lote.total)}`;
  const [r] = await pool.query(
    `INSERT INTO ordenes_pago (id_proveedor, proveedor_nombre, proveedor_rut, concepto, categoria, tipo_documento, tratamiento,
        monto_bruto, monto_neto, impuesto_pct, impuesto_monto, monto, destino, fecha_emision, fecha_documento, metodo_pago, estado, observaciones, id_usuario, usuario_nombre)
     VALUES (?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,'Transferencia','EMITIDA',?,?,?)`,
    [idProv, nomProv, null, concepto, 'Otros', 'Otros', m.clase, m.bruto, m.neto, m.pct, m.imp, m.aPagar, 'Según nómina TEF adjunta', hoy, hoy, obs, u.id_usuario || null, nombreDe(u) || 'Sistema']);
  const { emitirCorrelativo } = require('../../../../shared/ordenes-pago');
  const { numero } = await emitirCorrelativo({ origen: 'GENERAL', origen_id: r.insertId, concepto, monto: m.aPagar, id_usuario: u.id_usuario || null, usuario_nombre: nombreDe(u) || 'Sistema' });
  await pool.query('UPDATE ordenes_pago SET numero=? WHERE id=?', [numero, r.insertId]);
  try {
    const pv = require('../../../postventa/src/controllers/postventa.controller');
    await pv.guardarFacturaDoc({ origen: 'ODP', ref_id: r.insertId, nombre: `TEF-${lote.glosa_correo.replace(/[^\w]+/g, '_')}-lote${lote.id}.xlsx`,
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer, usuario: nombreDe(u) });
  } catch (e) { console.error('[anticipos adjunto ODP]', e.message); }
  return { id: r.insertId, numero };
}

/* POST /remuneraciones/anticipos/generar {items:[{origen, origen_id}], tipo, glosa_tef, glosa_correo, enviar_correos, odp_existente} */
const generar = async (req, res) => {
  try {
    const b = req.body || {};
    const sel = Array.isArray(b.items) ? b.items : [];
    if (!sel.length) return fail(res, 'Marca al menos un anticipo', 400);
    const tipo = TIPOS[b.tipo] ? b.tipo : 'OTRO';
    const glosaTef = String(b.glosa_tef || '').trim().slice(0, 100), glosaCorreo = String(b.glosa_correo || '').trim().slice(0, 100);
    if (!glosaTef || !glosaCorreo) return fail(res, 'Glosa TEF y glosa del correo son obligatorias', 400);
    const cta = await ctaOrigen();
    if (!cta) return fail(res, 'Configura la cuenta de origen del TEF', 400);
    const todos = await pendientes();
    const items = sel.map(s => todos.find(p => p.origen === s.origen && Number(p.origen_id) === Number(s.origen_id))).filter(Boolean);
    if (items.length !== sel.length) return fail(res, 'Algún anticipo ya salió en otro lote: recarga la página', 409);
    const malos = items.filter(i => !i.cuenta || i.cod_banco == null);
    if (malos.length) return fail(res, 'Sin cuenta o banco sin código: ' + malos.map(i => i.nombre).join(', ') + '. Corrige la ficha antes de generar.', 400);
    // Nombre como lo pide el banco: APELLIDO PATERNO MATERNO NOMBRES, sin tildes
    const [us] = await pool.query('SELECT id_usuario, nombre, apellido, apellido_materno FROM usuarios WHERE id_usuario IN (?)', [items.map(i => i.id_usuario)]);
    const sinTilde = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
    for (const i of items) { const u = us.find(x => x.id_usuario === i.id_usuario) || {}; i.nombre_tef = [u.apellido, u.apellido_materno, u.nombre].map(sinTilde).filter(Boolean).join(' ');
      if (i.origen === 'DESCUENTO') i.mes_descuento = i.mes; }
    // La ODP existente se valida ANTES de escribir nada: si no existe, no debe quedar un lote
    // vivo con los anticipos marcados (desaparecían de Pendientes y había que anular el lote fantasma)
    let odpExistente = null;
    if (b.odp_existente) {
      const [[o]] = await pool.query("SELECT id, numero, monto FROM ordenes_pago WHERE numero=? AND estado<>'ANULADA'", [String(b.odp_existente).trim().toUpperCase()]);
      if (!o) return fail(res, 'La ODP indicada no existe o está anulada', 400);
      odpExistente = { id: o.id, numero: o.numero, existente: true, monto: Number(o.monto) };
    }
    const total = items.reduce((s, i) => s + i.monto, 0);
    const buffer = armarXlsx(items, cta, glosaTef, glosaCorreo);
    const [l] = await pool.query('INSERT INTO rh_tef_lotes (tipo, glosa_tef, glosa_correo, cta_origen, total, personas, archivo, generado_por) VALUES (?,?,?,?,?,?,?,?)',
      [tipo, glosaTef, glosaCorreo, cta, total, items.length, buffer, nombreDe(req.usuario)]);
    const lote = { id: l.insertId, tipo, glosa_tef: glosaTef, glosa_correo: glosaCorreo, total };
    await pool.query('INSERT INTO rh_tef_items (id_lote, id_usuario, nombre, rut, email, banco, cod_banco, cuenta, monto, tipo, concepto, origen, origen_id) VALUES ?',
      [items.map(i => [lote.id, i.id_usuario, i.nombre, i.rut, i.email, i.banco, i.cod_banco, i.cuenta, i.monto, i.tipo, i.concepto, i.origen, i.origen_id])]);
    const adIds = items.filter(i => i.origen === 'ADICIONAL').map(i => i.origen_id), deIds = items.filter(i => i.origen === 'DESCUENTO').map(i => i.origen_id);
    if (adIds.length) await pool.query('UPDATE rh_adicionales SET tef_lote_id=? WHERE id IN (?)', [lote.id, adIds]);
    if (deIds.length) await pool.query('UPDATE rh_descuentos SET tef_lote_id=? WHERE id IN (?)', [lote.id, deIds]);
    // ODP: una ya emitida (ej. la que hizo Tesorería a mano) o una nueva si hay más de una persona
    let odp = odpExistente;
    if (!odp && items.length > 1) odp = await crearOdp(req, lote, items, buffer);
    if (odp) await pool.query('UPDATE rh_tef_lotes SET odp_id=?, odp_numero=? WHERE id=?', [odp.id, odp.numero, lote.id]);
    // Correos a los beneficiarios (best-effort, no bloquea)
    let correos = 0;
    if (b.enviar_correos !== false) {
      const [its] = await pool.query('SELECT * FROM rh_tef_items WHERE id_lote=?', [lote.id]);
      its.forEach(x => { const src = items.find(i => i.origen === x.origen && Number(i.origen_id) === Number(x.origen_id)) || {}; x.mes_descuento = src.mes_descuento; x.cuotas = src.cuotas; x.valor_cuota = src.valor_cuota; });
      correos = await enviarCorreos(lote, its).catch(e => { console.error('[anticipos correos]', e.message); return 0; });
    }
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'tef_lote', entidad_id: lote.id,
      detalle: `Lote TEF #${lote.id} ${tipo} "${glosaCorreo}": ${items.length} personas, ${CLP(total)}${odp ? ` · ODP ${odp.numero}${odp.existente ? ' (existente)' : ''}` : ''} · ${correos} correo(s) enviados` });
    ok(res, { id: lote.id, total, personas: items.length, odp: odp?.numero || null, correos });
  } catch (e) { console.error('[anticipos generar]', e.message); fail(res, 'Error interno del servidor'); }
};

/* GET /remuneraciones/anticipos/:id/tef.xlsx */
const descargar = async (req, res) => {
  try {
    const [[l]] = await pool.query('SELECT id, glosa_correo, archivo, anulado_at FROM rh_tef_lotes WHERE id=?', [req.params.id]);
    if (!l || !l.archivo) return fail(res, 'Lote no encontrado', 404);
    auditar({ req, accion: 'EXPORTAR', modulo: 'rrhh', entidad: 'tef_lote', entidad_id: l.id, detalle: `Descargó TEF lote #${l.id} (${l.glosa_correo})` });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="TEF-${String(l.glosa_correo).replace(/[^\w]+/g, '_')}-lote${l.id}.xlsx"`);
    res.send(l.archivo);
  } catch (e) { fail(res, 'Error interno del servidor'); }
};

/* POST /remuneraciones/anticipos/:id/correos — reenviar a quienes no lo recibieron (o a todos con {todos:true}) */
const reenviarCorreos = async (req, res) => {
  try {
    const [[l]] = await pool.query('SELECT * FROM rh_tef_lotes WHERE id=? AND anulado_at IS NULL', [req.params.id]);
    if (!l) return fail(res, 'Lote no encontrado', 404);
    const [its] = await pool.query(`SELECT * FROM rh_tef_items WHERE id_lote=? ${req.body?.todos ? '' : 'AND correo_ok=0'}`, [l.id]);
    for (const x of its) {
      if (x.origen === 'DESCUENTO') { const [[d]] = await pool.query('SELECT mes_inicio, cuotas, valor_cuota FROM rh_descuentos WHERE id=?', [x.origen_id]); if (d) { x.mes_descuento = d.mes_inicio; x.cuotas = d.cuotas; x.valor_cuota = Math.round(Number(d.valor_cuota)); } }
    }
    const n = await enviarCorreos(l, its);
    auditar({ req, accion: 'ENVIAR', modulo: 'rrhh', entidad: 'tef_lote', entidad_id: l.id, detalle: `Reenvió correos del lote #${l.id}: ${n} de ${its.length}` });
    ok(res, { enviados: n, intentados: its.length });
  } catch (e) { console.error('[anticipos reenviar]', e.message); fail(res, 'Error interno del servidor'); }
};

/* POST /remuneraciones/anticipos/:id/anular — libera las fuentes para rehacer el lote (la ODP se anula aparte en Órdenes de Pago) */
const anular = async (req, res) => {
  try {
    const [[l]] = await pool.query('SELECT * FROM rh_tef_lotes WHERE id=? AND anulado_at IS NULL', [req.params.id]);
    if (!l) return fail(res, 'Lote no encontrado o ya anulado', 404);
    await pool.query('UPDATE rh_adicionales SET tef_lote_id=NULL WHERE tef_lote_id=?', [l.id]);
    await pool.query('UPDATE rh_descuentos SET tef_lote_id=NULL WHERE tef_lote_id=?', [l.id]);
    await pool.query('UPDATE rh_tef_lotes SET anulado_por=?, anulado_at=NOW() WHERE id=?', [nombreDe(req.usuario), l.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'rrhh', entidad: 'tef_lote', entidad_id: l.id, detalle: `Anuló lote TEF #${l.id} (${l.glosa_correo}, ${CLP(l.total)}) — motivo: ${String(req.body?.motivo || '').trim().slice(0, 200) || 'sin motivo'}${l.odp_numero ? ` · la ODP ${l.odp_numero} debe anularse en Órdenes de Pago si corresponde` : ''}` });
    ok(res, { anulado: true });
  } catch (e) { fail(res, 'Error interno del servidor'); }
};

module.exports = { getAll, getLote, putConfig, generar, descargar, reenviarCorreos, anular, pendientes, armarXlsx };
