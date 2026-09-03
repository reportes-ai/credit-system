'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   PAGOS RECURRENTES (Tesorería)

   Qué hace: inscribe los pagos que se repiten (arriendos, servicios, cuotas
   administrativas) con su proveedor, periodicidad, moneda y monto de origen.
   Un motor diario genera SOLA la Orden de Pago el día del vencimiento, al tipo
   de cambio del día (UF / UTM / dólar → pesos), la deja EMITIDA para que la
   Caja la pague por el flujo normal (segregación de funciones incluida), avisa
   a Tesorería con el link a la orden, y al pagarse avisa al proveedor con la
   glosa del período.

   Motores que reusa (Máxima 1): calcularDoc() de Órdenes de Pago para el IVA /
   retención, emitirCorrelativo() del libro central, getUF() y las tablas utm /
   dolar del mantenedor de indicadores, plantillas-correo para los avisos y el
   flujo de pago existente (que es el que contabiliza — Máxima 4).

   La glosa acepta variables de período: {MES} {MES_ANTERIOR} {AÑO} {MES_NUM}.
   ═══════════════════════════════════════════════════════════════════════════ */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { programar } = require('../../../../shared/scheduler');
const fc = require('../../../../shared/fecha-chile');
const { getUF } = require('../../../../shared/uf');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, error, code = 500) => res.status(code).json({ success: false, data: null, error });
const norm = s => String(s ?? '').trim();

const PERIODICIDADES = { MENSUAL: 1, BIMENSUAL: 2, TRIMESTRAL: 3, SEMESTRAL: 6, ANUAL: 12 };
const TIPOS_PAGO     = ['Arriendos', 'Administrativos', 'Otros'];   // = categoría de la ODP
const MONEDAS        = ['CLP', 'UF', 'UTM', 'USD'];
const TIPOS_DOC      = ['Factura', 'Factura Exenta', 'Boleta de Honorarios', 'Boleta Exenta', 'Nota de Cobro', 'Otros'];
const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const USUARIO_SISTEMA = 'Sistema — Pagos Recurrentes';
const HOST = process.env.APP_URL || 'https://afbs.autofacilchile.cl';

/* ── Migración (idempotente, por el capataz) ─────────────────────────────── */
require('../../../../shared/migrate').enFila('pagos-recurrentes', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tesoreria_pagos_recurrentes (
        id                      INT AUTO_INCREMENT PRIMARY KEY,
        apodo                   VARCHAR(80)   NOT NULL,
        descripcion             VARCHAR(300)  NULL,
        periodicidad            VARCHAR(12)   NOT NULL,
        id_proveedor            INT           NOT NULL,
        tipo_pago               VARCHAR(30)   NOT NULL,
        tipo_documento          VARCHAR(30)   NOT NULL DEFAULT 'Factura',
        glosa                   VARCHAR(300)  NOT NULL,
        moneda                  VARCHAR(5)    NOT NULL DEFAULT 'CLP',
        monto_origen            DECIMAL(14,4) NOT NULL,
        fecha_ultimo_pago       DATE          NULL,
        fecha_proximo_pago      DATE          NOT NULL,
        fecha_ultima_generacion DATE          NULL,
        activo                  TINYINT(1)    NOT NULL DEFAULT 1,
        creado_por              INT           NULL,
        creado_nombre           VARCHAR(150)  NULL,
        created_at              DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at              DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_prox (activo, fecha_proximo_pago), INDEX idx_prov (id_proveedor)
      )`);
    // Trazabilidad de cada generación: qué tipo de cambio se usó y qué ODP salió.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tesoreria_pagos_recurrentes_log (
        id                INT AUTO_INCREMENT PRIMARY KEY,
        id_pago           INT           NOT NULL,
        fecha_vencimiento DATE          NOT NULL,
        moneda            VARCHAR(5)    NOT NULL,
        monto_origen      DECIMAL(14,4) NOT NULL,
        tipo_cambio       DECIMAL(14,4) NOT NULL,
        monto_clp         DECIMAL(14,0) NOT NULL,
        id_orden_pago     INT           NULL,
        numero_odp        VARCHAR(30)   NULL,
        mail_tesoreria    TINYINT(1)    NOT NULL DEFAULT 0,
        mail_proveedor    DATETIME      NULL,
        created_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_pago (id_pago), INDEX idx_odp (id_orden_pago)
      )`);
    // La ODP sabe de qué pago recurrente nació (para el aviso al proveedor al pagarla).
    await pool.query('ALTER TABLE ordenes_pago ADD COLUMN IF NOT EXISTS id_pago_recurrente INT NULL');
    // Propuesto: detectado desde la historia contable, nace PAUSADO hasta que alguien lo revise y lo encienda.
    await pool.query('ALTER TABLE tesoreria_pagos_recurrentes ADD COLUMN IF NOT EXISTS propuesto TINYINT(1) NOT NULL DEFAULT 0');
    // Día de pago (1-31): cada vencimiento cae ese día del mes (el 31 se acomoda al último día del mes corto).
    await pool.query('ALTER TABLE tesoreria_pagos_recurrentes ADD COLUMN IF NOT EXISTS dia_pago TINYINT NULL');
    await pool.query('UPDATE tesoreria_pagos_recurrentes SET dia_pago = DAY(fecha_proximo_pago) WHERE dia_pago IS NULL');

    // Card en Tesorería + permisos (anti-hardcode: módulos y cards salen de la BD)
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Tesorería' OR ruta LIKE '/tesoreria%' LIMIT 1");
    if (mod) {
      const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='pagos_recurrentes' LIMIT 1");
      let idF = ex && ex.id_funcionalidad;
      if (!idF) {
        const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
          [mod.id_modulo, 'Pagos Recurrentes', 'pagos_recurrentes', '/tesoreria/pagos-recurrentes', 'bi-arrow-repeat']);
        idF = r.insertId;
      }
      // Admin, Tesorero, Analista Financiero, Gerente de Finanzas — el resto por la matriz de Perfiles
      for (const idp of [1, 30001, 90003, 90007])
        await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idF]);
    }
    console.log('[pagos-recurrentes] módulo listo');
  } catch (e) { console.error('[pagos-recurrentes migration]', e.message); }
});

