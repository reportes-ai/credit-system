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
  /* EJECUTIVO (24-09-2026): MENSUAL por ejecutivo al cierre, con el cálculo del motor de Revisión de Comisiones (lo mismo que cierra RRHH); ver bloque EJECUTIVO más abajo. */
  EJECUTIVO: { nombre: 'Comisión ejecutivo', regla: 'PROV_EJECUTIVO', reglaLib: 'PROV_EJECUTIVO_LIB', cuentaProv: '2106014', cuentaGasto: '4001100', paramDesde: 'prov_ejecutivo_desde' },
  /* SUELDOS (24-09-2026): concepto MENSUAL, no por crédito. Si un mes termina sin su libro de remuneraciones
     contabilizado (ni REMUNERACIONES del motor RRHH ni el traspaso de AVSOFT en 4001060 con fecha de ese mes),
     el cierre provisiona los haberes proyectados de la dotación (motor único haberesProyectados) al último día
     del mes, contra 2106015. Se libera cuando se emiten las liquidaciones de ese mes o cuando aparece el asiento
     real de remuneraciones fechado en el mes (importación AVSOFT). Hoy AVSOFT contabiliza el libro el último
     día del mes, así que normalmente no hay nada que provisionar: es la red de seguridad del devengo. */
  SUELDOS: { nombre: 'Sueldos (libro de remuneraciones)', regla: 'PROV_SUELDOS', reglaLib: 'PROV_SUELDOS_LIB', cuentaProv: '2106015', cuentaGasto: '4001060', paramDesde: 'prov_sueldos_desde' },
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
  await pool.query("INSERT IGNORE INTO ctb_config (clave, valor) VALUES ('prov_dealer_desde','2026-09'), ('prov_parque_desde','2026-09'), ('prov_ejecutivo_desde','2026-09'), ('prov_sueldos_desde','2026-09')");
  await pool.query("INSERT IGNORE INTO ctb_cuentas (codigo, nombre, tipo, imputable) VALUES ('2106011','PROVISION COMISIONES DEALER','PASIVO',1), ('2106013','PROVISION COMISIONES Y ARRIENDO PARQUE (DEVENGO)','PASIVO',1), ('2106014','PROVISION COMISIONES EJECUTIVOS (DEVENGO)','PASIVO',1), ('2106015','PROVISION REMUNERACIONES (DEVENGO)','PASIVO',1)");
  // Desglose por campo de la regla (parque: arriendo + comision); monto = total
  await pool.query('ALTER TABLE ctb_provisiones ADD COLUMN IF NOT EXISTS montos_json VARCHAR(400) NULL');
  // origen_id pasa a texto para los conceptos mensuales por tercero (EJECUTIVO|AAAA-MM); los ids numéricos siguen iguales
  await pool.query('ALTER TABLE ctb_provisiones MODIFY origen_id VARCHAR(80) NOT NULL');
  // La ref de idempotencia PROV-EJECUTIVO-<EJECUTIVO>|AAAA-MM supera los 40 caracteres del libro central
  await pool.query('ALTER TABLE ctb_comprobantes MODIFY origen_ref VARCHAR(100) NULL').catch(() => {});
  await pool.query('ALTER TABLE ctb_eventos_log MODIFY ref VARCHAR(100) NULL').catch(() => {});
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
    ['PROV_EJECUTIVO', 'Provisión comisión ejecutivo (cierre de mes)', 'Se dispara al terminar el mes (motor provisiones): por cada ejecutivo con comisión calculada por el motor de Revisión de Comisiones (incentivo con semana corrida, descuentos y ajustes) y aún no aprobada, reconoce ese valor al último día del mes y deja la provisión. Es el mismo valor que cierra RRHH. Se libera al aprobar en Revisión. Campos: monto.', 'TRASPASO', 1, [
      ['4001100', 'DEBE',  'monto', 'Provisión comisión ejecutivo'],
      ['2106014', 'HABER', 'monto', 'Provisión comisiones ejecutivos'],
    ]],
    ['PROV_EJECUTIVO_LIB', 'Liberación provisión comisión ejecutivo', 'Se dispara al APROBAR en Revisión de Comisiones la comisión del ejecutivo del mes (entra el devengo real por COMISION_EJECUTIVOS): reversa íntegra la provisión del ejecutivo de ese mes. Campos: monto.', 'TRASPASO', 1, [
      ['2106014', 'DEBE',  'monto', 'Liberación provisión comisión ejecutivo'],
      ['4001100', 'HABER', 'monto', 'Abono comisión ejecutivo provisionada'],
    ]],
    ['PROV_SUELDOS', 'Provisión de remuneraciones y leyes sociales (mes en curso)', 'Cada mes (último día, ajustada en cada sincronización) mientras el libro de remuneraciones no esté contabilizado: haberes proyectados de la dotación (motor RRHH) y aportes patronales SIS, AFC empleador y mutual + SANNA, cada uno a su gasto. Los descuentos del trabajador van dentro de los haberes. Se libera al emitir las liquidaciones o al aparecer el libro. Campos: haberes, sis, afc, mutual.', 'TRASPASO', 1, [
      ['4001060', 'DEBE',  'haberes', 'Provisión remuneraciones del mes'],
      ['4001093', 'DEBE',  'sis',     'Provisión SIS (aporte patronal)'],
      ['4001091', 'DEBE',  'afc',     'Provisión seguro de cesantía empleador'],
      ['4001092', 'DEBE',  'mutual',  'Provisión mutual + Ley SANNA'],
      ['2106015', 'HABER', 'haberes', 'Provisión remuneraciones'],
      ['2106015', 'HABER', 'sis',     'Provisión leyes sociales (SIS)'],
      ['2106015', 'HABER', 'afc',     'Provisión leyes sociales (AFC)'],
      ['2106015', 'HABER', 'mutual',  'Provisión leyes sociales (mutual + SANNA)'],
    ]],
    ['PROV_SUELDOS_LIB', 'Liberación provisión de remuneraciones y leyes sociales', 'Se dispara al EMITIR las liquidaciones del mes en RRHH (entra el devengo real por REMUNERACIONES) o cuando se contabiliza el libro de ese mes por otra vía (traspaso AVSOFT), y en cada ajuste al motor: reversa la provisión por campo. Campos: haberes, sis, afc, mutual.', 'TRASPASO', 1, [
      ['2106015', 'DEBE',  'haberes', 'Liberación provisión remuneraciones'],
      ['2106015', 'DEBE',  'sis',     'Liberación provisión leyes sociales (SIS)'],
      ['2106015', 'DEBE',  'afc',     'Liberación provisión leyes sociales (AFC)'],
      ['2106015', 'DEBE',  'mutual',  'Liberación provisión leyes sociales (mutual + SANNA)'],
      ['4001060', 'HABER', 'haberes', 'Abono remuneraciones provisionadas'],
      ['4001093', 'HABER', 'sis',     'Abono SIS provisionado'],
      ['4001091', 'HABER', 'afc',     'Abono seguro de cesantía empleador provisionado'],
      ['4001092', 'HABER', 'mutual',  'Abono mutual + SANNA provisionado'],
    ]],
  ];
  for (const [evento, nombre, desc, tipo, activa, lineas] of R) {
    const [r] = await pool.query('INSERT IGNORE INTO ctb_reglas (evento, nombre, descripcion, tipo, activa) VALUES (?,?,?,?,?)', [evento, nombre, desc, tipo, activa]);
    if (r.affectedRows) for (const [cuenta, lado, campo, glosa] of lineas)
      await pool.query('INSERT INTO ctb_reglas_lineas (evento, cuenta, lado, campo, glosa) VALUES (?,?,?,?,?)', [evento, cuenta, lado, campo, glosa]);
  }
  // Parche idempotente (24-09-2026): PROV_SUELDOS nació con un solo campo 'monto'; ahora separa haberes y leyes
  // sociales (sis, afc, mutual). Solo si la regla conserva 'monto' y nunca generó un asiento.
  for (const ev of ['PROV_SUELDOS', 'PROV_SUELDOS_LIB']) {
    try {
      const [[viejo]] = await pool.query("SELECT COUNT(*) n FROM ctb_reglas_lineas WHERE evento=? AND campo='monto'", [ev]);
      const [[usada]] = await pool.query("SELECT COUNT(*) n FROM ctb_eventos_log WHERE evento=? AND estado='CONTABILIZADO'", [ev]);
      if (viejo.n > 0 && usada.n === 0) {
        const def = R.find(r => r[0] === ev);
        await pool.query('DELETE FROM ctb_reglas_lineas WHERE evento=?', [ev]);
        for (const [cuenta, lado, campo, glosa] of def[5]) await pool.query('INSERT INTO ctb_reglas_lineas (evento, cuenta, lado, campo, glosa) VALUES (?,?,?,?,?)', [ev, cuenta, lado, campo, glosa]);
        await pool.query('UPDATE ctb_reglas SET nombre=?, descripcion=? WHERE evento=?', [def[1], def[2], ev]);
        console.log('[provisiones] ' + ev + ': haberes y leyes sociales separados');
      }
    } catch (e) { console.error('[provisiones parche sueldos]', e.message); }
  }
  // Card en Contabilidad: Administrador, Finanzas (Analista Financiero, Gerente de Finanzas), Gerente General y Gerente de Operaciones y Crédito (Pato, 24-09-2026)
  const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='ctb_provisiones' LIMIT 1");
  let idf = ex?.id_funcionalidad;
  if (!idf) {
    const [r] = await pool.query("INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (500003,'Provisiones por Devengo','ctb_provisiones','/contabilidad/provisiones/','bi-hourglass-split')");
    idf = r.insertId;
  }
  for (const idp of [1, 90003, 90007, 90008, 90009])
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
  /* Una factura puede cubrir varias OP (réplicas es_replica=1 que apuntan a la titular por id_titular): el
     desglose vive solo en la titular. Sin este JOIN las OP hermanas nunca se liberaban (auditoría 24-09-2026, A2). */
  const [[d]] = await pool.query(
    `SELECT fc.es_boleta, COALESCE(fc.numero_factura, t.numero_factura) numero_factura, COALESCE(fc.monto_bruto, t.monto_bruto) neto,
            COALESCE(fc.nombre_dealer, t.nombre_dealer) nombre_dealer, DATE_FORMAT(COALESCE(fc.fecha_factura, t.fecha_factura, fc.created_at),'%Y-%m-%d') f
       FROM postventa_facturas_comision fc LEFT JOIN postventa_facturas_comision t ON t.id_seguimiento = fc.id_titular
      WHERE fc.num_op=? AND COALESCE(fc.monto_liquido, t.monto_liquido) IS NOT NULL ${registradoDesde ? 'AND fc.created_at >= ?' : ''}
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
    if (!id) { await pool.query('DELETE FROM ctb_provisiones WHERE id=?', [ins.insertId]); return { error: 'sin asiento (ver log del motor en Reglas de Centralización)' }; }
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
    if (!id) { await pool.query("UPDATE ctb_provisiones SET estado='CONSTITUIDA', motivo_liberacion=NULL, fecha_liberacion=NULL, liberada_contra=NULL WHERE id=?", [p.id]); return { error: 'sin asiento de liberación (ver log del motor)' }; }
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
  if (p.concepto === 'EJECUTIVO') return _liberarFilaEjecutivo(p, motivo, fechaISO, usuario, contra);
  if (p.concepto === 'SUELDOS') return liberarSueldos(p.mes, motivo, fechaISO, usuario, contra);
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
    if (d) {
      const fc0 = p.fecha_constitucion ? String(p.fecha_constitucion instanceof Date ? p.fecha_constitucion.toISOString().slice(0, 10) : p.fecha_constitucion).slice(0, 10) : null;
      const f = (p.origen_tipo === 'CREDITO' && fc0 && d.fecha < fc0) ? fc0 : d.fecha;   // nunca antes de la constitución (auditoría B2)
      const x = await _liberarFilaDealer(p, d.tipo, f, usuario, d.contra); if (x && x.id) out.liberadas++; continue;
    }
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
    if (!id) { await pool.query('DELETE FROM ctb_provisiones WHERE id=?', [ins.insertId]); return { error: 'sin asiento (ver log del motor en Reglas de Centralización)' }; }
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
    if (!id) { await pool.query("UPDATE ctb_provisiones SET estado='CONSTITUIDA', motivo_liberacion=NULL, fecha_liberacion=NULL, liberada_contra=NULL WHERE id=?", [p.id]); return { error: 'sin asiento de liberación (ver log del motor)' }; }
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
  /* Los AJUSTES al motor (refs -AJn: la provisión del mes en curso siguiendo al cálculo) no son constituciones
     ni liberaciones: van en su propia columna, con signo. Así "constituido" y "liberado" cuentan solo lo real
     (Pato, 24-09-2026: "se constituyen en el mes y se pagan el 31"). */
  const [[mv]] = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN c.origen_ref NOT LIKE '%-AJ%' THEN m.haber END),0) h, COALESCE(SUM(CASE WHEN c.origen_ref NOT LIKE '%-AJ%' THEN m.debe END),0) d,
            COALESCE(SUM(CASE WHEN c.origen_ref LIKE '%-AJ%' THEN m.haber - m.debe END),0) aj,
            COUNT(DISTINCT CASE WHEN m.haber>0 AND c.origen_ref NOT LIKE '%-AJ%' THEN c.id END) nh, COUNT(DISTINCT CASE WHEN m.debe>0 AND c.origen_ref NOT LIKE '%-AJ%' THEN c.id END) nd,
            COUNT(DISTINCT CASE WHEN c.origen_ref LIKE '%-AJ%' THEN c.id END) naj
       FROM ctb_movimientos m JOIN ctb_comprobantes c ON c.id=m.id_comprobante
      WHERE m.cuenta=? AND c.estado='CONTABILIZADO' AND DATE_FORMAT(c.fecha,'%Y-%m') = ?`, [cta, mes]);
  const saldo_inicial = Number(si.s), constituido = Number(mv.h), liberado = Number(mv.d), ajustes = Number(mv.aj), saldo_final = saldo_inicial + constituido + ajustes - liberado;
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
    saldo_inicial, constituido, n_constituido: mv.nh, liberado, n_liberado: mv.nd, ajustes, n_ajustes: mv.naj, saldo_final,
    motor_constituido: Number(con.m), motor_n_constituido: con.n, motor_liberado: Number(lib.m), motor_n_liberado: lib.n,
    motor_vigente, motor_n_vigente: sf.n, avsoft_vigente, avsoft_n, saldo_historico, pendientes, movimientos: movs, desde };
}

