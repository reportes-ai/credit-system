'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   LIBROS LEGALES — motores de los libros que faltaban (Pato, 15-09-2026)
   Cada motor devuelve { hojas:[{nombre, columnas:[[clave,titulo]], filas:[obj]}],
   fuente, total_1, total_2, resumen } y NO calcula nada nuevo: reusa los motores
   existentes (balance/diario/mayor de contabilidad, cuenta de vacaciones de RRHH,
   asistencia Workera, MORA_SQL de cobranza, mantenedor de tasas/TMC). Un solo
   motor por magnitud; aquí solo se ordena y se exporta.
   Períodos: 'YYYY' (año) o 'YYYY-MM' (mes) según el libro.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../shared/config/database');
const { isoDeBD } = require('../../../shared/fecha-chile');

const R = v => Math.round(Number(v) || 0);
const nRut = r => String(r || '').replace(/\./g, '').replace(/\s/g, '').toUpperCase();
const iso = f => f == null ? '' : (isoDeBD(f) || '');
const finDeMes = mes => { const [a, m] = mes.split('-').map(Number); return `${mes}-${String(new Date(a, m, 0).getDate()).padStart(2, '0')}`; };
const hoyISO = () => require('../../../shared/fecha-chile').hoyISO();

/* Llama a un handler express existente (el motor único de esa pantalla) y captura su JSON. */
function capturar(handler, query = {}, usuario = null) {
  return new Promise((resolve, reject) => {
    const res = { status() { return this; }, json(j) { j && j.success ? resolve(j.data) : reject(new Error((j && j.error) || 'sin datos')); } };
    Promise.resolve(handler({ query, params: {}, body: {}, usuario }, res)).catch(reject);
  });
}
const sum = (filas, k) => filas.reduce((a, f) => a + R(f[k]), 0);

/* ── 1. BALANCE DE 8 COLUMNAS (año) — motor: contabilidad.controller.balance ── */
async function balance8(anio) {
  const ctrl = require('./controllers/contabilidad.controller');
  const rows = await capturar(ctrl.balance, { desde: `${anio}-01-01`, hasta: `${anio}-12-31` });
  const columnas = [['cuenta', 'Cuenta'], ['nombre', 'Nombre'], ['tipo', 'Tipo'], ['debe', 'Débitos'], ['haber', 'Créditos'], ['deudor', 'Deudor'], ['acreedor', 'Acreedor'], ['activo', 'Activo'], ['pasivo', 'Pasivo'], ['perdida', 'Pérdida'], ['ganancia', 'Ganancia']];
  const filas = rows.map(r => ({ ...r, debe: R(r.debe), haber: R(r.haber), deudor: R(r.deudor), acreedor: R(r.acreedor), activo: R(r.activo), pasivo: R(r.pasivo), perdida: R(r.perdida), ganancia: R(r.ganancia) }));
  const tot = {}; for (const k of ['debe', 'haber', 'deudor', 'acreedor', 'activo', 'pasivo', 'perdida', 'ganancia']) tot[k] = sum(filas, k);
  const resultado = tot.ganancia - tot.perdida;   // utilidad (+) o pérdida (−) del ejercicio
  return { fuente: 'CONTABILIDAD', total_1: tot.debe, total_2: resultado,
    hojas: [{ nombre: `Balance ${anio}`, columnas, filas, totales: { nombre: 'TOTALES', ...tot } }],
    resumen: { cuentas: filas.length, resultado } };
}

