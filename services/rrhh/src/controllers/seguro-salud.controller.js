'use strict';
/* ── Seguro Complementario de Salud (MetLife) — Pato, 17-09-2026 ─────────────────────
   Seguro colectivo de los empleados. Cada mes se paga a la aseguradora una NÓMINA de
   asegurados: el TITULAR (lo paga AutoFácil) y, si el empleado las inscribe, sus CARGAS.

   · Quién paga la carga: a quienes se contrató HASTA una fecha de corte (paramétrica) el
     seguro de sus cargas lo paga AutoFácil; después de esa fecha la carga la paga el
     EMPLEADO y se le descuenta en la liquidación. Se puede corregir carga por carga.
   · Registro de cargas (rh_cargas): nombre, RUT, nacimiento, sexo, relación. Fuente única
     de los beneficiarios del seguro. (Los contadores de cargas de la ficha son de la
     ASIGNACIÓN FAMILIAR legal: otra magnitud, no se fusionan.)
   · Edad máxima de los hijos (paramétrica, 23 según la póliza): la aseguradora rechazó
     cargas de 24 y 28 años. Pasada la edad la carga se marca y sale de la nómina sola.
   · Selección: casilla por titular (rh_fichas.seguro_salud) y por carga (rh_cargas.en_seguro).
   · Generar la nómina CONGELA el mes (rh_seguro_nomina) y crea UN descuento VARIOS por
     empleado con cargas a su costo (rh_descuentos.seguro_mes lo ata al mes). Anular la
     nómina anula esos descuentos. La liquidación ya emitida no se toca.
   · Primas paramétricas con vigencia desde un mes (UF o pesos): titular y por carga. */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const XLSX = require('xlsx');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });
const nombreDe = u => `${u?.nombre || ''} ${u?.apellido || ''}`.trim() || u?.email || null;
const CLP = v => '$' + Math.round(Number(v) || 0).toLocaleString('es-CL');
const mesOk = m => /^\d{4}-\d{2}$/.test(m || '');
const iso = d => d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d || '').slice(0, 10);
const fechaOk = f => /^\d{4}-\d{2}-\d{2}$/.test(f || '');
const RELACIONES = ['CONYUGE', 'CONVIVIENTE CIVIL', 'HIJO', 'OTRO'];

