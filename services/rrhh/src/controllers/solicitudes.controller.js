'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   SOLICITUDES DEL COLABORADOR (paperless) — anticipo, préstamo, aumento de
   sueldo, ascenso y otras. Vacaciones NO va aquí (tiene su módulo propio).
   · Cada TIPO es paramétrico: cadena de aprobación por pasos (JEFATURA =
     usuarios.id_supervisor · RRHH = rh_colaboradores · GERENCIA = rh_aprobar).
   · Cada aprobación/rechazo queda firmada estilo FES: usuario, cargo, IP,
     fecha y hash SHA-256 del contenido de la solicitud (integridad).
   · Al aprobar el ÚLTIMO paso, la solicitud EJECUTA sola contra el motor
     que corresponde (un solo motor por cálculo):
       ANTICIPO / PRESTAMO → rh_descuentos (cuotas desde la próxima remuneración)
       AUMENTO → rh_fichas.sueldo_base   ·   ASCENSO → usuarios.cargo
   ───────────────────────────────────────────────────────────────────────────── */
const crypto = require('crypto');
const pool = require('../../../../shared/config/database');
const { tieneFunc } = require('../../../../shared/middleware/permisos');
const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');
const { auditar } = require('../../../../shared/audit');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });

require('../../../../shared/migrate').enFila('rrhh-solicitudes', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_sol_tipos (
    codigo VARCHAR(20) PRIMARY KEY,
    nombre VARCHAR(120) NOT NULL,
    icono VARCHAR(40) NULL,
    descripcion VARCHAR(300) NULL,
    cadena JSON NOT NULL,
    activo TINYINT(1) DEFAULT 1,
    orden INT DEFAULT 0
  )`);
  const T = [
    ['ANTICIPO', 'Anticipo de sueldo', 'bi-cash', 'Anticipo sin interés, descontado en cuotas desde la próxima remuneración', ['JEFATURA', 'RRHH'], 1],
    ['PRESTAMO', 'Préstamo al personal', 'bi-bank', 'Préstamo con interés (tope TMC), cuota francesa descontada por planilla', ['JEFATURA', 'RRHH'], 2],
    ['AUMENTO', 'Aumento de sueldo', 'bi-graph-up-arrow', 'Propuesta de nuevo sueldo base — rige desde el mes siguiente a la aprobación', ['JEFATURA', 'GERENCIA', 'RRHH'], 3],
    ['ASCENSO', 'Ascenso / cambio de cargo', 'bi-arrow-up-circle', 'Cambio de cargo (y sueldo si aplica) — actualiza la ficha al aprobarse', ['JEFATURA', 'GERENCIA', 'RRHH'], 4],
    ['OTRA', 'Otra solicitud', 'bi-chat-left-text', 'Cualquier otra petición formal al empleador', ['JEFATURA', 'RRHH'], 5],
  ];
  for (const [c, n, i, d, cad, o] of T)
    await pool.query(`INSERT IGNORE INTO rh_sol_tipos (codigo, nombre, icono, descripcion, cadena, orden) VALUES (?,?,?,?,?,?)`,
      [c, n, i, d, JSON.stringify(cad), o]);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_solicitudes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tipo VARCHAR(20) NOT NULL,
    id_usuario INT NOT NULL,
    nombre VARCHAR(160) NULL,
    datos JSON NULL,
    comentario VARCHAR(500) NULL,
    estado VARCHAR(12) DEFAULT 'PENDIENTE',
    paso INT DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_u (id_usuario), INDEX idx_e (estado)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_sol_firmas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_solicitud INT NOT NULL,
    paso INT NOT NULL,
    rol VARCHAR(12) NOT NULL,
    id_usuario INT NOT NULL,
    nombre VARCHAR(160), cargo VARCHAR(120), ip VARCHAR(45),
    decision VARCHAR(10) NOT NULL,
    comentario VARCHAR(500) NULL,
    hash_doc CHAR(64) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_sol_paso (id_solicitud, paso)
  )`);
  const [[modRRHH]] = await pool.query(`SELECT id_modulo FROM modulos WHERE ruta='/recursos-humanos/' LIMIT 1`);
  if (modRRHH) {
    const [[f]] = await pool.query(`SELECT id_funcionalidad FROM funcionalidades WHERE codigo='rh_solicitudes' LIMIT 1`);
    if (!f) {
      const [r] = await pool.query(`INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
        VALUES (?, 'Solicitudes', 'rh_solicitudes', '/recursos-humanos/solicitudes/', 'bi-send-check')`, [modRRHH.id_modulo]);
      await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
                        SELECT p.id_perfil, ?, 1 FROM perfiles p`, [r.insertId]);
    }
  }
  console.log('[rrhh-solicitudes] listo');
});

const hashSol = s => crypto.createHash('sha256')
  .update(JSON.stringify({ id: s.id, tipo: s.tipo, id_usuario: s.id_usuario, datos: s.datos, comentario: s.comentario }))
  .digest('hex');

const esRRHH = id => tieneFunc(id, 'rh_colaboradores').catch(() => false);
const esGerencia = id => tieneFunc(id, 'rh_aprobar').catch(() => false);

async function tipoDe(codigo) {
  const [[t]] = await pool.query(`SELECT * FROM rh_sol_tipos WHERE codigo=? AND activo=1`, [codigo]);
  if (t && typeof t.cadena === 'string') t.cadena = JSON.parse(t.cadena);
  return t;
}

/* ¿Quiénes pueden resolver el paso actual de una solicitud? */
async function aprobadoresDe(sol, rol) {
  if (rol === 'JEFATURA') {
    const [[u]] = await pool.query(`SELECT id_supervisor FROM usuarios WHERE id_usuario=?`, [sol.id_usuario]);
    return u?.id_supervisor ? [u.id_supervisor] : [];
  }
  const func = rol === 'GERENCIA' ? 'rh_aprobar' : 'rh_colaboradores';
  const [rows] = await pool.query(
    `SELECT DISTINCT u.id_usuario FROM usuarios u
      JOIN permisos_perfil pp ON pp.id_perfil=u.id_perfil AND pp.habilitado=1
      JOIN funcionalidades f ON f.id_funcionalidad=pp.id_funcionalidad
     WHERE f.codigo=? AND u.estado='activo'`, [func]);
  return rows.map(r => r.id_usuario);
}

async function avisarPaso(sol, tipo) {
  const rol = tipo.cadena[sol.paso];
  if (!rol) return;
  let ids = await aprobadoresDe(sol, rol);
  if (!ids.length && rol === 'JEFATURA') { // sin jefatura definida → salta a RRHH del mismo paso
    ids = await aprobadoresDe(sol, 'RRHH');
  }
  if (!ids.length) return;
  notificar(ids, {
    tipo: 'RRHH', prioridad: 'alta', sonar: true,
    titulo: `Solicitud por aprobar: ${tipo.nombre}`,
    mensaje: `${sol.nombre} — paso ${sol.paso + 1} de ${tipo.cadena.length} (${rol}). Resuélvela en Solicitudes.`,
    href: '/recursos-humanos/solicitudes/', clave: `sol_${sol.id}_p${sol.paso}` });
}

/* ── Tipos (catálogo; config solo RRHH) ─────────────────────────────────────── */
exports.tipos = async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM rh_sol_tipos WHERE activo=1 ORDER BY orden`);
    ok(res, { tipos: rows.map(t => ({ ...t, cadena: typeof t.cadena === 'string' ? JSON.parse(t.cadena) : t.cadena })) });
  } catch (e) { fail(res, e.message); }
};

