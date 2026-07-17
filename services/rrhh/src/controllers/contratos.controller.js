'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   CONTRATOS Y CARTAS OFERTA (RRHH) — plan anti-Buk #2
   · Cargos: catálogo con DESCRIPCIÓN DE CARGO. Se puede crear sin descripción,
     pero el sistema ALEGA a diario (campana) a quien creó el cargo y a RRHH
     hasta que la cargue.
   · Carta Oferta: candidato + cargo + sueldo + BENEFICIOS por checkbox
     (catálogo paramétrico rh_beneficios + "otros" libres). Se imprime/envía.
   · Contrato: nace DESDE la carta aceptada — los beneficios ofertados entran
     como cláusulas automáticamente (una sola fuente: lo ofertado = lo contratado).
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });
const CLP = n => '$' + Number(n || 0).toLocaleString('es-CL');

/* ── Migración + seeds ──────────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('rrhh-contratos', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_cargos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nombre VARCHAR(120) NOT NULL UNIQUE,
    descripcion MEDIUMTEXT NULL,
    activo TINYINT(1) DEFAULT 1,
    creado_por INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_beneficios (
    id INT AUTO_INCREMENT PRIMARY KEY,
    codigo VARCHAR(40) NOT NULL UNIQUE,
    titulo VARCHAR(120) NOT NULL,
    clausula TEXT NOT NULL,
    monto_default INT NULL,
    unidad VARCHAR(20) NULL,
    activo TINYINT(1) DEFAULT 1,
    orden INT DEFAULT 0
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_cartas_oferta (
    id INT AUTO_INCREMENT PRIMARY KEY,
    candidato VARCHAR(160) NOT NULL,
    rut VARCHAR(15) NULL,
    email VARCHAR(160) NULL,
    id_cargo INT NOT NULL,
    sueldo_base INT NOT NULL,
    fecha_ingreso DATE NULL,
    tipo_contrato VARCHAR(20) DEFAULT 'INDEFINIDO',
    jornada VARCHAR(20) DEFAULT 'COMPLETA',
    beneficios JSON NULL,
    otros TEXT NULL,
    vigencia_dias INT DEFAULT 7,
    estado VARCHAR(15) DEFAULT 'BORRADOR',
    creado_por INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_estado (estado)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_contratos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_carta INT NULL,
    id_usuario INT NULL,
    trabajador VARCHAR(160) NOT NULL,
    rut VARCHAR(15) NULL,
    id_cargo INT NOT NULL,
    sueldo_base INT NOT NULL,
    fecha_ingreso DATE NULL,
    tipo_contrato VARCHAR(20) DEFAULT 'INDEFINIDO',
    jornada VARCHAR(20) DEFAULT 'COMPLETA',
    beneficios JSON NULL,
    otros TEXT NULL,
    estado VARCHAR(15) DEFAULT 'BORRADOR',
    creado_por INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Seed de cargos desde los cargos ya usados en usuarios (sin descripción → el sistema alegará)
  await pool.query(`INSERT IGNORE INTO rh_cargos (nombre)
    SELECT DISTINCT UPPER(TRIM(cargo)) FROM usuarios WHERE cargo IS NOT NULL AND TRIM(cargo)<>'' AND estado='activo'`);

  // Catálogo de beneficios (editable en la misma página; INSERT IGNORE = no pisa cambios)
  const B = [
    ['edenred', 'Tarjeta de Alimentación Edenred', 'Tarjeta de Alimentación Edenred por un monto de {monto} diarios por día efectivamente trabajado.', 3600, 'diarios'],
    ['seguro_salud', 'Seguro de salud complementario', 'Seguro de salud complementario para el trabajador, con la posibilidad de incorporar a sus cargas familiares a precio preferente.', null, null],
    ['bono_telefono', 'Bono uso de teléfono personal', 'Bono compensatorio por uso de teléfono personal de {monto} mensuales.', 10000, 'mensuales'],
    ['jornada_40', 'Jornada de 40 horas semanales', 'Jornada ordinaria de trabajo de 40 horas semanales, distribuidas de lunes a viernes.', null, null],
    ['art_22', 'Artículo 22 (sin límite de jornada)', 'El trabajador quedará excluido de la limitación de jornada de trabajo, conforme al artículo 22 inciso 2° del Código del Trabajo.', null, null],
    ['estacionamiento', 'Estacionamiento', 'Estacionamiento disponible en las dependencias de la empresa, sin costo para el trabajador.', null, null],
    ['bono_movilizacion', 'Bono de movilización', 'Bono de movilización de {monto} mensuales.', 30000, 'mensuales'],
    ['bono_gasolina', 'Bono de gasolina', 'Bono de gasolina de {monto} mensuales, asociado al desempeño de funciones en terreno.', 50000, 'mensuales'],
    ['bono_colacion', 'Bono de colación', 'Bono de colación de {monto} mensuales.', 40000, 'mensuales'],
    ['bono_18', 'Bono de Fiestas Patrias', 'Bono de Fiestas Patrias de {monto}, pagadero en septiembre de cada año.', 100000, 'anual'],
    ['bono_navidad', 'Aguinaldo de Navidad', 'Aguinaldo de Navidad de {monto}, pagadero en diciembre de cada año.', 100000, 'anual'],
    ['bono_vacaciones', 'Bono de vacaciones', 'Bono de vacaciones de {monto}, pagadero al momento de hacer uso del feriado legal anual.', 100000, 'anual'],
    ['indemnizacion_te', 'Indemnización a todo evento', 'Indemnización por años de servicio a todo evento, conforme al artículo 164 y siguientes del Código del Trabajo.', null, null],
    ['dia_cumple', 'Día libre de cumpleaños', 'Medio día o día libre en la fecha de cumpleaños del trabajador, a convenir con su jefatura.', null, null],
    ['teletrabajo', 'Días de teletrabajo', 'Modalidad híbrida con días de teletrabajo a la semana, a convenir con la jefatura directa.', null, null],
    ['capacitacion', 'Capacitación anual', 'Acceso a un programa de capacitación anual financiado por la empresa, según plan de desarrollo.', null, null],
    ['credito_pref', 'Crédito automotriz preferente', 'Acceso a condiciones preferentes en créditos automotrices de la empresa, según política interna vigente.', null, null],
  ];
  let i = 0;
  for (const [codigo, titulo, clausula, monto, unidad] of B)
    await pool.query(`INSERT IGNORE INTO rh_beneficios (codigo, titulo, clausula, monto_default, unidad, orden) VALUES (?,?,?,?,?,?)`,
      [codigo, titulo, clausula, monto, unidad, i++]);

  // Card en RRHH (todos los perfiles que gestionan personas: gate por rh_colaboradores en rutas)
  const [[modRRHH]] = await pool.query(`SELECT id_modulo FROM modulos WHERE ruta='/recursos-humanos/' LIMIT 1`);
  if (modRRHH) {
    const [[f]] = await pool.query(`SELECT id_funcionalidad FROM funcionalidades WHERE codigo='rh_contratos' LIMIT 1`);
    if (!f) {
      const [r] = await pool.query(`INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
        VALUES (?, 'Contratos y Cartas Oferta', 'rh_contratos', '/recursos-humanos/contratos/', 'bi-file-earmark-text')`, [modRRHH.id_modulo]);
      // mismos perfiles que ya gestionan colaboradores
      await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
        SELECT pp.id_perfil, ?, 1 FROM permisos_perfil pp JOIN funcionalidades f2 ON f2.id_funcionalidad=pp.id_funcionalidad
        WHERE f2.codigo='rh_colaboradores' AND pp.habilitado=1`, [r.insertId]);
      await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1, ?, 1)`, [r.insertId]);
    }
  }
  console.log('[rrhh-contratos] listo');
});

/* ── El ALEGATO: cargos sin descripción → campana SEMANAL a RRHH y al creador ── */
const _w = d => { const t = new Date(d); t.setHours(0,0,0,0); t.setDate(t.getDate()+3-((t.getDay()+6)%7)); const w1 = new Date(t.getFullYear(),0,4); return t.getFullYear()+'-S'+String(1+Math.round(((t-w1)/86400000-3+((w1.getDay()+6)%7))/7)).padStart(2,'0'); };
async function alegarCargosSinDescripcion() {
  try {
    const [cargos] = await pool.query(
      `SELECT id, nombre, creado_por FROM rh_cargos WHERE activo=1 AND (descripcion IS NULL OR TRIM(descripcion)='')`);
    if (!cargos.length) return;
    // destinatarios: quienes tienen rh_colaboradores + los creadores de cargos pendientes
    const [dest] = await pool.query(
      `SELECT DISTINCT u.id_usuario FROM usuarios u
        JOIN permisos_perfil pp ON pp.id_perfil=u.id_perfil AND pp.habilitado=1
        JOIN funcionalidades f ON f.id_funcionalidad=pp.id_funcionalidad
       WHERE f.codigo='rh_colaboradores' AND u.estado='activo'`);
    const ids = new Set(dest.map(d => d.id_usuario));
    cargos.forEach(c => { if (c.creado_por) ids.add(c.creado_por); });
    // la clave NO deduplica en notificar(): chequear aquí para no repetir en la semana
    const _clave = 'cargos_sin_descripcion_' + _w(new Date());
    const [[_ya]] = await pool.query('SELECT 1 ok FROM notificaciones WHERE clave=? LIMIT 1', [_clave]);
    if (_ya) return;
    const nombres = cargos.map(c => c.nombre).slice(0, 5).join(', ') + (cargos.length > 5 ? '…' : '');
    await notificar([...ids], {
      tipo: 'RRHH', prioridad: 'alta', sonar: true,
      titulo: `${cargos.length} cargo(s) sin descripción de cargo`,
      mensaje: `Falta la descripción de: ${nombres}. Sin descripción no se pueden generar cartas oferta ni contratos prolijos. Cárgala en Contratos → Cargos.`,
      href: '/recursos-humanos/contratos/',
      clave: _clave,   // 1 vez por semana
    });
  } catch (e) { console.error('[alegato cargos]', e.message); }
}
setTimeout(alegarCargosSinDescripcion, 120 * 1000);
setInterval(alegarCargosSinDescripcion, 24 * 60 * 60 * 1000);

