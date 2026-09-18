'use strict';
/* ── Seguro Complementario de Salud (MetLife) — Pato, 17-09-2026 ─────────────────────
   Seguro colectivo de los empleados. Cada mes se paga a la aseguradora una NÓMINA de
   asegurados: el TITULAR (lo paga AutoFácil) y, si el empleado las inscribe, sus CARGAS.

   · Quién paga la carga: a quienes se contrató HASTA una fecha de corte (paramétrica) el
     seguro de sus cargas lo paga AutoFácil; después de esa fecha la carga la paga el
     EMPLEADO y se le descuenta en la liquidación. Se puede corregir carga por carga.
   · Registro de cargas (rh_cargas): nombre, RUT, nacimiento, sexo, relación. FUENTE ÚNICA de la
     familia del colaborador: la misma fila lleva es_carga (asignación familiar Previred, la edita
     la ficha) y en_seguro / certificado_estudios (seguro). rh_hijos quedó en desuso (17-09-2026).
     Se ve y se edita en la ficha del colaborador (sección Hijos y cargas familiares) y acá.
   · Edad máxima de los hijos (paramétrica, 23 según la póliza): la aseguradora rechazó
     cargas de 24 y 28 años. Pasada la edad la carga se marca y sale de la nómina sola,
     SALVO que tenga certificado de estudios (rh_cargas.certificado_estudios): la aseguradora
     acepta al hijo estudiante HASTA LA RENOVACIÓN DE LA PÓLIZA (rh_seguro_poliza.vigencia_hasta,
     editable arriba de la nómina). Al renovar, la fecha se actualiza y hay que reenviar los
     certificados; hasta entonces esos hijos quedan fuera con aviso (Pato 17-09-2026).
   · Selección: casilla por titular (rh_fichas.seguro_salud) y por carga (rh_cargas.en_seguro).
   · NO hay "generar nómina" (Pato 17-09-2026): la nómina del mes es la vista viva (lo que se
     espera cobrar) y el Excel sale de ahí. Al EMITIR LA ODP del mes se crea UN descuento
     VARIOS por empleado con cargas a su costo (rh_descuentos.seguro_mes lo ata al mes).
     rh_seguro_nomina y generar/anular quedan como endpoints sin uso en la pantalla.
   · Primas paramétricas con vigencia desde un mes (UF o pesos): titular y por carga.
   · SOLO INDEFINIDOS (Pato 17-09-2026): el plazo fijo no tiene seguro. Cuando un contrato pasa a
     INDEFINIDO (vencimiento del plazo fijo o edición de la ficha) el motor `seguro-inscribir-aviso`
     lo marca titular y manda correo a RRHH con copia a Contabilidad para que lo inscriban en la
     aseguradora (plantilla seguro_inscribir_aviso, una vez por persona: rh_fichas.seguro_aviso_at).
     Los indefinidos existentes al 17-09-2026 se dieron por informados. */
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
require('../../../../shared/migrate').migrar('rrhh-seguro-salud-certificado', async () => {
  await pool.query('ALTER TABLE rh_cargas ADD COLUMN IF NOT EXISTS certificado_estudios_hasta DATE NULL');
});
require('../../../../shared/migrate').migrar('rrhh-cargas-fuente-unica', async () => {
  await pool.query('ALTER TABLE rh_cargas ADD COLUMN IF NOT EXISTS es_carga TINYINT(1) NOT NULL DEFAULT 0');
  // rh_hijos estaba vacía al unificar; si alguna vez tuvo filas, se traen sin duplicar por RUT
  await pool.query(`INSERT INTO rh_cargas (id_usuario, nombres, rut, fecha_nacimiento, relacion, es_carga, en_seguro, creado_por)
    SELECT h.id_usuario, h.nombre, h.rut, h.fecha_nacimiento, 'HIJO', h.es_carga, 0, 'Migrado de rh_hijos'
      FROM rh_hijos h WHERE NOT EXISTS (SELECT 1 FROM rh_cargas c WHERE c.id_usuario=h.id_usuario AND (c.rut=h.rut OR c.nombres=h.nombre))`).catch(() => {});
});
require('../../../../shared/migrate').migrar('rrhh-seguro-solo-indefinidos', async () => {
  await pool.query('ALTER TABLE rh_fichas ADD COLUMN IF NOT EXISTS seguro_aviso_at DATETIME NULL');
  // Punto de partida: los indefinidos de hoy ya fueron informados a la aseguradora (Pato) → titulares, sin correo
  await pool.query("UPDATE rh_fichas f JOIN usuarios u ON u.id_usuario=f.id_usuario SET f.seguro_salud=1, f.seguro_aviso_at=NOW() WHERE u.estado='activo' AND f.tipo_contrato='INDEFINIDO' AND f.seguro_aviso_at IS NULL");
  // El plazo fijo no tiene seguro
  await pool.query("UPDATE rh_fichas SET seguro_salud=0 WHERE tipo_contrato<>'INDEFINIDO' AND seguro_salud=1");
});
require('../../../../shared/migrate').migrar('rrhh-seguro-param-certificado', async () => {
  await pool.query('ALTER TABLE rh_seguro_param ADD COLUMN IF NOT EXISTS certificado_dias_antes INT NOT NULL DEFAULT 30');   // cuántos días antes de la edad máxima se pide
  await pool.query('ALTER TABLE rh_seguro_param ADD COLUMN IF NOT EXISTS certificado_plazo_dias INT NOT NULL DEFAULT 5');    // plazo para entregarlo: N días antes del cumpleaños
});
require('../../../../shared/migrate').migrar('rrhh-seguro-certificado-fecha', async () => {
  await pool.query('ALTER TABLE rh_cargas ADD COLUMN IF NOT EXISTS certificado_enviado_at DATE NULL');   // cuándo se envió el certificado a la aseguradora
  await pool.query('ALTER TABLE rh_cargas ADD COLUMN IF NOT EXISTS certificado_aviso_at DATE NULL');     // cuándo se le pidió al colaborador (un mes antes de la edad máxima)
});
require('../../../../shared/migrate').migrar('rrhh-seguro-pago', async () => {
  await pool.query('ALTER TABLE rh_seguro_param ADD COLUMN IF NOT EXISTS edad_max_estudiante INT NOT NULL DEFAULT 27');
  await pool.query('ALTER TABLE rh_seguro_param ADD COLUMN IF NOT EXISTS tolerancia_uf DECIMAL(8,4) NOT NULL DEFAULT 0.05');
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_seguro_pago (
    id INT AUTO_INCREMENT PRIMARY KEY, mes CHAR(7) NOT NULL,
    uf_periodo DECIMAL(10,4) NULL, uf_ajustes DECIMAL(10,4) NULL, uf_total DECIMAL(10,4) NULL, uf_cobro DECIMAL(12,2) NULL, total_clp DECIMAL(12,0) NULL,
    esperado_uf DECIMAL(10,4) NULL, esperado_clp DECIMAL(12,0) NULL, diferencia_uf DECIMAL(10,4) NULL,
    estado VARCHAR(15) NOT NULL DEFAULT 'NO_CUADRA',      -- CUADRA / NO_CUADRA / OK_RRHH / PAGO_EMITIDO
    diff_json MEDIUMTEXT NULL, avisos_at DATETIME NULL,
    ok_por VARCHAR(160) NULL, ok_motivo VARCHAR(300) NULL, ok_at DATETIME NULL,
    odp_id INT NULL, odp_numero VARCHAR(20) NULL,
    actualizado_por VARCHAR(160) NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NULL,
    UNIQUE KEY uq_mes (mes))`);
});
require('../../../../shared/migrate').migrar('rrhh-seguro-salud-poliza', async () => {
  await pool.query('ALTER TABLE rh_cargas ADD COLUMN IF NOT EXISTS certificado_estudios TINYINT(1) NOT NULL DEFAULT 0');
  await pool.query('UPDATE rh_cargas SET certificado_estudios=1 WHERE certificado_estudios_hasta IS NOT NULL');
  // Póliza vigente: un solo registro (número, vigencia). La vigencia manda sobre los certificados de estudios.
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_seguro_poliza (
    id INT PRIMARY KEY, numero VARCHAR(40) NULL, vigencia_desde DATE NULL, vigencia_hasta DATE NULL,
    actualizado_por VARCHAR(160) NULL, updated_at DATETIME NULL)`);
  await pool.query("INSERT IGNORE INTO rh_seguro_poliza (id, numero, vigencia_desde, vigencia_hasta, actualizado_por) VALUES (1, '340025555', '2026-01-02', '2027-01-01', 'Documento de pago MetLife mar-2026')");
});
async function polizaVigente() {
  const [[p]] = await pool.query('SELECT * FROM rh_seguro_poliza WHERE id=1');
  return p ? { numero: p.numero, vigencia_desde: p.vigencia_desde ? iso(p.vigencia_desde) : null, vigencia_hasta: p.vigencia_hasta ? iso(p.vigencia_hasta) : null } : { numero: null, vigencia_desde: null, vigencia_hasta: null };
}

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
  const poliza = await polizaVigente();
  const ini = mes + '-01';
  let valorUF = null;
  if (p.moneda === 'UF') { try { valorUF = Number(await require('../../../../shared/uf').getUF(new Date(ini + 'T12:00:00'))) || null; } catch (_) {} }
  const aCLP = v => Math.round(p.moneda === 'UF' ? (Number(v) || 0) * (valorUF || 0) : (Number(v) || 0));
  const [gente] = await pool.query(
    `SELECT u.id_usuario, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) nombre, u.nombre nombres, u.apellido, u.apellido_materno, u.rut, u.sexo,
            u.fecha_nacimiento, u.fecha_ingreso, u.fecha_baja, COALESCE(f.seguro_salud,0) seguro_salud, f.tipo_contrato
       FROM usuarios u JOIN rh_fichas f ON f.id_usuario=u.id_usuario
      WHERE COALESCE(f.sueldo_base,0) > 0 AND (u.estado='activo' OR (u.fecha_baja IS NOT NULL AND u.fecha_baja > ?))
      ORDER BY nombre`, [ini]);
  const [cargas] = await pool.query('SELECT * FROM rh_cargas WHERE activo=1 ORDER BY id_usuario, relacion, fecha_nacimiento');
  const titulares = gente.map(g => {
    const cs = cargas.filter(c => c.id_usuario === g.id_usuario).map(c => {
      const edad = edadAl(c.fecha_nacimiento, ini);
      // Certificado de estudios: vale hasta la renovación de la póliza (vigencia_hasta)
      const certHasta = c.certificado_estudios ? poliza.vigencia_hasta : null;
      const edadEst = Number(p.edad_max_estudiante) || 27;
      const estudiante = !!c.certificado_estudios && !!certHasta && certHasta >= ini && (edad == null || edad <= edadEst);
      const excedeEdad = c.relacion === 'HIJO' && edad != null && edad > p.edad_max_hijo && !estudiante;
      const certVencido = !!c.certificado_estudios && !estudiante && c.relacion === 'HIJO' && edad != null && edad > p.edad_max_hijo;
      const pagaAuto = p.corte_cargas_empresa && g.fecha_ingreso && iso(g.fecha_ingreso) <= p.corte_cargas_empresa ? 'EMPRESA' : 'EMPLEADO';
      const paga = c.paga === 'EMPRESA' || c.paga === 'EMPLEADO' ? c.paga : pagaAuto;
      const incluida = !!c.en_seguro && !!g.seguro_salud && !excedeEdad;
      return { id: c.id, nombre: [c.nombres, c.apellido_paterno, c.apellido_materno].filter(Boolean).join(' '), nombres: c.nombres, apellido_paterno: c.apellido_paterno,
        apellido_materno: c.apellido_materno, rut: c.rut, fecha_nacimiento: c.fecha_nacimiento ? iso(c.fecha_nacimiento) : null, sexo: c.sexo, relacion: c.relacion,
        edad, excede_edad: excedeEdad, estudiante, certificado_estudios: c.certificado_estudios ? 1 : 0, certificado_estudios_hasta: certHasta, cert_vencido: certVencido,
        certificado_enviado_at: c.certificado_enviado_at ? iso(c.certificado_enviado_at) : null, certificado_aviso_at: c.certificado_aviso_at ? iso(c.certificado_aviso_at) : null, en_seguro: c.en_seguro ? 1 : 0, paga, paga_manual: !!c.paga, incluida, prima: incluida ? aCLP(p.prima_carga) : 0 };
    });
    const primaTit = g.seguro_salud ? aCLP(p.prima_titular) : 0;
    const costoEmpresa = primaTit + cs.filter(c => c.incluida && c.paga === 'EMPRESA').reduce((s, c) => s + c.prima, 0);
    const costoEmpleado = cs.filter(c => c.incluida && c.paga === 'EMPLEADO').reduce((s, c) => s + c.prima, 0);
    return { id_usuario: g.id_usuario, nombre: g.nombre, rut: g.rut, sexo: g.sexo, fecha_nacimiento: g.fecha_nacimiento ? iso(g.fecha_nacimiento) : null,
      fecha_ingreso: g.fecha_ingreso ? iso(g.fecha_ingreso) : null, seguro_salud: g.seguro_salud ? 1 : 0, baja: g.fecha_baja ? 1 : 0,
      tipo_contrato: g.tipo_contrato || null, elegible: g.tipo_contrato === 'INDEFINIDO',
      nombres: g.nombres, apellido: g.apellido, apellido_materno: g.apellido_materno,
      nombre_completo: [g.nombres, g.apellido, g.apellido_materno].filter(Boolean).join(' '),
      prima: primaTit, cargas: cs, costo_empresa: costoEmpresa, costo_empleado: costoEmpleado };
  });
  return { param: p, poliza, valor_uf: valorUF, titulares };
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
    const [hist] = await pool.query('SELECT mes, estado, uf_total, esperado_uf, total_clp, odp_numero, created_at, updated_at FROM rh_seguro_pago ORDER BY mes DESC LIMIT 36').catch(() => [[]]);
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
    const edadEst = Math.round(Number(b.edad_max_estudiante) || 27);
    if (edadEst < edad || edadEst > 40) return fail(res, 'La edad máxima de estudiante debe ser mayor o igual a la de hijos', 400);
    const tol = Number(b.tolerancia_uf); const tolF = tol >= 0 && tol < 5 ? tol : 0.05;
    const diasAntes = Math.round(Number(b.certificado_dias_antes)); const dA = diasAntes >= 7 && diasAntes <= 120 ? diasAntes : 30;
    const plazo = Math.round(Number(b.certificado_plazo_dias)); const dP = plazo >= 0 && plazo < dA ? plazo : 5;
    const [[gen]] = await pool.query('SELECT COUNT(*) n FROM rh_seguro_nomina WHERE mes >= ?', [b.mes_desde]);
    if (gen.n) return fail(res, `Ya hay nóminas generadas desde ${b.mes_desde}: el cambio debe regir desde un mes sin nómina`, 400);
    const aseg = String(b.aseguradora || 'METLIFE').trim().toUpperCase().slice(0, 80);
    await pool.query(`INSERT INTO rh_seguro_param (mes_desde, aseguradora, moneda, prima_titular, prima_carga, edad_max_hijo, edad_max_estudiante, tolerancia_uf, certificado_dias_antes, certificado_plazo_dias, corte_cargas_empresa, creado_por) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE aseguradora=VALUES(aseguradora), moneda=VALUES(moneda), prima_titular=VALUES(prima_titular), prima_carga=VALUES(prima_carga),
        edad_max_hijo=VALUES(edad_max_hijo), edad_max_estudiante=VALUES(edad_max_estudiante), tolerancia_uf=VALUES(tolerancia_uf), certificado_dias_antes=VALUES(certificado_dias_antes), certificado_plazo_dias=VALUES(certificado_plazo_dias), corte_cargas_empresa=VALUES(corte_cargas_empresa), creado_por=VALUES(creado_por), created_at=NOW()`,
      [b.mes_desde, aseg, moneda, pt, pc, edad, edadEst, tolF, dA, dP, corte, nombreDe(req.usuario)]);
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'seguro_param', detalle: `Seguro de salud desde ${b.mes_desde}: ${aseg} · titular ${pt} ${moneda} · carga ${pc} ${moneda} · hijos hasta ${edad} años (estudiantes hasta ${edadEst}) · tolerancia ${tolF} UF · certificado ${dA} días antes, plazo ${dP} días · empresa paga cargas de contratados hasta ${corte || '—'}` });
    ok(res, { mes_desde: b.mes_desde });
  } catch (e) { console.error('[seguro param]', e.message); fail(res, 'Error interno del servidor'); }
};