exports.tipoGuardar = async (req, res) => {
  try {
    if (!await esRRHH(req.usuario.id_usuario)) return fail(res, 'Solo RRHH', 403);
    const b = req.body || {};
    const cadena = (b.cadena || []).filter(r => ['JEFATURA', 'RRHH', 'GERENCIA'].includes(r));
    if (!cadena.length) return fail(res, 'La cadena necesita al menos un paso', 400);
    await pool.query(`UPDATE rh_sol_tipos SET nombre=COALESCE(?,nombre), descripcion=COALESCE(?,descripcion), cadena=? WHERE codigo=?`,
      [b.nombre || null, b.descripcion || null, JSON.stringify(cadena), String(b.codigo || '')]);
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'rh_sol_tipo', detalle: `Tipo ${b.codigo} → cadena ${cadena.join('→')}` });
    ok(res, { ok: true });
  } catch (e) { fail(res, e.message); }
};

/* ── Crear (el colaborador) ─────────────────────────────────────────────────── */
exports.crear = async (req, res) => {
  try {
    const b = req.body || {};
    const tipo = await tipoDe(String(b.tipo || ''));
    if (!tipo) return fail(res, 'Tipo de solicitud inválido', 400);
    const datos = {};
    if (['ANTICIPO', 'PRESTAMO'].includes(tipo.codigo)) {
      datos.monto = parseInt(b.monto) || 0;
      datos.cuotas = Math.min(Math.max(parseInt(b.cuotas) || 1, 1), 36);
      if (datos.monto < 1000) return fail(res, 'Indica el monto', 400);
    }
    if (tipo.codigo === 'AUMENTO') {
      datos.sueldo_propuesto = parseInt(b.sueldo_propuesto) || 0;
      if (datos.sueldo_propuesto < 1000) return fail(res, 'Indica el sueldo propuesto', 400);
    }
    if (tipo.codigo === 'ASCENSO') {
      datos.cargo_propuesto = String(b.cargo_propuesto || '').trim().slice(0, 120);
      datos.sueldo_propuesto = parseInt(b.sueldo_propuesto) || null;
      if (!datos.cargo_propuesto) return fail(res, 'Indica el cargo propuesto', 400);
    }
    const comentario = String(b.comentario || '').trim().slice(0, 500);
    if (tipo.codigo === 'OTRA' && !comentario) return fail(res, 'Describe tu solicitud', 400);
    const [[u]] = await pool.query(`SELECT CONCAT_WS(' ', nombre, apellido) nombre FROM usuarios WHERE id_usuario=?`, [req.usuario.id_usuario]);
    const [r] = await pool.query(`INSERT INTO rh_solicitudes (tipo, id_usuario, nombre, datos, comentario) VALUES (?,?,?,?,?)`,
      [tipo.codigo, req.usuario.id_usuario, u?.nombre || '', JSON.stringify(datos), comentario || null]);
    const sol = { id: r.insertId, id_usuario: req.usuario.id_usuario, nombre: u?.nombre || '', paso: 0 };
    await avisarPaso(sol, tipo);
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'rh_solicitud', entidad_id: r.insertId, detalle: `Solicitud ${tipo.codigo} de ${u?.nombre}` });
    ok(res, { id: r.insertId });
  } catch (e) { fail(res, e.message); }
};