/* ── Cargos ─────────────────────────────────────────────────────────────────── */
exports.getCargos = async (req, res) => {
  try {
    const [cargos] = await pool.query(`SELECT * FROM rh_cargos WHERE activo=1 ORDER BY nombre`);
    ok(res, { cargos, sin_descripcion: cargos.filter(c => !String(c.descripcion || '').trim()).length });
  } catch (e) { fail(res, e.message); }
};

exports.guardarCargo = async (req, res) => {
  try {
    const { id, nombre, descripcion } = req.body || {};
    const nom = String(nombre || '').trim().toUpperCase().slice(0, 120);
    if (!nom) return fail(res, 'Falta el nombre del cargo', 400);
    const desc = String(descripcion || '').trim() || null;
    if (parseInt(id)) {
      await pool.query(`UPDATE rh_cargos SET nombre=?, descripcion=? WHERE id=?`, [nom, desc, parseInt(id)]);
      ok(res, { id: parseInt(id), alerta: !desc });
    } else {
      const [r] = await pool.query(`INSERT INTO rh_cargos (nombre, descripcion, creado_por) VALUES (?,?,?)`,
        [nom, desc, req.usuario.id_usuario]);
      if (!desc) alegarCargosSinDescripcion();   // alegato inmediato + diario
      auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'rh_cargo', entidad_id: r.insertId, detalle: `Cargo ${nom}${desc ? '' : ' SIN DESCRIPCIÓN'}` });
      ok(res, { id: r.insertId, alerta: !desc });
    }
  } catch (e) { fail(res, e.code === 'ER_DUP_ENTRY' ? 'Ese cargo ya existe' : e.message); }
};