/* ── Helpers de negocio ──────────────────────────────────────────────────── */

// Tipo de cambio del día a pesos. UF por el motor único; UTM y dólar del mantenedor
// de indicadores (última cotización ≤ fecha). Sin cotización → error explícito: se
// reintenta al día siguiente en vez de emitir una orden con un monto inventado.
async function tipoCambio(moneda, fechaISO) {
  if (moneda === 'CLP') return 1;
  if (moneda === 'UF') {
    const v = await getUF(fechaISO);
    if (v) return v;
    const [[u]] = await pool.query('SELECT valor FROM uf ORDER BY fecha DESC LIMIT 1');
    if (u) return parseFloat(u.valor);
    throw new Error('No hay UF cargada');
  }
  const tabla = moneda === 'UTM' ? 'utm' : moneda === 'USD' ? 'dolar' : null;
  if (!tabla) throw new Error('Moneda no soportada: ' + moneda);
  const [[r]] = await pool.query(`SELECT valor, fecha FROM ${tabla} WHERE fecha <= ? ORDER BY fecha DESC LIMIT 1`, [fechaISO]);
  if (!r) throw new Error(`No hay ${moneda} cargado en el mantenedor de indicadores`);
  return parseFloat(r.valor);
}

// {MES} {MES_ANTERIOR} {AÑO} {MES_NUM} según la fecha de vencimiento del período.
function renderGlosa(glosa, vencISO) {
  const d = fc.desdeISO(vencISO) || new Date();
  const m = d.getMonth(), y = d.getFullYear();
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const ant = m === 0 ? { m: 11, y: y - 1 } : { m: m - 1, y };
  return String(glosa || '')
    .replace(/\{MES_ANTERIOR\}/gi, cap(MESES[ant.m]) + (ant.y !== y ? ' ' + ant.y : ''))
    .replace(/\{MES_NUM\}/gi, String(m + 1).padStart(2, '0'))
    .replace(/\{MES\}/gi, cap(MESES[m]))
    .replace(/\{A(Ñ|N)O\}/gi, String(y))
    .replace(/\{ANIO\}/gi, String(y));
}

