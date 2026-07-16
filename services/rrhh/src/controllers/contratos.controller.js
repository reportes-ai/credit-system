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

/* ── El ALEGATO: cargos sin descripción → campana diaria a RRHH y al creador ── */
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
    const nombres = cargos.map(c => c.nombre).slice(0, 5).join(', ') + (cargos.length > 5 ? '…' : '');
    await notificar([...ids], {
      tipo: 'RRHH', prioridad: 'alta', sonar: true,
      titulo: `${cargos.length} cargo(s) sin descripción de cargo`,
      mensaje: `Falta la descripción de: ${nombres}. Sin descripción no se pueden generar cartas oferta ni contratos prolijos. Cárgala en Contratos → Cargos.`,
      href: '/recursos-humanos/contratos/',
      clave: 'cargos_sin_descripcion_' + new Date().toISOString().slice(0, 10),   // 1 vez al día
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
