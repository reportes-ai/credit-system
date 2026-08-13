'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   COMISIONES PARQUES A PAGAR — pago mensual al dueño de cada parque:
   arriendo fijo + comisión por créditos (suma de creditos.com_parque del mes).

   Los montos salen del mantenedor "Arriendos y Comisiones Parque y Calle"
   (tabla parques_comisiones) y del motor único comision-dealer.js que ya
   persiste com_parque por operación al calcular cada crédito. Aquí NO se
   recalcula nada: se agrega lo ya calculado (un solo motor por cálculo).

   Flujo de etapas por parque+mes:
     EN_APROBACION → APROBADA → OP_EMITIDA → PAGO_REALIZADO
   - Aprobar: congela los montos (snapshot) en parques_pagos_mes.
   - Emitir OP: correlativo ODP único global (shared/ordenes-pago.js, origen
     'PARQUE') + correo y alerta a Contabilidad; queda "por pagar" en el
     ledger de Órdenes de Pago automáticamente.
   - Pagar: marca el correlativo pagado y alerta a los ejecutivos del parque.
   ═══════════════════════════════════════════════════════════════════════════ */
const pool = require('../../../../shared/config/database');
const { emitirCorrelativo, pagarCorrelativo, anularCorrelativo, despagarCorrelativo } = require('../../../../shared/ordenes-pago');
const { auditar } = require('../../../../shared/audit');

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/* ── Migración + registro de funcionalidades ─────────────────────────────── */
require('../../../../shared/migrate').enFila('comisiones-parques', async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS parques_pagos_mes (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      parque            VARCHAR(120) NOT NULL,
      mes               DATE NOT NULL,
      arriendo          DECIMAL(12,0) NOT NULL DEFAULT 0,
      comision_creditos DECIMAL(14,0) NOT NULL DEFAULT 0,
      ops               INT NOT NULL DEFAULT 0,
      etapa             VARCHAR(20) NOT NULL DEFAULT 'EN_APROBACION',
      odp_id            INT NULL,
      odp_numero        VARCHAR(30) NULL,
      aprobada_por      VARCHAR(200) NULL,
      fecha_aprobada    DATETIME NULL,
      emitida_por       VARCHAR(200) NULL,
      fecha_emitida     DATETIME NULL,
      pagada_por        VARCHAR(200) NULL,
      fecha_pagada      DATETIME NULL,
      created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_parque_mes (parque, mes)
    )`);

    // Funcionalidades bajo el módulo Post Venta (mismo módulo que Comisiones Dealer a Pagar)
    const [[fRef]] = await pool.query(
      "SELECT id_modulo FROM funcionalidades WHERE codigo='postventa_comisiones_pagar' LIMIT 1");
    if (fRef) {
      const funcs = [
        ['Comisiones Parques a Pagar',            'postventa_comisiones_parques', '/postventa/comisiones-parques/', 'bi-signpost-2'],
        ['Seguimiento Comisión Parques',          'postventa_seg_parques',        '/postventa/seguimiento-parques/', 'bi-p-square'],
        ['Emisión de Cartolas Parque',            'postventa_cartolas_parque',    '/postventa/cartolas-parque/',    'bi-envelope-paper'],
        ['Aprobar Comisión de Parque',            'pv_parques_aprobar',           null, null],
        ['Emitir Orden de Pago de Parque',        'pv_parques_emitir',            null, null],
        ['Confirmar Pago de Parque',              'pv_parques_pagar',             null, null],
      ];
      for (const [nombre, codigo, href, icono] of funcs) {
        const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [codigo]);
        let idf = ex?.id_funcionalidad;
        if (!idf) {
          const [ins] = await pool.query(
            'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
            [fRef.id_modulo, nombre, codigo, href, icono]);
          idf = ins.insertId;
        }
        const [[pp]] = await pool.query('SELECT 1 v FROM permisos_perfil WHERE id_perfil=1 AND id_funcionalidad=? LIMIT 1', [idf]);
        if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1, ?, 1)', [idf]);
      }
    }
    // Facturas de parque: registro formal (número/fecha/monto) con cuadratura
    // contra el total de la cartola — espejo de la factura del dealer.
    await pool.query(`CREATE TABLE IF NOT EXISTS parques_facturas (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      mes            VARCHAR(7)   NOT NULL,
      parque         VARCHAR(120) NOT NULL,
      numero_factura VARCHAR(40)  NOT NULL,
      fecha_factura  DATE NULL,
      monto_bruto    BIGINT NOT NULL,
      registrado_por VARCHAR(150) NULL,
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_parque_mes_fac (parque, mes)
    )`);
    // Registro de cartolas de parque enviadas (reverso preciso por envío).
    await pool.query(`CREATE TABLE IF NOT EXISTS parques_cartolas_enviadas (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      mes         VARCHAR(7)   NOT NULL,
      parque      VARCHAR(120) NOT NULL,
      mail        VARCHAR(200) NULL,
      arriendo    BIGINT NULL,
      comision    BIGINT NULL,
      total       BIGINT NULL,
      enviado_por VARCHAR(150) NULL,
      fecha_envio DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_mes (mes)
    )`);
    console.log('[comisiones-parques] módulo registrado');
  } catch (e) { console.error('[comisiones-parques migration]', e.message); }
});

/* ── Cálculo del mes: agrega lo ya persistido por operación ──────────────────
   Atribución: 1) creditos.parque (el de la CARTA: dónde cursó ESA operación);
   2) fallback dealers.ccs_parque (ficha = parque de HOY, puede haber cambiado).
   Solo créditos OTORGADOS del mes cierre. */
async function calcularMes(mes /* 'YYYY-MM' */) {
  const [parques] = await pool.query(
    'SELECT nombre, arriendo, comision_pct FROM parques_comisiones WHERE activo=1 ORDER BY orden, nombre');
  const canon = new Map(parques.map(p => [norm(p.nombre), p.nombre]));

  const [creds] = await pool.query(`
    SELECT c.num_op, c.rut_dealer, c.parque, c.com_parque, c.saldo_precio, c.ejecutivo, c.automotora
    FROM creditos c
    WHERE c.estado='OTORGADO' AND DATE_FORMAT(c.mes,'%Y-%m') = ?`, [mes]);

  const [dealers] = await pool.query('SELECT rut, ccs_parque, nombre_razon FROM dealers');
  const rutNorm = r => String(r || '').replace(/[^0-9kK]/g, '').toUpperCase();
  const dealerByRut = new Map(dealers.map(d => [rutNorm(d.rut), d]));

  const porParque = new Map(); // nombre canónico -> { ops:[], comision }
  for (const c of creds) {
    const d = dealerByRut.get(rutNorm(c.rut_dealer));
    /* El parque de la OPERACIÓN manda (viene de la carta): la ficha del dealer
       dice su parque de HOY, y un dealer puede haberse cambiado. Caso real: op
       89213 de NIBARO cursó en AUTOCENTER MAIPU pero su ficha ya decía CARMOONS
       y la comisión salía en la cartola del parque equivocado. */
    const key = canon.get(norm(c.parque)) || canon.get(norm(d?.ccs_parque));
    if (!key) continue; // dealer calle o parque no registrado en el mantenedor
    if (!porParque.has(key)) porParque.set(key, { ops: [], comision: 0 });
    const g = porParque.get(key);
    const monto = Math.round(Number(c.com_parque) || 0);
    g.comision += monto;
    g.ops.push({
      num_op: c.num_op, dealer: d?.nombre_razon || c.automotora || '—',
      ejecutivo: c.ejecutivo || '—',
      saldo_precio: Math.round(Number(c.saldo_precio) || 0), com_parque: monto,
    });
  }

  return parques.map(p => {
    const g = porParque.get(p.nombre) || { ops: [], comision: 0 };
    return {
      parque: p.nombre,
      arriendo: Math.round(Number(p.arriendo) || 0),
      comision_pct: Number(p.comision_pct) || 0,
      comision_creditos: g.comision,
      ops: g.ops.length,
      total: Math.round(Number(p.arriendo) || 0) + g.comision,
      detalle: g.ops.sort((a, b) => b.com_parque - a.com_parque),
    };
  });
}

/* Refleja el hito en el track PARQUE del Seguimiento por operación: marca la(s)
   etapa(s) en todos los créditos del parque cuyo mes de cierre es `mes`.
   Espejo del patrón COMISION: las etapas de ODP/pago se marcan desde su módulo. */
async function marcarEtapaParqueOps(parque, mes, etapas, usuario) {
  for (const etapa of etapas) {
    await pool.query(`
      INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario, fecha)
      SELECT s.id, 'PARQUE', ?, ?, NOW()
      FROM postventa_seguimiento s
      JOIN creditos c ON c.id = s.id_credito
      WHERE UPPER(s.parque) = UPPER(?) AND DATE_FORMAT(c.mes,'%Y-%m') = ?`,
      [etapa, usuario, parque, mes]).catch(e => console.error('[parques marcar etapa]', e.message));
  }
}

/* Reversa exacta de marcarEtapaParqueOps: quita etapa(s) del track PARQUE. */
async function desmarcarEtapaParqueOps(parque, mes, etapas) {
  for (const etapa of etapas) {
    await pool.query(`
      DELETE pe FROM postventa_etapas pe
      JOIN postventa_seguimiento s ON s.id = pe.id_seguimiento
      JOIN creditos c ON c.id = s.id_credito
      WHERE pe.track='PARQUE' AND pe.etapa=?
        AND UPPER(s.parque) = UPPER(?) AND DATE_FORMAT(c.mes,'%Y-%m') = ?`,
      [etapa, parque, mes]).catch(e => console.error('[parques desmarcar etapa]', e.message));
  }
}

const mesParam = req => {
  const m = String(req.query.mes || req.body?.mes || '').slice(0, 7);
  return /^\d{4}-\d{2}$/.test(m) ? m : null;
};

/* ── GET /api/comisiones-parques?mes=YYYY-MM ─────────────────────────────── */
const listar = async (req, res) => {
  try {
    const mes = mesParam(req);
    if (!mes) return res.status(400).json({ success: false, data: null, error: 'Parámetro mes (YYYY-MM) requerido' });
    const calc = await calcularMes(mes);
    const [estados] = await pool.query(
      "SELECT parque, etapa, odp_numero, arriendo, comision_creditos, ops, aprobada_por, fecha_aprobada, emitida_por, fecha_emitida, pagada_por, fecha_pagada FROM parques_pagos_mes WHERE DATE_FORMAT(mes,'%Y-%m')=?", [mes]);
    const estByParque = new Map(estados.map(e => [e.parque, e]));
    const rows = calc.map(r => {
      const e = estByParque.get(r.parque);
      // Con snapshot (aprobada o posterior) mandan los montos congelados
      const frozen = e && e.etapa !== 'EN_APROBACION';
      return {
        ...r,
        detalle: undefined,
        arriendo: frozen ? Math.round(Number(e.arriendo)) : r.arriendo,
        comision_creditos: frozen ? Math.round(Number(e.comision_creditos)) : r.comision_creditos,
        ops: frozen ? e.ops : r.ops,
        total: frozen ? Math.round(Number(e.arriendo)) + Math.round(Number(e.comision_creditos)) : r.total,
        etapa: e?.etapa || 'EN_APROBACION',
        odp_numero: e?.odp_numero || null,
        hitos: e ? {
          aprobada: e.fecha_aprobada ? { por: e.aprobada_por, fecha: e.fecha_aprobada } : null,
          emitida:  e.fecha_emitida  ? { por: e.emitida_por,  fecha: e.fecha_emitida }  : null,
          pagada:   e.fecha_pagada   ? { por: e.pagada_por,   fecha: e.fecha_pagada }   : null,
        } : null,
      };
    });
    res.json({ success: true, data: { mes, rows }, error: null });
  } catch (e) { console.error('[comisiones-parques listar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── GET /api/comisiones-parques/detalle?mes&parque — operaciones del parque ── */
const detalle = async (req, res) => {
  try {
    const mes = mesParam(req);
    const parque = String(req.query.parque || '').trim();
    if (!mes || !parque) return res.status(400).json({ success: false, data: null, error: 'mes y parque requeridos' });
    const calc = await calcularMes(mes);
    const row = calc.find(r => r.parque === parque);
    if (!row) return res.status(404).json({ success: false, data: null, error: 'Parque no encontrado' });
    res.json({ success: true, data: { mes, parque, ops: row.detalle, comision_creditos: row.comision_creditos }, error: null });
  } catch (e) { console.error('[comisiones-parques detalle]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Helpers de notificación ──────────────────────────────────────────────
   Destinatarios PARAMÉTRICOS: se leen del mantenedor Alertas Post Venta
   (postventa_alertas_config), pestaña Parques — igual que los flujos de
   Saldo Precio y Comisión Dealer. Default sembrado: parque_orden_emitida →
   Administrador,Tesorero (quien paga las OP hoy). */
async function destinatariosEvento(evento) {
  const [[cfg]] = await pool.query('SELECT * FROM postventa_alertas_config WHERE evento=?', [evento]);
  if (cfg && !cfg.activo) return [];
  const perfiles = String(cfg?.perfiles || 'Administrador').split(',').map(s => s.trim()).filter(Boolean);
  const out = [];
  if (perfiles.length) {
    const [us] = await pool.query(
      `SELECT u.id_usuario, u.email FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
       WHERE p.nombre IN (?) AND (u.estado IS NULL OR u.estado <> 'inactivo')`, [perfiles]);
    out.push(...us);
  }
  const extras = String(cfg?.usuarios_extra || '').split(',').map(s => parseInt(s.trim())).filter(Boolean);
  if (extras.length) {
    const [us] = await pool.query('SELECT id_usuario, email FROM usuarios WHERE id_usuario IN (?)', [extras]);
    out.push(...us);
  }
  return out;
}
async function notificarUsuarios(ids, { titulo, mensaje, href, clave }) {
  let dest = [...new Set(ids)].filter(Boolean);
  try { dest = await require('../../../../shared/backups').expandirAlerta(dest); } catch (_) {}
  for (const uid of dest) {
    try {
      const [[ex]] = await pool.query('SELECT 1 v FROM notificaciones WHERE id_usuario=? AND clave=? AND leida=0 LIMIT 1', [uid, clave]);
      if (ex) continue;
      await pool.query(
        `INSERT INTO notificaciones (id_usuario, tipo, titulo, mensaje, href, clave, prioridad, sonar)
         VALUES (?,?,?,?,?,?,'alta',1)`, [uid, 'alerta', titulo, mensaje, href, clave]);
    } catch (e) { console.error('[comisiones-parques notif]', e.message); }
  }
}
const CLP = n => '$' + Math.round(Number(n) || 0).toLocaleString('es-CL');

/* ── POST /api/comisiones-parques/aprobar {mes, parque} ──────────────────── */
const aprobar = async (req, res) => {
  try {
    const mes = mesParam(req);
    const parque = String(req.body.parque || '').trim();
    if (!mes || !parque) return res.status(400).json({ success: false, data: null, error: 'mes y parque requeridos' });
    const calc = await calcularMes(mes);
    const row = calc.find(r => r.parque === parque);
    if (!row) return res.status(404).json({ success: false, data: null, error: 'Parque no encontrado' });
    const quien = `${req.user?.nombre || ''} ${req.user?.apellido || ''}`.trim() || 'sistema';
    // Snapshot: los montos quedan congelados al aprobar
    await pool.query(`
      INSERT INTO parques_pagos_mes (parque, mes, arriendo, comision_creditos, ops, etapa, aprobada_por, fecha_aprobada)
      VALUES (?, ?, ?, ?, ?, 'APROBADA', ?, NOW())
      ON DUPLICATE KEY UPDATE
        arriendo=IF(etapa='EN_APROBACION', VALUES(arriendo), arriendo),
        comision_creditos=IF(etapa='EN_APROBACION', VALUES(comision_creditos), comision_creditos),
        ops=IF(etapa='EN_APROBACION', VALUES(ops), ops),
        etapa=IF(etapa='EN_APROBACION', 'APROBADA', etapa),
        aprobada_por=IF(fecha_aprobada IS NULL, VALUES(aprobada_por), aprobada_por),
        fecha_aprobada=IF(fecha_aprobada IS NULL, NOW(), fecha_aprobada)`,
      [parque, mes + '-01', row.arriendo, row.comision_creditos, row.ops, quien]);
    // Máxima 4: devengo del gasto al aprobar (regla COMISION_PARQUES, idempotente por ref)
    require('../../../contabilidad/src/motor-asientos').contabilizar({
      evento: 'COMISION_PARQUES',
      glosa: `Comisión/arriendo parque ${parque} — ${mes}`,
      ref: `PARQUE-${parque}-${mes}`,
      montos: { arriendo: Math.round(Number(row.arriendo) || 0), comision: Math.round(Number(row.comision_creditos) || 0) },
    }).catch(e => console.error('[parques ctb devengo]', e.message));
    auditar({ req, accion: 'EDITAR', modulo: 'postventa', entidad: 'parque_pago', detalle: `Aprobó comisión parque ${parque} ${mes}: arriendo ${CLP(row.arriendo)} + comisión ${CLP(row.comision_creditos)} (${row.ops} ops)` });
    res.json({ success: true, data: { etapa: 'APROBADA' }, error: null });
  } catch (e) { console.error('[comisiones-parques aprobar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── POST /api/comisiones-parques/emitir {mes, parque} — OP + correo + alerta ── */
const emitir = async (req, res) => {
  try {
    const mes = mesParam(req);
    const parque = String(req.body.parque || '').trim();
    if (!mes || !parque) return res.status(400).json({ success: false, data: null, error: 'mes y parque requeridos' });
    const [[e]] = await pool.query("SELECT * FROM parques_pagos_mes WHERE parque=? AND DATE_FORMAT(mes,'%Y-%m')=?", [parque, mes]);
    if (!e || e.etapa !== 'APROBADA')
      return res.status(400).json({ success: false, data: null, error: 'La comisión debe estar APROBADA antes de emitir la Orden de Pago' });

    /* Mismas condiciones que el dealer: la ODP nace de la FACTURA, nunca antes.
       Todas las operaciones del parque en el mes deben tener FACTURA RECIBIDA en
       su track (la marca el módulo de Cartolas Parque, o a mano en Seguimiento
       Comisión Parques). Un parque solo-arriendo (0 ops) pasa sin exigencia. */
    const [[sinFactura]] = await pool.query(`
      SELECT COUNT(*) n
      FROM postventa_seguimiento s
      JOIN creditos c ON c.id = s.id_credito
      WHERE UPPER(s.parque) = UPPER(?) AND DATE_FORMAT(c.mes,'%Y-%m') = ?
        AND NOT EXISTS (SELECT 1 FROM postventa_etapas pe
          WHERE pe.id_seguimiento = s.id AND pe.track='PARQUE' AND pe.etapa='FACTURA RECIBIDA')`,
      [parque, mes]);
    if (sinFactura.n > 0)
      return res.status(400).json({ success: false, data: null,
        error: `No se puede emitir la Orden de Pago: ${sinFactura.n} operación(es) del parque aún sin FACTURA RECIBIDA en el Seguimiento Comisión Parques. La ODP nace de la factura, igual que en dealers.` });

    const arriendo = Math.round(Number(e.arriendo)), comision = Math.round(Number(e.comision_creditos));
    const total = arriendo + comision;
    const quien = `${req.user?.nombre || ''} ${req.user?.apellido || ''}`.trim() || 'sistema';
    const concepto = `Comisión Parque ${parque} — ${mes} (arriendo ${CLP(arriendo)} + comisión créditos ${CLP(comision)})`;
    const odp = await emitirCorrelativo({ origen: 'PARQUE', origen_id: e.id, concepto, monto: total, id_usuario: req.user?.id_usuario, usuario_nombre: quien });

    await pool.query("UPDATE parques_pagos_mes SET etapa='OP_EMITIDA', odp_id=?, odp_numero=?, emitida_por=?, fecha_emitida=NOW() WHERE id=?",
      [odp.id, odp.numero, quien, e.id]);

    // Alerta in-app según el mantenedor Alertas Post Venta (default Administrador,Tesorero)
    // — la OP queda "por pagar" en el ledger de Órdenes de Pago
    const destinatarios = await destinatariosEvento('parque_orden_emitida');
    await notificarUsuarios(destinatarios.map(u => u.id_usuario), {
      titulo: `Orden de Pago ${odp.numero} — Comisión Parque por pagar`,
      mensaje: `${parque} (${mes}): arriendo ${CLP(arriendo)} + comisión créditos ${CLP(comision)} = ${CLP(total)}.`,
      href: '/ordenes-pago/', clave: `parqueop:${odp.numero}`,
    });

    // Correo a Contabilidad con el desglose
    try {
      const { enviarCorreo, mailConfigurado, envolverHTML } = require('../../../../shared/mailer');
      const to = destinatarios.map(u => u.email).filter(Boolean);
      if (mailConfigurado() && to.length) {
        const html = envolverHTML(`
          <h2 style="color:#012d70">Orden de Pago ${odp.numero} — Comisión Parque</h2>
          <p><b>Parque:</b> ${parque}<br><b>Período:</b> ${mes}</p>
          <table cellpadding="8" style="border-collapse:collapse;border:1px solid #e2e8f0">
            <tr style="background:#012d70;color:#fff"><th align="left">Concepto</th><th align="right">Monto</th></tr>
            <tr><td>Arriendo mensual</td><td align="right">${CLP(arriendo)}</td></tr>
            <tr><td>Comisión por créditos (${e.ops} operaciones)</td><td align="right">${CLP(comision)}</td></tr>
            <tr style="font-weight:700;background:#f1f5f9"><td>TOTAL A PAGAR</td><td align="right">${CLP(total)}</td></tr>
          </table>
          <p>Emitida por ${quien}. La orden queda <b>por pagar</b> en el módulo Órdenes de Pago.</p>`);
        await enviarCorreo({ to, subject: `OP ${odp.numero} — Comisión Parque ${parque} ${mes} (${CLP(total)})`, html });
      }
    } catch (me) { console.error('[comisiones-parques mail]', me.message); }

    await marcarEtapaParqueOps(parque, mes, ['ORDEN DE PAGO EMITIDA'], quien);
    auditar({ req, accion: 'CREAR', modulo: 'postventa', entidad: 'orden_pago_parque', entidad_id: odp.id, detalle: `Emitió ${odp.numero}: ${concepto}` });
    res.json({ success: true, data: { etapa: 'OP_EMITIDA', odp_numero: odp.numero }, error: null });
  } catch (e) { console.error('[comisiones-parques emitir]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── POST /api/comisiones-parques/pagar {mes, parque} — pago + alerta ejecutivos ── */
const pagar = async (req, res) => {
  try {
    const mes = mesParam(req);
    const parque = String(req.body.parque || '').trim();
    if (!mes || !parque) return res.status(400).json({ success: false, data: null, error: 'mes y parque requeridos' });
    const [[e]] = await pool.query("SELECT * FROM parques_pagos_mes WHERE parque=? AND DATE_FORMAT(mes,'%Y-%m')=?", [parque, mes]);
    if (!e || e.etapa !== 'OP_EMITIDA')
      return res.status(400).json({ success: false, data: null, error: 'Debe existir una Orden de Pago emitida para confirmar el pago' });

    const quien = `${req.user?.nombre || ''} ${req.user?.apellido || ''}`.trim() || 'sistema';
    // Segregación de funciones: quien emitió la orden del parque no puede pagarla.
    const seg = await require('../../../../shared/segregacion-pagos')
      .validarPagador({ nombreEmisor: e.emitida_por, nombrePagador: quien, idPagador: null });
    if (!seg.ok) return res.status(403).json({ success: false, data: null, error: seg.motivo });
    await pagarCorrelativo({ numero: e.odp_numero, id_usuario: req.user?.id_usuario, usuario_nombre: quien });
    await pool.query("UPDATE parques_pagos_mes SET etapa='PAGO_REALIZADO', pagada_por=?, fecha_pagada=NOW() WHERE id=?", [quien, e.id]);

    // Alerta a los ejecutivos del parque (siempre, es parte del flujo) + perfiles
    // configurados en el mantenedor Alertas Post Venta (parque_pago_realizado)
    const calc = await calcularMes(mes);
    const row = calc.find(r => r.parque === parque);
    const ejecutivos = [...new Set((row?.detalle || []).map(o => o.ejecutivo).filter(x => x && x !== '—'))];
    const ids = (await destinatariosEvento('parque_pago_realizado')).map(u => u.id_usuario);
    for (const ej of ejecutivos) {
      try {
        const [us] = await pool.query('SELECT id_usuario FROM usuario_ejecutivos WHERE ejecutivo = ?', [ej]);
        us.forEach(u => ids.push(u.id_usuario));
      } catch (_) {}
    }
    const total = Math.round(Number(e.arriendo)) + Math.round(Number(e.comision_creditos));
    await notificarUsuarios(ids, {
      titulo: `Comisión de ${parque} pagada`,
      mensaje: `Se pagó la comisión del parque ${parque} (${mes}) por ${CLP(total)} — OP ${e.odp_numero}.`,
      href: '/postventa/comisiones-parques/', clave: `parquepago:${e.odp_numero}`,
    });

    await marcarEtapaParqueOps(parque, mes, ['ENVIADO A PAGO', 'COMISION PAGADA'], quien);
    // Máxima 4: el pago rebaja el pasivo contra banco (regla COMISION_PARQUES_PAGADA)
    require('../../../contabilidad/src/motor-asientos').contabilizar({
      evento: 'COMISION_PARQUES_PAGADA',
      glosa: `Pago ${e.odp_numero} — parque ${parque} ${mes}`,
      ref: `PARQUE-PAGO-${e.odp_numero}`,
      montos: { monto: Math.round(Number(e.arriendo) || 0) + Math.round(Number(e.comision_creditos) || 0) },
    }).catch(er => console.error('[parques ctb pago]', er.message));
    auditar({ req, accion: 'EDITAR', modulo: 'postventa', entidad: 'orden_pago_parque', entidad_id: e.id, detalle: `Confirmó pago ${e.odp_numero} — parque ${parque} ${mes}` });
    res.json({ success: true, data: { etapa: 'PAGO_REALIZADO' }, error: null });
  } catch (e) { console.error('[comisiones-parques pagar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ═══ CARTOLAS PARQUE ═══════════════════════════════════════════════════════
   La cartola del parque del mes: sus operaciones (com_parque) + la línea de
   arriendo. Cada acción marca la etapa en el track PARQUE de TODAS las ops del
   parque/mes (y las previas de cartola, patrón del envío de cartolas dealer). */

/* GET /cartola-estado?mes — por parque: etapas de cartola + datos de la ficha. */
const cartolaEstado = async (req, res) => {
  try {
    const mes = mesParam(req);
    if (!mes) return res.status(400).json({ success: false, data: null, error: 'Parámetro mes (YYYY-MM) requerido' });
    // Una etapa está "hecha" cuando TODAS las ops del parque/mes la tienen.
    const [rows] = await pool.query(`
      SELECT s.parque,
             COUNT(*) ops,
             SUM(EXISTS(SELECT 1 FROM postventa_etapas e WHERE e.id_seguimiento=s.id AND e.track='PARQUE' AND e.etapa='CARTOLA EMITIDA'))  em,
             SUM(EXISTS(SELECT 1 FROM postventa_etapas e WHERE e.id_seguimiento=s.id AND e.track='PARQUE' AND e.etapa='CARTOLA APROBADA')) ap,
             SUM(EXISTS(SELECT 1 FROM postventa_etapas e WHERE e.id_seguimiento=s.id AND e.track='PARQUE' AND e.etapa='CARTOLA ENVIADA'))  en,
             SUM(EXISTS(SELECT 1 FROM postventa_etapas e WHERE e.id_seguimiento=s.id AND e.track='PARQUE' AND e.etapa='FACTURA RECIBIDA')) fa
      FROM postventa_seguimiento s
      JOIN creditos c ON c.id = s.id_credito
      WHERE s.parque IS NOT NULL AND DATE_FORMAT(c.mes,'%Y-%m') = ?
      GROUP BY s.parque`, [mes]);
    const [facs] = await pool.query('SELECT parque, numero_factura, fecha_factura, monto_bruto FROM parques_facturas WHERE mes=?', [mes]);
    const facMap = new Map(facs.map(f => [f.parque, f]));
    const [fichas] = await pool.query(`
      SELECT p.nombre, f.rut, f.razon_social, f.cf_email, f.cf_nombre, f.tipo_documento
      FROM parques_comisiones p LEFT JOIN parques_ficha f ON f.id_parque = p.id`);
    const fMap = new Map(fichas.map(f => [f.nombre, f]));
    const data = rows.map(r => ({
      parque: r.parque, ops: r.ops,
      emitida: Number(r.em) >= r.ops, aprobada: Number(r.ap) >= r.ops,
      enviada: Number(r.en) >= r.ops, factura: Number(r.fa) >= r.ops,
      ficha: fMap.get(r.parque) || null,
      factura_datos: facMap.get(r.parque) || null,
    }));
    // También los parques solo-arriendo (sin ops en el mes) con su ficha
    for (const [nombre, f] of fMap) {
      if (!data.some(d => d.parque === nombre))
        data.push({ parque: nombre, ops: 0, emitida: false, aprobada: false, enviada: false, factura: false, ficha: f, factura_datos: facMap.get(nombre) || null });
    }
    res.json({ success: true, data: { mes, rows: data }, error: null });
  } catch (e) { console.error('[cartola-estado]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const quienDe = req => `${req.user?.nombre || req.usuario?.nombre || ''} ${req.user?.apellido || req.usuario?.apellido || ''}`.trim() || 'sistema';

/* POST /cartola/emitir {mes,parque} */
const cartolaEmitir = async (req, res) => {
  try {
    const mes = mesParam(req), parque = String(req.body.parque || '').trim();
    if (!mes || !parque) return res.status(400).json({ success: false, data: null, error: 'mes y parque requeridos' });
    await marcarEtapaParqueOps(parque, mes, ['CARTOLA EMITIDA'], quienDe(req));
    auditar({ req, accion: 'CREAR', modulo: 'postventa', entidad: 'cartola_parque', detalle: `Emitió cartola parque ${parque} (${mes})` });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[cartola emitir]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* POST /cartola/aprobar {mes,parque} — revisión conforme (marca también EMITIDA si faltara) */
const cartolaAprobar = async (req, res) => {
  try {
    const mes = mesParam(req), parque = String(req.body.parque || '').trim();
    if (!mes || !parque) return res.status(400).json({ success: false, data: null, error: 'mes y parque requeridos' });
    await marcarEtapaParqueOps(parque, mes, ['CARTOLA EMITIDA', 'CARTOLA APROBADA'], quienDe(req));
    auditar({ req, accion: 'APROBAR', modulo: 'postventa', entidad: 'cartola_parque', detalle: `Aprobó cartola parque ${parque} (${mes})` });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[cartola aprobar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* POST /cartola/enviar {mes,parque,mail,arriendo,comision,total} — registra el
   envío y marca las 4 etapas de cartola en cada operación (patrón dealer). */
const cartolaEnviar = async (req, res) => {
  try {
    const mes = mesParam(req), parque = String(req.body.parque || '').trim();
    if (!mes || !parque) return res.status(400).json({ success: false, data: null, error: 'mes y parque requeridos' });
    const quien = quienDe(req);
    const [r] = await pool.query(
      `INSERT INTO parques_cartolas_enviadas (mes, parque, mail, arriendo, comision, total, enviado_por)
       VALUES (?,?,?,?,?,?,?)`,
      [mes, parque, String(req.body.mail || '') || null,
       Math.round(Number(req.body.arriendo) || 0), Math.round(Number(req.body.comision) || 0),
       Math.round(Number(req.body.total) || 0), quien]);
    await marcarEtapaParqueOps(parque, mes, ['COMISION A PAGAR', 'CARTOLA EMITIDA', 'CARTOLA APROBADA', 'CARTOLA ENVIADA'], quien);
    auditar({ req, accion: 'ENVIAR_CARTOLA', modulo: 'postventa', entidad: 'cartola_parque', entidad_id: r.insertId,
      detalle: `Envió cartola parque ${parque} (${mes}) por ${CLP(Number(req.body.total) || 0)}` });
    res.status(201).json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) { console.error('[cartola enviar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* GET /cartolas-enviadas?mes */
const cartolasEnviadas = async (req, res) => {
  try {
    const mes = mesParam(req);
    const [rows] = await pool.query(
      `SELECT * FROM parques_cartolas_enviadas ${mes ? 'WHERE mes=?' : ''} ORDER BY fecha_envio DESC LIMIT 300`, mes ? [mes] : []);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { console.error('[cartolas enviadas]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* DELETE /cartolas-enviadas/:id — reversa el envío: quita CARTOLA ENVIADA (las previas quedan). */
const cartolaReversarEnvio = async (req, res) => {
  try {
    const [[env]] = await pool.query('SELECT * FROM parques_cartolas_enviadas WHERE id=?', [req.params.id]);
    if (!env) return res.status(404).json({ success: false, data: null, error: 'Envío no encontrado' });
    await desmarcarEtapaParqueOps(env.parque, env.mes, ['CARTOLA ENVIADA']);
    await pool.query('DELETE FROM parques_cartolas_enviadas WHERE id=?', [req.params.id]);
    auditar({ req, accion: 'REVERSAR', modulo: 'postventa', entidad: 'cartola_parque', entidad_id: req.params.id,
      detalle: `Reversó envío de cartola parque ${env.parque} (${env.mes})` });
    res.json({ success: true, data: { reversado: Number(req.params.id) }, error: null });
  } catch (e) { console.error('[cartola reversar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* POST /cartola/factura {mes,parque,numero,fecha,monto} — registra la factura
   del parque con CUADRATURA contra el total (snapshot si existe; si no, el
   cálculo vivo). Al cuadrar, marca FACTURA RECIBIDA en todas las ops del mes. */
const facturaRegistrar = async (req, res) => {
  try {
    const mes = mesParam(req), parque = String(req.body.parque || '').trim();
    const numero = String(req.body.numero || '').trim();
    const monto = Math.round(Number(req.body.monto) || 0);
    if (!mes || !parque) return res.status(400).json({ success: false, data: null, error: 'mes y parque requeridos' });
    if (!numero) return res.status(400).json({ success: false, data: null, error: 'Número de factura requerido' });
    if (monto <= 0) return res.status(400).json({ success: false, data: null, error: 'Monto de la factura requerido' });

    // Total esperado: manda el snapshot aprobado; sin snapshot, el cálculo del mes.
    let esperado = null;
    const [[snap]] = await pool.query("SELECT arriendo, comision_creditos, etapa FROM parques_pagos_mes WHERE parque=? AND DATE_FORMAT(mes,'%Y-%m')=?", [parque, mes]);
    if (snap && snap.etapa !== 'EN_APROBACION') esperado = Math.round(Number(snap.arriendo)) + Math.round(Number(snap.comision_creditos));
    else { const row = (await calcularMes(mes)).find(r => r.parque === parque); if (row) esperado = row.total; }
    if (esperado == null) return res.status(404).json({ success: false, data: null, error: 'Parque sin movimiento en el mes' });
    if (monto !== esperado)
      return res.status(400).json({ success: false, data: null,
        error: `La factura (${CLP(monto)}) no cuadra con el total de la cartola (${CLP(esperado)}). El parque debe facturar exactamente el total.` });

    const quien = quienDe(req);
    await pool.query(
      `INSERT INTO parques_facturas (mes, parque, numero_factura, fecha_factura, monto_bruto, registrado_por)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE numero_factura=VALUES(numero_factura), fecha_factura=VALUES(fecha_factura),
         monto_bruto=VALUES(monto_bruto), registrado_por=VALUES(registrado_por)`,
      [mes, parque, numero, req.body.fecha || null, monto, quien]);
    await marcarEtapaParqueOps(parque, mes, ['FACTURA RECIBIDA'], quien);
    auditar({ req, accion: 'CREAR', modulo: 'postventa', entidad: 'factura_parque',
      detalle: `Registró factura ${numero} del parque ${parque} (${mes}) por ${CLP(monto)} — cuadrada contra la cartola` });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[parques factura]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ═══ REVERSAS DE ODP Y PAGO (con motivo, auditadas) ═══════════════════════ */

/* POST /anular-odp {mes,parque,motivo} — solo con la ODP emitida y NO pagada.
   Anula el correlativo (el número no se libera), vuelve el mes a APROBADA y
   desmarca ORDEN DE PAGO EMITIDA en las operaciones. */
const anularODP = async (req, res) => {
  try {
    const mes = mesParam(req), parque = String(req.body.parque || '').trim();
    const motivo = String(req.body.motivo || '').trim();
    if (!mes || !parque) return res.status(400).json({ success: false, data: null, error: 'mes y parque requeridos' });
    if (motivo.length < 5) return res.status(400).json({ success: false, data: null, error: 'Debes indicar un motivo válido' });
    const [[e]] = await pool.query("SELECT * FROM parques_pagos_mes WHERE parque=? AND DATE_FORMAT(mes,'%Y-%m')=?", [parque, mes]);
    if (!e || e.etapa !== 'OP_EMITIDA')
      return res.status(400).json({ success: false, data: null, error: 'Solo se puede anular una ODP emitida y aún no pagada' });
    const quien = quienDe(req);
    await anularCorrelativo({ numero: e.odp_numero, id_usuario: req.user?.id_usuario, usuario_nombre: quien });
    await pool.query("UPDATE parques_pagos_mes SET etapa='APROBADA', odp_id=NULL, odp_numero=NULL, emitida_por=NULL, fecha_emitida=NULL WHERE id=?", [e.id]);
    await desmarcarEtapaParqueOps(parque, mes, ['ORDEN DE PAGO EMITIDA']);
    auditar({ req, accion: 'REVERSAR', modulo: 'postventa', entidad: 'orden_pago_parque', entidad_id: e.id,
      detalle: `Anuló ODP ${e.odp_numero} — parque ${parque} ${mes}: "${motivo}"` });
    res.json({ success: true, data: { etapa: 'APROBADA', odp_anulada: e.odp_numero }, error: null });
  } catch (e) { console.error('[parques anular-odp]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* POST /revertir-pago {mes,parque,motivo} — deshace el pago: la ODP vuelve a
   "por pagar" y se desmarcan ENVIADO A PAGO + COMISION PAGADA. */
const revertirPago = async (req, res) => {
  try {
    const mes = mesParam(req), parque = String(req.body.parque || '').trim();
    const motivo = String(req.body.motivo || '').trim();
    if (!mes || !parque) return res.status(400).json({ success: false, data: null, error: 'mes y parque requeridos' });
    if (motivo.length < 5) return res.status(400).json({ success: false, data: null, error: 'Debes indicar un motivo válido' });
    const [[e]] = await pool.query("SELECT * FROM parques_pagos_mes WHERE parque=? AND DATE_FORMAT(mes,'%Y-%m')=?", [parque, mes]);
    if (!e || e.etapa !== 'PAGO_REALIZADO')
      return res.status(400).json({ success: false, data: null, error: 'Solo se puede revertir un pago realizado' });
    await despagarCorrelativo({ numero: e.odp_numero });
    await pool.query("UPDATE parques_pagos_mes SET etapa='OP_EMITIDA', pagada_por=NULL, fecha_pagada=NULL WHERE id=?", [e.id]);
    await desmarcarEtapaParqueOps(parque, mes, ['ENVIADO A PAGO', 'COMISION PAGADA']);
    auditar({ req, accion: 'REVERSAR', modulo: 'postventa', entidad: 'orden_pago_parque', entidad_id: e.id,
      detalle: `Revirtió el pago de ${e.odp_numero} — parque ${parque} ${mes}: "${motivo}"` });
    res.json({ success: true, data: { etapa: 'OP_EMITIDA' }, error: null });
  } catch (e) { console.error('[parques revertir-pago]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { listar, detalle, aprobar, emitir, pagar,
  facturaRegistrar, cartolaEstado, cartolaEmitir, cartolaAprobar, cartolaEnviar, cartolasEnviadas, cartolaReversarEnvio,
  anularODP, revertirPago };