// 'YYYY-MM-DD' con el día de pago del mes; un 31 en mes corto cae en el último día.
function conDia(iso, dia) {
  const d = parseInt(dia); if (!(d >= 1 && d <= 31)) return iso;
  const [y, m] = String(iso).slice(0, 10).split('-').map(Number);
  const ultimo = new Date(y, m, 0).getDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(d, ultimo)).padStart(2, '0')}`;
}

const fmtCLP = n => '$' + Math.round(Number(n) || 0).toLocaleString('es-CL');
const fmtOrigen = (n, mon) => mon === 'CLP' ? fmtCLP(n) : `${Number(n).toLocaleString('es-CL', { maximumFractionDigits: 4 })} ${mon}`;

/* Genera la ODP de UN pago recurrente para su vencimiento vigente. Devuelve el
   número emitido. Idempotente por (pago, vencimiento): si ya se generó para esa
   fecha, no hace nada. */
async function generarUno(p, hoyISO, req) {
  const venc = fc.isoDe(p.fecha_proximo_pago) || String(p.fecha_proximo_pago).slice(0, 10);
  if (p.fecha_ultima_generacion && fc.isoDe(p.fecha_ultima_generacion) >= venc) return null;

  const [[prov]] = await pool.query('SELECT id, nombre, rut, email, banco, tipo_cuenta, numero_cuenta FROM proveedores WHERE id=?', [p.id_proveedor]);
  if (!prov) throw new Error(`Proveedor ${p.id_proveedor} no existe`);

  const tc = await tipoCambio(p.moneda, hoyISO);
  const montoCLP = Math.round(Number(p.monto_origen) * tc);
  const { calcularDoc, } = require('../../../ordenes-pago/src/controllers/ordenes-pago.controller');
  const m = await calcularDoc(p.tipo_documento || 'Factura', 'BRUTO', montoCLP);   // el monto inscrito es lo que se paga
  const concepto = renderGlosa(p.glosa, venc);
  const destino = norm([prov.tipo_cuenta || (prov.numero_cuenta ? 'Cuenta Corriente' : null), prov.numero_cuenta].filter(Boolean).join(' ') + (prov.banco ? ' · ' + prov.banco : '')) || null;
  const detalleTC = p.moneda === 'CLP' ? '' : ` ${fmtOrigen(p.monto_origen, p.moneda)} × ${p.moneda === 'UF' || p.moneda === 'UTM' ? '$' + Number(tc).toLocaleString('es-CL', { maximumFractionDigits: 2 }) : '$' + Number(tc).toLocaleString('es-CL', { maximumFractionDigits: 2 })} (${p.moneda} del ${hoyISO.split('-').reverse().join('-')}) = ${fmtCLP(montoCLP)}.`;
  const obs = `Generada automáticamente por PAGOS RECURRENTES — «${p.apodo}» (${p.periodicidad.toLowerCase()}), vencimiento ${venc.split('-').reverse().join('-')}.${detalleTC}` +
    (p.descripcion ? `\n${p.descripcion}` : '');

  const [r] = await pool.query(
    `INSERT INTO ordenes_pago
       (id_proveedor, proveedor_nombre, proveedor_rut, concepto, categoria, tipo_documento,
        tratamiento, monto_bruto, monto_neto, impuesto_pct, impuesto_monto, monto, destino,
        fecha_emision, metodo_pago, estado, observaciones, id_usuario, usuario_nombre, id_pago_recurrente)
     VALUES (?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,'Transferencia','EMITIDA',?,NULL,?,?)`,
    [prov.id, prov.nombre, prov.rut, concepto, p.tipo_pago, p.tipo_documento || 'Factura',
     m.clase, m.bruto, m.neto, m.pct, m.imp, m.aPagar, destino,
     hoyISO, obs, USUARIO_SISTEMA, p.id]);
  const { emitirCorrelativo } = require('../../../../shared/ordenes-pago');
  const { id: ocId, numero } = await emitirCorrelativo({
    origen: 'GENERAL', origen_id: r.insertId, concepto: `${concepto} — ${prov.nombre}`,
    monto: m.aPagar, id_usuario: null, usuario_nombre: USUARIO_SISTEMA });
  await pool.query('UPDATE ordenes_pago SET numero=? WHERE id=?', [numero, r.insertId]);

  const meses = PERIODICIDADES[p.periodicidad] || 1;
  await pool.query(
    'UPDATE tesoreria_pagos_recurrentes SET fecha_ultima_generacion=?, fecha_proximo_pago=? WHERE id=?',
    [venc, conDia(fc.sumarMeses(venc, meses), p.dia_pago), p.id]);
  const [lg] = await pool.query(
    `INSERT INTO tesoreria_pagos_recurrentes_log (id_pago, fecha_vencimiento, moneda, monto_origen, tipo_cambio, monto_clp, id_orden_pago, numero_odp)
     VALUES (?,?,?,?,?,?,?,?)`, [p.id, venc, p.moneda, p.monto_origen, tc, montoCLP, r.insertId, numero]);

  auditar({ req, accion: 'CREAR', modulo: 'pagos-recurrentes', entidad: 'orden_pago', entidad_id: String(r.insertId),
    detalle: `ODP ${numero} generada por pago recurrente «${p.apodo}» a ${prov.nombre} por ${fmtCLP(m.aPagar)} (${fmtOrigen(p.monto_origen, p.moneda)}${p.moneda !== 'CLP' ? ' × ' + tc : ''}), vencimiento ${venc}` });

  // Aviso a Tesorería con el link a la orden (plantilla paramétrica; perfil Tesorero por defecto).
  try {
    const plant = require('../../../../shared/plantillas-correo');
    const env = await plant.enviar({ codigo: 'pago_recurrente_odp', datos: {
      APODO: p.apodo, ODP: numero, PROVEEDOR: prov.nombre, RUT: prov.rut || '—', GLOSA: concepto,
      MONTO: fmtCLP(m.aPagar), ORIGEN: fmtOrigen(p.monto_origen, p.moneda) + (p.moneda !== 'CLP' ? ` (${p.moneda} $${Number(tc).toLocaleString('es-CL', { maximumFractionDigits: 2 })})` : ''),
      VENCIMIENTO: venc.split('-').reverse().join('-'), PERIODICIDAD: p.periodicidad.toLowerCase(),
      LINK: `${HOST}/ordenes-pago/historial/?ver=${ocId}`,
    } });
    if (env.enviado) await pool.query('UPDATE tesoreria_pagos_recurrentes_log SET mail_tesoreria=1 WHERE id=?', [lg.insertId]);
    else console.warn('[pagos-recurrentes correo tesorería]', numero, env.motivo);
  } catch (e) { console.error('[pagos-recurrentes correo tesorería]', e.message); }
  return numero;
}

/* Motor diario: todo pago activo cuyo vencimiento ya llegó y aún no se generó. */
async function generarVencidos() {
  const hoy = fc.hoyISO();
  const [rows] = await pool.query(
    `SELECT * FROM tesoreria_pagos_recurrentes
      WHERE activo=1 AND fecha_proximo_pago <= ?
        AND (fecha_ultima_generacion IS NULL OR fecha_ultima_generacion < fecha_proximo_pago)`, [hoy]);
  let n = 0;
  for (const p of rows) {
    try { if (await generarUno(p, hoy)) n++; }
    catch (e) { console.error(`[pagos-recurrentes] «${p.apodo}» (#${p.id}):`, e.message); }
  }
  if (n) console.log(`[pagos-recurrentes] ${n} orden(es) de pago generada(s)`);
}
programar('pagos-recurrentes', generarVencidos, 6 * 60 * 60 * 1000, { arranqueMs: 90 * 1000 });