/* ── EJECUTIVO (mensual, por ejecutivo) ─────────────────────────────────────
   Pato (24-09-2026): la provisión debe ser LA MISMA que cierra RRHH en las comisiones. El 2,12% de
   Parámetros de Crédito incluye parte del sueldo fijo (deliberado en rentabilidad) y sobreestimaba
   la comisión un 50%. Por eso el concepto pasó de "por crédito al otorgar" a "por ejecutivo al
   cierre del mes": cuando el mes termina, cada ejecutivo con comisión calculada por el motor único
   de Revisión de Comisiones (calcularMes: incentivo con semana corrida, descuentos y ajustes) y aún
   no aprobado se provisiona por ese valor al último día del mes (origen EJECUTIVO_MES, id
   "EJECUTIVO|AAAA-MM"). Al aprobar en Revisión entra el devengo real (COMISION_EJECUTIVOS) por el
   mismo valor y la provisión se libera íntegra. Las 108 filas por crédito de septiembre 2026 se
   reversaron (motivo CAMBIO_MODELO). */
/* ¿La comisión del ejecutivo de ese mes ya está aprobada por Operaciones? → { fecha, total } | null */
async function aprobacionEjecutivo(ejecutivo, mes) {
  if (!ejecutivo || !mes) return null;
  const [[a]] = await pool.query(
    "SELECT DATE_FORMAT(aprobado_at,'%Y-%m-%d') f, incentivo_final, con_semana_corrida FROM comisiones_aprobaciones WHERE ejecutivo=? AND mes=? AND estado='aprobado'", [ejecutivo, mes]);
  if (!a) return null;
  return { fecha: a.f, total: Math.round(Number(a.con_semana_corrida) || Number(a.incentivo_final) || 0) };
}
const idEjecMes = (ejecutivo, mes) => String(ejecutivo).toUpperCase().trim() + '|' + mes;
/* Comisiones del mes según el motor único de Revisión (lo que RRHH va a cerrar) → [{ ejecutivo, total, creditos }] */
async function comisionesMotorMes(mes) {
  const filas = await require('../../comisiones/src/controllers/comisiones.controller').calcularMes(mes);
  return (filas || []).map(f => ({ ejecutivo: f.ejecutivo, total: Math.round(Number(f.con_semana_corrida) || Number(f.incentivo_final) || 0), creditos: f.total_creditos || (f.creditos || []).length || 0 }))
    .filter(f => f.ejecutivo && f.total > 0);
}
/* Constituye las provisiones de un mes TERMINADO: un asiento por ejecutivo con comisión no aprobada. Idempotente. */
async function constituirEjecutivoMes(mes, usuario = 'Motor provisiones') {
  const C = CONCEPTOS.EJECUTIVO;
  const out = { constituidas: 0, omitidas: 0, total: 0 };
  try {
    if (!/^\d{4}-\d{2}$/.test(mes || '')) return { ...out, skip: 'mes inválido' };
    const desde = await param(C.paramDesde, '2026-09');
    if (mes < desde) return { ...out, skip: 'anterior a ' + desde };
    // El mes en curso también se provisiona (Pato: "tiene que cuadrar con lo que hay que provisionar en septiembre");
    // el valor se ajusta en cada sincronización hasta que Operaciones apruebe.
    if (mes > hoyISO().slice(0, 7)) return { ...out, skip: 'mes futuro' };
    const fecha = await fechaContable(ultimoDiaMes(mes));
    for (const f of await comisionesMotorMes(mes)) {
      const oid = idEjecMes(f.ejecutivo, mes);
      const [[ya]] = await pool.query("SELECT id FROM ctb_provisiones WHERE concepto='EJECUTIVO' AND origen_tipo='EJECUTIVO_MES' AND origen_id=?", [oid]);
      if (ya) { out.omitidas++; continue; }
      if (await aprobacionEjecutivo(f.ejecutivo, mes)) { out.omitidas++; continue; }   // ya devengó real
      const [ins] = await pool.query(
        "INSERT IGNORE INTO ctb_provisiones (concepto, origen_tipo, origen_id, tercero, mes, fecha_constitucion, monto, montos_json, creado_por) VALUES ('EJECUTIVO','EJECUTIVO_MES',?,?,?,?,?,?,?)",
        [oid, f.ejecutivo, mes, fecha, f.total, JSON.stringify({ creditos: f.creditos }), usuario]);
      if (!ins.affectedRows) { out.omitidas++; continue; }
      const id = await contabilizar({
        evento: C.regla, fecha, ref: 'PROV-EJECUTIVO-' + oid, montos: { monto: f.total },
        glosa: ('Provisión comisión ejecutivo ' + f.ejecutivo + ' — ' + mes + ' (motor Revisión de Comisiones, sin aprobar al cierre)').slice(0, 300),
        detalle: f.ejecutivo + ' · ' + mes + ' · ' + f.creditos + ' crédito(s) · cálculo del motor al cierre',
      });
      if (!id) { await pool.query('DELETE FROM ctb_provisiones WHERE id=?', [ins.insertId]); out.omitidas++; continue; }
      await pool.query('UPDATE ctb_provisiones SET id_comprobante_constitucion=? WHERE id=?', [id, ins.insertId]);
      out.constituidas++; out.total += f.total;
    }
    return out;
  } catch (e) { console.error('[provisiones constituirEjecutivoMes]', mes, e.message); return { ...out, error: e.message }; }
}
/* Libera una fila EJECUTIVO (mensual, o legado por crédito) */
async function _liberarFilaEjecutivo(p, motivo = 'MANUAL', fechaISO = null, usuario = 'Motor provisiones', contra = null) {
  const C = CONCEPTOS.EJECUTIVO;
  try {
    const fecha = await fechaContable(fechaISO || hoyISO());
    const [u] = await pool.query("UPDATE ctb_provisiones SET estado='LIBERADA', motivo_liberacion=?, fecha_liberacion=?, liberada_contra=?, updated_at=NOW() WHERE id=? AND estado='CONSTITUIDA'",
      [motivo, fecha, String(contra || (motivo === 'MANUAL' ? 'Liberación manual por ' + usuario : motivo)).slice(0, 240), p.id]);
    if (!u.affectedRows) return { skip: 'carrera: ya liberada' };
    const id = await contabilizar({
      evento: C.reglaLib, fecha, ref: 'PROV-EJECUTIVO-' + p.origen_id + '-LIB', montos: { monto: Number(p.monto) },
      glosa: ('Liberación provisión comisión ejecutivo ' + (p.tercero || '') + ' ' + p.mes + (p.num_op ? ' OP ' + p.num_op : '') + ' (' + motivo.toLowerCase() + ')').slice(0, 300), num_op: p.num_op || null,
      detalle: (p.tercero || 'ejecutivo') + ' · ' + p.mes + ' · ' + motivo + ' · por ' + usuario,
    });
    if (!id) { await pool.query("UPDATE ctb_provisiones SET estado='CONSTITUIDA', motivo_liberacion=NULL, fecha_liberacion=NULL, liberada_contra=NULL WHERE id=?", [p.id]); return { error: 'sin asiento de liberación (ver log del motor)' }; }
    await pool.query('UPDATE ctb_provisiones SET id_comprobante_liberacion=? WHERE id=?', [id, p.id]);
    return { id: p.id, monto: Number(p.monto), id_comprobante: id };
  } catch (e) { console.error('[provisiones liberarEjecutivo]', p.id, e.message); return { error: e.message }; }
}
async function liberarEjecutivo(idFila, motivo, fechaISO, usuario, contra) {
  const [[p]] = await pool.query("SELECT * FROM ctb_provisiones WHERE concepto='EJECUTIVO' AND id=? AND estado='CONSTITUIDA'", [idFila]);
  return p ? _liberarFilaEjecutivo(p, motivo, fechaISO, usuario, contra) : { skip: 'sin provisión constituida' };
}
/* Al aprobar la comisión del ejecutivo del mes en Revisión: libera su provisión mensual (y filas legado por crédito si quedaran) */
async function liberarEjecutivoPorAprobacion(ejecutivo, mes, fechaISO = null, usuario = 'Motor provisiones', total = null) {
  const ATRIB = require('../../../shared/mes-atribucion');
  const mesSql = ATRIB.MES_SQL(mes, await ATRIB.mesCorte(), 'c');
  const [filas] = await pool.query(
    "SELECT p.* FROM ctb_provisiones p LEFT JOIN creditos c ON c.id = CASE WHEN p.origen_tipo='CREDITO' THEN p.origen_id END " +
    "WHERE p.concepto='EJECUTIVO' AND p.estado='CONSTITUIDA' AND ((p.origen_tipo='EJECUTIVO_MES' AND p.origen_id=?) OR (p.origen_tipo='CREDITO' AND c.ejecutivo=? AND " + mesSql + " = ?))",
    [idEjecMes(ejecutivo, mes), ejecutivo, mes]);
  const contra = 'Comisión de ' + ejecutivo + ' ' + mes + ' aprobada en Revisión de Comisiones' + (total != null ? ' · total $' + Math.round(total).toLocaleString('es-CL') : '') + ' (devengo COMISION_EJECUTIVOS)';
  let n = 0;
  for (const p of filas) { const x = await _liberarFilaEjecutivo(p, 'APROBACION', fechaISO, usuario, contra); if (x && x.id) n++; }
  return { liberadas: n, filas: filas.length };
}
/* Mientras no se apruebe, la provisión sigue al motor: si el cálculo cambió (más créditos, descuentos,
   ajustes), se contabiliza solo la DIFERENCIA (PROV_EJECUTIVO si sube, PROV_EJECUTIVO_LIB si baja) con
   ref propia por ajuste, y la fila queda en el valor vigente. Una sola fila por ejecutivo y mes. */