/* ── 2. REGISTRO DE FERIADOS POR TRABAJADOR (año) — motor: vac-cuenta.saldoCuenta ── */
async function vacaciones(anio) {
  const vac = require('../../rrhh/src/controllers/vac-cuenta.controller');
  const corte = `${anio}-12-31` < hoyISO() ? `${anio}-12-31` : hoyISO();
  const [pers] = await pool.query(
    `SELECT u.id_usuario, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) nombre, u.rut, u.fecha_ingreso, u.fecha_baja, u.estado,
            COALESCE(f.anos_trabajados_previos,0) previos, f.tipo_contrato, u.cargo
       FROM usuarios u LEFT JOIN rh_fichas f ON f.id_usuario=u.id_usuario
      WHERE u.fecha_ingreso IS NOT NULL AND COALESCE(f.no_mostrar,0)=0
        AND (u.estado='activo' OR YEAR(u.fecha_baja)=?) AND u.fecha_ingreso <= ?
      ORDER BY nombre`, [anio, corte]);
  const ids = pers.map(p => p.id_usuario);
  const [movs] = ids.length ? await pool.query(
    `SELECT m.id_usuario, m.tipo, m.dias, m.periodo_desde, m.periodo_hasta, m.glosa, m.created_at,
            v.fecha_desde, v.fecha_hasta, v.dias v_dias, v.estado v_estado, v.codigo_verificacion
       FROM rh_vac_movimientos m LEFT JOIN rh_vacaciones v ON v.id=m.id_ref AND m.tipo='TOMADO'
      WHERE m.id_usuario IN (?) ORDER BY m.id_usuario, m.id`, [ids]) : [[]];
  const [[cfgV]] = await pool.query("SELECT valor FROM rh_config WHERE clave='vac_dias_anuales'");
  const anuales = parseFloat(cfgV?.valor) || 15;
  const filas = [], detalle = [];
  for (const p of pers) {
    const mm = movs.filter(m => m.id_usuario === p.id_usuario);
    const enAnio = m => (m.tipo === 'TOMADO' ? iso(m.fecha_desde) || iso(m.created_at) : (m.tipo === 'DEVENGO' || m.tipo === 'PROGRESIVO') ? iso(m.periodo_hasta) : iso(m.created_at)).startsWith(anio);
    const devengo = mm.filter(m => m.tipo === 'DEVENGO' && enAnio(m)).reduce((a, m) => a + Number(m.dias), 0);
    const progresivo = mm.filter(m => m.tipo === 'PROGRESIVO' && enAnio(m)).reduce((a, m) => a + Number(m.dias), 0);
    const tomados = mm.filter(m => m.tipo === 'TOMADO' && enAnio(m));
    const ajustes = mm.filter(m => m.tipo === 'AJUSTE' && enAnio(m)).reduce((a, m) => a + Number(m.dias), 0);
    const diasTomados = tomados.reduce((a, m) => a - Number(m.dias), 0);
    const [ini, fin] = await Promise.all([vac.saldoCuenta(p.id_usuario, `${Number(anio) - 1}-12-31`), vac.saldoCuenta(p.id_usuario, corte)]);
    filas.push({ rut: nRut(p.rut), nombre: p.nombre, cargo: p.cargo || '', tipo_contrato: p.tipo_contrato || '', fecha_ingreso: iso(p.fecha_ingreso), fecha_baja: iso(p.fecha_baja),
      previos: p.previos, dias_anuales: anuales, saldo_inicial: ini.disponibles, devengo, progresivo, ajustes, tomados: diasTomados, n_periodos: tomados.length,
      saldo_periodos: fin.saldo_periodos, proporcional: fin.proporcional, saldo_final: fin.disponibles });
    for (const t of tomados) detalle.push({ rut: nRut(p.rut), nombre: p.nombre, desde: iso(t.fecha_desde), hasta: iso(t.fecha_hasta), dias_habiles: -Number(t.dias), estado: t.v_estado || '', codigo: t.codigo_verificacion || '', glosa: t.glosa || '' });
  }
  detalle.sort((a, b) => a.desde.localeCompare(b.desde) || a.nombre.localeCompare(b.nombre));
  const cols1 = [['rut', 'RUT'], ['nombre', 'Nombre'], ['cargo', 'Cargo'], ['tipo_contrato', 'Contrato'], ['fecha_ingreso', 'F. ingreso'], ['fecha_baja', 'F. egreso'], ['previos', 'Años previos'], ['dias_anuales', 'Días anuales'],
    ['saldo_inicial', `Saldo al 31-12-${Number(anio) - 1}`], ['devengo', 'Devengado en el año'], ['progresivo', 'Progresivo'], ['ajustes', 'Ajustes'], ['tomados', 'Días tomados'], ['n_periodos', 'Períodos'], ['saldo_periodos', 'Saldo períodos cumplidos'], ['proporcional', 'Proporcional en curso'], ['saldo_final', `Saldo al ${corte}`]];
  const cols2 = [['rut', 'RUT'], ['nombre', 'Nombre'], ['desde', 'Desde'], ['hasta', 'Hasta'], ['dias_habiles', 'Días hábiles'], ['estado', 'Estado solicitud'], ['codigo', 'Código verificación'], ['glosa', 'Glosa']];
  return { fuente: 'RRHH', total_1: sum(filas, 'tomados'), total_2: Math.round(filas.reduce((a, f) => a + Number(f.saldo_final), 0)),
    hojas: [{ nombre: `Feriados ${anio}`, columnas: cols1, filas, totales: { nombre: 'TOTALES', tomados: sum(filas, 'tomados'), devengo: sum(filas, 'devengo'), progresivo: sum(filas, 'progresivo'), saldo_final: Math.round(filas.reduce((a, f) => a + Number(f.saldo_final), 0) * 100) / 100 } },
            { nombre: 'Períodos tomados', columnas: cols2, filas: detalle }],
    resumen: { personas: filas.length, periodos: detalle.length, corte } };
}