/* PUT /remuneraciones/seguro/poliza {numero, vigencia_desde, vigencia_hasta} — editable arriba de la nómina */
const putPoliza = async (req, res) => {
  try {
    const b = req.body || {};
    const hasta = fechaOk(b.vigencia_hasta) ? b.vigencia_hasta : null, desde = fechaOk(b.vigencia_desde) ? b.vigencia_desde : null;
    if (!hasta) return fail(res, 'Indica hasta cuándo rige la póliza (fecha de renovación)', 400);
    if (desde && desde > hasta) return fail(res, 'La vigencia termina antes de empezar', 400);
    const numero = String(b.numero || '').trim().slice(0, 40) || null;
    await pool.query(`INSERT INTO rh_seguro_poliza (id, numero, vigencia_desde, vigencia_hasta, actualizado_por, updated_at) VALUES (1,?,?,?,?,NOW())
      ON DUPLICATE KEY UPDATE numero=VALUES(numero), vigencia_desde=VALUES(vigencia_desde), vigencia_hasta=VALUES(vigencia_hasta), actualizado_por=VALUES(actualizado_por), updated_at=NOW()`, [numero, desde, hasta, nombreDe(req.usuario)]);
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'seguro_poliza', detalle: `Póliza ${numero || '—'}: vigencia ${desde || '—'} → ${hasta} (los certificados de estudios valen hasta esa fecha)` });
    ok(res, await polizaVigente());
  } catch (e) { console.error('[seguro poliza]', e.message); fail(res, 'Error interno del servidor'); }
};