require('../../../../shared/migrate').migrar('rrhh-seguro-salud', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_cargas (
    id INT AUTO_INCREMENT PRIMARY KEY, id_usuario INT NOT NULL,
    nombres VARCHAR(120) NOT NULL, apellido_paterno VARCHAR(80) NULL, apellido_materno VARCHAR(80) NULL,
    rut VARCHAR(15) NULL, fecha_nacimiento DATE NULL, sexo CHAR(1) NULL,
    relacion VARCHAR(30) NOT NULL DEFAULT 'HIJO',
    en_seguro TINYINT(1) NOT NULL DEFAULT 1,
    paga VARCHAR(10) NULL,                       -- EMPRESA / EMPLEADO; NULL = según la fecha de corte
    activo TINYINT(1) NOT NULL DEFAULT 1,
    creado_por VARCHAR(160) NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NULL,
    INDEX idx_usuario (id_usuario))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_seguro_param (
    id INT AUTO_INCREMENT PRIMARY KEY, mes_desde CHAR(7) NOT NULL,
    aseguradora VARCHAR(80) NOT NULL DEFAULT 'METLIFE',
    moneda VARCHAR(3) NOT NULL DEFAULT 'UF',
    prima_titular DECIMAL(12,4) NOT NULL DEFAULT 0, prima_carga DECIMAL(12,4) NOT NULL DEFAULT 0,
    edad_max_hijo INT NOT NULL DEFAULT 23,
    corte_cargas_empresa DATE NULL,              -- contratados hasta esta fecha: la empresa paga sus cargas
    creado_por VARCHAR(160) NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_mes (mes_desde))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_seguro_nomina (
    id INT AUTO_INCREMENT PRIMARY KEY, mes CHAR(7) NOT NULL, id_usuario INT NOT NULL, id_carga INT NULL,
    titular VARCHAR(200) NULL, nombre VARCHAR(200) NULL, rut VARCHAR(15) NULL, fecha_nacimiento DATE NULL, sexo CHAR(1) NULL,
    relacion VARCHAR(30) NOT NULL, paga VARCHAR(10) NOT NULL,
    moneda VARCHAR(3) NOT NULL, prima_origen DECIMAL(12,4) NOT NULL, valor_uf DECIMAL(12,2) NULL, prima DECIMAL(12,0) NOT NULL,
    generado_por VARCHAR(160) NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_mes (mes))`);
  await pool.query('ALTER TABLE rh_fichas ADD COLUMN IF NOT EXISTS seguro_salud TINYINT(1) NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE rh_descuentos ADD COLUMN IF NOT EXISTS seguro_mes CHAR(7) NULL');
});

async function paramDe(mes) {
  const [[p]] = await pool.query('SELECT * FROM rh_seguro_param WHERE mes_desde <= ? ORDER BY mes_desde DESC LIMIT 1', [mes]);
  if (!p) return { aseguradora: 'METLIFE', moneda: 'UF', prima_titular: 0, prima_carga: 0, edad_max_hijo: 23, corte_cargas_empresa: null, mes_desde: null };
  return { ...p, prima_titular: Number(p.prima_titular), prima_carga: Number(p.prima_carga), corte_cargas_empresa: p.corte_cargas_empresa ? iso(p.corte_cargas_empresa) : null };
}
const edadAl = (nac, fechaISO) => {
  if (!nac) return null;
  const n = new Date(iso(nac) + 'T12:00:00'), f = new Date(fechaISO + 'T12:00:00');
  let e = f.getFullYear() - n.getFullYear();
  if (f.getMonth() < n.getMonth() || (f.getMonth() === n.getMonth() && f.getDate() < n.getDate())) e--;
  return e;
};

/* Vista del mes: titulares + cargas, con quién paga, edad y prima en pesos */
async function calcularMes(mes) {
  const p = await paramDe(mes);
  const ini = mes + '-01';
  let valorUF = null;
  if (p.moneda === 'UF') { try { valorUF = Number(await require('../../../../shared/uf').getUF(new Date(ini + 'T12:00:00'))) || null; } catch (_) {} }
  const aCLP = v => Math.round(p.moneda === 'UF' ? (Number(v) || 0) * (valorUF || 0) : (Number(v) || 0));
  const [gente] = await pool.query(
    `SELECT u.id_usuario, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) nombre, u.nombre nombres, u.apellido, u.apellido_materno, u.rut, u.sexo,
            u.fecha_nacimiento, u.fecha_ingreso, u.fecha_baja, COALESCE(f.seguro_salud,0) seguro_salud
       FROM usuarios u JOIN rh_fichas f ON f.id_usuario=u.id_usuario
      WHERE COALESCE(f.sueldo_base,0) > 0 AND (u.estado='activo' OR (u.fecha_baja IS NOT NULL AND u.fecha_baja > ?))
      ORDER BY nombre`, [ini]);
  const [cargas] = await pool.query('SELECT * FROM rh_cargas WHERE activo=1 ORDER BY id_usuario, relacion, fecha_nacimiento');
  const titulares = gente.map(g => {
    const cs = cargas.filter(c => c.id_usuario === g.id_usuario).map(c => {
      const edad = edadAl(c.fecha_nacimiento, ini);
      const excedeEdad = c.relacion === 'HIJO' && edad != null && edad > p.edad_max_hijo;
      const pagaAuto = p.corte_cargas_empresa && g.fecha_ingreso && iso(g.fecha_ingreso) <= p.corte_cargas_empresa ? 'EMPRESA' : 'EMPLEADO';
      const paga = c.paga === 'EMPRESA' || c.paga === 'EMPLEADO' ? c.paga : pagaAuto;
      const incluida = !!c.en_seguro && !!g.seguro_salud && !excedeEdad;
      return { id: c.id, nombre: [c.nombres, c.apellido_paterno, c.apellido_materno].filter(Boolean).join(' '), nombres: c.nombres, apellido_paterno: c.apellido_paterno,
        apellido_materno: c.apellido_materno, rut: c.rut, fecha_nacimiento: c.fecha_nacimiento ? iso(c.fecha_nacimiento) : null, sexo: c.sexo, relacion: c.relacion,
        edad, excede_edad: excedeEdad, en_seguro: c.en_seguro ? 1 : 0, paga, paga_manual: !!c.paga, incluida, prima: incluida ? aCLP(p.prima_carga) : 0 };
    });
    const primaTit = g.seguro_salud ? aCLP(p.prima_titular) : 0;
    const costoEmpresa = primaTit + cs.filter(c => c.incluida && c.paga === 'EMPRESA').reduce((s, c) => s + c.prima, 0);
    const costoEmpleado = cs.filter(c => c.incluida && c.paga === 'EMPLEADO').reduce((s, c) => s + c.prima, 0);
    return { id_usuario: g.id_usuario, nombre: g.nombre, rut: g.rut, sexo: g.sexo, fecha_nacimiento: g.fecha_nacimiento ? iso(g.fecha_nacimiento) : null,
      fecha_ingreso: g.fecha_ingreso ? iso(g.fecha_ingreso) : null, seguro_salud: g.seguro_salud ? 1 : 0, baja: g.fecha_baja ? 1 : 0,
      nombre_completo: [g.nombres, g.apellido, g.apellido_materno].filter(Boolean).join(' '),
      prima: primaTit, cargas: cs, costo_empresa: costoEmpresa, costo_empleado: costoEmpleado };
  });
  return { param: p, valor_uf: valorUF, titulares };
}
const totales = ts => ({
  titulares: ts.filter(t => t.seguro_salud).length,
  cargas: ts.reduce((s, t) => s + t.cargas.filter(c => c.incluida).length, 0),
  empresa: ts.reduce((s, t) => s + t.costo_empresa, 0), empleado: ts.reduce((s, t) => s + t.costo_empleado, 0),
});

/* GET /remuneraciones/seguro?mes= */
const getMes = async (req, res) => {
  try {
    const mes = mesOk(req.query.mes) ? req.query.mes : new Date().toISOString().slice(0, 7);
    const c = await calcularMes(mes);
    const [gen] = await pool.query('SELECT * FROM rh_seguro_nomina WHERE mes=? ORDER BY titular, id_carga IS NOT NULL, nombre', [mes]);
    const [params] = await pool.query('SELECT * FROM rh_seguro_param ORDER BY mes_desde DESC');
    const [hist] = await pool.query(`SELECT mes, SUM(id_carga IS NULL) titulares, SUM(id_carga IS NOT NULL) cargas, SUM(prima) total,
        SUM(CASE WHEN paga='EMPLEADO' THEN prima ELSE 0 END) empleado, MAX(created_at) generado_at FROM rh_seguro_nomina GROUP BY mes ORDER BY mes DESC LIMIT 24`);
    const t = totales(c.titulares);
    ok(res, { mes, ...c, totales: { ...t, total: t.empresa + t.empleado }, generada: gen.length > 0,
      nomina: gen.map(r => ({ ...r, prima: Number(r.prima), prima_origen: Number(r.prima_origen), fecha_nacimiento: r.fecha_nacimiento ? iso(r.fecha_nacimiento) : null })),
      generado_por: gen[0]?.generado_por || null, generado_at: gen[0]?.created_at || null, params, historial: hist, relaciones: RELACIONES });
  } catch (e) { console.error('[seguro get]', e.message); fail(res, 'Error interno del servidor'); }
};

/* PUT /remuneraciones/seguro/param */
const putParam = async (req, res) => {
  try {
    const b = req.body || {};
    if (!mesOk(b.mes_desde)) return fail(res, 'Indica desde qué mes rige', 400);
    const moneda = b.moneda === 'CLP' ? 'CLP' : 'UF';
    const pt = Number(b.prima_titular), pc = Number(b.prima_carga);
    if (!(pt >= 0) || !(pc >= 0) || (!pt && !pc)) return fail(res, 'Indica la prima del titular y la de la carga', 400);
    const edad = Math.round(Number(b.edad_max_hijo) || 23);
    if (edad < 18 || edad > 35) return fail(res, 'Edad máxima de hijos fuera de rango', 400);
    const corte = fechaOk(b.corte_cargas_empresa) ? b.corte_cargas_empresa : null;
    const [[gen]] = await pool.query('SELECT COUNT(*) n FROM rh_seguro_nomina WHERE mes >= ?', [b.mes_desde]);
    if (gen.n) return fail(res, `Ya hay nóminas generadas desde ${b.mes_desde}: el cambio debe regir desde un mes sin nómina`, 400);
    const aseg = String(b.aseguradora || 'METLIFE').trim().toUpperCase().slice(0, 80);
    await pool.query(`INSERT INTO rh_seguro_param (mes_desde, aseguradora, moneda, prima_titular, prima_carga, edad_max_hijo, corte_cargas_empresa, creado_por) VALUES (?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE aseguradora=VALUES(aseguradora), moneda=VALUES(moneda), prima_titular=VALUES(prima_titular), prima_carga=VALUES(prima_carga),
        edad_max_hijo=VALUES(edad_max_hijo), corte_cargas_empresa=VALUES(corte_cargas_empresa), creado_por=VALUES(creado_por), created_at=NOW()`,
      [b.mes_desde, aseg, moneda, pt, pc, edad, corte, nombreDe(req.usuario)]);
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'seguro_param', detalle: `Seguro de salud desde ${b.mes_desde}: ${aseg} · titular ${pt} ${moneda} · carga ${pc} ${moneda} · hijos hasta ${edad} años · empresa paga cargas de contratados hasta ${corte || '—'}` });
    ok(res, { mes_desde: b.mes_desde });
  } catch (e) { console.error('[seguro param]', e.message); fail(res, 'Error interno del servidor'); }
};

/* PUT /remuneraciones/seguro/titular {id_usuario, seguro_salud} */
const putTitular = async (req, res) => {
  try {
    const idU = Number(req.body?.id_usuario), v = req.body?.seguro_salud ? 1 : 0;
    if (!idU) return fail(res, 'Colaborador requerido', 400);
    const [r] = await pool.query('UPDATE rh_fichas SET seguro_salud=? WHERE id_usuario=?', [v, idU]);
    if (!r.affectedRows) return fail(res, 'Ficha no encontrada', 404);
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'ficha', entidad_id: idU, detalle: `Seguro complementario de salud ${v ? 'INCLUIDO' : 'excluido'} (usuario ${idU})` });
    ok(res, { id_usuario: idU, seguro_salud: v });
  } catch (e) { console.error('[seguro titular]', e.message); fail(res, 'Error interno del servidor'); }
};

/* POST /remuneraciones/seguro/carga {id?, id_usuario, nombres, apellido_paterno, apellido_materno, rut, fecha_nacimiento, sexo, relacion, en_seguro, paga} */
const guardarCarga = async (req, res) => {
  try {
    const b = req.body || {}, id = Number(b.id) || null, idU = Number(b.id_usuario);
    const nombres = String(b.nombres || '').trim().slice(0, 120);
    if (!idU || !nombres) return fail(res, 'Colaborador y nombre de la carga son obligatorios', 400);
    const relacion = RELACIONES.includes(String(b.relacion || '').toUpperCase()) ? String(b.relacion).toUpperCase() : 'HIJO';
    const nac = fechaOk(b.fecha_nacimiento) ? b.fecha_nacimiento : null;
    if (!nac) return fail(res, 'La fecha de nacimiento es obligatoria (la aseguradora la exige y define la edad máxima)', 400);
    const sexo = ['M', 'F'].includes(String(b.sexo || '').toUpperCase()) ? String(b.sexo).toUpperCase() : null;
    const paga = ['EMPRESA', 'EMPLEADO'].includes(b.paga) ? b.paga : null;
    const rut = String(b.rut || '').trim().toUpperCase().slice(0, 15) || null;
    const vals = [nombres, String(b.apellido_paterno || '').trim().slice(0, 80) || null, String(b.apellido_materno || '').trim().slice(0, 80) || null, rut, nac, sexo, relacion, b.en_seguro === false || b.en_seguro === 0 ? 0 : 1, paga];
    let idFinal = id;
    if (id) {
      const [r] = await pool.query('UPDATE rh_cargas SET nombres=?, apellido_paterno=?, apellido_materno=?, rut=?, fecha_nacimiento=?, sexo=?, relacion=?, en_seguro=?, paga=?, updated_at=NOW() WHERE id=? AND id_usuario=?', [...vals, id, idU]);
      if (!r.affectedRows) return fail(res, 'Carga no encontrada', 404);
    } else {
      const [r] = await pool.query('INSERT INTO rh_cargas (nombres, apellido_paterno, apellido_materno, rut, fecha_nacimiento, sexo, relacion, en_seguro, paga, id_usuario, creado_por) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [...vals, idU, nombreDe(req.usuario)]);
      idFinal = r.insertId;
    }
    auditar({ req, accion: id ? 'EDITAR' : 'CREAR', modulo: 'rrhh', entidad: 'carga', entidad_id: idFinal, detalle: `${id ? 'Editó' : 'Registró'} carga ${nombres} (${relacion}, nac. ${nac}) del usuario ${idU} · seguro ${vals[7] ? 'sí' : 'no'} · paga ${paga || 'según fecha de corte'}` });
    ok(res, { id: idFinal });
  } catch (e) { console.error('[seguro carga]', e.message); fail(res, 'Error interno del servidor'); }
};

/* PUT /remuneraciones/seguro/carga/seleccion {id, en_seguro?, paga?} — casilla y quién paga, desde la nómina */
const seleccionCarga = async (req, res) => {
  try {
    const id = Number(req.body?.id); if (!id) return fail(res, 'Carga requerida', 400);
    const sets = [], vals = [];
    if (req.body.en_seguro !== undefined) { sets.push('en_seguro=?'); vals.push(req.body.en_seguro ? 1 : 0); }
    if (req.body.paga !== undefined) { sets.push('paga=?'); vals.push(['EMPRESA', 'EMPLEADO'].includes(req.body.paga) ? req.body.paga : null); }
    if (!sets.length) return fail(res, 'Nada que cambiar', 400);
    const [r] = await pool.query(`UPDATE rh_cargas SET ${sets.join(', ')}, updated_at=NOW() WHERE id=?`, [...vals, id]);
    if (!r.affectedRows) return fail(res, 'Carga no encontrada', 404);
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'carga', entidad_id: id, detalle: `Carga ${id}: ${sets.map((s, i) => s.replace('=?', '=' + vals[i])).join(', ')}` });
    ok(res, { id });
  } catch (e) { console.error('[seguro seleccion]', e.message); fail(res, 'Error interno del servidor'); }
};

/* DELETE /remuneraciones/seguro/carga/:id — baja lógica (el historial de nóminas la conserva) */
const bajaCarga = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [r] = await pool.query('UPDATE rh_cargas SET activo=0, en_seguro=0, updated_at=NOW() WHERE id=? AND activo=1', [id]);
    if (!r.affectedRows) return fail(res, 'Carga no encontrada', 404);
    auditar({ req, accion: 'ELIMINAR', modulo: 'rrhh', entidad: 'carga', entidad_id: id, detalle: `Dio de baja la carga ${id}` });
    ok(res, { id });
  } catch (e) { console.error('[seguro baja carga]', e.message); fail(res, 'Error interno del servidor'); }
};

/* POST /remuneraciones/seguro/generar {mes} — congela la nómina y crea los descuentos de cargas a costo del empleado */
const generar = async (req, res) => {
  try {
    const mes = req.body?.mes;
    if (!mesOk(mes)) return fail(res, 'Mes inválido', 400);
    const [[ya]] = await pool.query('SELECT COUNT(*) n FROM rh_seguro_nomina WHERE mes=?', [mes]);
    if (ya.n) return fail(res, 'La nómina de este mes ya está generada. Anúlala primero si necesitas rehacerla.', 400);
    const c = await calcularMes(mes), p = c.param;
    if (!p.prima_titular && !p.prima_carga) return fail(res, 'Configura las primas en la pestaña Parámetros', 400);
    if (p.moneda === 'UF' && !c.valor_uf) return fail(res, 'No hay valor de la UF para el día 1 de ese mes', 400);
    const quien = nombreDe(req.usuario), filas = [];
    for (const t of c.titulares.filter(x => x.seguro_salud)) {
      filas.push([mes, t.id_usuario, null, t.nombre, t.nombre_completo || t.nombre, t.rut, t.fecha_nacimiento, t.sexo, 'TITULAR', 'EMPRESA', p.moneda, p.prima_titular, c.valor_uf, t.prima, quien]);
      for (const k of t.cargas.filter(x => x.incluida))
        filas.push([mes, t.id_usuario, k.id, t.nombre, k.nombre, k.rut, k.fecha_nacimiento, k.sexo, k.relacion, k.paga, p.moneda, p.prima_carga, c.valor_uf, k.prima, quien]);
    }
    if (!filas.length) return fail(res, 'No hay nadie marcado en el seguro', 400);
    await pool.query('INSERT INTO rh_seguro_nomina (mes, id_usuario, id_carga, titular, nombre, rut, fecha_nacimiento, sexo, relacion, paga, moneda, prima_origen, valor_uf, prima, generado_por) VALUES ?', [filas]);
    // Un descuento por empleado con cargas a su costo (sale en la liquidación de ese mes)
    let nDesc = 0, totDesc = 0;
    for (const t of c.titulares.filter(x => x.seguro_salud && x.costo_empleado > 0)) {
      const n = t.cargas.filter(k => k.incluida && k.paga === 'EMPLEADO').length;
      await pool.query(`INSERT INTO rh_descuentos (id_usuario, tipo, detalle_texto, monto_total, cuotas, valor_cuota, mes_inicio, creado_por, moneda, seguro_mes)
        VALUES (?,'VARIOS',?,?,1,?,?,?,'CLP',?)`, [t.id_usuario, `Seguro complementario de salud — ${n} carga${n === 1 ? '' : 's'} (${p.aseguradora})`, t.costo_empleado, t.costo_empleado, mes, quien, mes]);
      nDesc++; totDesc += t.costo_empleado;
    }
    const t = totales(c.titulares);
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'seguro_nomina', detalle: `Generó nómina seguro de salud ${mes} (${p.aseguradora}): ${t.titulares} titulares + ${t.cargas} cargas = ${CLP(t.empresa + t.empleado)} · a costo de la empresa ${CLP(t.empresa)} · descuentos a ${nDesc} empleados por ${CLP(totDesc)}` });
    ok(res, { titulares: t.titulares, cargas: t.cargas, total: t.empresa + t.empleado, descuentos: nDesc, total_descuentos: totDesc });
  } catch (e) { console.error('[seguro generar]', e.message); fail(res, 'Error interno del servidor'); }
};

/* POST /remuneraciones/seguro/anular {mes, motivo} */
const anular = async (req, res) => {
  try {
    const mes = req.body?.mes, motivo = String(req.body?.motivo || '').trim().slice(0, 200);
    if (!mesOk(mes)) return fail(res, 'Mes inválido', 400);
    if (motivo.length < 5) return fail(res, 'Indica el motivo', 400);
    const [[t]] = await pool.query('SELECT COUNT(*) n, COALESCE(SUM(prima),0) total FROM rh_seguro_nomina WHERE mes=?', [mes]);
    if (!t.n) return fail(res, 'No hay nómina generada para este mes', 404);
    await pool.query('DELETE FROM rh_seguro_nomina WHERE mes=?', [mes]);
    const [d] = await pool.query("UPDATE rh_descuentos SET estado='ANULADO', anulado_por=?, anulado_at=NOW() WHERE seguro_mes=? AND estado='VIGENTE'", [nombreDe(req.usuario), mes]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'rrhh', entidad: 'seguro_nomina', detalle: `Anuló nómina seguro de salud ${mes} (${t.n} asegurados, ${CLP(t.total)}) y ${d.affectedRows} descuento(s) de cargas — motivo: ${motivo}` });
    ok(res, { anulada: true, descuentos_anulados: d.affectedRows });
  } catch (e) { console.error('[seguro anular]', e.message); fail(res, 'Error interno del servidor'); }
};

/* GET /remuneraciones/seguro/nomina.xlsx?mes= — nómina para la aseguradora (layout de la "Nómina de cotización") + resumen de costo */
const nominaXlsx = async (req, res) => {
  try {
    const mes = req.query.mes;
    if (!mesOk(mes)) return fail(res, 'Mes inválido', 400);
    const [rows] = await pool.query(`SELECT n.*, u.nombre u_nombres, u.apellido u_pat, u.apellido_materno u_mat, k.nombres k_nombres, k.apellido_paterno k_pat, k.apellido_materno k_mat
      FROM rh_seguro_nomina n LEFT JOIN usuarios u ON u.id_usuario=n.id_usuario LEFT JOIN rh_cargas k ON k.id=n.id_carga WHERE n.mes=? ORDER BY n.titular, n.id_carga IS NOT NULL, n.nombre`, [mes]);
    if (!rows.length) return fail(res, 'Genera la nómina del mes antes de descargarla', 400);
    const dmy = f => f ? iso(f).split('-').reverse().join('-') : '';
    const REL = { TITULAR: 'AS', CONYUGE: 'CO', 'CONVIVIENTE CIVIL': 'CO', HIJO: 'HI', OTRO: 'OT' };
    const aoa1 = [['Nombre', 'Apellido Paterno', 'Apellido Materno', 'Fecha Nacimiento', 'Sexo', 'Relación', 'RUT', 'Titular', 'Estado asegurado'],
      ...rows.map(r => r.id_carga ? [r.k_nombres || r.nombre, r.k_pat || '', r.k_mat || '', dmy(r.fecha_nacimiento), r.sexo || '', REL[r.relacion] || r.relacion, r.rut || '', r.titular, 'VIGENTE']
                                  : [r.u_nombres || r.nombre, r.u_pat || '', r.u_mat || '', dmy(r.fecha_nacimiento), r.sexo || '', 'AS', r.rut || '', r.titular, 'VIGENTE'])];
    const porTit = {};
    for (const r of rows) { const t = (porTit[r.id_usuario] = porTit[r.id_usuario] || { titular: r.titular, cargas: 0, empresa: 0, empleado: 0 }); if (r.id_carga) t.cargas++; t[r.paga === 'EMPLEADO' ? 'empleado' : 'empresa'] += Number(r.prima); }
    const lista = Object.values(porTit);
    const aoa2 = [['Titular', 'Cargas', 'Costo empresa', 'Descuento al empleado', 'Total'], ...lista.map(t => [t.titular, t.cargas, t.empresa, t.empleado, t.empresa + t.empleado]),
      [], ['TOTAL', lista.reduce((s, t) => s + t.cargas, 0), lista.reduce((s, t) => s + t.empresa, 0), lista.reduce((s, t) => s + t.empleado, 0), lista.reduce((s, t) => s + t.empresa + t.empleado, 0)]];
    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet(aoa1); ws1['!cols'] = [{ wch: 24 }, { wch: 18 }, { wch: 18 }, { wch: 16 }, { wch: 6 }, { wch: 9 }, { wch: 13 }, { wch: 28 }, { wch: 16 }];
    const ws2 = XLSX.utils.aoa_to_sheet(aoa2); ws2['!cols'] = [{ wch: 30 }, { wch: 8 }, { wch: 15 }, { wch: 22 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, ws1, 'Nomina de cotizacion'); XLSX.utils.book_append_sheet(wb, ws2, 'Costo por titular');
    auditar({ req, accion: 'EXPORTAR', modulo: 'rrhh', entidad: 'seguro_nomina', detalle: `Descargó nómina seguro de salud ${mes} (${rows.length} asegurados)` });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="nomina-seguro-salud-${mes}.xlsx"`);
    res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  } catch (e) { console.error('[seguro xlsx]', e.message); fail(res, 'Error interno del servidor'); }
};

module.exports = { getMes, putParam, putTitular, guardarCarga, seleccionCarga, bajaCarga, generar, anular, nominaXlsx, calcularMes };
