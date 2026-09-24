'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   PROVISIONES POR DEVENGO — motor único. Pato, 24-09-2026. Primer concepto: COMISIÓN DEALER.

   · Principio: el gasto se reconoce en el mes en que NACE la obligación, no cuando llega el
     documento. La provisión es el puente: se constituye al otorgar y se libera cuando entra el
     asiento definitivo (factura/boleta → COMISION_DEV_*), o si la operación se anula.
   · DEALER: al OTORGAR el crédito se provisiona el NETO de comdea_real (la comisión del sistema
     es bruta, IVA incluido; el IVA no es gasto). DEBE 4001127 COMISIONES DEALER / HABER 2106011
     PROVISIÓN COMISIONES DEALER (regla PROV_DEALER). Al registrar la factura o boleta en Post
     Venta se reversa ÍNTEGRA (PROV_DEALER_LIB) y el devengo real entra por su propia regla; la
     diferencia entre lo provisionado y lo real queda en el resultado del mes de la liberación.
   · Una fila por origen (concepto + origen_tipo + origen_id): nunca dos provisiones del mismo
     crédito. Estados: CONSTITUIDA → LIBERADA (motivo FACTURA | BOLETA | ANULACION | MANUAL).
   · Parámetros (ctb_config): prov_dealer_desde (primer mes de otorgamiento que se provisiona,
     AAAA-MM). Lo anterior ya venía devengado por documento y no se toca.
   · Motor automático `provisiones-dealer` (cada 6 h): red de seguridad para TODAS las vías de
     otorgamiento (carta, carga Trinidad, digitación, edición) y para liberar lo facturado o anulado.
     Los disparos directos (otorgar la carta, registrar la factura) solo adelantan el momento.
   · Nunca bloquea la operación: si el mes contable está cerrado, el asiento va al día de hoy.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../shared/config/database');
const { hoyISO } = require('../../../shared/fecha-chile');

const CONCEPTOS = {
  DEALER: { nombre: 'Comisión dealer', regla: 'PROV_DEALER', reglaLib: 'PROV_DEALER_LIB', cuentaProv: '2106011', cuentaGasto: '4001127', paramDesde: 'prov_dealer_desde' },
  /* PARQUE (24-09-2026): al otorgar se provisiona la comisión parque (com_parque) y el arriendo prorrateado
     (arriendo_parque) del crédito, cada uno a su gasto (4001100 / 4002100) contra 2106013 (cuenta propia:
     la 2106012 es el "por pagar" que deja COMISION_PARQUES al aprobar el mes). Se libera al APROBAR el pago
     del parque del mes en Post Venta → Comisiones Parques (foto parques_pagos_ops) o al anular. */
  PARQUE: { nombre: 'Comisión y arriendo parque', regla: 'PROV_PARQUE', reglaLib: 'PROV_PARQUE_LIB', cuentaProv: '2106013', cuentaGasto: '4001100 / 4002100', paramDesde: 'prov_parque_desde' },
  /* EJECUTIVO (24-09-2026): al otorgar se provisiona la comisión estimada del ejecutivo de la operación
     (creditos.comej = monto financiado × %: carta > producto > pct_ejecutivo_fin) contra 2106014. Se libera
     cuando Operaciones APRUEBA la comisión del ejecutivo del mes en Revisión de Comisiones; en ese acto entra
     el devengo real por COMISION_EJECUTIVOS (incentivo aprobado, con semana corrida) contra 2106060. */
  EJECUTIVO: { nombre: 'Comisión ejecutivo', regla: 'PROV_EJECUTIVO', reglaLib: 'PROV_EJECUTIVO_LIB', cuentaProv: '2106014', cuentaGasto: '4001100', paramDesde: 'prov_ejecutivo_desde' },
};