exports.eliminarCargo = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [[uso]] = await pool.query(`SELECT (SELECT COUNT(*) FROM rh_cartas_oferta WHERE id_cargo=?) + (SELECT COUNT(*) FROM rh_contratos WHERE id_cargo=?) n`, [id, id]);
    if (uso.n) return fail(res, 'El cargo tiene cartas o contratos asociados — desactívalo editándolo, no se puede eliminar', 409);
    await pool.query(`UPDATE rh_cargos SET activo=0 WHERE id=?`, [id]);
    ok(res, { id });
  } catch (e) { fail(res, e.message); }
};

/* ── Beneficios (catálogo paramétrico) ──────────────────────────────────────── */
exports.getBeneficios = async (req, res) => {
  try {
    const [b] = await pool.query(`SELECT * FROM rh_beneficios WHERE activo=1 ORDER BY orden, id`);
    ok(res, { beneficios: b });
  } catch (e) { fail(res, e.message); }
};

exports.guardarBeneficio = async (req, res) => {
  try {
    const { id, titulo, clausula, monto_default, unidad } = req.body || {};
    if (!String(titulo || '').trim() || !String(clausula || '').trim()) return fail(res, 'Faltan título o cláusula', 400);
    if (parseInt(id)) {
      await pool.query(`UPDATE rh_beneficios SET titulo=?, clausula=?, monto_default=?, unidad=? WHERE id=?`,
        [titulo.slice(0, 120), clausula.slice(0, 2000), parseInt(monto_default) || null, String(unidad || '').slice(0, 20) || null, parseInt(id)]);
      ok(res, { id: parseInt(id) });
    } else {
      const codigo = 'b_' + Date.now().toString(36);
      const [r] = await pool.query(`INSERT INTO rh_beneficios (codigo, titulo, clausula, monto_default, unidad, orden) VALUES (?,?,?,?,?,99)`,
        [codigo, titulo.slice(0, 120), clausula.slice(0, 2000), parseInt(monto_default) || null, String(unidad || '').slice(0, 20) || null]);
      ok(res, { id: r.insertId });
    }
  } catch (e) { fail(res, e.message); }
};

/* ── Cartas Oferta ──────────────────────────────────────────────────────────── */
exports.getCartas = async (req, res) => {
  try {
    const [cartas] = await pool.query(
      `SELECT co.*, c.nombre cargo, c.descripcion cargo_desc FROM rh_cartas_oferta co JOIN rh_cargos c ON c.id=co.id_cargo
        ORDER BY co.id DESC LIMIT 200`);
    ok(res, { cartas });
  } catch (e) { fail(res, e.message); }
};