/* Hook desde Órdenes de Pago al PAGAR una ODP general: si nació de un pago
   recurrente, registra la fecha de último pago y avisa al proveedor con la glosa. */
async function onOdpPagada(idOrdenPago) {
  const [[op]] = await pool.query(
    'SELECT id, numero, concepto, monto, fecha_pago, id_proveedor, id_pago_recurrente FROM ordenes_pago WHERE id=? AND id_pago_recurrente IS NOT NULL', [idOrdenPago]);
  if (!op) return;
  const fechaPago = fc.isoDe(op.fecha_pago) || fc.hoyISO();
  await pool.query('UPDATE tesoreria_pagos_recurrentes SET fecha_ultimo_pago=? WHERE id=?', [fechaPago, op.id_pago_recurrente]);
  const [[prov]] = await pool.query('SELECT nombre, email FROM proveedores WHERE id=?', [op.id_proveedor]);
  if (!prov || !prov.email) { console.warn('[pagos-recurrentes] proveedor sin correo, no se avisa el pago de', op.numero); return; }
  const plant = require('../../../../shared/plantillas-correo');
  const env = await plant.enviar({ codigo: 'pago_recurrente_pagado', to: [prov.email], datos: {
    PROVEEDOR: prov.nombre, GLOSA: op.concepto, MONTO: fmtCLP(op.monto), ODP: op.numero,
    FECHA_PAGO: fechaPago.split('-').reverse().join('-'),
  } });
  if (env.enviado) await pool.query('UPDATE tesoreria_pagos_recurrentes_log SET mail_proveedor=NOW() WHERE id_orden_pago=?', [op.id]);
  else console.warn('[pagos-recurrentes correo proveedor]', op.numero, env.motivo);
}