/* ── 3. REGISTRO DE ASISTENCIA WORKERA (mes) — motor: asistencia.controller.resumen ── */
async function asistencia(mes) {
  const asis = require('../../rrhh/src/controllers/asistencia.controller');
  const d = await capturar(asis.resumen, { mes });
  const tol = Number(d.tolerancia_min) || 0, hEnt = d.hora_entrada || '09:00';
  const min = h => { const [hh, mm] = String(h || '').split(':').map(Number); return (hh || 0) * 60 + (mm || 0); };
  const resumen = [], detalle = [];
  for (const c of d.colaboradores || []) {
    let atrasos = 0;
    for (const x of c.detalle || []) {
      const fila = { rut: nRut(c.rut), nombre: c.nombre, dia: x.dia, entrada: '', salida: '', marcas: '', horario: '', estado: '', atraso_min: '' };
      if (x.falta) fila.estado = 'SIN MARCA';
      else if (x.cubierto) fila.estado = x.cubierto;
      else {
        fila.entrada = String(x.entrada || '').slice(0, 5); fila.salida = String(x.salida || '').slice(0, 5); fila.marcas = x.marcas; fila.horario = String(x.horario || hEnt).slice(0, 5);
        const at = min(fila.entrada) - min(fila.horario) - tol;
        fila.atraso_min = at > 0 ? at : 0; fila.estado = at > 0 ? 'ATRASO' : 'OK'; if (at > 0) atrasos++;
      }
      detalle.push(fila);
    }
    resumen.push({ rut: nRut(c.rut), nombre: c.nombre, en_workera: c.en_workera ? 'SÍ' : 'NO', dias_habiles: (d.dias_habiles || []).length, marcados: c.dias_marcados, cubiertos: c.dias_cubiertos, faltas: (c.faltas || []).length, atrasos });
  }
  const cols1 = [['rut', 'RUT'], ['nombre', 'Nombre'], ['en_workera', 'Enrolado Workera'], ['dias_habiles', 'Días hábiles'], ['marcados', 'Días marcados'], ['cubiertos', 'Cubiertos (vac./ausencia)'], ['faltas', 'Sin marca'], ['atrasos', 'Atrasos']];
  const cols2 = [['rut', 'RUT'], ['nombre', 'Nombre'], ['dia', 'Día'], ['entrada', 'Entrada'], ['salida', 'Salida'], ['marcas', 'Marcas'], ['horario', 'Horario'], ['estado', 'Estado'], ['atraso_min', 'Atraso (min)']];
  return { fuente: 'WORKERA', total_1: sum(resumen, 'marcados'), total_2: sum(resumen, 'faltas'),
    hojas: [{ nombre: `Asistencia ${mes}`, columnas: cols1, filas: resumen, totales: { nombre: 'TOTALES', marcados: sum(resumen, 'marcados'), cubiertos: sum(resumen, 'cubiertos'), faltas: sum(resumen, 'faltas'), atrasos: sum(resumen, 'atrasos') } },
            { nombre: 'Detalle diario', columnas: cols2, filas: detalle }],
    resumen: { personas: resumen.length, desde: d.desde, hasta: d.hasta, hora_entrada: hEnt, tolerancia_min: tol } };
}