exports.guardarCarta = async (req, res) => {
  try {
    const b = req.body || {};
    const idCargo = parseInt(b.id_cargo);
    if (!String(b.candidato || '').trim()) return fail(res, 'Falta el nombre del candidato', 400);
    if (!idCargo) return fail(res, 'Selecciona el cargo', 400);
    if (!(parseInt(b.sueldo_base) > 0)) return fail(res, 'Falta el sueldo base', 400);
    const [[cargo]] = await pool.query(`SELECT descripcion FROM rh_cargos WHERE id=?`, [idCargo]);
    const beneficios = (Array.isArray(b.beneficios) ? b.beneficios : []).map(x => ({
      codigo: String(x.codigo || ''), titulo: String(x.titulo || '').slice(0, 120),
      clausula: String(x.clausula || '').slice(0, 2000), monto: parseInt(x.monto) || null,
    })).filter(x => x.titulo);
    const vals = [String(b.candidato).trim().slice(0, 160), String(b.rut || '').slice(0, 15) || null,
      String(b.email || '').slice(0, 160) || null, idCargo, parseInt(b.sueldo_base),
      b.fecha_ingreso || null, String(b.tipo_contrato || 'INDEFINIDO').slice(0, 20),
      String(b.jornada || 'COMPLETA').slice(0, 20), JSON.stringify(beneficios),
      String(b.otros || '').slice(0, 3000) || null, Math.max(1, parseInt(b.vigencia_dias) || 7)];
    let id = parseInt(b.id) || 0;
    if (id) {
      const [[c]] = await pool.query(`SELECT estado FROM rh_cartas_oferta WHERE id=?`, [id]);
      if (!c || c.estado !== 'BORRADOR') return fail(res, 'Solo se editan cartas en BORRADOR', 409);
      await pool.query(`UPDATE rh_cartas_oferta SET candidato=?, rut=?, email=?, id_cargo=?, sueldo_base=?, fecha_ingreso=?,
        tipo_contrato=?, jornada=?, beneficios=?, otros=?, vigencia_dias=? WHERE id=?`, [...vals, id]);
    } else {
      const [r] = await pool.query(`INSERT INTO rh_cartas_oferta (candidato, rut, email, id_cargo, sueldo_base, fecha_ingreso,
        tipo_contrato, jornada, beneficios, otros, vigencia_dias, creado_por) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [...vals, req.usuario.id_usuario]);
      id = r.insertId;
    }
    ok(res, { id, aviso_cargo: cargo && !String(cargo.descripcion || '').trim() ? 'El cargo NO tiene descripción de cargo cargada — complétala en la pestaña Cargos' : null });
  } catch (e) { fail(res, e.message); }
};

exports.cambiarEstadoCarta = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const estado = String(req.body?.estado || '');
    if (!['EMITIDA', 'ACEPTADA', 'RECHAZADA', 'ANULADA'].includes(estado)) return fail(res, 'Estado inválido', 400);
    await pool.query(`UPDATE rh_cartas_oferta SET estado=? WHERE id=?`, [estado, id]);
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'rh_carta_oferta', entidad_id: id, detalle: `Carta oferta → ${estado}` });
    ok(res, { id, estado });
  } catch (e) { fail(res, e.message); }
};

/* ── Contrato: nace de la carta ACEPTADA (lo ofertado = lo contratado) ──────── */
exports.contratarDesdeCarta = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [[c]] = await pool.query(`SELECT * FROM rh_cartas_oferta WHERE id=?`, [id]);
    if (!c) return fail(res, 'Carta no existe', 404);
    if (c.estado !== 'ACEPTADA') return fail(res, 'La carta debe estar ACEPTADA para generar el contrato', 409);
    const [[ya]] = await pool.query(`SELECT id FROM rh_contratos WHERE id_carta=?`, [id]);
    if (ya) return fail(res, `Ya existe el contrato #${ya.id} para esta carta`, 409);
    const [r] = await pool.query(`INSERT INTO rh_contratos (id_carta, trabajador, rut, id_cargo, sueldo_base, fecha_ingreso,
      tipo_contrato, jornada, beneficios, otros, creado_por)
      SELECT id, candidato, rut, id_cargo, sueldo_base, fecha_ingreso, tipo_contrato, jornada, beneficios, otros, ?
        FROM rh_cartas_oferta WHERE id=?`, [req.usuario.id_usuario, id]);
    await pool.query(`UPDATE rh_cartas_oferta SET estado='CONTRATADA' WHERE id=?`, [id]);
    // Onboarding automático desde la fecha de ingreso (o hoy)
    try { await crearProceso({ tipo: 'ONBOARDING', persona: c.candidato, rut: c.rut, id_ref: r.insertId,
      fecha_base: c.fecha_ingreso ? String(c.fecha_ingreso).slice(0, 10) : new Date().toISOString().slice(0, 10),
      creado_por: req.usuario.id_usuario }); } catch (e) { console.error('[onb auto]', e.message); }
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'rh_contrato', entidad_id: r.insertId, detalle: `Contrato desde carta oferta #${id} (${c.candidato})` });
    ok(res, { id: r.insertId });
  } catch (e) { fail(res, e.message); }
};

exports.getContratos = async (req, res) => {
  try {
    const [contratos] = await pool.query(
      `SELECT ct.*, c.nombre cargo, c.descripcion cargo_desc FROM rh_contratos ct JOIN rh_cargos c ON c.id=ct.id_cargo
        ORDER BY ct.id DESC LIMIT 200`);
    ok(res, { contratos });
  } catch (e) { fail(res, e.message); }
};

/* ─────────────────────────────────────────────────────────────────────────────
   FINIQUITOS (anti-Buk #3) — cálculo sobre los motores existentes:
   · Base = última remuneración imponible (promedio 3 últimas EMITIDAS si hay
     variables), topada a 90 UF (art. 172 CT) — la propuesta es de fórmula y
     RRHH la puede ajustar antes de guardar (filosofía campos forzados).
   · Indemnización años de servicio: 1 mes por año, fracción ≥6 meses = 1 año,
     tope paramétrico (default 11) — solo si la causal la lleva.
   · Mes de aviso: si la causal lo lleva y NO se avisó con 30 días.
   · Feriado proporcional: devengado − usado (misma matemática del módulo
     Vacaciones), en días corridos (hábiles × 1,4), valor día = base/30.
   ───────────────────────────────────────────────────────────────────────────── */
const { getUF } = require('../../../../shared/uf');