require('../../../shared/migrate').enFila('ctb-provisiones', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS ctb_provisiones (
    id INT AUTO_INCREMENT PRIMARY KEY,
    concepto VARCHAR(20) NOT NULL, origen_tipo VARCHAR(20) NOT NULL, origen_id INT NOT NULL,
    num_op VARCHAR(30) NULL, tercero VARCHAR(200) NULL, rut_tercero VARCHAR(20) NULL,
    mes CHAR(7) NOT NULL, fecha_constitucion DATE NOT NULL, monto DECIMAL(14,0) NOT NULL,
    base_bruta DECIMAL(14,0) NULL,
    estado VARCHAR(12) NOT NULL DEFAULT 'CONSTITUIDA',
    motivo_liberacion VARCHAR(20) NULL, fecha_liberacion DATE NULL,
    id_comprobante_constitucion INT NULL, id_comprobante_liberacion INT NULL,
    creado_por VARCHAR(160) NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NULL,
    UNIQUE KEY uq_origen (concepto, origen_tipo, origen_id), INDEX idx_estado (concepto, estado), INDEX idx_mes (mes))`);
  await pool.query('CREATE TABLE IF NOT EXISTS ctb_config (clave VARCHAR(60) PRIMARY KEY, valor VARCHAR(200) NOT NULL)');
  await pool.query("INSERT IGNORE INTO ctb_config (clave, valor) VALUES ('prov_dealer_desde','2026-09'), ('prov_parque_desde','2026-09'), ('prov_ejecutivo_desde','2026-09')");
  await pool.query("INSERT IGNORE INTO ctb_cuentas (codigo, nombre, tipo, imputable) VALUES ('2106011','PROVISION COMISIONES DEALER','PASIVO',1), ('2106013','PROVISION COMISIONES Y ARRIENDO PARQUE (DEVENGO)','PASIVO',1), ('2106014','PROVISION COMISIONES EJECUTIVOS (DEVENGO)','PASIVO',1)");
  // Desglose por campo de la regla (parque: arriendo + comision); monto = total
  await pool.query('ALTER TABLE ctb_provisiones ADD COLUMN IF NOT EXISTS montos_json VARCHAR(400) NULL');
  // Contra qué se liberó (factura N°/fecha/neto, pago, aprobación del parque, anulación, conciliación)
  await pool.query('ALTER TABLE ctb_provisiones ADD COLUMN IF NOT EXISTS liberada_contra VARCHAR(240) NULL');
  // Reglas paramétricas (editables en Reglas de Centralización). INSERT IGNORE: si el Administrador las editó, se respetan.
  const R = [
    ['PROV_DEALER', 'Provisión comisión dealer (al otorgar)', 'Se dispara al OTORGAR un crédito con comisión dealer (motor provisiones): reconoce el gasto del mes de curse por el NETO de la comisión (sin IVA) y deja la provisión. Se libera al registrar la factura/boleta en Post Venta. Campos: monto (neto provisionado).', 'TRASPASO', 1, [
      ['4001127', 'DEBE',  'monto', 'Provisión comisión dealer (neto)'],
      ['2106011', 'HABER', 'monto', 'Provisión comisiones dealer'],
    ]],
    ['PROV_DEALER_LIB', 'Liberación provisión comisión dealer', 'Se dispara al registrar la FACTURA/BOLETA de la comisión en Post Venta (entra el devengo real por COMISION_DEV_*) o al anular la operación: reversa íntegra la provisión constituida. Campos: monto (lo provisionado).', 'TRASPASO', 1, [
      ['2106011', 'DEBE',  'monto', 'Liberación provisión comisión dealer'],
      ['4001127', 'HABER', 'monto', 'Abono comisión dealer provisionada'],
    ]],
    ['PROV_PARQUE', 'Provisión comisión y arriendo parque (al otorgar)', 'Se dispara al OTORGAR un crédito de parque (motor provisiones): reconoce en el mes de curse la comisión parque y el arriendo prorrateado de la operación, cada uno a su gasto, y deja la provisión. Se libera al aprobar el pago del parque del mes en Post Venta → Comisiones Parques. Campos: comision, arriendo.', 'TRASPASO', 1, [
      ['4001100', 'DEBE',  'comision', 'Provisión comisión por ventas parque'],
      ['4002100', 'DEBE',  'arriendo', 'Provisión arriendo de parque'],
      ['2106013', 'HABER', 'comision', 'Provisión parque (comisión)'],
      ['2106013', 'HABER', 'arriendo', 'Provisión parque (arriendo)'],
    ]],
    ['PROV_PARQUE_LIB', 'Liberación provisión parque', 'Se dispara al APROBAR el pago del parque del mes en Post Venta → Comisiones Parques (entra el devengo real por COMISION_PARQUES) o al anular la operación: reversa íntegra la provisión de cada crédito de la foto del mes. Campos: comision, arriendo.', 'TRASPASO', 1, [
      ['2106013', 'DEBE',  'comision', 'Liberación provisión parque (comisión)'],
      ['2106013', 'DEBE',  'arriendo', 'Liberación provisión parque (arriendo)'],
      ['4001100', 'HABER', 'comision', 'Abono comisión parque provisionada'],
      ['4002100', 'HABER', 'arriendo', 'Abono arriendo parque provisionado'],
    ]],
    ['PROV_EJECUTIVO', 'Provisión comisión ejecutivo (al otorgar)', 'Se dispara al OTORGAR un crédito (motor provisiones): reconoce en el mes de curse la comisión estimada del ejecutivo de la operación (creditos.comej: monto financiado × % de la carta, del producto o de Parámetros de Crédito) y deja la provisión. Se libera al aprobar la comisión del ejecutivo del mes en Revisión de Comisiones. Campos: monto.', 'TRASPASO', 1, [
      ['4001100', 'DEBE',  'monto', 'Provisión comisión ejecutivo'],
      ['2106014', 'HABER', 'monto', 'Provisión comisiones ejecutivos'],
    ]],
    ['PROV_EJECUTIVO_LIB', 'Liberación provisión comisión ejecutivo', 'Se dispara al APROBAR en Revisión de Comisiones la comisión del ejecutivo del mes (entra el devengo real por COMISION_EJECUTIVOS) o al anular la operación: reversa íntegra la provisión de cada crédito del ejecutivo en ese mes. Campos: monto.', 'TRASPASO', 1, [
      ['2106014', 'DEBE',  'monto', 'Liberación provisión comisión ejecutivo'],
      ['4001100', 'HABER', 'monto', 'Abono comisión ejecutivo provisionada'],
    ]],
  ];
  for (const [evento, nombre, desc, tipo, activa, lineas] of R) {
    const [r] = await pool.query('INSERT IGNORE INTO ctb_reglas (evento, nombre, descripcion, tipo, activa) VALUES (?,?,?,?,?)', [evento, nombre, desc, tipo, activa]);
    if (r.affectedRows) for (const [cuenta, lado, campo, glosa] of lineas)
      await pool.query('INSERT INTO ctb_reglas_lineas (evento, cuenta, lado, campo, glosa) VALUES (?,?,?,?,?)', [evento, cuenta, lado, campo, glosa]);
  }
  // Card en Contabilidad (mismos perfiles que Libros Legales: Administrador + contabilidad/tesorería)
  const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='ctb_provisiones' LIMIT 1");
  let idf = ex?.id_funcionalidad;
  if (!idf) {
    const [r] = await pool.query("INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (500003,'Provisiones por Devengo','ctb_provisiones','/contabilidad/provisiones/','bi-hourglass-split')");
    idf = r.insertId;
  }
  for (const idp of [1, 90003, 90007, 90009])
    await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
});

const param = async (clave, def) => {
  const [[r]] = await pool.query('SELECT valor FROM ctb_config WHERE clave=?', [clave]);
  return r && r.valor != null && r.valor !== '' ? r.valor : def;
};
const ivaFactor = async () => {
  const [[r]] = await pool.query("SELECT porcentaje FROM impuestos WHERE codigo='IVA'").catch(() => [[null]]);
  return 1 + (r ? Number(r.porcentaje) : 19) / 100;
};
/* Fecha contable: la pedida, salvo que su mes esté cerrado con candado → hoy (nunca se pierde el asiento) */
async function fechaContable(iso) {
  const f = /^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? iso : hoyISO();
  const [[cerrado]] = await pool.query('SELECT mes FROM ctb_meses_cerrados WHERE mes=?', [f.slice(0, 7)]);
  return cerrado ? hoyISO() : f;
}
const contabilizar = (...a) => require('./motor-asientos').contabilizar(...a);

/* ¿La comisión de esta OP ya tiene documento registrado en Post Venta? → { tipo, fecha } | null */
async function documentoDealer(num_op, registradoDesde = null) {
  if (!num_op) return null;
  const [[d]] = await pool.query(
    `SELECT fc.es_boleta, fc.numero_factura, fc.monto_bruto neto, fc.nombre_dealer, DATE_FORMAT(COALESCE(fc.fecha_factura, fc.created_at),'%Y-%m-%d') f
       FROM postventa_facturas_comision fc WHERE fc.num_op=? AND fc.monto_liquido IS NOT NULL ${registradoDesde ? 'AND fc.created_at >= ?' : ''}
      ORDER BY fc.created_at DESC LIMIT 1`, registradoDesde ? [num_op, registradoDesde] : [num_op]);
  if (!d) return null;
  // Nunca antes del arranque del motor: una factura vieja no puede mandar el asiento a un mes ya informado
  const fecha = registradoDesde && d.f < registradoDesde ? registradoDesde : d.f;
  const tipo = Number(d.es_boleta) ? 'BOLETA' : 'FACTURA';
  const contra = `${tipo === 'BOLETA' ? 'Boleta' : 'Factura'} N° ${d.numero_factura || 's/n'} del ${(d.f || '').split('-').reverse().join('-')} · neto $${Math.round(Number(d.neto) || 0).toLocaleString('es-CL')}${d.nombre_dealer ? ' · ' + d.nombre_dealer : ''}`;
  return { tipo, fecha, contra };
}

/* Constituye la provisión de comisión dealer de UN crédito otorgado. Idempotente. Devuelve la fila o null (con motivo). */
async function constituirDealer(idCredito, usuario = 'Motor provisiones') {
  const C = CONCEPTOS.DEALER;
  try {
    const [[c]] = await pool.query(
      `SELECT id, num_op, UPPER(COALESCE(estado_credito,'')) est, comdea_real, DATE_FORMAT(fecha_otorgado,'%Y-%m-%d') fo,
              DATE_FORMAT(mes,'%Y-%m') mes, automotora, rut_dealer FROM creditos WHERE id=?`, [idCredito]);
    if (!c) return { skip: 'sin crédito' };
    if (c.est !== 'OTORGADO') return { skip: 'no otorgado' };
    const bruto = Math.round(Number(c.comdea_real) || 0);
    if (bruto <= 0) return { skip: 'sin comisión dealer' };
    const desde = await param(C.paramDesde, '2026-09');
    const mes = c.mes || (c.fo || '').slice(0, 7);
    if (!mes || mes < desde) return { skip: `anterior a ${desde}` };
    const [[ya]] = await pool.query("SELECT id, estado FROM ctb_provisiones WHERE concepto='DEALER' AND origen_tipo='CREDITO' AND origen_id=?", [idCredito]);
    if (ya) return { skip: `ya ${ya.estado.toLowerCase()}`, id: ya.id };
    if (await documentoDealer(c.num_op)) return { skip: 'ya tiene documento (devengo real)' };
    const monto = Math.round(bruto / await ivaFactor());
    const fecha = await fechaContable(c.fo || `${mes}-01`);
    const [ins] = await pool.query(
      `INSERT IGNORE INTO ctb_provisiones (concepto, origen_tipo, origen_id, num_op, tercero, rut_tercero, mes, fecha_constitucion, monto, base_bruta, creado_por)
       VALUES ('DEALER','CREDITO',?,?,?,?,?,?,?,?,?)`,
      [idCredito, c.num_op || null, c.automotora || null, c.rut_dealer || null, mes, fecha, monto, bruto, usuario]);
    if (!ins.affectedRows) return { skip: 'carrera: ya existía' };
    const id = await contabilizar({
      evento: C.regla, fecha, ref: `PROV-DEALER-${idCredito}`, montos: { monto },
      glosa: `Provisión comisión dealer OP ${c.num_op || idCredito} — ${c.automotora || ''}`.slice(0, 300),
      num_op: c.num_op || null, rut: c.rut_dealer || null,
      detalle: `OP ${c.num_op || idCredito} · ${c.automotora || 'dealer'} · bruto $${bruto.toLocaleString('es-CL')}`,
    });
    await pool.query('UPDATE ctb_provisiones SET id_comprobante_constitucion=? WHERE id=?', [id, ins.insertId]);
    return { id: ins.insertId, monto, id_comprobante: id };
  } catch (e) { console.error('[provisiones constituirDealer]', idCredito, e.message); return { error: e.message }; }
}

/* Libera (reversa íntegra) la provisión CONSTITUIDA de un crédito. motivo: FACTURA | BOLETA | ANULACION | MANUAL */
/* Libera UNA fila de provisión dealer (del motor: origen CREDITO, o del detalle AVSOFT del contador:
   origen AVSOFT, cargado el 24-09-2026 sin asiento porque ya vivía en la cuenta). Ref idempotente por fila. */
async function _liberarFilaDealer(p, motivo = 'MANUAL', fechaISO = null, usuario = 'Motor provisiones', contra = null) {
  const C = CONCEPTOS.DEALER;
  try {
    const fecha = await fechaContable(fechaISO || hoyISO());
    const [u] = await pool.query("UPDATE ctb_provisiones SET estado='LIBERADA', motivo_liberacion=?, fecha_liberacion=?, liberada_contra=?, updated_at=NOW() WHERE id=? AND estado='CONSTITUIDA'",
      [motivo, fecha, String(contra || (motivo === 'MANUAL' ? 'Liberación manual por ' + usuario : motivo)).slice(0, 240), p.id]);
    if (!u.affectedRows) return { skip: 'carrera: ya liberada' };
    const ref = p.origen_tipo === 'CREDITO' ? `PROV-DEALER-${p.origen_id}-LIB` : `PROV-DEALER-${p.origen_tipo}-${p.origen_id}-LIB`;
    const id = await contabilizar({
      evento: C.reglaLib, fecha, ref, montos: { monto: Number(p.monto) },
      glosa: `Liberación provisión comisión dealer OP ${p.num_op || p.origen_id} — ${p.tercero || ''} (${motivo.toLowerCase()}${p.origen_tipo === 'AVSOFT' ? ', provisión AVSOFT' : ''})`.slice(0, 300),
      num_op: p.num_op || null, rut: p.rut_tercero || null,
      detalle: `OP ${p.num_op || p.origen_id} · ${p.tercero || 'dealer'} · ${motivo} · ${p.origen_tipo === 'AVSOFT' ? 'provisionada en AVSOFT ' + p.mes + ' · ' : ''}por ${usuario}`,
    });
    await pool.query('UPDATE ctb_provisiones SET id_comprobante_liberacion=? WHERE id=?', [id, p.id]);
    return { id: p.id, monto: Number(p.monto), id_comprobante: id };
  } catch (e) { console.error('[provisiones liberarDealer]', p.id, e.message); return { error: e.message }; }
}
/* Libera (reversa íntegra) la provisión CONSTITUIDA de un crédito: la del motor y, si existe, la de AVSOFT amarrada a su OP */
async function liberarDealer(idCredito, motivo = 'MANUAL', fechaISO = null, usuario = 'Motor provisiones', contra = null) {
  const [[c]] = await pool.query('SELECT num_op FROM creditos WHERE id=?', [idCredito]);
  const [filas] = await pool.query(
    `SELECT * FROM ctb_provisiones WHERE concepto='DEALER' AND estado='CONSTITUIDA'
       AND ((origen_tipo='CREDITO' AND origen_id=?) OR (origen_tipo='AVSOFT' AND num_op IS NOT NULL AND num_op=?))`, [idCredito, c ? c.num_op : null]);
  if (!filas.length) return { skip: 'sin provisión constituida' };
  // Si no nos dicen contra qué, se busca el documento de la OP (factura/boleta) para dejarlo escrito
  if (!contra && (motivo === 'FACTURA' || motivo === 'BOLETA') && c) { const d = await documentoDealer(c.num_op); if (d) contra = d.contra; }
  let out = null;
  for (const p of filas) { const r = await _liberarFilaDealer(p, motivo, fechaISO, usuario, contra); if (r && r.id) out = out ? { ...out, monto: out.monto + r.monto, n: (out.n || 1) + 1 } : r; }
  return out || { skip: 'nada liberado' };
}
async function liberarDealerPorNumOp(num_op, motivo, fechaISO, usuario, contra = null) {
  const [[c]] = await pool.query('SELECT id FROM creditos WHERE num_op=? LIMIT 1', [num_op]);
  return c ? liberarDealer(c.id, motivo, fechaISO, usuario, contra) : { skip: 'sin crédito' };
}
async function liberarFilaPorId(idFila, motivo, fechaISO, usuario, contra = null) {
  const [[p]] = await pool.query("SELECT * FROM ctb_provisiones WHERE id=? AND estado='CONSTITUIDA'", [idFila]);
  if (!p) return { skip: 'sin provisión constituida' };
  if (p.concepto === 'PARQUE') return liberarParque(p.origen_id, motivo, fechaISO, usuario, contra);
  if (p.concepto === 'EJECUTIVO') return liberarEjecutivo(p.origen_id, motivo, fechaISO, usuario, contra);
  return _liberarFilaDealer(p, motivo, fechaISO, usuario, contra);
}

/* Red de seguridad: constituye lo otorgado sin provisión y libera lo facturado o anulado. */
async function sincronizarDealer(usuario = 'Motor provisiones') {
  const desde = await param(CONCEPTOS.DEALER.paramDesde, '2026-09');
  const out = { constituidas: 0, liberadas: 0, omitidas: 0 };
  const [pend] = await pool.query(
    `SELECT c.id FROM creditos c
      LEFT JOIN ctb_provisiones p ON p.concepto='DEALER' AND p.origen_tipo='CREDITO' AND p.origen_id=c.id
     WHERE UPPER(COALESCE(c.estado_credito,''))='OTORGADO' AND COALESCE(c.comdea_real,0)>0
       AND DATE_FORMAT(COALESCE(c.mes, c.fecha_otorgado),'%Y-%m') >= ? AND p.id IS NULL`, [desde]);
  for (const r of pend) { const x = await constituirDealer(r.id, usuario); if (x && x.id && !x.skip) out.constituidas++; else out.omitidas++; }
  // Del motor: se liberan por documento o por anulación. De AVSOFT (contador): SOLO por documento —
  // el estado de un crédito antiguo no dice si su comisión se pagó o no.
  const [abiertas] = await pool.query(
    `SELECT p.*, UPPER(COALESCE(c.estado_credito,'')) est FROM ctb_provisiones p
      LEFT JOIN creditos c ON c.id = CASE WHEN p.origen_tipo='CREDITO' THEN p.origen_id END
     WHERE p.concepto='DEALER' AND p.estado='CONSTITUIDA' AND (p.origen_tipo='CREDITO' OR p.num_op IS NOT NULL)`);
  for (const p of abiertas) {
    if (p.origen_tipo === 'CREDITO' && p.est !== 'OTORGADO') { const x = await _liberarFilaDealer(p, 'ANULACION', null, usuario, `Crédito en estado ${p.est}`); if (x && x.id) out.liberadas++; continue; }
    // AVSOFT: solo documentos registrados desde que el motor manda (los anteriores ya los rebajó el contador o son parte de su diferencia)
    const d = await documentoDealer(p.num_op, p.origen_tipo === 'AVSOFT' ? `${desde}-01` : null);
    if (d) { const x = await _liberarFilaDealer(p, d.tipo, d.fecha, usuario, d.contra); if (x && x.id) out.liberadas++; continue; }
    // AVSOFT sin factura por OP pero con COMISION PAGADA en el Seguimiento desde el arranque (típico: comisiones de
    // parque que el contador provisionó en 2106011 y se pagan por la cartola del parque): el pago es la evidencia.
    if (p.origen_tipo === 'AVSOFT') {
      const [[pg]] = await pool.query(
        `SELECT DATE_FORMAT(MIN(e.fecha),'%Y-%m-%d') f FROM postventa_etapas e JOIN postventa_seguimiento s ON s.id=e.id_seguimiento
          JOIN creditos c ON c.id=s.id_credito WHERE c.num_op=? AND e.track='COMISION' AND e.etapa LIKE '%PAGAD%' AND e.fecha >= ?`, [p.num_op, `${desde}-01`]);
      if (pg && pg.f) { const x = await _liberarFilaDealer(p, 'PAGO', pg.f, usuario, `Comisión pagada el ${pg.f.split('-').reverse().join('-')} (Seguimiento Post Venta, sin factura por OP)`); if (x && x.id) out.liberadas++; }
    }
  }
  return out;
}

/* ── PARQUE ─────────────────────────────────────────────────────────────────── */
/* ¿El crédito ya está en la foto de un pago de parque APROBADO (o más allá)? → { parque, mes, fecha } | null */
async function pagoParqueAprobado(num_op) {
  if (!num_op) return null;
  const [[r]] = await pool.query(
    `SELECT pm.parque, DATE_FORMAT(pm.mes,'%Y-%m') mes, DATE_FORMAT(COALESCE(pm.fecha_aprobada, pm.updated_at, pm.created_at),'%Y-%m-%d') f
       FROM parques_pagos_ops po JOIN parques_pagos_mes pm ON pm.parque=po.parque AND pm.mes=po.mes
      WHERE po.num_op=? AND pm.etapa<>'EN_APROBACION' ORDER BY pm.mes DESC LIMIT 1`, [num_op]);
  return r || null;
}

/* Constituye la provisión de comisión + arriendo de parque de UN crédito otorgado. Idempotente. */
async function constituirParque(idCredito, usuario = 'Motor provisiones') {
  const C = CONCEPTOS.PARQUE;
  try {
    const [[c]] = await pool.query(
      `SELECT id, num_op, UPPER(COALESCE(estado_credito,'')) est, com_parque, arriendo_parque, parque, DATE_FORMAT(fecha_otorgado,'%Y-%m-%d') fo,
              DATE_FORMAT(mes,'%Y-%m') mes FROM creditos WHERE id=?`, [idCredito]);
    if (!c) return { skip: 'sin crédito' };
    if (c.est !== 'OTORGADO') return { skip: 'no otorgado' };
    const comision = Math.max(0, Math.round(Number(c.com_parque) || 0)), arriendo = Math.max(0, Math.round(Number(c.arriendo_parque) || 0));
    const monto = comision + arriendo;
    if (monto <= 0) return { skip: 'sin comisión ni arriendo de parque' };
    const desde = await param(C.paramDesde, '2026-09');
    const mes = c.mes || (c.fo || '').slice(0, 7);
    if (!mes || mes < desde) return { skip: `anterior a ${desde}` };
    const [[ya]] = await pool.query("SELECT id, estado FROM ctb_provisiones WHERE concepto='PARQUE' AND origen_tipo='CREDITO' AND origen_id=?", [idCredito]);
    if (ya) return { skip: `ya ${ya.estado.toLowerCase()}`, id: ya.id };
    if (await pagoParqueAprobado(c.num_op)) return { skip: 'pago del parque ya aprobado (devengo real)' };
    const fecha = await fechaContable(c.fo || `${mes}-01`);
    const montos = { comision, arriendo };
    const [ins] = await pool.query(
      `INSERT IGNORE INTO ctb_provisiones (concepto, origen_tipo, origen_id, num_op, tercero, mes, fecha_constitucion, monto, montos_json, creado_por)
       VALUES ('PARQUE','CREDITO',?,?,?,?,?,?,?,?)`,
      [idCredito, c.num_op || null, c.parque || null, mes, fecha, monto, JSON.stringify(montos), usuario]);
    if (!ins.affectedRows) return { skip: 'carrera: ya existía' };
    const id = await contabilizar({
      evento: C.regla, fecha, ref: `PROV-PARQUE-${idCredito}`, montos,
      glosa: `Provisión parque OP ${c.num_op || idCredito} — ${c.parque || ''}`.slice(0, 300), num_op: c.num_op || null,
      detalle: `OP ${c.num_op || idCredito} · ${c.parque || 'parque'} · comisión $${comision.toLocaleString('es-CL')} · arriendo $${arriendo.toLocaleString('es-CL')}`,
    });
    await pool.query('UPDATE ctb_provisiones SET id_comprobante_constitucion=? WHERE id=?', [id, ins.insertId]);
    return { id: ins.insertId, monto, id_comprobante: id };
  } catch (e) { console.error('[provisiones constituirParque]', idCredito, e.message); return { error: e.message }; }
}

/* Libera (reversa íntegra) la provisión PARQUE de un crédito. motivo: APROBACION | ANULACION | MANUAL */
async function liberarParque(idCredito, motivo = 'MANUAL', fechaISO = null, usuario = 'Motor provisiones', contra = null) {
  const C = CONCEPTOS.PARQUE;
  try {
    const [[p]] = await pool.query("SELECT * FROM ctb_provisiones WHERE concepto='PARQUE' AND origen_tipo='CREDITO' AND origen_id=? AND estado='CONSTITUIDA'", [idCredito]);
    if (!p) return { skip: 'sin provisión constituida' };
    const fecha = await fechaContable(fechaISO || hoyISO());
    const [u] = await pool.query("UPDATE ctb_provisiones SET estado='LIBERADA', motivo_liberacion=?, fecha_liberacion=?, liberada_contra=?, updated_at=NOW() WHERE id=? AND estado='CONSTITUIDA'",
      [motivo, fecha, String(contra || (motivo === 'MANUAL' ? 'Liberación manual por ' + usuario : motivo)).slice(0, 240), p.id]);
    if (!u.affectedRows) return { skip: 'carrera: ya liberada' };
    let montos; try { montos = JSON.parse(p.montos_json || ''); } catch (_) { montos = null; }
    if (!montos) montos = { comision: Number(p.monto), arriendo: 0 };
    const id = await contabilizar({
      evento: C.reglaLib, fecha, ref: `PROV-PARQUE-${idCredito}-LIB`, montos,
      glosa: `Liberación provisión parque OP ${p.num_op || idCredito} — ${p.tercero || ''} (${motivo.toLowerCase()})`.slice(0, 300), num_op: p.num_op || null,
      detalle: `OP ${p.num_op || idCredito} · ${p.tercero || 'parque'} · ${motivo} · por ${usuario}`,
    });
    await pool.query('UPDATE ctb_provisiones SET id_comprobante_liberacion=? WHERE id=?', [id, p.id]);
    return { id: p.id, monto: Number(p.monto), id_comprobante: id };
  } catch (e) { console.error('[provisiones liberarParque]', idCredito, e.message); return { error: e.message }; }
}
/* Al aprobar el pago del parque del mes: libera las provisiones de todas las OP de la foto */
async function liberarParquePorPago(parque, mes, fechaISO = null, usuario = 'Motor provisiones') {
  const [ops] = await pool.query(
    `SELECT c.id FROM parques_pagos_ops po JOIN creditos c ON c.num_op=po.num_op
      WHERE po.parque=? AND DATE_FORMAT(po.mes,'%Y-%m')=?`, [parque, mes]);
  let n = 0;
  const contra = `Pago del parque ${parque} ${mes} aprobado (Comisiones Parques, devengo COMISION_PARQUES)`;
  for (const o of ops) { const x = await liberarParque(o.id, 'APROBACION', fechaISO, usuario, contra); if (x && x.id) n++; }
  return { liberadas: n, ops: ops.length };
}

/* Red de seguridad PARQUE: constituye lo otorgado sin provisión y libera lo aprobado o anulado. */
async function sincronizarParque(usuario = 'Motor provisiones') {
  const desde = await param(CONCEPTOS.PARQUE.paramDesde, '2026-09');
  const out = { constituidas: 0, liberadas: 0, omitidas: 0 };
  const [pend] = await pool.query(
    `SELECT c.id FROM creditos c
      LEFT JOIN ctb_provisiones p ON p.concepto='PARQUE' AND p.origen_tipo='CREDITO' AND p.origen_id=c.id
     WHERE UPPER(COALESCE(c.estado_credito,''))='OTORGADO' AND (COALESCE(c.com_parque,0)>0 OR COALESCE(c.arriendo_parque,0)>0)
       AND DATE_FORMAT(COALESCE(c.mes, c.fecha_otorgado),'%Y-%m') >= ? AND p.id IS NULL`, [desde]);
  for (const r of pend) { const x = await constituirParque(r.id, usuario); if (x && x.id && !x.skip) out.constituidas++; else out.omitidas++; }
  const [abiertas] = await pool.query(
    `SELECT p.origen_id id, p.num_op, UPPER(COALESCE(c.estado_credito,'')) est FROM ctb_provisiones p
      JOIN creditos c ON c.id=p.origen_id WHERE p.concepto='PARQUE' AND p.estado='CONSTITUIDA'`);
  for (const p of abiertas) {
    if (p.est !== 'OTORGADO') { const x = await liberarParque(p.id, 'ANULACION', null, usuario, `Crédito en estado ${p.est}`); if (x && x.id) out.liberadas++; continue; }
    const a = await pagoParqueAprobado(p.num_op);
    if (a) { const x = await liberarParque(p.id, 'APROBACION', a.f, usuario, `Pago del parque ${a.parque} ${a.mes} aprobado (Comisiones Parques, devengo COMISION_PARQUES)`); if (x && x.id) out.liberadas++; }
  }
  return out;
}

/* Cuadro del mes por concepto. Los TOTALES salen de la CUENTA contable (2106011 completa: saldo
   inicial con lo que dejó AVSOFT, haber = constituido, debe = liberado, incluyendo comprobantes
   manuales), porque el saldo inicial es el de la cuenta y no solo lo del motor (Pato, 24-09-2026).
   Aparte se informa cuánto del saldo final controla el motor (vigentes) y cuánto es histórico. */
async function cuadro(mes, concepto = 'DEALER') {
  const cta = CONCEPTOS[concepto].cuentaProv;
  const desde = await param(CONCEPTOS[concepto].paramDesde, '2026-09');
  const [[si]] = await pool.query(
    `SELECT COALESCE(SUM(m.haber - m.debe),0) s FROM ctb_movimientos m JOIN ctb_comprobantes c ON c.id=m.id_comprobante
      WHERE m.cuenta=? AND c.estado='CONTABILIZADO' AND DATE_FORMAT(c.fecha,'%Y-%m') < ?`, [cta, mes]);
  const [[mv]] = await pool.query(
    `SELECT COALESCE(SUM(m.haber),0) h, COALESCE(SUM(m.debe),0) d,
            COUNT(DISTINCT CASE WHEN m.haber>0 THEN c.id END) nh, COUNT(DISTINCT CASE WHEN m.debe>0 THEN c.id END) nd
       FROM ctb_movimientos m JOIN ctb_comprobantes c ON c.id=m.id_comprobante
      WHERE m.cuenta=? AND c.estado='CONTABILIZADO' AND DATE_FORMAT(c.fecha,'%Y-%m') = ?`, [cta, mes]);
  const saldo_inicial = Number(si.s), constituido = Number(mv.h), liberado = Number(mv.d), saldo_final = saldo_inicial + constituido - liberado;
  // Lo que controla el motor (sus filas) al cierre del mes
  const [[con]] = await pool.query("SELECT COALESCE(SUM(monto),0) m, COUNT(*) n FROM ctb_provisiones WHERE concepto=? AND DATE_FORMAT(fecha_constitucion,'%Y-%m')=?", [concepto, mes]);
  const [[lib]] = await pool.query("SELECT COALESCE(SUM(monto),0) m, COUNT(*) n FROM ctb_provisiones WHERE concepto=? AND estado='LIBERADA' AND DATE_FORMAT(fecha_liberacion,'%Y-%m')=?", [concepto, mes]);
  const [[sf]] = await pool.query(
    `SELECT COALESCE(SUM(monto),0) m, COUNT(*) n,
            COALESCE(SUM(CASE WHEN origen_tipo='AVSOFT' THEN monto END),0) av, SUM(origen_tipo='AVSOFT') nav
       FROM ctb_provisiones
      WHERE concepto=? AND DATE_FORMAT(fecha_constitucion,'%Y-%m') <= ? AND (estado='CONSTITUIDA' OR DATE_FORMAT(fecha_liberacion,'%Y-%m') > ?)`, [concepto, mes, mes]);
  // motor_vigente incluye el detalle AVSOFT cargado (24-09-2026); la diferencia contra la cuenta es lo que el contador debe conciliar
  const motor_vigente = Number(sf.m), avsoft_vigente = Number(sf.av), avsoft_n = Number(sf.nav) || 0, saldo_historico = saldo_final - motor_vigente;
  const [pendientes] = await pool.query(
    `SELECT p.*, DATEDIFF(CURDATE(), p.fecha_constitucion) dias FROM ctb_provisiones p
      WHERE p.concepto=? AND p.estado='CONSTITUIDA' ORDER BY p.fecha_constitucion, p.id`, [concepto]);
  const [movs] = await pool.query(
    `SELECT * FROM ctb_provisiones WHERE concepto=? AND (DATE_FORMAT(fecha_constitucion,'%Y-%m')=? OR DATE_FORMAT(fecha_liberacion,'%Y-%m')=?) ORDER BY fecha_constitucion DESC, id DESC LIMIT 500`, [concepto, mes, mes]);
  return { mes, concepto, nombre: CONCEPTOS[concepto].nombre, cuenta_provision: cta, cuenta_gasto: CONCEPTOS[concepto].cuentaGasto,
    saldo_inicial, constituido, n_constituido: mv.nh, liberado, n_liberado: mv.nd, saldo_final,
    motor_constituido: Number(con.m), motor_n_constituido: con.n, motor_liberado: Number(lib.m), motor_n_liberado: lib.n,
    motor_vigente, motor_n_vigente: sf.n, avsoft_vigente, avsoft_n, saldo_historico, pendientes, movimientos: movs, desde };
}

/* ── EJECUTIVO ──────────────────────────────────────────────────────────────── */
/* Mes de atribución de comisiones del crédito (motor único shared/mes-atribucion) para un id */
async function mesAtribucionEjecutivo(idCredito) {
  const ATRIB = require('../../../shared/mes-atribucion');
  const corte = await ATRIB.mesCorte();
  const [[r]] = await pool.query(`SELECT DATE_FORMAT(c.mes,'%Y-%m') mes_c, DATE_FORMAT(c.fecha_otorgado,'%Y-%m') mes_f FROM creditos c WHERE c.id=?`, [idCredito]);
  if (!r) return null;
  // Desde el corte manda la fecha de curse; antes el mes contable ajustado (misma definición que MES_SQL)
  return (r.mes_f && r.mes_f >= corte) ? r.mes_f : (r.mes_c || r.mes_f);
}
/* ¿La comisión del ejecutivo de ese mes ya está aprobada por Operaciones? → { fecha, total } | null */
async function aprobacionEjecutivo(ejecutivo, mes) {
  if (!ejecutivo || !mes) return null;
  const [[a]] = await pool.query(
    `SELECT DATE_FORMAT(aprobado_at,'%Y-%m-%d') f, incentivo_final, con_semana_corrida FROM comisiones_aprobaciones WHERE ejecutivo=? AND mes=? AND estado='aprobado'`, [ejecutivo, mes]);
  if (!a) return null;
  return { fecha: a.f, total: Math.round(Number(a.con_semana_corrida) || Number(a.incentivo_final) || 0) };
}

async function constituirEjecutivo(idCredito, usuario = 'Motor provisiones') {
  const C = CONCEPTOS.EJECUTIVO;
  try {
    const [[c]] = await pool.query(
      `SELECT id, num_op, UPPER(COALESCE(estado_credito,'')) est, comej, ejecutivo, DATE_FORMAT(fecha_otorgado,'%Y-%m-%d') fo, DATE_FORMAT(mes,'%Y-%m') mes FROM creditos WHERE id=?`, [idCredito]);
    if (!c) return { skip: 'sin crédito' };
    if (c.est !== 'OTORGADO') return { skip: 'no otorgado' };
    const monto = Math.round(Number(c.comej) || 0);
    if (monto <= 0) return { skip: 'sin comisión ejecutivo (comej)' };
    if (!c.ejecutivo) return { skip: 'sin ejecutivo' };
    const desde = await param(C.paramDesde, '2026-09');
    const mes = c.mes || (c.fo || '').slice(0, 7);
    if (!mes || mes < desde) return { skip: `anterior a ${desde}` };
    const [[ya]] = await pool.query("SELECT id, estado FROM ctb_provisiones WHERE concepto='EJECUTIVO' AND origen_tipo='CREDITO' AND origen_id=?", [idCredito]);
    if (ya) return { skip: `ya ${ya.estado.toLowerCase()}`, id: ya.id };
    const mesAtr = await mesAtribucionEjecutivo(idCredito);
    if (await aprobacionEjecutivo(c.ejecutivo, mesAtr)) return { skip: 'comisión del mes ya aprobada (devengo real)' };
    const fecha = await fechaContable(c.fo || `${mes}-01`);
    const [ins] = await pool.query(
      `INSERT IGNORE INTO ctb_provisiones (concepto, origen_tipo, origen_id, num_op, tercero, mes, fecha_constitucion, monto, creado_por)
       VALUES ('EJECUTIVO','CREDITO',?,?,?,?,?,?,?)`, [idCredito, c.num_op || null, c.ejecutivo, mes, fecha, monto, usuario]);
    if (!ins.affectedRows) return { skip: 'carrera: ya existía' };
    const id = await contabilizar({
      evento: C.regla, fecha, ref: `PROV-EJECUTIVO-${idCredito}`, montos: { monto },
      glosa: `Provisión comisión ejecutivo OP ${c.num_op || idCredito} — ${c.ejecutivo}`.slice(0, 300), num_op: c.num_op || null,
      detalle: `OP ${c.num_op || idCredito} · ${c.ejecutivo} · mes de comisión ${mesAtr || mes}`,
    });
    await pool.query('UPDATE ctb_provisiones SET id_comprobante_constitucion=? WHERE id=?', [id, ins.insertId]);
    return { id: ins.insertId, monto, id_comprobante: id };
  } catch (e) { console.error('[provisiones constituirEjecutivo]', idCredito, e.message); return { error: e.message }; }
}
async function liberarEjecutivo(idCredito, motivo = 'MANUAL', fechaISO = null, usuario = 'Motor provisiones', contra = null) {
  const C = CONCEPTOS.EJECUTIVO;
  try {
    const [[p]] = await pool.query("SELECT * FROM ctb_provisiones WHERE concepto='EJECUTIVO' AND origen_tipo='CREDITO' AND origen_id=? AND estado='CONSTITUIDA'", [idCredito]);
    if (!p) return { skip: 'sin provisión constituida' };
    const fecha = await fechaContable(fechaISO || hoyISO());
    const [u] = await pool.query("UPDATE ctb_provisiones SET estado='LIBERADA', motivo_liberacion=?, fecha_liberacion=?, liberada_contra=?, updated_at=NOW() WHERE id=? AND estado='CONSTITUIDA'",
      [motivo, fecha, String(contra || (motivo === 'MANUAL' ? 'Liberación manual por ' + usuario : motivo)).slice(0, 240), p.id]);
    if (!u.affectedRows) return { skip: 'carrera: ya liberada' };
    const id = await contabilizar({
      evento: C.reglaLib, fecha, ref: `PROV-EJECUTIVO-${idCredito}-LIB`, montos: { monto: Number(p.monto) },
      glosa: `Liberación provisión comisión ejecutivo OP ${p.num_op || idCredito} — ${p.tercero || ''} (${motivo.toLowerCase()})`.slice(0, 300), num_op: p.num_op || null,
      detalle: `OP ${p.num_op || idCredito} · ${p.tercero || 'ejecutivo'} · ${motivo} · por ${usuario}`,
    });
    await pool.query('UPDATE ctb_provisiones SET id_comprobante_liberacion=? WHERE id=?', [id, p.id]);
    return { id: p.id, monto: Number(p.monto), id_comprobante: id };
  } catch (e) { console.error('[provisiones liberarEjecutivo]', idCredito, e.message); return { error: e.message }; }
}
/* Al aprobar la comisión del ejecutivo del mes: libera las provisiones de sus créditos de ese mes de atribución */
async function liberarEjecutivoPorAprobacion(ejecutivo, mes, fechaISO = null, usuario = 'Motor provisiones', total = null) {
  const ATRIB = require('../../../shared/mes-atribucion');
  const [ops] = await pool.query(
    `SELECT p.origen_id id FROM ctb_provisiones p JOIN creditos c ON c.id=p.origen_id
      WHERE p.concepto='EJECUTIVO' AND p.estado='CONSTITUIDA' AND c.ejecutivo=? AND ${ATRIB.MES_SQL(mes, await ATRIB.mesCorte(), 'c')} = ?`, [ejecutivo, mes]);
  const contra = `Comisión de ${ejecutivo} ${mes} aprobada en Revisión de Comisiones${total != null ? ' · total $' + Math.round(total).toLocaleString('es-CL') : ''} (devengo COMISION_EJECUTIVOS)`;
  let n = 0;
  for (const o of ops) { const x = await liberarEjecutivo(o.id, 'APROBACION', fechaISO, usuario, contra); if (x && x.id) n++; }
  return { liberadas: n, ops: ops.length };
}
async function sincronizarEjecutivo(usuario = 'Motor provisiones') {
  const desde = await param(CONCEPTOS.EJECUTIVO.paramDesde, '2026-09');
  const out = { constituidas: 0, liberadas: 0, omitidas: 0 };
  const [pend] = await pool.query(
    `SELECT c.id FROM creditos c
      LEFT JOIN ctb_provisiones p ON p.concepto='EJECUTIVO' AND p.origen_tipo='CREDITO' AND p.origen_id=c.id
     WHERE UPPER(COALESCE(c.estado_credito,''))='OTORGADO' AND COALESCE(c.comej,0)>0 AND c.ejecutivo IS NOT NULL AND c.ejecutivo<>''
       AND DATE_FORMAT(COALESCE(c.mes, c.fecha_otorgado),'%Y-%m') >= ? AND p.id IS NULL`, [desde]);
  for (const r of pend) { const x = await constituirEjecutivo(r.id, usuario); if (x && x.id && !x.skip) out.constituidas++; else out.omitidas++; }
  const [abiertas] = await pool.query(
    `SELECT p.origen_id id, c.ejecutivo, UPPER(COALESCE(c.estado_credito,'')) est FROM ctb_provisiones p
      JOIN creditos c ON c.id=p.origen_id WHERE p.concepto='EJECUTIVO' AND p.estado='CONSTITUIDA'`);
  for (const p of abiertas) {
    if (p.est !== 'OTORGADO') { const x = await liberarEjecutivo(p.id, 'ANULACION', null, usuario, `Crédito en estado ${p.est}`); if (x && x.id) out.liberadas++; continue; }
    const mesAtr = await mesAtribucionEjecutivo(p.id);
    const a = await aprobacionEjecutivo(p.ejecutivo, mesAtr);
    if (a) { const x = await liberarEjecutivo(p.id, 'APROBACION', a.fecha, usuario, `Comisión de ${p.ejecutivo} ${mesAtr} aprobada en Revisión de Comisiones · total $${a.total.toLocaleString('es-CL')} (devengo COMISION_EJECUTIVOS)`); if (x && x.id) out.liberadas++; }
  }
  return out;
}

/* Detalle detrás de cada cuadro (pop-up y Excel). tipo: INICIAL | CONSTITUIDO | LIBERADO | VIGENTE | CUENTA */
async function detalle(mes, concepto, tipo) {
  const cta = CONCEPTOS[concepto].cuentaProv;
  const cols = 'p.*, DATEDIFF(CURDATE(), p.fecha_constitucion) dias';
  const q = {
    INICIAL:     [`SELECT ${cols} FROM ctb_provisiones p WHERE p.concepto=? AND DATE_FORMAT(p.fecha_constitucion,'%Y-%m') < ? AND (p.estado='CONSTITUIDA' OR DATE_FORMAT(p.fecha_liberacion,'%Y-%m') >= ?) ORDER BY p.fecha_constitucion, p.id`, [concepto, mes, mes]],
    CONSTITUIDO: [`SELECT ${cols} FROM ctb_provisiones p WHERE p.concepto=? AND DATE_FORMAT(p.fecha_constitucion,'%Y-%m') = ? ORDER BY p.fecha_constitucion, p.id`, [concepto, mes]],
    LIBERADO:    [`SELECT ${cols} FROM ctb_provisiones p WHERE p.concepto=? AND p.estado='LIBERADA' AND DATE_FORMAT(p.fecha_liberacion,'%Y-%m') = ? ORDER BY p.fecha_liberacion, p.id`, [concepto, mes]],
    VIGENTE:     [`SELECT ${cols} FROM ctb_provisiones p WHERE p.concepto=? AND DATE_FORMAT(p.fecha_constitucion,'%Y-%m') <= ? AND (p.estado='CONSTITUIDA' OR DATE_FORMAT(p.fecha_liberacion,'%Y-%m') > ?) ORDER BY p.fecha_constitucion, p.id`, [concepto, mes, mes]],
  }[tipo];
  if (q) { const [r] = await pool.query(q[0], q[1]); return r; }
  if (tipo === 'CUENTA') {
    const [r] = await pool.query(
      `SELECT c.id id_comprobante, DATE_FORMAT(c.fecha,'%Y-%m-%d') fecha, c.tipo, c.numero, c.origen, c.origen_ref, c.glosa, m.glosa glosa_linea, m.debe, m.haber, m.num_op, m.rut
         FROM ctb_movimientos m JOIN ctb_comprobantes c ON c.id=m.id_comprobante
        WHERE m.cuenta=? AND c.estado='CONTABILIZADO' AND DATE_FORMAT(c.fecha,'%Y-%m') = ? ORDER BY c.fecha, c.id`, [cta, mes]);
    return r;
  }
  throw new Error('Tipo de detalle desconocido');
}

const SINCRONIZAR = { DEALER: sincronizarDealer, PARQUE: sincronizarParque, EJECUTIVO: sincronizarEjecutivo };
const LIBERAR = { DEALER: liberarDealer, PARQUE: liberarParque, EJECUTIVO: liberarEjecutivo };
/* Al otorgar: todos los conceptos que nacen con el crédito (fire-and-forget, nunca lanza) */
async function constituirAlOtorgar(idCredito, usuario) {
  const r = { DEALER: await constituirDealer(idCredito, usuario), PARQUE: await constituirParque(idCredito, usuario), EJECUTIVO: await constituirEjecutivo(idCredito, usuario) };
  return r;
}
async function tick() {
  for (const [k, fn] of Object.entries(SINCRONIZAR)) {
    try { const r = await fn(); if (r.constituidas || r.liberadas) console.log(`[provisiones-${k.toLowerCase()}]`, JSON.stringify(r)); }
    catch (e) { console.error(`[provisiones-${k.toLowerCase()}]`, e.message); }
  }
}
require('../../../shared/scheduler.js').programar('provisiones-devengo', tick, 6 * 60 * 60 * 1000, { arranqueMs: 3 * 60 * 1000 });

module.exports = { CONCEPTOS, SINCRONIZAR, LIBERAR, constituirAlOtorgar, constituirDealer, liberarDealer, liberarDealerPorNumOp, liberarFilaPorId, sincronizarDealer,
  constituirParque, liberarParque, liberarParquePorPago, sincronizarParque,
  constituirEjecutivo, liberarEjecutivo, liberarEjecutivoPorAprobacion, sincronizarEjecutivo, cuadro, detalle };