/* ── 4. CARTERA VIGENTE CON TASAS vs TMC (mes) — cartera propia (AUTOFACIL/AFA) al cierre del mes.
      Tramo y TMC como el motor de cobranza (umbral_uf_tramo × UF de otorgamiento; tabla tasas). ── */
async function carteraTmc(mes) {
  const corte = finDeMes(mes);
  const [ops] = await pool.query(
    `SELECT c.num_op, c.financiera, c.fecha_otorgado, c.monto_financiado, c.saldo_precio, c.plazo, c.cuota, c.tascli_real, c.estado, c.estado_cartera, c.origen,
            COALESCE(cl.rut,'') rut, COALESCE(cl.nombre_completo,'') nombre,
            COALESCE((SELECT cc.saldo_insoluto FROM cuotas_credito cc WHERE cc.id_credito=c.id AND cc.estado_cuota='PAGADA' AND cc.fecha_pago<=? ORDER BY cc.numero_cuota DESC LIMIT 1), c.monto_financiado, 0) saldo_insoluto,
            (SELECT COUNT(*) FROM cuotas_credito cc WHERE cc.id_credito=c.id AND cc.estado_cuota='PAGADA' AND cc.fecha_pago<=?) cuotas_pagadas
       FROM creditos c LEFT JOIN clientes cl ON cl.id_cliente=c.id_cliente
      WHERE UPPER(COALESCE(c.financiera,'')) IN ('AUTOFACIL','AFA') AND c.fecha_otorgado IS NOT NULL AND c.fecha_otorgado<=?
        AND UPPER(COALESCE(c.estado,'')) IN ('VIGENTE','EN MORA','OTORGADO') AND COALESCE(c.estado_cartera,'')<>'PREPAGADO'
      ORDER BY c.fecha_otorgado, c.num_op`, [corte, corte, corte]);
  const [[um]] = await pool.query("SELECT valor FROM parametros_credito WHERE clave='umbral_uf_tramo'");
  const umbral = um ? parseFloat(um.valor) || 200 : 200;
  const [tasas] = await pool.query("SELECT DATE_FORMAT(fecha_desde,'%Y-%m-%d') fd, DATE_FORMAT(fecha_hasta,'%Y-%m-%d') fh, tasa_mensual_menor, tasa_mensual_mayor, tasa_anual_menor, tasa_anual_mayor FROM tasas ORDER BY fecha_desde");
  // UF en una sola consulta (226 lecturas una a una tardaban 26 s): valor vigente = último ≤ fecha
  const fechas = ops.map(o => iso(o.fecha_otorgado)).filter(Boolean).sort();
  const [ufs] = fechas.length ? await pool.query("SELECT DATE_FORMAT(fecha,'%Y-%m-%d') f, valor FROM uf WHERE fecha BETWEEN DATE_SUB(?, INTERVAL 40 DAY) AND ? ORDER BY fecha", [fechas[0], fechas[fechas.length - 1]]) : [[]];
  const uf = f => { let v = 0; for (const u of ufs) { if (u.f > f) break; v = Number(u.valor); } return v; };
  const filas = [];
  let fuera = 0, sinTasa = 0;
  for (const o of ops) {
    const f = iso(o.fecha_otorgado);
    const ufOt = uf(f);
    const base = Number(o.saldo_precio) || Number(o.monto_financiado) || 0;
    const tramo = ufOt > 0 && base > umbral * ufOt ? 'mayor' : 'menor';
    const t = tasas.filter(x => x.fd <= f && (!x.fh || x.fh >= f)).pop();
    const tmcM = t ? Number(tramo === 'mayor' ? t.tasa_mensual_mayor : t.tasa_mensual_menor) : null;
    const tmcA = t ? Number(tramo === 'mayor' ? t.tasa_anual_mayor : t.tasa_anual_menor) : null;
    const tasa = o.tascli_real != null ? Number(o.tascli_real) : null;
    let cumple = tasa == null ? 'SIN TASA' : 'SIN TMC';   // SIN TMC: el mantenedor Tasas no cubre esa fecha (cartera antigua)
    if (tasa != null && tmcM != null) cumple = tasa <= tmcM + 1e-9 ? 'SÍ' : 'NO';
    if (cumple === 'NO') fuera++; if (cumple !== 'SÍ' && cumple !== 'NO') sinTasa++;
    filas.push({ num_op: o.num_op, rut: nRut(o.rut), nombre: o.nombre, financiera: o.financiera, fecha_otorgado: f, estado: o.estado, origen: o.origen || '',
      monto_financiado: R(o.monto_financiado), plazo: o.plazo, cuota: R(o.cuota), cuotas_pagadas: o.cuotas_pagadas, saldo_insoluto: R(o.saldo_insoluto),
      monto_uf: ufOt ? Math.round(base / ufOt * 100) / 100 : '', tramo: tramo === 'mayor' ? `> ${umbral} UF` : `≤ ${umbral} UF`,
      tasa_mensual: tasa, tasa_anual: tasa != null ? Math.round(tasa * 12 * 100) / 100 : '', tmc_mensual: tmcM ?? '', tmc_anual: tmcA ?? '',
      margen: tasa != null && tmcM != null ? Math.round((tmcM - tasa) * 10000) / 10000 : '', cumple });
  }
  const columnas = [['num_op', 'N° op'], ['rut', 'RUT'], ['nombre', 'Cliente'], ['financiera', 'Financiera'], ['origen', 'Origen'], ['fecha_otorgado', 'F. otorgado'], ['estado', 'Estado'], ['monto_financiado', 'Monto financiado'], ['monto_uf', 'Monto UF'], ['tramo', 'Tramo TMC'], ['plazo', 'Plazo'], ['cuota', 'Cuota'], ['cuotas_pagadas', 'Cuotas pagadas'], ['saldo_insoluto', 'Saldo insoluto'],
    ['tasa_mensual', 'Tasa mensual %'], ['tasa_anual', 'Tasa anual %'], ['tmc_mensual', 'TMC mensual %'], ['tmc_anual', 'TMC anual %'], ['margen', 'Holgura (TMC − tasa)'], ['cumple', 'Cumple TMC']];
  return { fuente: 'CARTERA', total_1: sum(filas, 'monto_financiado'), total_2: sum(filas, 'saldo_insoluto'),
    hojas: [{ nombre: `Cartera ${mes}`, columnas, filas, totales: { nombre: 'TOTALES', monto_financiado: sum(filas, 'monto_financiado'), saldo_insoluto: sum(filas, 'saldo_insoluto') } }],
    resumen: { operaciones: filas.length, corte, fuera_de_tmc: fuera, sin_tasa_o_tmc: sinTasa, umbral_uf: umbral,
      nota: 'Las operaciones con origen CARTERA_AFA / CARTERA_XLSX son cartera migrada: la tasa es la que vino en la migración (otorgada por AFA con su pizarra), no digitada en el Suite. Diferencias de milésimas contra la TMC corresponden a redondeo (tasa a 2 decimales, TMC a 3) o a la fecha de vigencia de la TMC cargada en el mantenedor.' } };
}

