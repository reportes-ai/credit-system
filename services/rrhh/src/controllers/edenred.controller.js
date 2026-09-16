'use strict';
/* ── Nómina EDENRED (tarjeta de alimentación) — Pato, 16-09-2026 ────────────────────
   Beneficio POR DÍA HÁBIL TRABAJADO (lunes a viernes, sin feriados legales) que NO va
   en la liquidación: se carga a la tarjeta con una nómina mensual tipo TEF.

   · Parámetros (mantenedor en la misma card): monto diario ($3.600 al nacer), si los
     feriados descuentan días hábiles y qué tipos de ausencia descuentan. Cada cambio
     lleva "desde qué mes de remuneración" rige: el historial guarda la vigencia y una
     nómina ya generada no se recalcula (queda con lo que se pagó).
   · Regla del mes M: se pagan TODOS los días hábiles de M (adelantado). Las faltas se
     descuentan al mes siguiente: la nómina de M resta los días no trabajados de M-1
     (ausencias aprobadas de los tipos configurados + vacaciones si están marcadas).
   · Ingreso / baja dentro del mes: solo los días hábiles entre esas fechas.
   · Quién recibe: rh_fichas.edenred (1 por defecto en toda ficha con sueldo base).
   · Generar la nómina CONGELA el mes en rh_edenred_nomina; anularla la borra (auditado). */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { esHabil, cargarFeriados } = require('../../../../shared/feriados');
const esFinde = d => d.getDay() === 0 || d.getDay() === 6;

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });
const nombreDe = u => `${u?.nombre || ''} ${u?.apellido || ''}`.trim() || u?.email || null;
const CLP = v => '$' + Math.round(Number(v) || 0).toLocaleString('es-CL');
const mesOk = m => /^\d{4}-\d{2}$/.test(m || '');
const mesAnterior = m => { let [y, mm] = m.split('-').map(Number); mm--; if (mm < 1) { mm = 12; y--; } return `${y}-${String(mm).padStart(2, '0')}`; };
const iso = d => d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d || '').slice(0, 10);

const TIPOS_DEFAULT = 'LICENCIA MEDICA,PERMISO SIN GOCE,AUSENCIA INJUSTIFICADA,VACACIONES';