/* ── API ─────────────────────────────────────────────────────────────────── */

exports.catalogo = (req, res) => ok(res, {
  periodicidades: Object.keys(PERIODICIDADES), tipos_pago: TIPOS_PAGO, monedas: MONEDAS, tipos_documento: TIPOS_DOC,
  variables_glosa: ['{MES}', '{MES_ANTERIOR}', '{AÑO}', '{MES_NUM}'],
});

exports.listar = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.*, pr.nombre proveedor_nombre, pr.rut proveedor_rut, pr.banco, pr.tipo_cuenta, pr.numero_cuenta, pr.email proveedor_email,
             (SELECT numero_odp FROM tesoreria_pagos_recurrentes_log l WHERE l.id_pago=p.id ORDER BY id DESC LIMIT 1) ultima_odp,
             (SELECT COUNT(*) FROM tesoreria_pagos_recurrentes_log l WHERE l.id_pago=p.id) generadas
        FROM tesoreria_pagos_recurrentes p
        LEFT JOIN proveedores pr ON pr.id = p.id_proveedor
       ORDER BY p.activo DESC, p.fecha_proximo_pago, p.apodo`);
    ok(res, rows);
  } catch (e) { fail(res, e.message); }
};

function validar(b) {
  const apodo = norm(b.apodo); if (!apodo) return 'El apodo del pago es obligatorio';
  if (!PERIODICIDADES[String(b.periodicidad || '').toUpperCase()]) return 'Periodicidad inválida';
  if (!parseInt(b.id_proveedor)) return 'Debes elegir el proveedor';
  if (!TIPOS_PAGO.includes(b.tipo_pago)) return 'Tipo de pago inválido (Arriendos, Administrativos u Otros)';
  if (!TIPOS_DOC.includes(b.tipo_documento || 'Factura')) return 'Tipo de documento inválido';
  if (!norm(b.glosa)) return 'La glosa del pago es obligatoria';
  if (!MONEDAS.includes(b.moneda)) return 'Moneda inválida';
  const monto = Number(String(b.monto_origen).replace(',', '.'));
  if (!(monto > 0)) return 'El monto debe ser mayor a 0';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha_proximo_pago || ''))) return 'Fecha del próximo pago inválida';
  const dia = parseInt(b.dia_pago); if (!(dia >= 1 && dia <= 31)) return 'El día de pago debe estar entre 1 y 31';
  if (b.fecha_ultimo_pago && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha_ultimo_pago))) return 'Fecha del último pago inválida';
  return null;
}
// El próximo pago se acomoda al día de pago elegido (el mes lo pone la fecha, el día lo pone dia_pago).
const campos = b => [norm(b.apodo), norm(b.descripcion) || null, String(b.periodicidad).toUpperCase(), parseInt(b.id_proveedor),
  b.tipo_pago, b.tipo_documento || 'Factura', norm(b.glosa), b.moneda, Number(String(b.monto_origen).replace(',', '.')),
  b.fecha_ultimo_pago || null, conDia(b.fecha_proximo_pago, b.dia_pago), parseInt(b.dia_pago)];

exports.crear = async (req, res) => {
  try {
    const b = req.body || {}; const err = validar(b); if (err) return fail(res, err, 400);
    const [[prov]] = await pool.query('SELECT id FROM proveedores WHERE id=?', [parseInt(b.id_proveedor)]);
    if (!prov) return fail(res, 'Proveedor no encontrado', 400);
    const u = req.usuario || {};
    const [r] = await pool.query(
      `INSERT INTO tesoreria_pagos_recurrentes (apodo, descripcion, periodicidad, id_proveedor, tipo_pago, tipo_documento, glosa, moneda, monto_origen,
         fecha_ultimo_pago, fecha_proximo_pago, dia_pago, creado_por, creado_nombre) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [...campos(b), u.id_usuario || null, [u.nombre, u.apellido].filter(Boolean).join(' ')]);
    auditar({ req, accion: 'CREAR', modulo: 'pagos-recurrentes', entidad: 'pago_recurrente', entidad_id: String(r.insertId),
      detalle: `Inscribió pago recurrente «${norm(b.apodo)}» (${String(b.periodicidad).toUpperCase()}, ${b.monto_origen} ${b.moneda}, próximo ${b.fecha_proximo_pago})` });
    ok(res, { id: r.insertId });
  } catch (e) { fail(res, e.message); }
};