/* ── 5. MORA Y GASTOS DE COBRANZA POR OPERACIÓN (mes) — cobrado en el mes (pagos_credito) + stock de mora (MORA_SQL de cobranza) ── */
async function cobranza(mes) {
  const corte = finDeMes(mes);
  const [pagos] = await pool.query(
    `SELECT c.num_op, COALESCE(cl.rut,'') rut, COALESCE(cl.nombre_completo,'') nombre, p.numero_cuota, p.fecha_vencimiento, p.fecha_pago,
            p.monto_cuota, p.interes_mora, p.gastos_cobranza, p.total_pagado, p.estado_pago, p.registrado_por, p.origen_fondos
       FROM pagos_credito p JOIN creditos c ON c.id=p.id_credito LEFT JOIN clientes cl ON cl.id_cliente=c.id_cliente
      WHERE p.fecha_pago >= ? AND p.fecha_pago < DATE_ADD(?, INTERVAL 1 DAY) AND p.estado_pago='PAGADO'
      ORDER BY p.fecha_pago, c.num_op, p.numero_cuota`, [`${mes}-01`, corte]);
  const filasPagos = pagos.map(p => {
    const venc = iso(p.fecha_vencimiento), fp = iso(p.fecha_pago);
    const dias = venc && fp ? Math.max(0, Math.round((new Date(fp + 'T12:00:00') - new Date(venc + 'T12:00:00')) / 86400000)) : '';
    return { num_op: p.num_op, rut: nRut(p.rut), nombre: p.nombre, cuota: p.numero_cuota, vencimiento: venc, fecha_pago: fp, dias_atraso: dias,
      monto_cuota: R(p.monto_cuota), interes_mora: R(p.interes_mora), gastos_cobranza: R(p.gastos_cobranza), total_pagado: R(p.total_pagado), registrado_por: p.registrado_por || '', origen_fondos: p.origen_fondos || '' };
  });
  const cob = require('../../cobranza/src/controllers/cobranza.controller');
  const [stock] = await pool.query(cob._motor.MORA_SQL() + ' ORDER BY dias_mora DESC');
  const filasStock = stock.map(s => ({ num_op: s.num_op, rut: nRut(s.rut_cliente), nombre: s.nombre_cliente, financiera: s.financiera, fecha_otorgado: iso(s.fecha_otorgado), plazo: s.plazo,
    cuotas_pagadas: s.cuotas_pagadas, cuotas_mora: s.cuotas_mora, dias_mora: s.dias_mora, monto_mora: R(s.monto_mora), saldo_insoluto: R(s.saldo_insoluto), estado_cartera: s.estado_cartera || '' }));
  const cols1 = [['num_op', 'N° op'], ['rut', 'RUT'], ['nombre', 'Cliente'], ['cuota', 'Cuota'], ['vencimiento', 'Vencimiento'], ['fecha_pago', 'F. pago'], ['dias_atraso', 'Días de atraso'], ['monto_cuota', 'Cuota'], ['interes_mora', 'Interés por mora'], ['gastos_cobranza', 'Gastos de cobranza'], ['total_pagado', 'Total pagado'], ['registrado_por', 'Registrado por'], ['origen_fondos', 'Origen fondos']];
  const cols2 = [['num_op', 'N° op'], ['rut', 'RUT'], ['nombre', 'Cliente'], ['financiera', 'Financiera'], ['fecha_otorgado', 'F. otorgado'], ['plazo', 'Plazo'], ['cuotas_pagadas', 'Cuotas pagadas'], ['cuotas_mora', 'Cuotas en mora'], ['dias_mora', 'Días de mora'], ['monto_mora', 'Monto en mora'], ['saldo_insoluto', 'Saldo insoluto'], ['estado_cartera', 'Estado cartera']];
  const tot1 = { nombre: 'TOTALES', monto_cuota: sum(filasPagos, 'monto_cuota'), interes_mora: sum(filasPagos, 'interes_mora'), gastos_cobranza: sum(filasPagos, 'gastos_cobranza'), total_pagado: sum(filasPagos, 'total_pagado') };
  const tot2 = { nombre: 'TOTALES', monto_mora: sum(filasStock, 'monto_mora'), saldo_insoluto: sum(filasStock, 'saldo_insoluto') };
  return { fuente: 'COBRANZA', total_1: tot1.interes_mora + tot1.gastos_cobranza, total_2: tot2.monto_mora,
    hojas: [{ nombre: `Cobrado ${mes}`, columnas: cols1, filas: filasPagos, totales: tot1 }, { nombre: `Mora vigente al ${hoyISO()}`, columnas: cols2, filas: filasStock, totales: tot2 }],
    resumen: { pagos: filasPagos.length, en_mora: filasStock.length, nota: 'El stock de mora es al día de hoy (la mora se calcula al vuelo, no se guarda por mes).' } };
}