/* PUT /remuneraciones/seguro/titular {id_usuario, seguro_salud} */
const putTitular = async (req, res) => {
  try {
    const idU = Number(req.body?.id_usuario), v = req.body?.seguro_salud ? 1 : 0;
    if (!idU) return fail(res, 'Colaborador requerido', 400);
    if (v) { const [[f]] = await pool.query('SELECT tipo_contrato FROM rh_fichas WHERE id_usuario=?', [idU]);
      if (f && f.tipo_contrato !== 'INDEFINIDO') return fail(res, `El seguro es solo para contrato INDEFINIDO (esta ficha dice ${f.tipo_contrato || 'sin tipo'})`, 400); }
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
    const cert = b.certificado_estudios ? 1 : 0;
    const certAt = fechaOk(b.certificado_enviado_at) ? b.certificado_enviado_at : null;
    const vals = [nombres, String(b.apellido_paterno || '').trim().slice(0, 80) || null, String(b.apellido_materno || '').trim().slice(0, 80) || null, rut, nac, sexo, relacion, b.en_seguro === false || b.en_seguro === 0 ? 0 : 1, paga];
    let idFinal = id;
    if (id) {
      const [r] = await pool.query('UPDATE rh_cargas SET nombres=?, apellido_paterno=?, apellido_materno=?, rut=?, fecha_nacimiento=?, sexo=?, relacion=?, en_seguro=?, paga=?, certificado_estudios=?, certificado_enviado_at=?, updated_at=NOW() WHERE id=? AND id_usuario=?', [...vals, cert, certAt, id, idU]);
      if (!r.affectedRows) return fail(res, 'Carga no encontrada', 404);
    } else {
      const [r] = await pool.query('INSERT INTO rh_cargas (nombres, apellido_paterno, apellido_materno, rut, fecha_nacimiento, sexo, relacion, en_seguro, paga, certificado_estudios, certificado_enviado_at, id_usuario, creado_por) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [...vals, cert, certAt, idU, nombreDe(req.usuario)]);
      idFinal = r.insertId;
    }
    auditar({ req, accion: id ? 'EDITAR' : 'CREAR', modulo: 'rrhh', entidad: 'carga', entidad_id: idFinal, detalle: `${id ? 'Editó' : 'Registró'} carga ${nombres} (${relacion}, nac. ${nac}) del usuario ${idU} · seguro ${vals[7] ? 'sí' : 'no'} · paga ${paga || 'según fecha de corte'}${cert ? ' · con certificado de estudios' + (certAt ? ' enviado el ' + certAt : '') + ' (vigente hasta la renovación de la póliza)' : ''}` });
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

/* GET /remuneraciones/seguro/nomina.xlsx?mes= — nómina del mes desde la vista viva (layout de la "Nómina de cotización") + costo por titular */
const nominaXlsx = async (req, res) => {
  try {
    const mes = req.query.mes;
    if (!mesOk(mes)) return fail(res, 'Mes inválido', 400);
    const c = await calcularMes(mes), T = c.titulares.filter(t => t.seguro_salud);
    if (!T.length) return fail(res, 'No hay nadie marcado en el seguro este mes', 400);
    const dmy = f => f ? iso(f).split('-').reverse().join('-') : '';
    const REL = { CONYUGE: 'CO', 'CONVIVIENTE CIVIL': 'CO', HIJO: 'HI', OTRO: 'OT' };
    const aoa1 = [['Nombre', 'Apellido Paterno', 'Apellido Materno', 'Fecha Nacimiento', 'Sexo', 'Relación', 'RUT', 'Titular', 'Paga']];
    const aoa2 = [['Titular', 'Cargas', 'Costo empresa', 'Descuento al empleado', 'Total']];
    let tc = 0, te = 0, td = 0;
    for (const t of T) {
      aoa1.push([t.nombres || t.nombre, t.apellido || '', t.apellido_materno || '', dmy(t.fecha_nacimiento), t.sexo || '', 'AS', t.rut || '', t.nombre, 'EMPRESA']);
      const cs = t.cargas.filter(k => k.incluida);
      for (const k of cs) aoa1.push([k.nombres, k.apellido_paterno || '', k.apellido_materno || '', dmy(k.fecha_nacimiento), k.sexo || '', REL[k.relacion] || k.relacion, k.rut || '', t.nombre, k.paga]);
      aoa2.push([t.nombre, cs.length, t.costo_empresa, t.costo_empleado, t.costo_empresa + t.costo_empleado]);
      tc += cs.length; te += t.costo_empresa; td += t.costo_empleado;
    }
    aoa2.push([], ['TOTAL', tc, te, td, te + td]);
    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet(aoa1); ws1['!cols'] = [{ wch: 24 }, { wch: 18 }, { wch: 18 }, { wch: 16 }, { wch: 6 }, { wch: 9 }, { wch: 13 }, { wch: 28 }, { wch: 10 }];
    const ws2 = XLSX.utils.aoa_to_sheet(aoa2); ws2['!cols'] = [{ wch: 30 }, { wch: 8 }, { wch: 15 }, { wch: 22 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, ws1, 'Nomina de cotizacion'); XLSX.utils.book_append_sheet(wb, ws2, 'Costo por titular');
    auditar({ req, accion: 'EXPORTAR', modulo: 'rrhh', entidad: 'seguro_nomina', detalle: `Descargó nómina seguro de salud ${mes} (${T.length} titulares, ${tc} cargas)` });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="nomina-seguro-salud-${mes}.xlsx"`);
    res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  } catch (e) { console.error('[seguro xlsx]', e.message); fail(res, 'Error interno del servidor'); }
};


/* ══════════ PAGO DEL MES: cupón de MetLife → cuadratura → nómina de cotización → avisos → ODP ══════════
   (Pato 17-09-2026) A MetLife no se le sube nómina: se BAJA el cupón de pago (y, si hace falta, la
   nómina de cotización). Antes de emitir la Orden de Pago se sube el cupón y se valida que cuadre con
   lo que el sistema espera (titulares + cargas × prima). Si no cuadra: alerta, se carga la nómina de
   cotización para ver quién quedó fuera (hijo < edad máx → alerta; entre edad máx y edad estudiante →
   pedir certificado; mayor → fuera por edad), se avisa al empleado con copia a RRHH, y RRHH puede dar
   su OK para no demorar el pago. La ODP se emite con el cupón y la nómina adjuntos.
   La nómina de cotización se sube SIEMPRE (aunque cuadre): una suma puede cuadrar por casualidad
   (uno que sobra y uno que falta se anulan) y sin la nómina nadie lo ve. */
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
const numCL = s => { const t = String(s || '').replace(/\$/g, '').replace(/\s/g, '').replace(/\./g, '').replace(',', '.'); const n = Number(t); return isNaN(n) ? null : n; };

async function pagoDe(mes) {
  const [[p]] = await pool.query('SELECT * FROM rh_seguro_pago WHERE mes=?', [mes]);
  if (!p) return null;
  const out = { ...p };
  for (const k of ['uf_cobro', 'uf_periodo', 'uf_ajustes', 'uf_total', 'total_clp', 'esperado_uf', 'esperado_clp', 'diferencia_uf']) out[k] = p[k] == null ? null : Number(p[k]);
  try { out.diff = p.diff_json ? JSON.parse(p.diff_json) : null; } catch (_) { out.diff = null; }
  delete out.diff_json;
  const [docs] = await pool.query("SELECT id, nombre, mime, subido_por, created_at FROM postventa_factura_docs WHERE origen='SEGURO' AND ref_id=? ORDER BY id", [p.id]);
  out.docs = docs;
  return out;
}

/* Lo que el sistema espera cobrar este mes (en UF de la prima): nómina generada si existe, si no la vista previa */
async function esperadoDe(mes) {
  const [gen] = await pool.query('SELECT prima_origen, moneda, id_carga FROM rh_seguro_nomina WHERE mes=?', [mes]);
  if (gen.length) return { uf: gen.reduce((s, r) => s + Number(r.prima_origen), 0), moneda: gen[0].moneda, titulares: gen.filter(r => !r.id_carga).length, cargas: gen.filter(r => r.id_carga).length, generada: true };
  const c = await calcularMes(mes), T = c.titulares.filter(t => t.seguro_salud);
  const cargas = T.reduce((s, t) => s + t.cargas.filter(k => k.incluida).length, 0);
  return { uf: T.length * c.param.prima_titular + cargas * c.param.prima_carga, moneda: c.param.moneda, titulares: T.length, cargas, generada: false };
}

/* Lee los totales del cupón de MetLife (PDF). Devuelve lo que encuentre; lo que no, queda null. */
async function leerCupon(buffer, mime) {
  const out = { mes: null, uf_periodo: null, uf_ajustes: null, uf_total: null, uf_cobro: null, total_clp: null };
  if (!/pdf/i.test(mime || '') && !(buffer.slice(0, 4).toString() === '%PDF')) return out;
  let text = '';
  try { text = (await require('pdf-parse')(buffer)).text || ''; } catch (_) { return out; }
  const t = text.replace(/\s+/g, ' ');
  const MES = { enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06', julio: '07', agosto: '08', septiembre: '09', setiembre: '09', octubre: '10', noviembre: '11', diciembre: '12' };
  const m = t.match(/Mes de Cobranza:\s*([a-záéíóú]+)-(\d{4})/i);
  if (m && MES[m[1].toLowerCase()]) out.mes = `${m[2]}-${MES[m[1].toLowerCase()]}`;
  const fila = re => { const x = t.match(re); return x ? x.slice(1).map(numCL) : null; };
  const per = fila(/Periodo Actual \(UF\)\s*(-?[\d.,]+)\s+(-?[\d.,]+)\s+(-?[\d.,]+)/i); if (per) out.uf_periodo = per[2];
  const aj = fila(/Periodos Anteriores \(UF\)\s*(-?[\d.,]+)\s+(-?[\d.,]+)\s+(-?[\d.,]+)/i); if (aj) out.uf_ajustes = aj[2];
  const tot = fila(/Total a Pagar Periodo \(UF\)\s*(-?[\d.,]+)\s+(-?[\d.,]+)\s+(-?[\d.,]+)/i); if (tot) out.uf_total = tot[2];
  const uf = t.match(/Valor UF Cobro\s*\$?\s*([\d.,]+)/i); if (uf) out.uf_cobro = numCL(uf[1]);
  const clp = t.match(/TOTAL PERIODO \(\$\)\s*\$?\s*([\d.,]+)/i); if (clp) out.total_clp = numCL(clp[1]);
  return out;
}

async function cuadrar(mes, uf_periodo, uf_cobro) {
  const p = await paramDe(mes), e = await esperadoDe(mes);
  const tol = Number(p.tolerancia_uf) || 0.05;
  const esperadoUF = e.moneda === 'UF' ? e.uf : (uf_cobro ? e.uf / uf_cobro : null);
  const dif = esperadoUF == null || uf_periodo == null ? null : Math.round((uf_periodo - esperadoUF) * 10000) / 10000;
  return { esperado_uf: esperadoUF, esperado_clp: esperadoUF != null && uf_cobro ? Math.round(esperadoUF * uf_cobro) : null, diferencia_uf: dif,
           cuadra: dif != null && Math.abs(dif) <= tol, tolerancia_uf: tol, titulares: e.titulares, cargas: e.cargas, generada: e.generada };
}

const e_titulares = pg => pg.diff ? (pg.diff.titulares_sistema ?? '') : '';
const e_cargas = pg => pg.diff ? (pg.diff.cargas_sistema ?? '') : '';

/* GET /remuneraciones/seguro/pago?mes= */
const getPago = async (req, res) => {
  try {
    const mes = mesOk(req.query.mes) ? req.query.mes : new Date().toISOString().slice(0, 7);
    const pago = await pagoDe(mes), e = await esperadoDe(mes), p = await paramDe(mes);
    ok(res, { mes, pago, esperado: e, tolerancia_uf: Number(p.tolerancia_uf) || 0.05, edad_max_hijo: p.edad_max_hijo, edad_max_estudiante: p.edad_max_estudiante });
  } catch (e) { console.error('[seguro pago get]', e.message); fail(res, 'Error interno del servidor'); }
};

/* POST /remuneraciones/seguro/cupon {mes, archivo_nombre, mime, archivo_data(base64), uf_periodo?, uf_ajustes?, uf_total?, uf_cobro?, total_clp?} */
const subirCupon = async (req, res) => {
  try {
    const b = req.body || {};
    if (!mesOk(b.mes)) return fail(res, 'Mes inválido', 400);
    const ya = await pagoDe(b.mes);
    if (ya && ya.estado === 'PAGO_EMITIDO') return fail(res, 'La orden de pago de este mes ya fue emitida', 400);
    let leido = {};
    let buffer = null;
    if (b.archivo_data) {
      buffer = Buffer.from(String(b.archivo_data), 'base64');
      if (buffer.length > 10 * 1024 * 1024) return fail(res, 'El cupón debe pesar máximo 10 MB', 400);
      leido = await leerCupon(buffer, b.mime);
      if (leido.mes && leido.mes !== b.mes) return fail(res, `El cupón es de ${leido.mes}, no de ${b.mes}`, 400);
    }
    const v = k => (b[k] !== undefined && b[k] !== null && b[k] !== '') ? Number(b[k]) : leido[k];
    const uf_periodo = v('uf_periodo'), uf_ajustes = v('uf_ajustes') ?? 0, uf_total = v('uf_total') ?? (uf_periodo != null ? Math.round((uf_periodo + uf_ajustes) * 100) / 100 : null), uf_cobro = v('uf_cobro'), total_clp = v('total_clp') ?? (uf_total != null && uf_cobro ? Math.round(uf_total * uf_cobro) : null);
    if (!(uf_periodo > 0) || !(uf_cobro > 0) || !(total_clp > 0)) return fail(res, 'No pude leer los totales del cupón: completa Prima del período (UF), Valor UF de cobro y Total $', 400);
    const c = await cuadrar(b.mes, uf_periodo, uf_cobro);
    const estado = c.cuadra ? 'CUADRA' : 'NO_CUADRA';
    const quien = nombreDe(req.usuario);
    await pool.query(`INSERT INTO rh_seguro_pago (mes, uf_periodo, uf_ajustes, uf_total, uf_cobro, total_clp, esperado_uf, esperado_clp, diferencia_uf, estado, actualizado_por, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW()) ON DUPLICATE KEY UPDATE uf_periodo=VALUES(uf_periodo), uf_ajustes=VALUES(uf_ajustes), uf_total=VALUES(uf_total), uf_cobro=VALUES(uf_cobro), total_clp=VALUES(total_clp),
        esperado_uf=VALUES(esperado_uf), esperado_clp=VALUES(esperado_clp), diferencia_uf=VALUES(diferencia_uf), estado=VALUES(estado), ok_por=NULL, ok_motivo=NULL, ok_at=NULL, actualizado_por=VALUES(actualizado_por), updated_at=NOW()`,
      [b.mes, uf_periodo, uf_ajustes, uf_total, uf_cobro, total_clp, c.esperado_uf, c.esperado_clp, c.diferencia_uf, estado, quien]);
    const pago = await pagoDe(b.mes);
    if (buffer) {
      const pv = require('../../../postventa/src/controllers/postventa.controller');
      await pv.guardarFacturaDoc({ origen: 'SEGURO', ref_id: pago.id, nombre: String(b.archivo_nombre || `cupon-${b.mes}.pdf`).slice(0, 200), mime: b.mime || 'application/pdf', buffer, usuario: quien });
    }
    if (!c.cuadra) {
      try { const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');
        const [rr] = await pool.query("SELECT u.id_usuario FROM usuarios u JOIN perfiles pf ON pf.id_perfil=u.id_perfil WHERE pf.nombre IN ('Consultora Recursos Humanos','Gerente de Finanzas') AND u.estado='activo'");
        await notificar(rr.map(x => x.id_usuario), { tipo: 'RRHH', prioridad: 'alta', sonar: true, titulo: `Seguro de salud ${b.mes}: el cupón NO cuadra`,
          mensaje: `MetLife cobra ${uf_periodo} UF y el sistema espera ${c.esperado_uf?.toFixed(4)} UF (${c.diferencia_uf > 0 ? '+' : ''}${c.diferencia_uf} UF). Carga la nómina de cotización para ver quién quedó fuera.`,
          href: '/recursos-humanos/remuneraciones/seguro-salud/', clave: `seguro_nocuadra_${b.mes}_${Date.now()}` }); } catch (_) {}
    }
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'seguro_pago', entidad_id: pago.id, detalle: `Cupón ${b.mes}: ${uf_periodo} UF período${uf_ajustes ? ` ${uf_ajustes > 0 ? '+' : ''}${uf_ajustes} UF ajustes` : ''} = ${uf_total} UF × $${uf_cobro} = ${CLP(total_clp)} · esperado ${c.esperado_uf?.toFixed(4)} UF → ${estado}${c.diferencia_uf != null ? ` (dif ${c.diferencia_uf} UF)` : ''}` });
    ok(res, { ...(await pagoDe(b.mes)), cuadratura: c, leido });
  } catch (e) { console.error('[seguro cupon]', e.message); fail(res, 'Error interno del servidor'); }
};

/* POST /remuneraciones/seguro/cotizacion {mes, archivo_nombre, mime, archivo_data} — nómina de cotización bajada de MetLife (xlsx) */
const subirCotizacion = async (req, res) => {
  try {
    const b = req.body || {};
    if (!mesOk(b.mes) || !b.archivo_data) return fail(res, 'Mes y archivo requeridos', 400);
    const pago = await pagoDe(b.mes);
    if (!pago) return fail(res, 'Sube primero el cupón de pago del mes', 400);
    const buffer = Buffer.from(String(b.archivo_data), 'base64');
    let wb; try { wb = XLSX.read(buffer, { type: 'buffer', raw: false }); } catch (_) { return fail(res, 'No pude leer el Excel', 400); }
    // Busca la hoja/fila de encabezados: Nombre | Apellido Paterno | Apellido Materno | Fecha Nacimiento | Sexo | Relación | Estado
    let filas = [];
    for (const n of wb.SheetNames) {
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false });
      const h = aoa.findIndex(r => r && r.some(c => /apellido paterno/i.test(String(c))) && r.some(c => /nombre/i.test(String(c))));
      if (h < 0) continue;
      const hdr = aoa[h].map(c => norm(c));
      const ix = k => hdr.findIndex(c => c.includes(k));
      const iN = ix('NOMBRE'), iP = ix('APELLIDO PATERNO'), iM = ix('APELLIDO MATERNO'), iF = ix('NACIMIENTO'), iR = ix('RELACION'), iE = ix('ESTADO'), iRut = hdr.findIndex(c => c === 'RUT' || c.includes('RUT ASEG'));
      for (const r of aoa.slice(h + 1)) {
        if (!r || !r[iN] || !r[iP]) continue;
        filas.push({ nombres: String(r[iN]).trim(), apellido_paterno: String(r[iP]).trim(), apellido_materno: iM >= 0 ? String(r[iM] || '').trim() : '', nacimiento: iF >= 0 ? String(r[iF] || '').trim() : '',
                     relacion: iR >= 0 ? String(r[iR] || '').trim().toUpperCase() : '', estado: iE >= 0 ? String(r[iE] || '').trim().toUpperCase() : '', rut: iRut >= 0 ? String(r[iRut] || '').replace(/[^0-9kK]/g, '').toUpperCase() : '' });
      }
      if (filas.length) break;
    }
    if (!filas.length) return fail(res, 'El archivo no trae la nómina de cotización (Nombre / Apellido Paterno / Apellido Materno / Fecha Nacimiento / Relación)', 400);
    const vig = filas.filter(f => !f.estado || /VIGENTE/.test(f.estado));
    /* Cruce por nombre (la nómina de cotización no trae RUT): primer nombre + apellido, tolerando
       una letra de diferencia (Irribara/Irribarra, Katherin/Katherine) y apellidos invertidos
       (Bernardo "Pinto Ponce"). Uno a uno: cada fila de la aseguradora se usa una sola vez. */
    const lev1 = (x, y) => { if (x === y) return true; if (Math.abs(x.length - y.length) > 1) return false; let i = 0, j = 0, d = 0;
      while (i < x.length && j < y.length) { if (x[i] === y[j]) { i++; j++; continue; } if (++d > 1) return false; if (x.length > y.length) i++; else if (y.length > x.length) j++; else { i++; j++; } }
      return d + (x.length - i) + (y.length - j) <= 1; };
    const primer = n => norm(n).split(' ')[0] || '';
    const disponibles = vig.slice();
    const tomar = (nombres, pat, mat) => {
      const n1 = primer(nombres), P = norm(pat), M = norm(mat);
      const ix = disponibles.findIndex(f => { const fn = primer(f.nombres), fp = norm(f.apellido_paterno), fm = norm(f.apellido_materno);
        if (!lev1(n1, fn) && !(n1.length >= 5 && fn.startsWith(n1.slice(0, 5)))) return false;
        return lev1(P, fp) || (M && lev1(M, fp)) || (fm && lev1(P, fm)); });
      return ix >= 0 ? disponibles.splice(ix, 1)[0] : null;
    };
    // Lo que el sistema espera
    const c = await calcularMes(b.mes), p = c.param, ini = b.mes + '-01';
    const edadEst = Number(p.edad_max_estudiante) || 27;
    const fuera = [];
    for (const t of c.titulares.filter(x => x.seguro_salud)) {
      const hit = tomar(t.nombres, t.apellido, t.apellido_materno);
      if (!hit) fuera.push({ id_usuario: t.id_usuario, titular: t.nombre, nombre: t.nombre, relacion: 'TITULAR', edad: edadAl(t.fecha_nacimiento, ini), accion: 'ALERTA', motivo: 'Titular sin inscribir en la aseguradora' });
      for (const k of t.cargas.filter(x => x.incluida)) {
        if (tomar(k.nombres, k.apellido_paterno, k.apellido_materno)) continue;
        let accion = 'ALERTA', motivo = 'Carga fuera de la nómina de la aseguradora';
        if (k.relacion === 'HIJO' && k.edad != null) {
          if (k.edad > edadEst) { accion = 'FUERA_EDAD'; motivo = `Hijo de ${k.edad} años: supera la edad máxima incluso como estudiante (${edadEst})`; }
          else if (k.edad > p.edad_max_hijo) { accion = 'PEDIR_CERTIFICADO'; motivo = `Hijo de ${k.edad} años: la aseguradora exige certificado de estudios (${p.edad_max_hijo + 1} a ${edadEst} años)`; }
          else motivo = `Hijo de ${k.edad} años, menor de ${p.edad_max_hijo + 1}: no debería estar fuera — revisar inscripción`;
        }
        fuera.push({ id_usuario: t.id_usuario, id_carga: k.id, titular: t.nombre, nombre: k.nombre, relacion: k.relacion, edad: k.edad, accion, motivo });
      }
    }
    const sobran = disponibles.map(f => ({ nombre: `${f.nombres} ${f.apellido_paterno} ${f.apellido_materno}`.trim(), relacion: f.relacion || '', nacimiento: f.nacimiento }));
    const T = c.titulares.filter(x => x.seguro_salud);
    const diff = { fecha: iso(new Date()), en_metlife: vig.length, titulares_sistema: T.length, cargas_sistema: T.reduce((s2, t) => s2 + t.cargas.filter(k => k.incluida).length, 0), fuera, sobran, prima_fuera_uf: fuera.reduce((s, f) => s + (f.relacion === 'TITULAR' ? p.prima_titular : p.prima_carga), 0) };
    await pool.query('UPDATE rh_seguro_pago SET diff_json=?, actualizado_por=?, updated_at=NOW() WHERE id=?', [JSON.stringify(diff), nombreDe(req.usuario), pago.id]);
    const pv = require('../../../postventa/src/controllers/postventa.controller');
    await pv.guardarFacturaDoc({ origen: 'SEGURO', ref_id: pago.id, nombre: String(b.archivo_nombre || `nomina-cotizacion-${b.mes}.xlsx`).slice(0, 200), mime: b.mime || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer, usuario: nombreDe(req.usuario) });
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'seguro_pago', entidad_id: pago.id, detalle: `Nómina de cotización ${b.mes}: ${vig.length} en la aseguradora · ${fuera.length} del sistema fuera (${fuera.map(f => f.nombre + ' [' + f.accion + ']').join(', ') || '—'}) · ${sobran.length} en la aseguradora que el sistema no tiene` });
    ok(res, await pagoDe(b.mes));
  } catch (e) { console.error('[seguro cotizacion]', e.message); fail(res, 'Error interno del servidor'); }
};

/* POST /remuneraciones/seguro/avisos {mes} — correo a cada empleado con su familia fuera del seguro, copia RRHH */
const enviarAvisos = async (req, res) => {
  try {
    const mes = req.body?.mes; if (!mesOk(mes)) return fail(res, 'Mes inválido', 400);
    const pago = await pagoDe(mes);
    if (!pago?.diff) return fail(res, 'Carga primero la nómina de cotización', 400);
    const cargasFuera = pago.diff.fuera.filter(f => f.relacion !== 'TITULAR');
    if (!cargasFuera.length) return fail(res, 'No hay cargas fuera que avisar', 400);
    const plant = require('../../../../shared/plantillas-correo');
    const p = await paramDe(mes);
    const porEmp = {}; for (const f of cargasFuera) (porEmp[f.id_usuario] = porEmp[f.id_usuario] || []).push(f);
    const enviados = [], fallidos = [];
    for (const [idU, lista] of Object.entries(porEmp)) {
      const [[u]] = await pool.query('SELECT TRIM(CONCAT_WS(" ", u.nombre, u.apellido)) nombre, u.email, f.email_personal FROM usuarios u LEFT JOIN rh_fichas f ON f.id_usuario=u.id_usuario WHERE u.id_usuario=?', [idU]);
      if (!u) continue;
      const to = (u.email_personal || u.email || '').trim();
      const detalle = lista.map(f => ` • ${f.nombre} (${f.relacion.toLowerCase()}${f.edad != null ? ', ' + f.edad + ' años' : ''}): ${f.accion === 'PEDIR_CERTIFICADO' ? 'la aseguradora exige certificado de estudios vigente para mantenerlo(a); envíalo a RRHH' : f.accion === 'FUERA_EDAD' ? 'supera la edad máxima de la póliza' : 'quedó fuera de la nómina de la aseguradora; RRHH lo está revisando'}`).join('\n');
      const r = to ? await plant.enviar({ codigo: 'seguro_carga_fuera_aviso', to: [to], datos: { NOMBRE: u.nombre, MES: mes, ASEGURADORA: p.aseguradora || 'METLIFE', DETALLE: detalle } }) : { enviado: false, motivo: 'sin correo' };
      (r.enviado ? enviados : fallidos).push(`${u.nombre} (${to || 'sin correo'}${r.enviado ? '' : ': ' + r.motivo})`);
    }
    await pool.query('UPDATE rh_seguro_pago SET avisos_at=NOW(), updated_at=NOW() WHERE id=?', [pago.id]);
    auditar({ req, accion: 'ENVIAR', modulo: 'rrhh', entidad: 'seguro_pago', entidad_id: pago.id, detalle: `Avisos de familia fuera del seguro ${mes}: enviados a ${enviados.join(', ') || '—'}${fallidos.length ? ' · fallidos: ' + fallidos.join(', ') : ''}` });
    ok(res, { enviados, fallidos });
  } catch (e) { console.error('[seguro avisos]', e.message); fail(res, 'Error interno del servidor'); }
};

/* POST /remuneraciones/seguro/ok-rrhh {mes, motivo} — RRHH autoriza pagar aunque no cuadre */
const okRRHH = async (req, res) => {
  try {
    const mes = req.body?.mes, motivo = String(req.body?.motivo || '').trim().slice(0, 300);
    if (!mesOk(mes)) return fail(res, 'Mes inválido', 400);
    if (motivo.length < 5) return fail(res, 'Indica el motivo del OK', 400);
    const pago = await pagoDe(mes);
    if (!pago) return fail(res, 'Sube primero el cupón', 400);
    if (pago.estado === 'PAGO_EMITIDO') return fail(res, 'La orden ya fue emitida', 400);
    await pool.query("UPDATE rh_seguro_pago SET estado='OK_RRHH', ok_por=?, ok_motivo=?, ok_at=NOW(), updated_at=NOW() WHERE id=?", [nombreDe(req.usuario), motivo, pago.id]);
    auditar({ req, accion: 'APROBAR', modulo: 'rrhh', entidad: 'seguro_pago', entidad_id: pago.id, detalle: `OK de RRHH para pagar el seguro ${mes} sin cuadrar (dif ${pago.diferencia_uf} UF): ${motivo}` });
    ok(res, await pagoDe(mes));
  } catch (e) { console.error('[seguro ok]', e.message); fail(res, 'Error interno del servidor'); }
};

/* POST /remuneraciones/seguro/emitir-odp {mes} — ODP a la aseguradora por el total del cupón, con cupón y nómina adjuntos */
const emitirOdp = async (req, res) => {
  try {
    const mes = req.body?.mes; if (!mesOk(mes)) return fail(res, 'Mes inválido', 400);
    const pago = await pagoDe(mes);
    if (!pago) return fail(res, 'Sube primero el cupón', 400);
    if (pago.estado === 'PAGO_EMITIDO') return fail(res, `La orden ${pago.odp_numero} ya fue emitida`, 400);
    if (!pago.diff) return fail(res, 'Falta la nómina de cotización de la aseguradora: se sube siempre junto con el cupón (Pato 17-09-2026)', 400);
    if (!['CUADRA', 'OK_RRHH'].includes(pago.estado)) return fail(res, 'El cupón no cuadra: revisa quién quedó fuera y pide el OK de RRHH, o corrige la nómina', 400);
    const p = await paramDe(mes), pol = await polizaVigente();
    const aseg = p.aseguradora || 'METLIFE';
    let [[prov]] = await pool.query('SELECT id, nombre, rut FROM proveedores WHERE UPPER(nombre) LIKE ? ORDER BY activo DESC, id LIMIT 1', ['%' + aseg + '%']);
    if (!prov) { const [np] = await pool.query('INSERT INTO proveedores (nombre, activo, comentario) VALUES (?,1,?)', [aseg, 'Aseguradora del seguro complementario de salud (creado desde Remuneraciones → Seguro de Salud)']); prov = { id: np.insertId, nombre: aseg, rut: null }; }
    const { calcularDoc, } = require('../../../ordenes-pago/src/controllers/ordenes-pago.controller');
    const m = await calcularDoc('Otros', 'EXENTO', pago.total_clp);
    const u = req.usuario || {}, hoy = iso(new Date());
    const mesTxt = `${['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'][Number(mes.slice(5))]} ${mes.slice(0, 4)}`;
    const concepto = `Seguro complementario de salud ${mesTxt} — ${aseg} póliza ${pol.numero || ''}`.trim();
    const obs = `Generada desde Remuneraciones → Seguro de Salud. Cupón de pago ${mes}: ${pago.uf_periodo} UF período${pago.uf_ajustes ? ` ${pago.uf_ajustes > 0 ? '+' : ''}${pago.uf_ajustes} UF ajustes de períodos anteriores` : ''} = ${pago.uf_total} UF × UF $${Number(pago.uf_cobro).toLocaleString('es-CL')} = ${CLP(pago.total_clp)}.\n` +
      `Cuadratura: sistema espera ${Number(pago.esperado_uf).toFixed(4)} UF (${pago.esperado_clp != null ? CLP(pago.esperado_clp) : '—'}) → ${pago.estado === 'CUADRA' ? 'CUADRA' : `NO cuadra (dif ${pago.diferencia_uf} UF), OK de RRHH: ${pago.ok_por} — ${pago.ok_motivo}`}.`;
    const [r] = await pool.query(
      `INSERT INTO ordenes_pago (id_proveedor, proveedor_nombre, proveedor_rut, concepto, categoria, tipo_documento, tratamiento, monto_bruto, monto_neto, impuesto_pct, impuesto_monto, monto, destino, fecha_emision, fecha_documento, metodo_pago, estado, observaciones, id_usuario, usuario_nombre)
       VALUES (?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,'Transferencia','EMITIDA',?,?,?)`,
      [prov.id, prov.nombre, prov.rut || null, concepto, 'Otros', 'Otros', m.clase, m.bruto, m.neto, m.pct, m.imp, m.aPagar, 'Cupón de pago (convenio Banco de Chile / Servipag)', hoy, hoy, obs, u.id_usuario || null, nombreDe(u) || 'Sistema']);
    const { emitirCorrelativo } = require('../../../../shared/ordenes-pago');
    const { numero } = await emitirCorrelativo({ origen: 'GENERAL', origen_id: r.insertId, concepto, monto: m.aPagar, id_usuario: u.id_usuario || null, usuario_nombre: nombreDe(u) || 'Sistema' });
    await pool.query('UPDATE ordenes_pago SET numero=? WHERE id=?', [numero, r.insertId]);
    // Adjuntos: cupón y nómina de cotización → a la ODP (copia del almacén) y al correo
    const adjuntos = [];
    try {
      const alm = require('../../../../shared/almacen-docs');
      const pv = require('../../../postventa/src/controllers/postventa.controller');
      const [docs] = await pool.query("SELECT * FROM postventa_factura_docs WHERE origen='SEGURO' AND ref_id=?", [pago.id]);
      for (const d of docs) { const buf = await alm.obtener({ ruta: d.doc_ruta, blob: d.archivo }); if (buf) { await pv.guardarFacturaDoc({ origen: 'ODP', ref_id: r.insertId, nombre: d.nombre, mime: d.mime, buffer: buf, usuario: nombreDe(u) }); adjuntos.push({ filename: d.nombre, content: buf, contentType: d.mime || undefined }); } }
    } catch (e) { console.error('[seguro odp adjuntos]', e.message); }
    await pool.query("UPDATE rh_seguro_pago SET estado='PAGO_EMITIDO', odp_id=?, odp_numero=?, updated_at=NOW() WHERE id=?", [r.insertId, numero, pago.id]);
    // Descuentos de cargas a costo del empleado: nacen con el pago del mes (un descuento por empleado, una cuota)
    let nDesc = 0, totDesc = 0;
    try {
      const cm = await calcularMes(mes);
      await pool.query("UPDATE rh_descuentos SET estado='ANULADO', anulado_por='Sistema (reemisión seguro)', anulado_at=NOW() WHERE seguro_mes=? AND estado='VIGENTE'", [mes]);
      for (const t of cm.titulares.filter(x => x.seguro_salud && x.costo_empleado > 0)) {
        const n = t.cargas.filter(k => k.incluida && k.paga === 'EMPLEADO').length;
        await pool.query(`INSERT INTO rh_descuentos (id_usuario, tipo, detalle_texto, monto_total, cuotas, valor_cuota, mes_inicio, creado_por, moneda, seguro_mes)
          VALUES (?,'VARIOS',?,?,1,?,?,?,'CLP',?)`, [t.id_usuario, `Seguro complementario de salud — ${n} carga${n === 1 ? '' : 's'} (${prov.nombre})`, t.costo_empleado, t.costo_empleado, mes, nombreDe(u), mes]);
        nDesc++; totDesc += t.costo_empleado;
      }
    } catch (e3) { console.error('[seguro odp descuentos]', e3.message); }
    // Correo a Contabilidad con copia a RRHH y a quien emitió (Pato 17-09-2026)
    let correo = { enviado: false, motivo: 'no intentado' };
    try {
      const plant = require('../../../../shared/plantillas-correo');
      const { destinatariosContabilidad } = require('../../../../shared/correo-contabilidad');
      const ctb = await destinatariosContabilidad(u.email);
      const base = process.env.APP_URL || 'https://afbs.autofacilchile.cl';
      correo = await plant.enviar({ codigo: 'seguro_odp_contabilidad', to: [ctb.to], cc: ctb.cc || [], adjuntos, datos: {
        ODP: numero, MES: mesTxt, ASEGURADORA: prov.nombre, POLIZA: pol.numero || '—', MONTO: CLP(pago.total_clp),
        UF_PERIODO: Number(pago.uf_periodo).toLocaleString('es-CL', { minimumFractionDigits: 2 }), AJUSTES: pago.uf_ajustes ? ` ${pago.uf_ajustes > 0 ? '+' : ''}${Number(pago.uf_ajustes).toLocaleString('es-CL', { minimumFractionDigits: 2 })} UF de ajustes de períodos anteriores` : '',
        UF_TOTAL: Number(pago.uf_total).toLocaleString('es-CL', { minimumFractionDigits: 2 }), UF_COBRO: '$' + Number(pago.uf_cobro).toLocaleString('es-CL', { minimumFractionDigits: 2 }),
        TITULARES: e_titulares(pago), CARGAS: e_cargas(pago), CUADRATURA: pago.estado === 'CUADRA' ? 'cuadra' : `NO cuadra (diferencia ${pago.diferencia_uf} UF) — OK de RRHH: ${pago.ok_por}, ${pago.ok_motivo}`,
        QUIEN: nombreDe(u) || 'Sistema', LINK: base + '/ordenes-pago/historial/' } });
    } catch (e2) { correo = { enviado: false, motivo: e2.message }; }
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'seguro_pago', entidad_id: pago.id, detalle: `Emitió ${numero} a ${prov.nombre} por ${CLP(pago.total_clp)} — seguro de salud ${mes}${nDesc ? ` · ${nDesc} descuento(s) a empleados por ${CLP(totDesc)}` : ''} · correo a Contabilidad ${correo.enviado ? 'enviado a ' + (correo.to || []).join(', ') + (correo.cc?.length ? ' cc ' + correo.cc.join(', ') : '') : 'NO enviado: ' + correo.motivo}` });
    ok(res, { odp_id: r.insertId, odp_numero: numero, correo });
  } catch (e) { console.error('[seguro odp]', e.message); fail(res, 'Error interno del servidor'); }
};

/* ── Correos del seguro: a quién se envían (destinatarios por perfil + copia + interruptor), desde la card ──
   El texto se edita en Correos del Sistema; acá solo lo que cambia si cambia la compañía. */
const CORREOS_SEGURO = ['seguro_inscribir_aviso', 'seguro_certificado_aviso', 'seguro_carga_fuera_aviso', 'seguro_odp_contabilidad'];
const getCorreos = async (req, res) => {
  try {
    const [pl] = await pool.query('SELECT codigo, nombre, descripcion, destinatario, para_perfiles, cc, activo FROM correos_plantillas WHERE codigo IN (?) ORDER BY FIELD(codigo, ?, ?, ?, ?)', [CORREOS_SEGURO, ...CORREOS_SEGURO]);
    const [perfiles] = await pool.query('SELECT nombre FROM perfiles ORDER BY nombre');
    ok(res, { plantillas: pl, perfiles: perfiles.map(x => x.nombre) });
  } catch (e) { console.error('[seguro correos]', e.message); fail(res, 'Error interno del servidor'); }
};
const putCorreo = async (req, res) => {
  try {
    const codigo = String(req.params.codigo || '');
    if (!CORREOS_SEGURO.includes(codigo)) return fail(res, 'Correo no pertenece al seguro', 400);
    const b = req.body || {};
    const perfiles = String(b.para_perfiles || '').split(',').map(x => x.trim()).filter(Boolean).join(',');
    const cc = String(b.cc || '').split(/[,;]/).map(x => x.trim().toLowerCase()).filter(x => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(x)).join(', ');
    const activo = b.activo === false || b.activo === 0 ? 0 : 1;
    const [[prev]] = await pool.query('SELECT para_perfiles, cc, activo FROM correos_plantillas WHERE codigo=?', [codigo]);
    if (!prev) return fail(res, 'Plantilla no encontrada', 404);
    await pool.query('UPDATE correos_plantillas SET para_perfiles=?, cc=?, activo=? WHERE codigo=?', [perfiles, cc, activo, codigo]);
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'correo_plantilla', entidad_id: codigo, detalle: `Seguro de Salud → correo ${codigo}: perfiles "${prev.para_perfiles}" → "${perfiles}" · copia "${prev.cc}" → "${cc}" · ${activo ? 'activo' : 'DESACTIVADO'}` });
    ok(res, { codigo });
  } catch (e) { console.error('[seguro correo put]', e.message); fail(res, 'Error interno del servidor'); }
};

/* ── Motor: hijo asegurado por cumplir la edad máxima → pedir el certificado UN MES ANTES ──
   Al colaborador (correo personal, si no el corporativo) con copia a RRHH + campana a RRHH.
   Una vez por hijo y por póliza: certificado_aviso_at anterior a la vigencia actual se considera
   de la póliza pasada y vuelve a pedirse. */
async function avisarCertificados() {
  try {
    const hoy = new Date(), hoyISO = iso(hoy), mes = hoyISO.slice(0, 7);
    const p = await paramDe(mes), pol = await polizaVigente();
    const edadMax = Number(p.edad_max_hijo) || 23, edadEst = Number(p.edad_max_estudiante) || 27;
    if (edadMax + 1 > edadEst) return;
    const diasAntes = Number(p.certificado_dias_antes) || 30, plazo = Number(p.certificado_plazo_dias) ?? 5;
    const lim = new Date(hoy); lim.setDate(lim.getDate() + diasAntes + 1); const limISO = iso(lim);
    const desdePol = pol.vigencia_desde || '1900-01-01';
    const [hijos] = await pool.query(
      `SELECT c.*, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) titular, u.email, f.email_personal
         FROM rh_cargas c JOIN usuarios u ON u.id_usuario=c.id_usuario JOIN rh_fichas f ON f.id_usuario=c.id_usuario
        WHERE c.activo=1 AND c.en_seguro=1 AND c.relacion='HIJO' AND c.fecha_nacimiento IS NOT NULL AND f.seguro_salud=1 AND u.estado='activo'
          AND (c.certificado_aviso_at IS NULL OR c.certificado_aviso_at < ?)`, [desdePol]);
    if (!hijos.length) return;
    const plant = require('../../../../shared/plantillas-correo');
    const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');
    const [rrhh] = await pool.query("SELECT u.id_usuario FROM usuarios u JOIN perfiles pf ON pf.id_perfil=u.id_perfil WHERE pf.nombre='Consultora Recursos Humanos' AND u.estado='activo'");
    const dmy = f => String(f).split('-').reverse().join('-');
    for (const h of hijos) {
      const nac = new Date(iso(h.fecha_nacimiento) + 'T12:00:00');
      const cumple = new Date(nac.getFullYear() + edadMax + 1, nac.getMonth(), nac.getDate(), 12);   // día en que cumple edadMax+1
      const cumpleISO = iso(cumple);
      if (cumpleISO < hoyISO || cumpleISO > limISO) continue;                     // solo dentro del próximo mes
      // Ya tiene certificado enviado para esta póliza → nada que pedir
      if (h.certificado_estudios && h.certificado_enviado_at && iso(h.certificado_enviado_at) >= desdePol) continue;
      const to = (h.email_personal || h.email || '').trim();
      const nombreCarga = [h.nombres, h.apellido_paterno, h.apellido_materno].filter(Boolean).join(' ');
      const limiteISO = iso(new Date(cumple.getFullYear(), cumple.getMonth(), cumple.getDate() - plazo, 12));
      const r = to ? await plant.enviar({ codigo: 'seguro_certificado_aviso', to: [to], datos: { NOMBRE: h.titular, CARGA: nombreCarga, EDAD: edadMax + 1, FECHA_CUMPLE: dmy(cumpleISO), FECHA_LIMITE: dmy(limiteISO), ASEGURADORA: p.aseguradora || 'METLIFE', POLIZA_HASTA: pol.vigencia_hasta ? dmy(pol.vigencia_hasta) : '—' } }) : { enviado: false, motivo: 'sin correo' };
      await notificar(rrhh.map(x => x.id_usuario), { tipo: 'RRHH', prioridad: 'media', sonar: false, titulo: `Certificado de estudios: ${nombreCarga}`,
        mensaje: `Hijo(a) de ${h.titular} cumple ${edadMax + 1} años el ${dmy(cumpleISO)}. Se le pidió el certificado al colaborador${r.enviado ? '' : ' (correo NO enviado: ' + r.motivo + ')'}; al recibirlo, márcalo en la carga con la fecha de envío a la aseguradora.`,
        href: '/recursos-humanos/remuneraciones/seguro-salud/', clave: `seguro_cert_${h.id}_${desdePol}` }).catch(() => {});
      await pool.query('UPDATE rh_cargas SET certificado_aviso_at=? WHERE id=?', [hoyISO, h.id]);
      auditar({ req: null, accion: 'ENVIAR', modulo: 'rrhh', entidad: 'carga', entidad_id: h.id, detalle: `Pidió certificado de estudios de ${nombreCarga} (cumple ${edadMax + 1} el ${dmy(cumpleISO)}) a ${h.titular} — correo ${r.enviado ? 'enviado a ' + to : 'NO enviado: ' + r.motivo}, copia RRHH` });
    }
  } catch (e) { console.error('[seguro certificados]', e.message); }
}
require('../../../../shared/scheduler').programar('seguro-certificado-aviso', avisarCertificados, 24 * 60 * 60 * 1000);

/* ── Motor: contrato que pasa a INDEFINIDO → titular + aviso a RRHH (copia Contabilidad) ── */
async function avisarInscripcion() {
  try {
    const [gente] = await pool.query(
      `SELECT u.id_usuario, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) nombre, TRIM(CONCAT_WS(' ', u.nombre, u.apellido, u.apellido_materno)) nombre_completo, u.rut, u.email
         FROM usuarios u JOIN rh_fichas f ON f.id_usuario=u.id_usuario
        WHERE u.estado='activo' AND f.tipo_contrato='INDEFINIDO' AND f.seguro_aviso_at IS NULL AND COALESCE(f.sueldo_base,0) > 0`);
    if (!gente.length) return;
    const plant = require('../../../../shared/plantillas-correo');
    const { destinatariosContabilidad } = require('../../../../shared/correo-contabilidad');
    const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');
    const hoy = iso(new Date()), mes = hoy.slice(0, 7), p = await paramDe(mes), pol = await polizaVigente();
    const mesTxt = `${['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'][Number(mes.slice(5))]} ${mes.slice(0, 4)}`;
    const base = process.env.APP_URL || 'https://afbs.autofacilchile.cl';
    const [rrhh] = await pool.query("SELECT u.id_usuario FROM usuarios u JOIN perfiles pf ON pf.id_perfil=u.id_perfil WHERE pf.nombre='Consultora Recursos Humanos' AND u.estado='activo'");
    for (const g of gente) {
      await pool.query('UPDATE rh_fichas SET seguro_salud=1, seguro_aviso_at=NOW() WHERE id_usuario=?', [g.id_usuario]);
      const ctb = await destinatariosContabilidad();
      const r = await plant.enviar({ codigo: 'seguro_inscribir_aviso', cc: [ctb.to, ...(ctb.cc || [])],
        datos: { NOMBRE: g.nombre, NOMBRE_COMPLETO: g.nombre_completo, RUT: g.rut || '—', FECHA: hoy.split('-').reverse().join('-'), MES: mesTxt,
                 ASEGURADORA: p.aseguradora || 'METLIFE', POLIZA: pol.numero || '—', LINK: base + '/recursos-humanos/remuneraciones/seguro-salud/' } });
      await notificar(rrhh.map(x => x.id_usuario), { tipo: 'RRHH', prioridad: 'alta', sonar: true, titulo: `Inscribir en el seguro: ${g.nombre}`,
        mensaje: `Pasó a contrato INDEFINIDO: inscribirlo(a) en el seguro complementario (${p.aseguradora || 'METLIFE'}). Ya quedó como titular en la nómina.`,
        href: '/recursos-humanos/remuneraciones/seguro-salud/', clave: `seguro_inscribir_${g.id_usuario}` }).catch(() => {});
      auditar({ req: null, accion: 'CREAR', modulo: 'rrhh', entidad: 'seguro_titular', entidad_id: g.id_usuario,
        detalle: `${g.nombre} pasó a INDEFINIDO: marcado titular del seguro de salud y aviso a RRHH (copia Contabilidad) — correo ${r.enviado ? 'enviado a ' + (r.to || []).join(', ') : 'NO enviado: ' + r.motivo}` });
    }
  } catch (e) { console.error('[seguro inscribir]', e.message); }
}
require('../../../../shared/scheduler').programar('seguro-inscribir-aviso', avisarInscripcion, 60 * 60 * 1000);

module.exports = { avisarInscripcion, avisarCertificados, getCorreos, putCorreo, getPago, subirCupon, subirCotizacion, enviarAvisos, okRRHH, emitirOdp, getMes, putParam, putPoliza, putTitular, guardarCarga, seleccionCarga, bajaCarga, generar, anular, nominaXlsx, calcularMes };