require('../../../../shared/migrate').enFila('rrhh-finiquitos', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_finiquito_causales (
    id INT AUTO_INCREMENT PRIMARY KEY,
    articulo VARCHAR(20) NOT NULL UNIQUE,
    glosa VARCHAR(200) NOT NULL,
    indemniza_anos TINYINT(1) DEFAULT 0,
    mes_aviso TINYINT(1) DEFAULT 0,
    activo TINYINT(1) DEFAULT 1
  )`);
  const C = [
    ['159-1', 'Mutuo acuerdo de las partes', 0, 0],
    ['159-2', 'Renuncia voluntaria del trabajador', 0, 0],
    ['159-4', 'Vencimiento del plazo convenido', 0, 0],
    ['159-5', 'Conclusión del trabajo o servicio', 0, 0],
    ['159-6', 'Caso fortuito o fuerza mayor', 0, 0],
    ['160', 'Caducidad (art. 160: causales imputables al trabajador)', 0, 0],
    ['161-1', 'Necesidades de la empresa', 1, 1],
    ['161-2', 'Desahucio escrito del empleador', 1, 1],
  ];
  for (const c of C) await pool.query(`INSERT IGNORE INTO rh_finiquito_causales (articulo, glosa, indemniza_anos, mes_aviso) VALUES (?,?,?,?)`, c);
  await pool.query(`INSERT IGNORE INTO rh_config (clave, valor) VALUES ('finiq_tope_anos', '11'), ('finiq_tope_uf', '90')`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_finiquitos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_usuario INT NOT NULL,
    trabajador VARCHAR(160), rut VARCHAR(15), cargo VARCHAR(120),
    fecha_ingreso DATE NULL, fecha_termino DATE NOT NULL,
    causal VARCHAR(20) NOT NULL, causal_glosa VARCHAR(200),
    detalle JSON NULL, total BIGINT DEFAULT 0,
    estado VARCHAR(15) DEFAULT 'BORRADOR',
    creado_por INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  console.log('[rrhh-finiquitos] listo');
});

exports.finiquitoColaboradores = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id_usuario, CONCAT_WS(' ', u.nombre, u.apellido) nombre, u.rut, u.cargo,
              DATE_FORMAT(u.fecha_ingreso,'%Y-%m-%d') fecha_ingreso, f.sueldo_base
         FROM usuarios u LEFT JOIN rh_fichas f ON f.id_usuario=u.id_usuario
        WHERE u.estado='activo' AND COALESCE(f.no_mostrar,0)=0 ORDER BY u.apellido, u.nombre`);
    const [causales] = await pool.query(`SELECT * FROM rh_finiquito_causales WHERE activo=1 ORDER BY articulo`);
    ok(res, { colaboradores: rows, causales });
  } catch (e) { fail(res, e.message); }
};

exports.finiquitoCalcular = async (req, res) => {
  try {
    const idU = parseInt(req.query.id_usuario);
    const causal = String(req.query.causal || '');
    const fechaT = String(req.query.fecha_termino || '').slice(0, 10);
    const avisado = String(req.query.avisado || '') === '1';
    if (!idU || !/^\d{4}-\d{2}-\d{2}$/.test(fechaT)) return fail(res, 'Faltan colaborador o fecha de término', 400);
    const [[cau]] = await pool.query(`SELECT * FROM rh_finiquito_causales WHERE articulo=?`, [causal]);
    if (!cau) return fail(res, 'Causal inválida', 400);
    const [[u]] = await pool.query(
      `SELECT u.id_usuario, CONCAT_WS(' ', u.nombre, u.apellido) nombre, u.rut, u.cargo,
              DATE_FORMAT(u.fecha_ingreso,'%Y-%m-%d') fecha_ingreso, f.sueldo_base
         FROM usuarios u LEFT JOIN rh_fichas f ON f.id_usuario=u.id_usuario WHERE u.id_usuario=?`, [idU]);
    if (!u) return fail(res, 'Colaborador no existe', 404);
    const avisos = [];

    // MOTOR ÚNICO base-remuneracion.js (el mismo de la provisión de Vacaciones):
    // promedio 3 últimas liquidaciones EMITIDAS o sueldo base ×1,25
    const [liqs] = await pool.query(
      `SELECT 1 FROM rh_liquidaciones WHERE id_usuario=? AND estado='EMITIDA' LIMIT 3`, [idU]);
    const base = await require('../base-remuneracion').remuneracionBase(idU);
    if (liqs.length > 1) avisos.push(`Base = promedio de las últimas ${liqs.length} liquidaciones emitidas (rentas variables).`);
    else if (!liqs.length) avisos.push('Sin liquidaciones emitidas: base estimada = sueldo base + 25% de gratificación. Revísala y ajústala.');
    const [[cfgA]] = await pool.query("SELECT valor FROM rh_config WHERE clave='finiq_tope_anos'");
    const [[cfgU]] = await pool.query("SELECT valor FROM rh_config WHERE clave='finiq_tope_uf'");
    const topeAnos = parseInt(cfgA?.valor) || 11, topeUFn = parseFloat(cfgU?.valor) || 90;
    const uf = (await getUF(fechaT)) || (await getUF(new Date().toISOString().slice(0, 10))) || 0;
    const topeUF = Math.round(topeUFn * uf);
    const baseTopada = Math.min(base, topeUF || base);
    if (topeUF && base > topeUF) avisos.push(`Base ${CLP(base)} supera el tope de ${topeUFn} UF (${CLP(topeUF)}) — se indemniza con el tope (art. 172).`);

    let anos = 0, meses = 0;
    if (u.fecha_ingreso) {
      // MOTOR ÚNICO rrhh-core.mesesAntiguedad (mismo del certificado de antigüedad)
      meses = require('../../../../api-gateway/public/js/rrhh-core').mesesAntiguedad(u.fecha_ingreso, fechaT);
      anos = Math.floor(meses / 12) + ((meses % 12) >= 6 ? 1 : 0);
      if (anos > topeAnos) { avisos.push(`${anos} años de servicio — se aplica el tope de ${topeAnos} años.`); anos = topeAnos; }
    } else avisos.push('Sin fecha de ingreso registrada: años de servicio en 0. Corrige la ficha del colaborador.');

    const indemAnos = cau.indemniza_anos ? anos * baseTopada : 0;
    const mesAviso = cau.mes_aviso && !avisado ? baseTopada : 0;

    // MOTOR ÚNICO: la misma cuenta corriente de vacaciones que usa el formulario
    let vacHabiles = 0;
    if (u.fecha_ingreso) {
      const s = await require('./vac-cuenta.controller').saldoCuenta(idU, fechaT);
      vacHabiles = Math.max(0, s.disponibles);
    }
    const vacCorridos = Math.round(vacHabiles * 1.4 * 10) / 10;
    // MOTOR ÚNICO rrhh-core.provisionVacaciones (misma fórmula de la cartola de Vacaciones)
    const vacMonto = require('../../../../api-gateway/public/js/rrhh-core').provisionVacaciones(vacHabiles, base);

    // Saldo pendiente de anticipos/préstamos: se descuenta del finiquito
    // (cláusula del convenio firmado). Cuotas cobradas = meses transcurridos
    // desde mes_inicio hasta el mes del término, tope el total de cuotas.
    const [descs] = await pool.query(
      `SELECT id, tipo, cuotas, valor_cuota, mes_inicio FROM rh_descuentos
        WHERE id_usuario=? AND estado='VIGENTE' AND tipo IN ('ANTICIPO','PRESTAMO','PAGO_EXCESO')`, [idU]);
    const mesFin = fechaT.slice(0, 7);
    const difM = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));
    let saldoPrestamos = 0;
    const prestamosDetalle = [];
    for (const d of descs) {
      const cobradas = Math.max(0, Math.min(Number(d.cuotas), difM(d.mes_inicio, mesFin) + 1));
      const saldo = Math.max(0, (Number(d.cuotas) - cobradas) * Number(d.valor_cuota));
      if (saldo > 0) { saldoPrestamos += saldo; prestamosDetalle.push({ id: d.id, tipo: d.tipo, saldo, cuotas_pendientes: Number(d.cuotas) - cobradas }); }
    }
    if (saldoPrestamos > 0)
      avisos.push(`Tiene ${prestamosDetalle.length} anticipo/préstamo vigente con saldo pendiente de ${CLP(saldoPrestamos)} (${prestamosDetalle.map(p => p.tipo + ' #' + p.id + ': ' + CLP(p.saldo)).join(', ')}) — precargado en Descuentos según el convenio firmado.`);

    ok(res, {
      descuentos_prestamos: saldoPrestamos, prestamos_detalle: prestamosDetalle,
      colaborador: u, causal: cau, uf, base, base_topada: baseTopada,
      anos_servicio: anos, meses_servicio: meses,
      indemnizacion_anos: indemAnos, mes_aviso: mesAviso,
      vac_dias_habiles: vacHabiles, vac_dias_corridos: vacCorridos, vac_monto: vacMonto,
      total: indemAnos + mesAviso + vacMonto,
      avisos,
    });
  } catch (e) { console.error('[finiquito calc]', e.message); fail(res, e.message); }
};