/* ── Libro Diario y Mayor del año para la carpeta (mismas queries que Libros Contables, sin tope) ── */
async function diario(anio) {
  const [rows] = await pool.query(
    `SELECT c.tipo, c.anio, c.numero, c.fecha, c.glosa comp_glosa, c.origen, c.origen_ref, m.cuenta, k.nombre cuenta_nombre, m.glosa, m.debe, m.haber, m.num_op, m.rut
       FROM ctb_comprobantes c JOIN ctb_movimientos m ON m.id_comprobante=c.id LEFT JOIN ctb_cuentas k ON k.codigo=m.cuenta
      WHERE c.estado='CONTABILIZADO' AND c.fecha BETWEEN ? AND ? ORDER BY c.fecha, c.id, m.id`, [`${anio}-01-01`, `${anio}-12-31`]);
  const filas = rows.map(x => ({ numero: `${x.tipo}-${x.anio}-${String(x.numero).padStart(6, '0')}`, fecha: iso(x.fecha), comp_glosa: x.comp_glosa, origen: x.origen || '', origen_ref: x.origen_ref || '', cuenta: x.cuenta, cuenta_nombre: x.cuenta_nombre || '', glosa: x.glosa || '', debe: R(x.debe), haber: R(x.haber), num_op: x.num_op || '', rut: x.rut || '' }));
  const columnas = [['numero', 'N° comprobante'], ['fecha', 'Fecha'], ['comp_glosa', 'Glosa comprobante'], ['origen', 'Origen'], ['origen_ref', 'Referencia'], ['cuenta', 'Cuenta'], ['cuenta_nombre', 'Nombre cuenta'], ['glosa', 'Glosa'], ['debe', 'Debe'], ['haber', 'Haber'], ['num_op', 'N° op'], ['rut', 'RUT']];
  return { fuente: 'CONTABILIDAD', total_1: sum(filas, 'debe'), total_2: sum(filas, 'haber'), hojas: [{ nombre: `Diario ${anio}`, columnas, filas, totales: { glosa: 'TOTALES', debe: sum(filas, 'debe'), haber: sum(filas, 'haber') } }], resumen: { lineas: filas.length } };
}
async function mayor(anio) {
  const ctrl = require('./controllers/contabilidad.controller');
  const d = await capturar(ctrl.libroMayorCompleto, { desde: `${anio}-01-01`, hasta: `${anio}-12-31`, limite: '50000', solo_con_movimiento: '0' });
  const filas = [];
  for (const c of d.cuentas) {
    let saldo = Number(c.saldo_inicial) || 0;
    filas.push({ cuenta: c.cuenta, nombre: c.nombre, fecha: '', numero: '', glosa: 'SALDO INICIAL', debe: '', haber: '', saldo: R(saldo) });
    for (const m of c.movimientos) { saldo += Number(m.debe) - Number(m.haber); filas.push({ cuenta: c.cuenta, nombre: c.nombre, fecha: iso(m.fecha), numero: m.num, glosa: m.glosa || m.comp_glosa || '', debe: R(m.debe), haber: R(m.haber), saldo: R(saldo), num_op: m.num_op || '', rut: m.rut || '' }); }
    filas.push({ cuenta: c.cuenta, nombre: c.nombre, fecha: '', numero: '', glosa: 'SALDO FINAL', debe: R(c.debe), haber: R(c.haber), saldo: R(c.saldo_final) });
  }
  const columnas = [['cuenta', 'Cuenta'], ['nombre', 'Nombre'], ['fecha', 'Fecha'], ['numero', 'N° comprobante'], ['glosa', 'Glosa'], ['debe', 'Debe'], ['haber', 'Haber'], ['saldo', 'Saldo'], ['num_op', 'N° op'], ['rut', 'RUT']];
  return { fuente: 'CONTABILIDAD', total_1: R(d.totales.debe), total_2: R(d.totales.haber), hojas: [{ nombre: `Mayor ${anio}`, columnas, filas }], resumen: { cuentas: d.cuentas.length, movimientos: d.totales.movimientos, truncado: !!d.truncado } };
}

module.exports = { balance8, vacaciones, asistencia, carteraTmc, cobranza, diario, mayor, finDeMes };