require('../../../../shared/migrate').migrar('rrhh-edenred', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_edenred_param (
    id INT AUTO_INCREMENT PRIMARY KEY,
    mes_desde CHAR(7) NOT NULL,
    monto_diario DECIMAL(10,0) NOT NULL,
    descuenta_feriados TINYINT(1) NOT NULL DEFAULT 1,
    tipos_descuento VARCHAR(300) NOT NULL DEFAULT '${TIPOS_DEFAULT}',
    creado_por VARCHAR(160) NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_mes (mes_desde))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_edenred_nomina (
    id INT AUTO_INCREMENT PRIMARY KEY,
    mes CHAR(7) NOT NULL, id_usuario INT NOT NULL, nombre VARCHAR(200) NULL, rut VARCHAR(15) NULL,
    dias_habiles DECIMAL(5,1) NOT NULL, dias_descuento DECIMAL(5,1) NOT NULL DEFAULT 0,
    monto_diario DECIMAL(10,0) NOT NULL, monto DECIMAL(12,0) NOT NULL,
    detalle VARCHAR(400) NULL,
    generado_por VARCHAR(160) NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_mes_usuario (mes, id_usuario), INDEX idx_mes (mes))`);
  await pool.query('ALTER TABLE rh_fichas ADD COLUMN IF NOT EXISTS edenred TINYINT(1) NOT NULL DEFAULT 1');
  await pool.query("INSERT IGNORE INTO rh_edenred_param (mes_desde, monto_diario, creado_por) VALUES ('2026-09', 3600, 'Semilla (Pato 16-09-2026)')");
  // Card en Remuneraciones: misma funcionalidad rh_remuneraciones (no exige permiso nuevo)
});

/* Parámetro vigente para un mes: el de mayor mes_desde <= mes */
async function paramDe(mes) {
  const [[p]] = await pool.query('SELECT * FROM rh_edenred_param WHERE mes_desde <= ? ORDER BY mes_desde DESC LIMIT 1', [mes]);
  if (!p) return { monto_diario: 0, descuenta_feriados: 1, tipos: TIPOS_DEFAULT.split(','), mes_desde: null };
  return { ...p, monto_diario: Number(p.monto_diario), tipos: String(p.tipos_descuento || '').split(',').map(s => s.trim()).filter(Boolean) };
}

/* Días hábiles (L-V, con o sin feriados) entre dos fechas inclusive, acotado a un mes */
function habilesRango(desdeISO, hastaISO, descFeriados) {
  const d = new Date(desdeISO + 'T12:00:00'), h = new Date(hastaISO + 'T12:00:00');
  let n = 0;
  for (; d <= h; d.setDate(d.getDate() + 1)) if (descFeriados ? esHabil(d) : !esFinde(d)) n++;
  return n;
}
const primerDia = mes => mes + '-01';
const ultimoDia = mes => { const [y, m] = mes.split('-').map(Number); return iso(new Date(y, m, 0)); };

/* Cálculo del mes (vista previa): una fila por colaborador con Edenred */
async function calcularMes(mes) {
  await cargarFeriados().catch(() => {});
  const p = await paramDe(mes);
  const ant = mesAnterior(mes);
  const ini = primerDia(mes), fin = ultimoDia(mes);
  const [gente] = await pool.query(
    `SELECT u.id_usuario, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) nombre, u.rut, u.fecha_ingreso, u.fecha_baja, f.edenred
       FROM usuarios u JOIN rh_fichas f ON f.id_usuario=u.id_usuario
      WHERE (u.estado='activo' OR (u.fecha_baja IS NOT NULL AND u.fecha_baja > ?)) AND COALESCE(f.sueldo_base,0) > 0
        AND COALESCE(f.edenred,1)=1 AND (u.fecha_ingreso IS NULL OR u.fecha_ingreso <= ?)
      ORDER BY nombre`, [ini, fin]);
  // Ausencias del mes ANTERIOR que descuentan (tipos paramétricos) + vacaciones si corresponde
  const tiposAus = p.tipos.filter(t => t !== 'VACACIONES');
  const [aus] = tiposAus.length ? await pool.query(
    `SELECT id_usuario, tipo, fecha_desde, fecha_hasta, medio_dia FROM rh_ausencias
      WHERE estado='APROBADA' AND tipo IN (?) AND fecha_desde <= ? AND fecha_hasta >= ?`, [tiposAus, ultimoDia(ant), primerDia(ant)]) : [[]];
  const [vac] = p.tipos.includes('VACACIONES') ? await pool.query(
    `SELECT id_usuario, 'VACACIONES' tipo, fecha_desde, fecha_hasta, 0 medio_dia FROM rh_vacaciones
      WHERE estado='APROBADA' AND id_usuario IS NOT NULL AND fecha_desde <= ? AND fecha_hasta >= ?`, [ultimoDia(ant), primerDia(ant)]) : [[]];
  const faltas = {};
  for (const a of [...aus, ...vac]) {
    const d = iso(a.fecha_desde) < primerDia(ant) ? primerDia(ant) : iso(a.fecha_desde);
    const h = iso(a.fecha_hasta) > ultimoDia(ant) ? ultimoDia(ant) : iso(a.fecha_hasta);
    let n = habilesRango(d, h, p.descuenta_feriados);
    if (a.medio_dia) n = n * 0.5;
    (faltas[a.id_usuario] = faltas[a.id_usuario] || { dias: 0, det: [] });
    faltas[a.id_usuario].dias += n;
    if (n) faltas[a.id_usuario].det.push(`${a.tipo} ${d.slice(8)}/${d.slice(5, 7)}${d !== h ? '–' + h.slice(8) + '/' + h.slice(5, 7) : ''} (${n})`);
  }
  const filas = gente.map(g => {
    const desde = g.fecha_ingreso && iso(g.fecha_ingreso) > ini ? iso(g.fecha_ingreso) : ini;
    // fecha_baja es EXCLUSIVA (igual que la liquidación): el último día trabajado es el anterior
    let hasta = fin;
    if (g.fecha_baja && iso(g.fecha_baja) <= fin) { const b = new Date(iso(g.fecha_baja) + 'T12:00:00'); b.setDate(b.getDate() - 1); hasta = iso(b); }
    const habiles = hasta >= desde ? habilesRango(desde, hasta, p.descuenta_feriados) : 0;
    const f = faltas[g.id_usuario] || { dias: 0, det: [] };
    const descuento = Math.min(f.dias, habiles);
    const monto = Math.round((habiles - descuento) * p.monto_diario);
    return { id_usuario: g.id_usuario, nombre: g.nombre, rut: g.rut, dias_habiles: habiles, dias_descuento: descuento,
             monto_diario: p.monto_diario, monto, detalle: f.det.join(' · ') || null,
             parcial: desde !== ini || hasta !== fin ? `${desde.slice(8)}/${desde.slice(5, 7)} → ${hasta.slice(8)}/${hasta.slice(5, 7)}` : null };
  });
  return { param: p, filas, mes_descuento: ant, dias_habiles_mes: habilesRango(ini, fin, p.descuenta_feriados) };
}

/* GET /remuneraciones/edenred?mes= */
const getMes = async (req, res) => {
  try {
    const mes = mesOk(req.query.mes) ? req.query.mes : new Date().toISOString().slice(0, 7);
    const [gen] = await pool.query('SELECT * FROM rh_edenred_nomina WHERE mes=? ORDER BY nombre', [mes]);
    let data;
    if (gen.length) {
      const p = await paramDe(mes);
      data = { param: p, filas: gen.map(r => ({ ...r, dias_habiles: Number(r.dias_habiles), dias_descuento: Number(r.dias_descuento), monto_diario: Number(r.monto_diario), monto: Number(r.monto) })),
               mes_descuento: mesAnterior(mes), generada: true, generado_por: gen[0].generado_por, generado_at: gen[0].created_at };
    } else data = { ...(await calcularMes(mes)), generada: false };
    const [params] = await pool.query('SELECT * FROM rh_edenred_param ORDER BY mes_desde DESC');
    const [hist] = await pool.query('SELECT mes, COUNT(*) personas, SUM(monto) total, SUM(dias_descuento) dias_desc, MAX(created_at) generado_at FROM rh_edenred_nomina GROUP BY mes ORDER BY mes DESC LIMIT 24');
    const total = data.filas.reduce((s, f) => s + Number(f.monto), 0);
    ok(res, { mes, ...data, total, params, historial: hist });
  } catch (e) { console.error('[edenred get]', e.message); fail(res, 'Error interno del servidor'); }
};

/* PUT /remuneraciones/edenred/param {mes_desde, monto_diario, descuenta_feriados, tipos_descuento[]} */
const putParam = async (req, res) => {
  try {
    const b = req.body || {};
    if (!mesOk(b.mes_desde)) return fail(res, 'Indica desde qué mes de remuneración rige', 400);
    const monto = Math.round(Number(b.monto_diario) || 0);
    if (!(monto > 0 && monto < 100000)) return fail(res, 'Monto diario inválido', 400);
    const [[gen]] = await pool.query('SELECT COUNT(*) n FROM rh_edenred_nomina WHERE mes >= ?', [b.mes_desde]);
    if (gen.n) return fail(res, `Ya hay nóminas generadas desde ${b.mes_desde}: el cambio debe regir desde un mes sin nómina (el historial no se recalcula)`, 400);
    const tipos = Array.isArray(b.tipos_descuento) ? b.tipos_descuento.map(s => String(s).toUpperCase().trim()).filter(Boolean).join(',') : TIPOS_DEFAULT;
    const df = b.descuenta_feriados === false || b.descuenta_feriados === 0 ? 0 : 1;
    await pool.query(`INSERT INTO rh_edenred_param (mes_desde, monto_diario, descuenta_feriados, tipos_descuento, creado_por) VALUES (?,?,?,?,?)
      ON DUPLICATE KEY UPDATE monto_diario=VALUES(monto_diario), descuenta_feriados=VALUES(descuenta_feriados), tipos_descuento=VALUES(tipos_descuento), creado_por=VALUES(creado_por), created_at=NOW()`,
      [b.mes_desde, monto, df, tipos, nombreDe(req.usuario)]);
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'edenred_param', detalle: `Edenred desde ${b.mes_desde}: ${CLP(monto)} por día hábil · feriados ${df ? 'descuentan' : 'NO descuentan'} · descuentan: ${tipos}` });
    ok(res, { mes_desde: b.mes_desde, monto_diario: monto });
  } catch (e) { console.error('[edenred param]', e.message); fail(res, 'Error interno del servidor'); }
};

/* POST /remuneraciones/edenred/generar {mes} — congela la nómina del mes */
const generar = async (req, res) => {
  try {
    const mes = req.body?.mes;
    if (!mesOk(mes)) return fail(res, 'Mes inválido', 400);
    const [[ya]] = await pool.query('SELECT COUNT(*) n FROM rh_edenred_nomina WHERE mes=?', [mes]);
    if (ya.n) return fail(res, 'La nómina de este mes ya está generada. Anúlala primero si necesitas rehacerla.', 400);
    const c = await calcularMes(mes);
    if (!c.param.monto_diario) return fail(res, 'No hay monto diario vigente para este mes', 400);
    const filas = c.filas.filter(f => f.monto > 0 || f.dias_descuento > 0);
    if (!filas.length) return fail(res, 'No hay personas con Edenred este mes', 400);
    await pool.query('INSERT INTO rh_edenred_nomina (mes, id_usuario, nombre, rut, dias_habiles, dias_descuento, monto_diario, monto, detalle, generado_por) VALUES ?',
      [filas.map(f => [mes, f.id_usuario, f.nombre, f.rut, f.dias_habiles, f.dias_descuento, f.monto_diario, f.monto, [f.parcial, f.detalle].filter(Boolean).join(' · ') || null, nombreDe(req.usuario)])]);
    const total = filas.reduce((s, f) => s + f.monto, 0);
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'edenred_nomina', detalle: `Generó nómina Edenred ${mes}: ${filas.length} personas, ${CLP(total)} (${CLP(c.param.monto_diario)}/día, ${c.dias_habiles_mes} días hábiles; descuenta faltas de ${c.mes_descuento})` });
    ok(res, { personas: filas.length, total });
  } catch (e) { console.error('[edenred generar]', e.message); fail(res, 'Error interno del servidor'); }
};

/* POST /remuneraciones/edenred/anular {mes} — borra la nómina generada (para rehacerla) */
const anular = async (req, res) => {
  try {
    const mes = req.body?.mes;
    if (!mesOk(mes)) return fail(res, 'Mes inválido', 400);
    const [[t]] = await pool.query('SELECT COUNT(*) n, COALESCE(SUM(monto),0) total FROM rh_edenred_nomina WHERE mes=?', [mes]);
    if (!t.n) return fail(res, 'No hay nómina generada para este mes', 404);
    await pool.query('DELETE FROM rh_edenred_nomina WHERE mes=?', [mes]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'rrhh', entidad: 'edenred_nomina', detalle: `Anuló nómina Edenred ${mes} (${t.n} personas, ${CLP(t.total)}) — motivo: ${String(req.body?.motivo || '').trim().slice(0, 200) || 'sin motivo'}` });
    ok(res, { anulada: true });
  } catch (e) { console.error('[edenred anular]', e.message); fail(res, 'Error interno del servidor'); }
};

/* GET /remuneraciones/edenred/nomina.csv?mes= — archivo de carga (formato provisorio hasta
   que Pato entregue el layout exacto de Edenred: RUT;NOMBRE;MONTO) */
const nominaCsv = async (req, res) => {
  try {
    const mes = req.query.mes;
    if (!mesOk(mes)) return fail(res, 'Mes inválido', 400);
    const [rows] = await pool.query('SELECT rut, nombre, monto FROM rh_edenred_nomina WHERE mes=? AND monto > 0 ORDER BY nombre', [mes]);
    if (!rows.length) return fail(res, 'Genera la nómina del mes antes de descargarla', 400);
    const lineas = ['RUT;NOMBRE;MONTO', ...rows.map(r => `${String(r.rut || '').replace(/\./g, '')};${r.nombre};${Math.round(Number(r.monto))}`)];
    auditar({ req, accion: 'EXPORTAR', modulo: 'rrhh', entidad: 'edenred_nomina', detalle: `Descargó nómina Edenred ${mes} (${rows.length} personas)` });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="nomina-edenred-${mes}.csv"`);
    res.send('﻿' + lineas.join('\r\n'));
  } catch (e) { console.error('[edenred csv]', e.message); fail(res, 'Error interno del servidor'); }
};