exports.finiquitoGuardar = async (req, res) => {
  try {
    const b = req.body || {};
    const idU = parseInt(b.id_usuario);
    if (!idU || !b.fecha_termino || !b.causal) return fail(res, 'Faltan datos', 400);
    const detalle = b.detalle || {};
    const total = ['indemnizacion_anos', 'mes_aviso', 'vac_monto', 'otros_haberes'].reduce((s, k) => s + (parseInt(detalle[k]) || 0), 0)
      - (parseInt(detalle.descuentos) || 0);
    const [r] = await pool.query(
      `INSERT INTO rh_finiquitos (id_usuario, trabajador, rut, cargo, fecha_ingreso, fecha_termino, causal, causal_glosa, detalle, total, creado_por)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [idU, String(b.trabajador || '').slice(0, 160), String(b.rut || '').slice(0, 15), String(b.cargo || '').slice(0, 120),
       b.fecha_ingreso || null, b.fecha_termino, String(b.causal).slice(0, 20), String(b.causal_glosa || '').slice(0, 200),
       JSON.stringify(detalle), total, req.usuario.id_usuario]);
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'rh_finiquito', entidad_id: r.insertId,
      detalle: `Finiquito ${b.trabajador} (${b.causal}) total ${CLP(total)}` });
    // Contabilización automática: gasto finiquito → finiquitos por pagar
    if (total > 0) {
      try {
        await require('../../../contabilidad/src/motor-asientos').contabilizar({
          evento: 'FINIQUITO_EMITIDO', fecha: b.fecha_termino,
          glosa: `Finiquito ${b.trabajador} (art. ${b.causal})`, ref: `FINIQ-${r.insertId}`,
          montos: { total },
        });
      } catch (e) { console.error('[finiquito asiento]', e.message); }
    }
    // Offboarding automático desde la fecha de término
    try { await crearProceso({ tipo: 'OFFBOARDING', persona: b.trabajador, rut: b.rut, id_usuario: idU,
      id_ref: r.insertId, fecha_base: b.fecha_termino, creado_por: req.usuario.id_usuario }); } catch (e) { console.error('[offb auto]', e.message); }
    ok(res, { id: r.insertId, total });
  } catch (e) { fail(res, e.message); }
};

exports.finiquitoLista = async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM rh_finiquitos ORDER BY id DESC LIMIT 100`);
    ok(res, { finiquitos: rows });
  } catch (e) { fail(res, e.message); }
};