/* ── Mis solicitudes (con timeline de firmas) ───────────────────────────────── */
async function conFirmas(rows) {
  const ids = rows.map(s => s.id);
  const [firmas] = ids.length ? await pool.query(
    `SELECT id_solicitud, paso, rol, nombre, cargo, decision, comentario, DATE_FORMAT(created_at,'%d-%m-%Y %H:%i') fecha
       FROM rh_sol_firmas WHERE id_solicitud IN (?) ORDER BY paso`, [ids]) : [[]];
  return rows.map(s => ({ ...s,
    datos: typeof s.datos === 'string' ? JSON.parse(s.datos || '{}') : (s.datos || {}),
    firmas: firmas.filter(f => f.id_solicitud === s.id) }));
}

exports.mias = async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM rh_solicitudes WHERE id_usuario=? ORDER BY id DESC LIMIT 100`, [req.usuario.id_usuario]);
    ok(res, { solicitudes: await conFirmas(rows) });
  } catch (e) { fail(res, e.message); }
};

/* ── Por aprobar (según mi rol en el paso actual de cada una) ───────────────── */
exports.porAprobar = async (req, res) => {
  try {
    const me = req.usuario.id_usuario;
    const [pend] = await pool.query(`SELECT * FROM rh_solicitudes WHERE estado='PENDIENTE' ORDER BY id`);
    const rrhh = await esRRHH(me), ger = await esGerencia(me);
    const mias = [];
    for (const s of pend) {
      if (s.id_usuario === me) continue;                      // nadie se aprueba a sí mismo
      const tipo = await tipoDe(s.tipo);
      if (!tipo) continue;
      const rol = tipo.cadena[s.paso];
      let puedo = false;
      if (rol === 'JEFATURA') {
        const [[u]] = await pool.query(`SELECT id_supervisor FROM usuarios WHERE id_usuario=?`, [s.id_usuario]);
        puedo = u?.id_supervisor === me || (!u?.id_supervisor && rrhh);   // sin jefe definido → RRHH
      } else if (rol === 'RRHH') puedo = rrhh;
      else if (rol === 'GERENCIA') puedo = ger;
      if (puedo) mias.push({ ...s, rol_paso: rol, cadena: tipo.cadena, tipo_nombre: tipo.nombre });
    }
    ok(res, { solicitudes: await conFirmas(mias) });
  } catch (e) { fail(res, e.message); }
};

/* ── Todas (RRHH) ───────────────────────────────────────────────────────────── */
exports.todas = async (req, res) => {
  try {
    if (!await esRRHH(req.usuario.id_usuario)) return fail(res, 'Solo RRHH', 403);
    const [rows] = await pool.query(`SELECT * FROM rh_solicitudes ORDER BY estado='PENDIENTE' DESC, id DESC LIMIT 300`);
    ok(res, { solicitudes: await conFirmas(rows) });
  } catch (e) { fail(res, e.message); }
};

/* ── EJECUCIÓN al aprobar el último paso — contra los motores existentes ────── */
const mesProximo = () => { const d = new Date(); const y = d.getFullYear(), m = d.getMonth() + 2; return `${m > 12 ? y + 1 : y}-${String(m > 12 ? m - 12 : m).padStart(2, '0')}`; };
const cuotaFrancesa = (M, iPct, n) => { const i = iPct / 100; return i > 0 ? Math.round(M * i / (1 - Math.pow(1 + i, -n))) : Math.round(M / n); };

/* ODP del desembolso (anticipo/préstamo): correlativo del libro central + aviso
   a Tesorería (ordenes_pago_pagar) para que deposite al colaborador. */
async function generarODP(sol, datos, req) {
  const { emitirCorrelativo } = require('../../../../shared/ordenes-pago');
  const [[trab]] = await pool.query(`SELECT rut FROM usuarios WHERE id_usuario=?`, [sol.id_usuario]);
  const concepto = `${sol.tipo === 'ANTICIPO' ? 'Anticipo de sueldo' : 'Préstamo al personal'} — ${sol.nombre} (Solicitud #${sol.id})`;
  const [[ap]] = await pool.query(`SELECT CONCAT_WS(' ', nombre, apellido) nombre FROM usuarios WHERE id_usuario=?`, [req.usuario.id_usuario]);
  const [r] = await pool.query(`INSERT INTO ordenes_pago (proveedor_nombre, proveedor_rut, concepto, categoria, monto, fecha_emision, estado, id_usuario, usuario_nombre, observaciones)
    VALUES (?,?,?,?,?,CURDATE(),'EMITIDA',?,?,?)`,
    [sol.nombre, trab?.rut || null, concepto, 'REMUNERACIONES', datos.monto, req.usuario.id_usuario, ap?.nombre || '',
     `Generada automáticamente al aprobarse la solicitud #${sol.id}. El descuento por planilla ya quedó programado.`]);
  let numero = null;
  try {
    numero = (await emitirCorrelativo({ origen: 'GENERAL', origen_id: r.insertId, concepto, monto: datos.monto,
      id_usuario: req.usuario.id_usuario, usuario_nombre: ap?.nombre || '' }))?.numero || null;
    if (numero) await pool.query(`UPDATE ordenes_pago SET numero=? WHERE id=?`, [numero, r.insertId]);
  } catch (e) { console.error('[solicitudes correlativo ODP]', e.message); }
  // Campana a Tesorería (quienes pagan ODP) para el depósito
  try {
    const [tes] = await pool.query(
      `SELECT DISTINCT u.id_usuario FROM usuarios u
        JOIN permisos_perfil pp ON pp.id_perfil=u.id_perfil AND pp.habilitado=1
        JOIN funcionalidades f ON f.id_funcionalidad=pp.id_funcionalidad
       WHERE f.codigo IN ('ordenes_pago_pagar','ordenes_pago_emitir') AND u.estado='activo'`);
    if (tes.length) notificar(tes.map(x => x.id_usuario), {
      tipo: 'TESORERIA', prioridad: 'alta', sonar: true,
      titulo: `ODP ${numero || ''} por depositar: ${sol.tipo === 'ANTICIPO' ? 'anticipo' : 'préstamo'} de ${sol.nombre}`,
      mensaje: `$${Number(datos.monto).toLocaleString('es-CL')} — aprobado por toda la cadena; deposítalo y marca la ODP pagada`,
      href: '/ordenes-pago/', clave: `sol_odp_${sol.id}` });
  } catch (e) { console.error('[solicitudes aviso tesoreria]', e.message); }
  return numero || `#${r.insertId}`;
}