/* PUT /remuneraciones/edenred/persona {id_usuario, edenred} — quién recibe la tarjeta */
const putPersona = async (req, res) => {
  try {
    const idU = Number(req.body?.id_usuario), v = req.body?.edenred ? 1 : 0;
    if (!idU) return fail(res, 'Colaborador requerido', 400);
    const [r] = await pool.query('UPDATE rh_fichas SET edenred=? WHERE id_usuario=?', [v, idU]);
    if (!r.affectedRows) return fail(res, 'Ficha no encontrada', 404);
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'ficha', entidad_id: idU, detalle: `Edenred ${v ? 'ACTIVADO' : 'desactivado'} (usuario ${idU})` });
    ok(res, { id_usuario: idU, edenred: v });
  } catch (e) { console.error('[edenred persona]', e.message); fail(res, 'Error interno del servidor'); }
};

/* GET /remuneraciones/edenred/resumen — pagado por mes y por persona (últimos 12 meses) */
const resumen = async (req, res) => {
  try {
    const [porMes] = await pool.query('SELECT mes, COUNT(*) personas, SUM(monto) total FROM rh_edenred_nomina GROUP BY mes ORDER BY mes DESC LIMIT 12');
    const [porPersona] = await pool.query(
      `SELECT id_usuario, MAX(nombre) nombre, COUNT(*) meses, SUM(monto) total, SUM(dias_descuento) dias_desc
         FROM rh_edenred_nomina WHERE mes >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 12 MONTH), '%Y-%m') GROUP BY id_usuario ORDER BY nombre`);
    ok(res, { por_mes: porMes, por_persona: porPersona });
  } catch (e) { console.error('[edenred resumen]', e.message); fail(res, 'Error interno del servidor'); }
};

module.exports = { getMes, putParam, generar, anular, nominaCsv, putPersona, resumen, calcularMes };