async function ajustarEjecutivoMes(mes, usuario = 'Motor provisiones') {
  const C = CONCEPTOS.EJECUTIVO;
  const out = { ajustadas: 0, delta: 0 };
  const [abiertas] = await pool.query("SELECT * FROM ctb_provisiones WHERE concepto='EJECUTIVO' AND estado='CONSTITUIDA' AND origen_tipo='EJECUTIVO_MES' AND mes=?", [mes]);
  if (!abiertas.length) return out;
  const motor = new Map((await comisionesMotorMes(mes)).map(f => [idEjecMes(f.ejecutivo, mes), f]));
  const fecha = await fechaContable(ultimoDiaMes(mes));
  for (const p of abiertas) {
    const f = motor.get(p.origen_id);
    const nuevo = f ? f.total : 0;
    const delta = nuevo - Math.round(Number(p.monto));
    if (!delta) continue;
    let mj = {}; try { mj = JSON.parse(p.montos_json || '{}'); } catch (_) {}
    const n = (mj.ajustes || 0) + 1;
    const id = await contabilizar({
      evento: delta > 0 ? C.regla : C.reglaLib, fecha, ref: 'PROV-EJECUTIVO-' + p.origen_id + '-AJ' + n, montos: { monto: Math.abs(delta) },
      glosa: ('Ajuste provisión comisión ejecutivo ' + p.tercero + ' — ' + mes + ' (' + (delta > 0 ? '+' : '−') + '$' + Math.abs(delta).toLocaleString('es-CL') + ', el motor pasó de $' + Math.round(Number(p.monto)).toLocaleString('es-CL') + ' a $' + nuevo.toLocaleString('es-CL') + ')').slice(0, 300),
      detalle: p.tercero + ' · ' + mes + ' · ajuste ' + n + ' · ' + (f ? f.creditos : 0) + ' crédito(s) · por ' + usuario,
    });
    if (!id) continue;   // sin asiento no se mueve la fila (queda en el log del motor)
    mj.ajustes = n; mj.creditos = f ? f.creditos : 0; mj.historial = [...(mj.historial || []), { n, fecha: hoyISO(), de: Math.round(Number(p.monto)), a: nuevo, comp: id }].slice(-8);
    await pool.query('UPDATE ctb_provisiones SET monto=?, montos_json=?, updated_at=NOW() WHERE id=?', [nuevo, JSON.stringify(mj).slice(0, 400), p.id]);
    out.ajustadas++; out.delta += delta;
  }
  return out;
}
/* Red de seguridad: constituye el mes en curso y el anterior, ajusta lo vigente al motor y libera lo aprobado. */
async function sincronizarEjecutivo(usuario = 'Motor provisiones') {
  const out = { constituidas: 0, liberadas: 0, omitidas: 0, ajustadas: 0 };
  const desde = await param(CONCEPTOS.EJECUTIVO.paramDesde, '2026-09');
  const actual = hoyISO().slice(0, 7), ant = mesAnteriorDe(actual);
  for (const m of [ant, actual]) {
    if (m < desde) continue;
    const x = await constituirEjecutivoMes(m, usuario); out.constituidas += x.constituidas || 0; out.omitidas += x.omitidas || 0;
    const aj = await ajustarEjecutivoMes(m, usuario); out.ajustadas += aj.ajustadas || 0;
  }
  const [abiertas] = await pool.query("SELECT * FROM ctb_provisiones WHERE concepto='EJECUTIVO' AND estado='CONSTITUIDA' AND origen_tipo='EJECUTIVO_MES'");
  for (const p of abiertas) {
    const a = await aprobacionEjecutivo(p.tercero, p.mes);
    if (a) { const x = await _liberarFilaEjecutivo(p, 'APROBACION', a.fecha, usuario, 'Comisión de ' + p.tercero + ' ' + p.mes + ' aprobada en Revisión de Comisiones · total $' + a.total.toLocaleString('es-CL') + ' (devengo COMISION_EJECUTIVOS)'); if (x && x.id) out.liberadas++; }
  }
  return out;
}