/* ─────────────────────────────────────────────────────────────────────────────
   ONBOARDING / OFFBOARDING (anti-Buk #4) — checklist automático del ciclo:
   · Al CONTRATAR (contrato desde carta aceptada) se crea el proceso ONBOARDING
     con las tareas de la plantilla paramétrica (responsable + plazo en días
     desde el ingreso).
   · Al GUARDAR un finiquito se crea el OFFBOARDING (plazos desde el término).
   · Recordatorio semanal por campana a RRHH con las tareas vencidas.
   ───────────────────────────────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('rrhh-onboarding', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_onb_plantilla (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tipo VARCHAR(12) NOT NULL,
    orden INT DEFAULT 0,
    tarea VARCHAR(250) NOT NULL,
    responsable VARCHAR(80) NULL,
    dias_plazo INT DEFAULT 0,
    activo TINYINT(1) DEFAULT 1
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_onb_procesos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tipo VARCHAR(12) NOT NULL,
    persona VARCHAR(160) NOT NULL,
    rut VARCHAR(15) NULL,
    id_usuario INT NULL,
    id_ref INT NULL,
    fecha_base DATE NOT NULL,
    estado VARCHAR(12) DEFAULT 'ABIERTO',
    creado_por INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_onb_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_proceso INT NOT NULL,
    orden INT DEFAULT 0,
    tarea VARCHAR(250) NOT NULL,
    responsable VARCHAR(80) NULL,
    fecha_limite DATE NULL,
    ok TINYINT(1) DEFAULT 0,
    ok_por VARCHAR(160) NULL,
    ok_at DATETIME NULL,
    INDEX idx_proc (id_proceso)
  )`);
  const [[n]] = await pool.query('SELECT COUNT(*) n FROM rh_onb_plantilla');
  if (!n.n) {
    const ON = [
      ['Contrato firmado y archivado en la carpeta digital', 'RRHH', 0],
      ['Usuario creado en el Business Suite con su perfil', 'Administrador', 0],
      ['Correo corporativo creado', 'TI', 0],
      ['Presentación del nuevo integrante en Facilbook', 'RRHH', 1],
      ['Alta en Workera (reloj control)', 'RRHH', 2],
      ['Tarjeta Edenred solicitada', 'RRHH', 3],
      ['Credencial corporativa con foto', 'RRHH', 3],
      ['Ficha completa: AFP, salud, cargas, datos Previred (campos *)', 'RRHH', 5],
      ['Inducción: jugar ¿Qué Dice AutoFácil? con la jefatura', 'Jefatura', 7],
      ['Reunión de feedback primera semana', 'Jefatura', 7],
    ];
    const OFF = [
      ['Notificación de la causal / carta de aviso entregada', 'RRHH', 0],
      ['Devolución de equipos, llaves y credencial', 'TI', 0],
      ['Usuario del Suite suspendido', 'Administrador', 0],
      ['Baja en Workera y Edenred', 'RRHH', 1],
      ['Finiquito calculado, firmado y ratificado', 'RRHH', 10],
      ['Finiquito pagado', 'Tesorería', 10],
      ['Convenios de préstamo saldados en el finiquito', 'RRHH', 10],
      ['Carpeta digital archivada (contrato, anexos, finiquito)', 'RRHH', 15],
    ];
    let i = 0;
    for (const [t, r, d] of ON) await pool.query('INSERT INTO rh_onb_plantilla (tipo, orden, tarea, responsable, dias_plazo) VALUES (?,?,?,?,?)', ['ONBOARDING', i++, t, r, d]);
    i = 0;
    for (const [t, r, d] of OFF) await pool.query('INSERT INTO rh_onb_plantilla (tipo, orden, tarea, responsable, dias_plazo) VALUES (?,?,?,?,?)', ['OFFBOARDING', i++, t, r, d]);
    console.log('✓ onboarding: plantillas sembradas');
  }
});

async function crearProceso({ tipo, persona, rut, id_usuario, id_ref, fecha_base, creado_por }) {
  if (id_ref) {
    const [[ya]] = await pool.query('SELECT id FROM rh_onb_procesos WHERE tipo=? AND id_ref=?', [tipo, id_ref]);
    if (ya) return ya.id;
  }
  const [r] = await pool.query(
    `INSERT INTO rh_onb_procesos (tipo, persona, rut, id_usuario, id_ref, fecha_base, creado_por) VALUES (?,?,?,?,?,?,?)`,
    [tipo, persona, rut || null, id_usuario || null, id_ref || null, fecha_base, creado_por || null]);
  const [plan] = await pool.query('SELECT * FROM rh_onb_plantilla WHERE tipo=? AND activo=1 ORDER BY orden', [tipo]);
  for (const p of plan) {
    const fl = new Date(fecha_base + 'T12:00:00'); fl.setDate(fl.getDate() + (Number(p.dias_plazo) || 0));
    await pool.query('INSERT INTO rh_onb_items (id_proceso, orden, tarea, responsable, fecha_limite) VALUES (?,?,?,?,?)',
      [r.insertId, p.orden, p.tarea, p.responsable, fl.toISOString().slice(0, 10)]);
  }
  return r.insertId;
}
exports._crearProcesoOnb = crearProceso;

exports.onbLista = async (req, res) => {
  try {
    const [procesos] = await pool.query(`SELECT * FROM rh_onb_procesos ORDER BY estado='ABIERTO' DESC, id DESC LIMIT 100`);
    const ids = procesos.map(p => p.id);
    const [items] = ids.length ? await pool.query(`SELECT * FROM rh_onb_items WHERE id_proceso IN (?) ORDER BY orden`, [ids]) : [[]];
    const hoy = new Date().toISOString().slice(0, 10);
    ok(res, { procesos: procesos.map(p => ({
      ...p,
      items: items.filter(i => i.id_proceso === p.id).map(i => ({ ...i, vencido: !i.ok && i.fecha_limite && String(i.fecha_limite).slice(0, 10) < hoy })),
    })) });
  } catch (e) { fail(res, e.message); }
};

exports.onbCrearManual = async (req, res) => {
  try {
    const b = req.body || {};
    if (!String(b.persona || '').trim() || !b.fecha_base || !['ONBOARDING', 'OFFBOARDING'].includes(b.tipo))
      return fail(res, 'Faltan persona, tipo o fecha', 400);
    const id = await crearProceso({ tipo: b.tipo, persona: String(b.persona).trim().slice(0, 160), rut: b.rut,
      id_usuario: parseInt(b.id_usuario) || null, id_ref: null, fecha_base: b.fecha_base, creado_por: req.usuario.id_usuario });
    ok(res, { id });
  } catch (e) { fail(res, e.message); }
};

exports.onbMarcar = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const okFlag = req.body?.ok !== false;
    await pool.query('UPDATE rh_onb_items SET ok=?, ok_por=?, ok_at=? WHERE id=?',
      [okFlag ? 1 : 0, okFlag ? `${req.usuario.nombre || ''} ${req.usuario.apellido || ''}`.trim() : null, okFlag ? new Date() : null, id]);
    const [[it]] = await pool.query('SELECT id_proceso FROM rh_onb_items WHERE id=?', [id]);
    const [[pend]] = await pool.query('SELECT COUNT(*) n FROM rh_onb_items WHERE id_proceso=? AND ok=0', [it.id_proceso]);
    await pool.query('UPDATE rh_onb_procesos SET estado=? WHERE id=?', [pend.n ? 'ABIERTO' : 'CERRADO', it.id_proceso]);
    ok(res, { ok: okFlag, cerrado: !pend.n });
  } catch (e) { fail(res, e.message); }
};

exports.onbPlantilla = async (req, res) => {
  try {
    const [items] = await pool.query('SELECT * FROM rh_onb_plantilla WHERE activo=1 ORDER BY tipo, orden');
    ok(res, { plantilla: items });
  } catch (e) { fail(res, e.message); }
};

exports.onbPlantillaGuardar = async (req, res) => {
  try {
    const b = req.body || {};
    if (parseInt(b.id)) {
      if (b.eliminar) await pool.query('UPDATE rh_onb_plantilla SET activo=0 WHERE id=?', [parseInt(b.id)]);
      else await pool.query('UPDATE rh_onb_plantilla SET tarea=?, responsable=?, dias_plazo=?, orden=? WHERE id=?',
        [String(b.tarea || '').slice(0, 250), String(b.responsable || '').slice(0, 80), parseInt(b.dias_plazo) || 0, parseInt(b.orden) || 0, parseInt(b.id)]);
    } else {
      if (!String(b.tarea || '').trim()) return fail(res, 'Falta la tarea', 400);
      await pool.query('INSERT INTO rh_onb_plantilla (tipo, orden, tarea, responsable, dias_plazo) VALUES (?,?,?,?,?)',
        [b.tipo === 'OFFBOARDING' ? 'OFFBOARDING' : 'ONBOARDING', parseInt(b.orden) || 99, String(b.tarea).slice(0, 250), String(b.responsable || '').slice(0, 80), parseInt(b.dias_plazo) || 0]);
    }
    ok(res, { ok: true });
  } catch (e) { fail(res, e.message); }
};

/* Recordatorio semanal: tareas vencidas de procesos abiertos → campana RRHH */
async function alegarOnbVencidos() {
  try {
    const hoy = new Date().toISOString().slice(0, 10);
    const [venc] = await pool.query(
      `SELECT p.persona, p.tipo, COUNT(*) n FROM rh_onb_items i JOIN rh_onb_procesos p ON p.id=i.id_proceso
        WHERE p.estado='ABIERTO' AND i.ok=0 AND i.fecha_limite < ? GROUP BY p.id, p.persona, p.tipo LIMIT 10`, [hoy]);
    if (!venc.length) return;
    const _clave = 'onb_vencidos_' + _w(new Date());
    const [[_ya]] = await pool.query('SELECT 1 ok FROM notificaciones WHERE clave=? LIMIT 1', [_clave]);
    if (_ya) return;
    const [rr] = await pool.query(
      `SELECT DISTINCT u.id_usuario FROM usuarios u
        JOIN permisos_perfil pp ON pp.id_perfil=u.id_perfil AND pp.habilitado=1
        JOIN funcionalidades f ON f.id_funcionalidad=pp.id_funcionalidad
       WHERE f.codigo='rh_colaboradores' AND u.estado='activo'`);
    notificar(rr.map(x => x.id_usuario), {
      tipo: 'RRHH', prioridad: 'alta',
      titulo: 'Tareas de onboarding/offboarding vencidas',
      mensaje: venc.map(v => `${v.persona} (${v.tipo.toLowerCase()}): ${v.n} tarea(s) atrasada(s)`).join(' · '),
      href: '/recursos-humanos/contratos/', clave: _clave,
    });
  } catch (e) { console.error('[alegato onb]', e.message); }
}
setTimeout(alegarOnbVencidos, 160 * 1000);
setInterval(alegarOnbVencidos, 24 * 60 * 60 * 1000);