exports.editar = async (req, res) => {
  try {
    const id = parseInt(req.params.id); const b = req.body || {}; const err = validar(b); if (err) return fail(res, err, 400);
    // Editar un propuesto también lo confirma (alguien lo revisó).
    const [r] = await pool.query(
      `UPDATE tesoreria_pagos_recurrentes SET apodo=?, descripcion=?, periodicidad=?, id_proveedor=?, tipo_pago=?, tipo_documento=?, glosa=?, moneda=?, monto_origen=?,
         fecha_ultimo_pago=?, fecha_proximo_pago=?, dia_pago=?, propuesto=0 WHERE id=?`, [...campos(b), id]);
    if (!r.affectedRows) return fail(res, 'Pago recurrente no encontrado', 404);
    auditar({ req, accion: 'EDITAR', modulo: 'pagos-recurrentes', entidad: 'pago_recurrente', entidad_id: String(id), detalle: `Editó «${norm(b.apodo)}»` });
    ok(res, { id });
  } catch (e) { fail(res, e.message); }
};

exports.activar = async (req, res) => {
  try {
    const id = parseInt(req.params.id); const activo = req.body && req.body.activo ? 1 : 0;
    // Encender un propuesto es aceptarlo: deja de ser propuesta.
    const [r] = await pool.query('UPDATE tesoreria_pagos_recurrentes SET activo=?, propuesto=IF(?=1, 0, propuesto) WHERE id=?', [activo, activo, id]);
    if (!r.affectedRows) return fail(res, 'Pago recurrente no encontrado', 404);
    auditar({ req, accion: activo ? 'ACTIVAR' : 'PAUSAR', modulo: 'pagos-recurrentes', entidad: 'pago_recurrente', entidad_id: String(id), detalle: activo ? 'Activó el pago recurrente (genera órdenes)' : 'Desactivó el pago recurrente (no genera órdenes)' });
    ok(res, { id, activo });
  } catch (e) { fail(res, e.message); }
};

// Se borra solo si nunca generó una orden; con historia, se pausa (la trazabilidad no se pierde).
exports.eliminar = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [[l]] = await pool.query('SELECT COUNT(*) n FROM tesoreria_pagos_recurrentes_log WHERE id_pago=?', [id]);
    if (l.n) { await pool.query('UPDATE tesoreria_pagos_recurrentes SET activo=0 WHERE id=?', [id]); return ok(res, { id, pausado: true }); }
    const [r] = await pool.query('DELETE FROM tesoreria_pagos_recurrentes WHERE id=?', [id]);
    if (!r.affectedRows) return fail(res, 'Pago recurrente no encontrado', 404);
    auditar({ req, accion: 'ELIMINAR', modulo: 'pagos-recurrentes', entidad: 'pago_recurrente', entidad_id: String(id), detalle: 'Eliminó un pago recurrente sin historia' });
    ok(res, { id, eliminado: true });
  } catch (e) { fail(res, e.message); }
};

exports.log = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tesoreria_pagos_recurrentes_log WHERE id_pago=? ORDER BY id DESC LIMIT 60', [parseInt(req.params.id)]);
    ok(res, rows);
  } catch (e) { fail(res, e.message); }
};

// Vista previa: tipo de cambio de hoy y glosa renderizada para el próximo vencimiento.
exports.previa = async (req, res) => {
  try {
    const moneda = String(req.query.moneda || 'CLP').toUpperCase();
    const hoy = fc.hoyISO();
    const tc = await tipoCambio(moneda, hoy);
    ok(res, { moneda, fecha: hoy, tipo_cambio: tc, glosa: renderGlosa(req.query.glosa || '', req.query.fecha || hoy) });
  } catch (e) { fail(res, e.message, 400); }
};

// Generar AHORA la orden del vencimiento vigente (sin esperar al motor) — misma función.
exports.generarAhora = async (req, res) => {
  try {
    const [[p]] = await pool.query('SELECT * FROM tesoreria_pagos_recurrentes WHERE id=?', [parseInt(req.params.id)]);
    if (!p) return fail(res, 'Pago recurrente no encontrado', 404);
    if (!p.activo) return fail(res, 'El pago está pausado', 400);
    const numero = await generarUno(p, fc.hoyISO(), req);
    if (!numero) return fail(res, 'Ya se generó la orden de este vencimiento', 409);
    ok(res, { numero });
  } catch (e) { fail(res, e.message, 400); }
};

exports.onOdpPagada = onOdpPagada;
exports.generarVencidos = generarVencidos;
exports.renderGlosa = renderGlosa;