/* ── SUELDOS (mensual) ──────────────────────────────────────────────────────── */
const ultimoDiaMes = mes => { const [y, m] = mes.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const mesAnteriorDe = mes => { const [y, m] = mes.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
/* ¿El libro de remuneraciones del mes ya está en la contabilidad? (motor RRHH o traspaso AVSOFT en 4001060 fechado en el mes) */
async function libroRemuneracionesContabilizado(mes) {
  const [[r]] = await pool.query(
    `SELECT c.id, c.origen, DATE_FORMAT(c.fecha,'%Y-%m-%d') f FROM ctb_comprobantes c JOIN ctb_movimientos m ON m.id_comprobante=c.id
      WHERE m.cuenta=? AND m.debe>0 AND c.estado='CONTABILIZADO' AND c.origen NOT IN (?,?)
        AND (DATE_FORMAT(c.fecha,'%Y-%m')=? OR (c.origen='REMUNERACIONES' AND c.origen_ref=?))
      ORDER BY c.id LIMIT 1`, [CONCEPTOS.SUELDOS.cuentaGasto, CONCEPTOS.SUELDOS.regla, CONCEPTOS.SUELDOS.reglaLib, mes, `REM-${mes}`]);
  return r || null;
}
/* Haberes proyectados + aportes patronales de la dotación del mes (motor único RRHH haberesProyectados, misma
   dotación que el libro). Los aportes van AGREGADOS por concepto (SIS, AFC empleador, mutual + SANNA): la
   provisión es una estimación de gasto; el detalle por institución nace con el libro y Previred. */
async function proyeccionSueldos(mes) {
  const REM = require('../../rrhh/src/controllers/remuneraciones.controller');
  const [emps] = await pool.query(
    `SELECT u.id_usuario, CONCAT(UPPER(COALESCE(u.nombre,'')),' ',UPPER(COALESCE(u.apellido,''))) nombre FROM usuarios u JOIN rh_fichas f ON f.id_usuario=u.id_usuario
      WHERE (u.estado='activo' OR (DATE_FORMAT(u.fecha_baja,'%Y-%m') >= ? AND u.fecha_baja > CONCAT(?, '-01'))
             OR EXISTS (SELECT 1 FROM rh_liquidaciones l WHERE l.id_usuario=u.id_usuario AND l.mes=?))
        AND COALESCE(f.sueldo_base,0) > 0 ORDER BY nombre`, [mes, mes, mes]);
  const filas = [];
  for (const e of emps) {
    try {
      const h = await REM.haberesProyectados(e.id_usuario, mes);
      if (!h || !(Number(h.total_haberes) > 0)) continue;
      const c = h.calc || {};
      const R = v => Math.round(Number(v) || 0);
      // Las comisiones (mes vencido) que trae la liquidación YA están provisionadas en el concepto EJECUTIVO y
      // devengan por COMISION_EJECUTIVOS al aprobarse: acá se provisiona el resto de los haberes (Pato, 24-09-2026).
      filas.push({ id_usuario: e.id_usuario, nombre: e.nombre, haberes: R(h.total_haberes) - R(c.comisiones), comisiones: R(c.comisiones), sis: R(c.aporte_sis), afc: R(c.aporte_afc_emp), mutual: R(c.aporte_mutual) + R(c.aporte_sanna), emitida: !!h.emitida });
    } catch (err) { console.error('[provisiones sueldos] haberes', e.id_usuario, err.message); }
  }
  const sum = k => filas.reduce((s, f) => s + f[k], 0);
  const montos = { haberes: sum('haberes'), sis: sum('sis'), afc: sum('afc'), mutual: sum('mutual') };
  return { mes, montos, total: montos.haberes + montos.sis + montos.afc + montos.mutual, filas };
}
const montosDe = p => { try { const m = JSON.parse(p.montos_json || '{}'); if (m && m.montos) return m.montos; } catch (_) {} return { haberes: Number(p.monto) || 0 }; };
/* Constituye la provisión del mes (en curso o terminado) si el libro no está contabilizado. origen MES / id AAAAMM. */
async function constituirSueldos(mes, usuario = 'Motor provisiones') {
  const C = CONCEPTOS.SUELDOS;
  try {
    if (!/^\d{4}-\d{2}$/.test(mes || '')) return { skip: 'mes inválido' };
    const desde = await param(C.paramDesde, '2026-09');
    if (mes < desde) return { skip: 'anterior a ' + desde };
    if (mes > hoyISO().slice(0, 7)) return { skip: 'mes futuro' };
    const origenId = String(Number(mes.replace('-', '')));
    const [[ya]] = await pool.query("SELECT id, estado FROM ctb_provisiones WHERE concepto='SUELDOS' AND origen_tipo='MES' AND origen_id=?", [origenId]);
    if (ya) return { skip: 'ya ' + ya.estado.toLowerCase(), id: ya.id };
    if (await libroRemuneracionesContabilizado(mes)) return { skip: 'libro de remuneraciones ya contabilizado' };
    const py = await proyeccionSueldos(mes);
    if (!(py.total > 0)) return { skip: 'sin haberes proyectados' };
    const fecha = await fechaContable(ultimoDiaMes(mes));
    const [ins] = await pool.query(
      "INSERT IGNORE INTO ctb_provisiones (concepto, origen_tipo, origen_id, tercero, mes, fecha_constitucion, monto, montos_json, creado_por) VALUES ('SUELDOS','MES',?,?,?,?,?,?,?)",
      [origenId, 'Libro de remuneraciones ' + mes + ' (' + py.filas.length + ' colaboradores)', mes, fecha, py.total, JSON.stringify({ montos: py.montos, colaboradores: py.filas.length }), usuario]);
    if (!ins.affectedRows) return { skip: 'carrera: ya existía' };
    const id = await contabilizar({
      evento: C.regla, fecha, ref: 'PROV-SUELDOS-' + mes, montos: py.montos,
      glosa: ('Provisión remuneraciones y leyes sociales ' + mes + ' — libro no contabilizado (' + py.filas.length + ' colaboradores)').slice(0, 300),
      detalle: 'Haberes $' + py.montos.haberes.toLocaleString('es-CL') + ' · SIS $' + py.montos.sis.toLocaleString('es-CL') + ' · AFC $' + py.montos.afc.toLocaleString('es-CL') + ' · mutual+SANNA $' + py.montos.mutual.toLocaleString('es-CL') + ' · motor RRHH',
    });
    if (!id) { await pool.query('DELETE FROM ctb_provisiones WHERE id=?', [ins.insertId]); return { error: 'sin asiento (ver log del motor en Reglas de Centralización)' }; }
    await pool.query('UPDATE ctb_provisiones SET id_comprobante_constitucion=? WHERE id=?', [id, ins.insertId]);
    return { id: ins.insertId, monto: py.total, id_comprobante: id, colaboradores: py.filas.length };
  } catch (e) { console.error('[provisiones constituirSueldos]', mes, e.message); return { error: e.message }; }
}
async function liberarSueldos(mes, motivo = 'MANUAL', fechaISO = null, usuario = 'Motor provisiones', contra = null) {
  const C = CONCEPTOS.SUELDOS;
  try {
    const origenId = String(Number(String(mes).replace('-', '')));
    const [[p]] = await pool.query("SELECT * FROM ctb_provisiones WHERE concepto='SUELDOS' AND origen_tipo='MES' AND origen_id=? AND estado='CONSTITUIDA'", [origenId]);
    if (!p) return { skip: 'sin provisión constituida' };
    const fecha = await fechaContable(fechaISO || hoyISO());
    const [u] = await pool.query("UPDATE ctb_provisiones SET estado='LIBERADA', motivo_liberacion=?, fecha_liberacion=?, liberada_contra=?, updated_at=NOW() WHERE id=? AND estado='CONSTITUIDA'",
      [motivo, fecha, String(contra || (motivo === 'MANUAL' ? 'Liberación manual por ' + usuario : motivo)).slice(0, 240), p.id]);
    if (!u.affectedRows) return { skip: 'carrera: ya liberada' };
    const id = await contabilizar({
      evento: C.reglaLib, fecha, ref: 'PROV-SUELDOS-' + mes + '-LIB', montos: montosDe(p),
      glosa: ('Liberación provisión remuneraciones y leyes sociales ' + mes + ' (' + motivo.toLowerCase() + ')').slice(0, 300), detalle: motivo + ' · por ' + usuario,
    });
    if (!id) { await pool.query("UPDATE ctb_provisiones SET estado='CONSTITUIDA', motivo_liberacion=NULL, fecha_liberacion=NULL, liberada_contra=NULL WHERE id=?", [p.id]); return { error: 'sin asiento de liberación (ver log del motor)' }; }
    await pool.query('UPDATE ctb_provisiones SET id_comprobante_liberacion=? WHERE id=?', [id, p.id]);
    return { id: p.id, monto: Number(p.monto), id_comprobante: id };
  } catch (e) { console.error('[provisiones liberarSueldos]', mes, e.message); return { error: e.message }; }
}
/* Mientras no aparezca el libro, la provisión sigue al motor: si la proyección cambió (días, licencias,
   comisiones, adicionales), reversa lo anterior y constituye lo nuevo (dos asientos, refs -AJn-LIB y -AJn). */
async function ajustarSueldos(mes, usuario = 'Motor provisiones') {
  const C = CONCEPTOS.SUELDOS;
  const origenId = String(Number(mes.replace('-', '')));
  const [[p]] = await pool.query("SELECT * FROM ctb_provisiones WHERE concepto='SUELDOS' AND origen_tipo='MES' AND origen_id=? AND estado='CONSTITUIDA'", [origenId]);
  if (!p) return { ajustada: false };
  const py = await proyeccionSueldos(mes);
  if (!(py.total > 0) || py.total === Math.round(Number(p.monto))) return { ajustada: false };
  let mj = {}; try { mj = JSON.parse(p.montos_json || '{}'); } catch (_) {}
  const n = (mj.ajustes || 0) + 1, viejo = montosDe(p), fecha = await fechaContable(ultimoDiaMes(mes));
  // Solo la DIFERENCIA por concepto: lo que sube va por PROV_SUELDOS, lo que baja por PROV_SUELDOS_LIB (refs -AJn / -AJn-LIB)
  const sube = {}, baja = {};
  for (const k of ['haberes', 'sis', 'afc', 'mutual']) { const d = (py.montos[k] || 0) - (Number(viejo[k]) || 0); if (d > 0) sube[k] = d; else if (d < 0) baja[k] = -d; }
  const txt = o => Object.entries(o).map(([k, v]) => k + ' $' + v.toLocaleString('es-CL')).join(' · ');
  let idNew = null, idLib = null;
  if (Object.keys(sube).length) idNew = await contabilizar({ evento: C.regla, fecha, ref: 'PROV-SUELDOS-' + mes + '-AJ' + n, montos: sube,
    glosa: ('Ajuste provisión remuneraciones ' + mes + ' (' + n + '): la proyección subió a $' + py.total.toLocaleString('es-CL') + ' (' + py.filas.length + ' colaboradores)').slice(0, 300), detalle: ('sube: ' + txt(sube) + ' · por ' + usuario).slice(0, 300) });
  if (Object.keys(baja).length) idLib = await contabilizar({ evento: C.reglaLib, fecha, ref: 'PROV-SUELDOS-' + mes + '-AJ' + n + '-LIB', montos: baja,
    glosa: ('Ajuste provisión remuneraciones ' + mes + ' (' + n + '): la proyección bajó a $' + py.total.toLocaleString('es-CL') + ' (' + py.filas.length + ' colaboradores)').slice(0, 300), detalle: ('baja: ' + txt(baja) + ' · por ' + usuario).slice(0, 300) });
  if (!idNew && !idLib) return { ajustada: false };
  mj = { ...mj, montos: py.montos, colaboradores: py.filas.length, ajustes: n, historial: [...(mj.historial || []), { n, fecha: hoyISO(), de: Math.round(Number(p.monto)), a: py.total, lib: idLib, comp: idNew }].slice(-6) };
  await pool.query('UPDATE ctb_provisiones SET monto=?, montos_json=?, tercero=?, updated_at=NOW() WHERE id=?', [py.total, JSON.stringify(mj).slice(0, 400), 'Libro de remuneraciones ' + mes + ' (' + py.filas.length + ' colaboradores)', p.id]);
  return { ajustada: true, de: Math.round(Number(p.monto)), a: py.total };
}
/* Red de seguridad: mes en curso y anterior; ajusta al motor; libera lo que ya tiene libro. */
async function sincronizarSueldos(usuario = 'Motor provisiones') {
  const out = { constituidas: 0, liberadas: 0, omitidas: 0, ajustadas: 0 };
  const desde = await param(CONCEPTOS.SUELDOS.paramDesde, '2026-09');
  const actual = hoyISO().slice(0, 7), ant = mesAnteriorDe(actual);
  for (const m of [ant, actual]) {
    if (m < desde) continue;
    const x = await constituirSueldos(m, usuario); if (x && x.id && !x.skip) out.constituidas++; else out.omitidas++;
    const aj = await ajustarSueldos(m, usuario); if (aj.ajustada) out.ajustadas++;
  }
  const [abiertas] = await pool.query("SELECT * FROM ctb_provisiones WHERE concepto='SUELDOS' AND estado='CONSTITUIDA'");
  for (const p of abiertas) {
    const lib = await libroRemuneracionesContabilizado(p.mes);
    if (lib) { const x = await liberarSueldos(p.mes, 'LIBRO', lib.f, usuario, 'Libro de remuneraciones ' + p.mes + ' contabilizado (comprobante #' + lib.id + ', origen ' + lib.origen + ', ' + lib.f + ')'); if (x && x.id) out.liberadas++; }
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
  if (tipo === 'CUENTA' || tipo === 'AJUSTES') {
    const [r] = await pool.query(
      `SELECT c.id id_comprobante, DATE_FORMAT(c.fecha,'%Y-%m-%d') fecha, c.tipo, c.numero, c.origen, c.origen_ref, c.glosa, m.glosa glosa_linea, m.debe, m.haber, m.num_op, m.rut
         FROM ctb_movimientos m JOIN ctb_comprobantes c ON c.id=m.id_comprobante
        WHERE m.cuenta=? AND c.estado='CONTABILIZADO' AND DATE_FORMAT(c.fecha,'%Y-%m') = ? ${tipo === 'AJUSTES' ? "AND c.origen_ref LIKE '%-AJ%'" : ''} ORDER BY c.fecha, c.id`, [cta, mes]);
    return r;
  }
  throw new Error('Tipo de detalle desconocido');
}

const SINCRONIZAR = { DEALER: sincronizarDealer, PARQUE: sincronizarParque, EJECUTIVO: sincronizarEjecutivo, SUELDOS: sincronizarSueldos };
const LIBERAR = { DEALER: liberarDealer, PARQUE: liberarParque, EJECUTIVO: liberarEjecutivo, SUELDOS: liberarSueldos };
/* Al otorgar: todos los conceptos que nacen con el crédito (fire-and-forget, nunca lanza) */
async function constituirAlOtorgar(idCredito, usuario) {
  const r = { DEALER: await constituirDealer(idCredito, usuario), PARQUE: await constituirParque(idCredito, usuario) };   // EJECUTIVO es mensual (al cierre), no al otorgar
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
  constituirEjecutivoMes, liberarEjecutivo, liberarEjecutivoPorAprobacion, sincronizarEjecutivo, comisionesMotorMes,
  constituirSueldos, liberarSueldos, sincronizarSueldos, proyeccionSueldos, cuadro, detalle };