/* Tope legal art. 58 CT: la cuota del descuento acordado no puede superar el 15%
   de la remuneración total (última liquidación EMITIDA; fallback sueldo base). */
async function validarTope15(idUsuario, valorCuota) {
  const [[liq]] = await pool.query(
    `SELECT total_haberes FROM rh_liquidaciones WHERE id_usuario=? AND estado='EMITIDA' ORDER BY mes DESC LIMIT 1`, [idUsuario]);
  let base = Number(liq?.total_haberes) || 0;
  if (!base) { const [[f]] = await pool.query(`SELECT sueldo_base FROM rh_fichas WHERE id_usuario=?`, [idUsuario]); base = Number(f?.sueldo_base) || 0; }
  if (!base) return;   // sin referencia no se puede validar — RRHH decide
  const tope = Math.round(base * 0.15);
  if (valorCuota > tope) throw new Error(
    `La cuota de $${valorCuota.toLocaleString('es-CL')} supera el tope legal del 15% de la remuneración (art. 58 CT): máximo $${tope.toLocaleString('es-CL')} — sube el número de cuotas o baja el monto antes de aprobar`);
}

async function ejecutar(sol, datos, req) {
  const mes = mesProximo();
  if (sol.tipo === 'ANTICIPO') {
    await validarTope15(sol.id_usuario, Math.round(datos.monto / datos.cuotas));
    await pool.query(`INSERT INTO rh_descuentos (id_usuario, nombre, tipo, monto_total, cuotas, valor_cuota, mes_inicio, creado_por)
      VALUES (?,?,?,?,?,?,?,?)`,
      [sol.id_usuario, sol.nombre, 'ANTICIPO', datos.monto, datos.cuotas, Math.round(datos.monto / datos.cuotas), mes, `Solicitud #${sol.id}`]);
    const odp = await generarODP(sol, datos, req);
    return `Anticipo de $${datos.monto.toLocaleString('es-CL')} en ${datos.cuotas} cuota(s) desde ${mes}. ODP ${odp} emitida — Tesorería avisada para el depósito`;
  }
  if (sol.tipo === 'PRESTAMO') {
    const tasa = parseFloat(datos.tasa_pct) || 0;
    const [[t]] = await pool.query('SELECT tasa_mensual_menor FROM tasas ORDER BY fecha_desde DESC LIMIT 1').catch(() => [[null]]);
    const tmc = t ? parseFloat(t.tasa_mensual_menor) : null;
    if (tmc != null && tasa > tmc) throw new Error(`La tasa ${tasa}% supera la TMC vigente (${tmc}%) — ajústala antes de aprobar`);
    const vc = cuotaFrancesa(datos.monto, tasa, datos.cuotas);
    await validarTope15(sol.id_usuario, vc);
    await pool.query(`INSERT INTO rh_descuentos (id_usuario, nombre, tipo, monto_total, tasa_pct, cuotas, valor_cuota, mes_inicio, creado_por)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      [sol.id_usuario, sol.nombre, 'PRESTAMO', datos.monto, tasa, datos.cuotas, vc, mes, `Solicitud #${sol.id}`]);
    const odp = await generarODP(sol, datos, req);
    return `Préstamo de $${datos.monto.toLocaleString('es-CL')} al ${tasa}% en ${datos.cuotas} cuotas de $${vc.toLocaleString('es-CL')} desde ${mes}. ODP ${odp} emitida — Tesorería avisada para el depósito`;
  }
  if (sol.tipo === 'AUMENTO') {
    await pool.query(`UPDATE rh_fichas SET sueldo_base=? WHERE id_usuario=?`, [datos.sueldo_propuesto, sol.id_usuario]);
    return `Sueldo base actualizado a $${datos.sueldo_propuesto.toLocaleString('es-CL')} en la ficha (rige la próxima liquidación)`;
  }
  if (sol.tipo === 'ASCENSO') {
    await pool.query(`UPDATE usuarios SET cargo=? WHERE id_usuario=?`, [datos.cargo_propuesto, sol.id_usuario]);
    if (datos.sueldo_propuesto) await pool.query(`UPDATE rh_fichas SET sueldo_base=? WHERE id_usuario=?`, [datos.sueldo_propuesto, sol.id_usuario]);
    return `Cargo actualizado a ${datos.cargo_propuesto}${datos.sueldo_propuesto ? ` con sueldo $${datos.sueldo_propuesto.toLocaleString('es-CL')}` : ''}`;
  }
  return 'Solicitud aprobada (sin ejecución automática)';
}

/* ── Resolver un paso (aprobar/rechazar con firma FES) ──────────────────────── */
exports.resolver = async (req, res) => {
  try {
    const b = req.body || {};
    const id = parseInt(b.id);
    const decision = b.decision === 'RECHAZAR' ? 'RECHAZAR' : 'APROBAR';
    const [[sol]] = await pool.query(`SELECT * FROM rh_solicitudes WHERE id=?`, [id]);
    if (!sol) return fail(res, 'No existe', 404);
    if (sol.estado !== 'PENDIENTE') return fail(res, `La solicitud ya está ${sol.estado}`, 409);
    if (sol.id_usuario === req.usuario.id_usuario) return fail(res, 'No puedes resolver tu propia solicitud', 403);
    const tipo = await tipoDe(sol.tipo);
    const rol = tipo.cadena[sol.paso];
    const me = req.usuario.id_usuario;
    let puedo = false;
    if (rol === 'JEFATURA') {
      const [[u]] = await pool.query(`SELECT id_supervisor FROM usuarios WHERE id_usuario=?`, [sol.id_usuario]);
      puedo = u?.id_supervisor === me || (!u?.id_supervisor && await esRRHH(me));
    } else if (rol === 'RRHH') puedo = await esRRHH(me);
    else if (rol === 'GERENCIA') puedo = await esGerencia(me);
    if (!puedo) return fail(res, `Este paso lo resuelve ${rol}`, 403);

    let datos = typeof sol.datos === 'string' ? JSON.parse(sol.datos || '{}') : (sol.datos || {});
    // RRHH puede ajustar condiciones al resolver (tasa del préstamo, cuotas, montos)
    if (decision === 'APROBAR' && rol === 'RRHH' && b.datos && typeof b.datos === 'object') {
      for (const k of ['monto', 'cuotas', 'tasa_pct', 'sueldo_propuesto', 'cargo_propuesto'])
        if (b.datos[k] != null && b.datos[k] !== '') datos[k] = ['cargo_propuesto'].includes(k) ? String(b.datos[k]).slice(0, 120) : parseFloat(b.datos[k]);
      await pool.query(`UPDATE rh_solicitudes SET datos=? WHERE id=?`, [JSON.stringify(datos), id]);
      sol.datos = datos;
    }
    const esUltimo = sol.paso + 1 >= tipo.cadena.length;
    let efecto = null;
    if (decision === 'APROBAR' && esUltimo) efecto = await ejecutar(sol, datos, req);   // si falla, NO se firma

    const [[u]] = await pool.query(`SELECT CONCAT_WS(' ', nombre, apellido) nombre, cargo FROM usuarios WHERE id_usuario=?`, [me]);
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 45);
    await pool.query(`INSERT INTO rh_sol_firmas (id_solicitud, paso, rol, id_usuario, nombre, cargo, ip, decision, comentario, hash_doc)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, sol.paso, rol, me, u?.nombre || '', u?.cargo || '', ip, decision, String(b.comentario || '').slice(0, 500) || null, hashSol({ ...sol, datos })]);

    if (decision === 'RECHAZAR') {
      await pool.query(`UPDATE rh_solicitudes SET estado='RECHAZADA' WHERE id=?`, [id]);
      notificar([sol.id_usuario], { tipo: 'RRHH', prioridad: 'media',
        titulo: `Solicitud rechazada: ${tipo.nombre}`,
        mensaje: b.comentario ? `Motivo: ${String(b.comentario).slice(0, 150)}` : `Rechazada en el paso ${rol}`,
        href: '/recursos-humanos/solicitudes/', clave: `sol_rz_${id}` });
    } else if (esUltimo) {
      await pool.query(`UPDATE rh_solicitudes SET estado='APROBADA', paso=? WHERE id=?`, [sol.paso + 1, id]);
      notificar([sol.id_usuario], { tipo: 'RRHH', prioridad: 'media',
        titulo: `Solicitud APROBADA: ${tipo.nombre}`, mensaje: efecto || 'Aprobada por toda la cadena',
        href: '/recursos-humanos/solicitudes/', clave: `sol_ok_${id}` });
    } else {
      await pool.query(`UPDATE rh_solicitudes SET paso=? WHERE id=?`, [sol.paso + 1, id]);
      await avisarPaso({ ...sol, paso: sol.paso + 1 }, tipo);
    }
    auditar({ req, accion: decision === 'APROBAR' ? 'APROBAR' : 'RECHAZAR', modulo: 'rrhh', entidad: 'rh_solicitud', entidad_id: id,
      detalle: `${sol.tipo} de ${sol.nombre} — ${decision} en paso ${rol}${efecto ? ' · ' + efecto : ''}` });
    ok(res, { ok: true, efecto });
  } catch (e) { fail(res, e.message); }
};
