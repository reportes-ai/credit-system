'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   RRHH — Ingreso de Colaboradores (Pato, 21-09-2026).
   RRHH registra a la persona contratada → la aprueba su SUPERVISOR → la aprueba el
   ADMINISTRADOR → recién ahí nace el usuario (motor único `altaUsuario` de Usuarios:
   clave temporal + correo con usuario y clave) y su ficha RRHH.
   · Cargo = uno de los perfiles de Business Suite (lista viva desde `perfiles`: un perfil
     nuevo aparece solo). El perfil elegido es también el id_perfil del usuario.
   · Estados: PEND_SUPERVISOR → PEND_ADMIN → APROBADA; cualquiera de las dos firmas puede
     RECHAZAR con motivo. Mientras no está APROBADA no existe usuario ni acceso.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { tieneFunc } = require('../../../../shared/middleware/permisos');
const RUT = require('../../../../api-gateway/public/js/rut-core');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });
const APP_URL = (process.env.APP_URL || 'https://afbs.autofacilchile.cl').replace(/\/+$/, '');
const LINK = `${APP_URL}/recursos-humanos/ingresos/`;

require('../../../../shared/migrate').enFila('rrhh-ingresos', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_ingresos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    rut VARCHAR(15) NOT NULL, nombre VARCHAR(80) NOT NULL, apellido VARCHAR(80) NOT NULL,
    apellido_materno VARCHAR(80) NULL, email VARCHAR(150) NOT NULL, telefono VARCHAR(30) NULL,
    sexo CHAR(1) NULL, fecha_nacimiento DATE NULL, fecha_ingreso DATE NOT NULL,
    id_perfil INT NOT NULL, cargo VARCHAR(120) NULL, id_supervisor INT NOT NULL,
    centro_costo VARCHAR(80) NULL, tipo_contrato VARCHAR(30) NULL, jornada VARCHAR(60) NULL,
    estado VARCHAR(20) NOT NULL DEFAULT 'PEND_SUPERVISOR',
    creado_por INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    sup_por INT NULL, sup_at DATETIME NULL,
    admin_por INT NULL, admin_at DATETIME NULL,
    rechazo_por INT NULL, rechazo_at DATETIME NULL, motivo_rechazo VARCHAR(300) NULL,
    id_usuario INT NULL, correo_enviado TINYINT(1) NULL, error_alta VARCHAR(300) NULL,
    INDEX idx_estado (estado), INDEX idx_sup (id_supervisor)
  )`);
  /* Tarjeta en el landing de RRHH, para TODOS los perfiles: cualquiera puede ser supervisor y
     aprobar desde aquí; el listado muestra a cada uno solo lo suyo (RRHH/Admin ven todo). */
  const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='rh_ingresos' LIMIT 1");
  if (!ex) {
    const [r] = await pool.query("INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (500002,'Ingreso de Colaboradores','rh_ingresos','/recursos-humanos/ingresos/','bi-person-plus')");
    await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) SELECT id_perfil, ?, 1 FROM perfiles', [r.insertId]);
  }
});

const esAdmin = async id => {
  const [[u]] = await pool.query(`SELECT p.nombre FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil WHERE u.id_usuario=?`, [id]);
  return u?.nombre === 'Administrador';
};
const esRRHH = id => tieneFunc(id, 'rh_colaboradores', 'rh_aprobar').catch(() => false);

async function avisar(to, subject, cuerpo) {
  try {
    if (!to || (Array.isArray(to) && !to.length)) return;
    const { enviarCorreo, envolverHTML } = require('../../../../shared/mailer');
    const html = `${cuerpo}<p style="text-align:center;margin:22px 0 4px"><a href="${LINK}" style="background:#0141A2;color:#fff;text-decoration:none;padding:11px 26px;border-radius:8px;font-weight:600;display:inline-block">Ver solicitudes de ingreso</a></p>`;
    await enviarCorreo({ to, subject, html: envolverHTML ? envolverHTML(html) : html });
  } catch (e) { console.error('[rrhh ingresos aviso]', e.message); }
}
const ficha = s => `<p style="margin:0 0 12px"><b>${s.nombre} ${s.apellido}${s.apellido_materno ? ' ' + s.apellido_materno : ''}</b> · RUT ${s.rut}<br>
  Cargo: <b>${s.cargo || ''}</b> · Ingreso: ${String(s.fecha_ingreso || '').slice(0, 10)}<br>Correo corporativo: ${s.email}</p>`;
const correosAdmin = async () => (await pool.query(
  `SELECT u.email FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
    WHERE p.nombre='Administrador' AND u.estado='activo' AND u.email LIKE '%@%'`))[0].map(r => r.email);

/* GET /api/rrhh/ingresos/opciones — cargos (perfiles) y supervisores posibles */
exports.opciones = async (req, res) => {
  try {
    const [perfiles] = await pool.query(`SELECT id_perfil, nombre FROM perfiles ORDER BY nombre`);
    const [supervisores] = await pool.query(
      `SELECT id_usuario, TRIM(CONCAT_WS(' ', nombre, apellido)) nombre, cargo FROM usuarios
        WHERE estado='activo' ORDER BY nombre`);
    ok(res, { perfiles, supervisores });
  } catch (e) { fail(res, e.message); }
};

/* GET /api/rrhh/ingresos — RRHH/Admin ven todo; el supervisor, las suyas */
exports.listar = async (req, res) => {
  try {
    const yo = req.usuario.id_usuario;
    const [admin, rrhh] = await Promise.all([esAdmin(yo), esRRHH(yo)]);
    const [rows] = await pool.query(
      `SELECT i.*, DATE_FORMAT(i.fecha_ingreso,'%Y-%m-%d') fecha_ingreso, DATE_FORMAT(i.fecha_nacimiento,'%Y-%m-%d') fecha_nacimiento,
              TRIM(CONCAT_WS(' ', s.nombre, s.apellido)) supervisor, TRIM(CONCAT_WS(' ', c.nombre, c.apellido)) creado_por_nombre
         FROM rh_ingresos i
         LEFT JOIN usuarios s ON s.id_usuario=i.id_supervisor
         LEFT JOIN usuarios c ON c.id_usuario=i.creado_por
        ${admin || rrhh ? '' : 'WHERE i.id_supervisor = ?'}
        ORDER BY FIELD(i.estado,'PEND_SUPERVISOR','PEND_ADMIN','APROBADA','RECHAZADA'), i.id DESC LIMIT 300`,
      admin || rrhh ? [] : [yo]);
    ok(res, { ingresos: rows, yo, es_admin: admin, es_rrhh: rrhh });
  } catch (e) { fail(res, e.message); }
};

/* POST /api/rrhh/ingresos — RRHH registra la contratación */
exports.crear = async (req, res) => {
  try {
    const b = req.body || {};
    const t = (v, n) => String(v ?? '').trim().slice(0, n);
    const d = {
      rut: RUT.normalizar(t(b.rut, 15)) || '', nombre: t(b.nombre, 80), apellido: t(b.apellido, 80),
      apellido_materno: t(b.apellido_materno, 80) || null, email: t(b.email, 150).toLowerCase(),
      telefono: t(b.telefono, 30) || null, sexo: ['M', 'F'].includes(b.sexo) ? b.sexo : null,
      fecha_nacimiento: /^\d{4}-\d{2}-\d{2}$/.test(b.fecha_nacimiento || '') ? b.fecha_nacimiento : null,
      fecha_ingreso: /^\d{4}-\d{2}-\d{2}$/.test(b.fecha_ingreso || '') ? b.fecha_ingreso : null,
      id_perfil: parseInt(b.id_perfil, 10) || null, id_supervisor: parseInt(b.id_supervisor, 10) || null,
      centro_costo: t(b.centro_costo, 80) || null,
      tipo_contrato: ['INDEFINIDO', 'PLAZO FIJO', 'HONORARIOS', 'PRACTICA'].includes(b.tipo_contrato) ? b.tipo_contrato : null,
      jornada: ['COMPLETA', 'PARCIAL'].includes(b.jornada) ? b.jornada : null,
    };
    if (!d.rut || !RUT.validar(d.rut)) return fail(res, 'RUT inválido', 400);
    if (!d.nombre || !d.apellido) return fail(res, 'Nombre y apellido son obligatorios', 400);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email)) return fail(res, 'Correo corporativo inválido (ahí llegan el usuario y la clave)', 400);
    if (!d.fecha_ingreso) return fail(res, 'Fecha de ingreso obligatoria', 400);
    if (!d.id_supervisor) return fail(res, 'El supervisor es obligatorio: es quien aprueba la contratación', 400);
    const [[pf]] = await pool.query('SELECT nombre FROM perfiles WHERE id_perfil=?', [d.id_perfil]);
    if (!pf) return fail(res, 'Elige el cargo de la lista de perfiles', 400);
    d.cargo = pf.nombre;
    const [[sup]] = await pool.query(`SELECT id_usuario, email, nombre, apellido FROM usuarios WHERE id_usuario=? AND estado='activo'`, [d.id_supervisor]);
    if (!sup) return fail(res, 'Supervisor no válido', 400);
    const [[dupU]] = await pool.query('SELECT id_usuario FROM usuarios WHERE rut=? OR email=? LIMIT 1', [d.rut, d.email]);
    if (dupU) return fail(res, 'Ya existe un usuario con ese RUT o correo', 409);
    const [[dupI]] = await pool.query(`SELECT id FROM rh_ingresos WHERE (rut=? OR email=?) AND estado IN ('PEND_SUPERVISOR','PEND_ADMIN') LIMIT 1`, [d.rut, d.email]);
    if (dupI) return fail(res, `Ya hay una solicitud en curso (#${dupI.id}) para ese RUT o correo`, 409);

    const cols = Object.keys(d);
    const [r] = await pool.query(`INSERT INTO rh_ingresos (${cols.join(', ')}, creado_por) VALUES (${cols.map(() => '?').join(', ')}, ?)`,
      [...cols.map(k => d[k]), req.usuario.id_usuario]);
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'rh_ingreso', entidad_id: r.insertId,
      detalle: `Solicitud de ingreso ${d.nombre} ${d.apellido} (${d.cargo}) — espera aprobación del supervisor` });
    avisar(sup.email, `🧑‍💼 Aprobar contratación — ${d.nombre} ${d.apellido}`,
      `<p style="margin:0 0 12px">Hola ${sup.nombre}, RRHH registró una contratación que queda a tu cargo y necesita <b>tu aprobación</b>:</p>${ficha(d)}
       <p style="margin:0">Después de ti la aprueba el Administrador y recién ahí se crea el usuario.</p>`);
    ok(res, { id: r.insertId });
  } catch (e) { fail(res, e.message); }
};

/* POST /api/rrhh/ingresos/:id/aprobar — firma del supervisor o del Administrador según la etapa */
exports.aprobar = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10), yo = req.usuario.id_usuario;
    const [[s]] = await pool.query(`SELECT *, DATE_FORMAT(fecha_ingreso,'%Y-%m-%d') fecha_ingreso, DATE_FORMAT(fecha_nacimiento,'%Y-%m-%d') fecha_nacimiento FROM rh_ingresos WHERE id=?`, [id]);
    if (!s) return fail(res, 'Solicitud no existe', 404);

    if (s.estado === 'PEND_SUPERVISOR') {
      if (Number(s.id_supervisor) !== Number(yo)) return fail(res, 'Solo el supervisor asignado aprueba esta etapa', 403);
      const [u] = await pool.query(`UPDATE rh_ingresos SET estado='PEND_ADMIN', sup_por=?, sup_at=NOW() WHERE id=? AND estado='PEND_SUPERVISOR'`, [yo, id]);
      if (u.affectedRows !== 1) return fail(res, 'La solicitud cambió de estado; recarga', 409);
      auditar({ req, accion: 'APROBAR', modulo: 'rrhh', entidad: 'rh_ingreso', entidad_id: id, detalle: `Supervisor aprobó ingreso de ${s.nombre} ${s.apellido}` });
      avisar(await correosAdmin(), `🧑‍💼 Contratación por aprobar — ${s.nombre} ${s.apellido}`,
        `<p style="margin:0 0 12px">El supervisor ya aprobó esta contratación. Falta la <b>aprobación del Administrador</b> para crear el usuario:</p>${ficha(s)}`);
      return ok(res, { estado: 'PEND_ADMIN' });
    }

    if (s.estado === 'PEND_ADMIN') {
      if (!(await esAdmin(yo))) return fail(res, 'Solo un Administrador aprueba esta etapa', 403);
      const [u] = await pool.query(`UPDATE rh_ingresos SET estado='CREANDO' WHERE id=? AND estado='PEND_ADMIN'`, [id]);
      if (u.affectedRows !== 1) return fail(res, 'La solicitud cambió de estado; recarga', 409);
      let alta;
      try {
        alta = await require('../../../usuarios/src/controllers/usuarios.controller').altaUsuario(s, req);
      } catch (e) {
        const msg = e.code === 'ER_DUP_ENTRY' ? 'El RUT o correo ya están registrados como usuario' : e.message;
        await pool.query(`UPDATE rh_ingresos SET estado='PEND_ADMIN', error_alta=? WHERE id=?`, [String(msg).slice(0, 300), id]);
        return fail(res, msg, 409);
      }
      await pool.query(`UPDATE rh_ingresos SET estado='APROBADA', admin_por=?, admin_at=NOW(), id_usuario=?, correo_enviado=?, error_alta=NULL WHERE id=?`,
        [yo, alta.id_usuario, alta.envio.ok ? 1 : 0, id]);
      // Ficha RRHH con lo laboral que ya se conoce (fuente única rh_fichas)
      await pool.query(`INSERT INTO rh_fichas (id_usuario, tipo_contrato, jornada, updated_by) VALUES (?,?,?,?)
        ON DUPLICATE KEY UPDATE tipo_contrato=VALUES(tipo_contrato), jornada=VALUES(jornada)`,
        [alta.id_usuario, s.tipo_contrato, s.jornada, 'Ingreso de colaboradores']).catch(e => console.error('[ingresos ficha]', e.message));
      auditar({ req, accion: 'APROBAR', modulo: 'rrhh', entidad: 'rh_ingreso', entidad_id: id,
        detalle: `Administrador aprobó ingreso de ${s.nombre} ${s.apellido}: usuario #${alta.id_usuario} creado${alta.envio.ok ? ' y correo enviado' : ' (correo NO enviado)'}` });
      const [[cr]] = await pool.query('SELECT email FROM usuarios WHERE id_usuario=?', [s.creado_por]);
      avisar(cr?.email, `✅ Contratación aprobada — ${s.nombre} ${s.apellido}`,
        `<p style="margin:0 0 12px">La contratación quedó aprobada y el usuario está creado${alta.envio.ok ? '; el colaborador recibió su usuario y clave por correo' : '. <b>El correo con la clave NO salió</b>: pide al Administrador que la entregue'}.</p>${ficha(s)}
         <p style="margin:0">Completa su ficha (previsión, sueldo, cuenta de pago) en RRHH › Colaboradores.</p>`);
      return ok(res, { estado: 'APROBADA', id_usuario: alta.id_usuario, correo_enviado: alta.envio.ok,
        clave_temporal: alta.envio.ok ? null : alta.claveTemporal, correo_error: alta.envio.ok ? null : alta.envio.error });
    }
    fail(res, `La solicitud está ${s.estado}`, 409);
  } catch (e) { fail(res, e.message); }
};

/* POST /api/rrhh/ingresos/:id/rechazar { motivo } — supervisor o Administrador en su etapa */
exports.rechazar = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10), yo = req.usuario.id_usuario;
    const motivo = String(req.body?.motivo || '').trim().slice(0, 300);
    if (!motivo) return fail(res, 'Indica el motivo del rechazo', 400);
    const [[s]] = await pool.query('SELECT * FROM rh_ingresos WHERE id=?', [id]);
    if (!s) return fail(res, 'Solicitud no existe', 404);
    const puede = (s.estado === 'PEND_SUPERVISOR' && Number(s.id_supervisor) === Number(yo)) || (s.estado === 'PEND_ADMIN' && await esAdmin(yo));
    if (!puede) return fail(res, 'No te corresponde resolver esta solicitud', 403);
    const [u] = await pool.query(`UPDATE rh_ingresos SET estado='RECHAZADA', rechazo_por=?, rechazo_at=NOW(), motivo_rechazo=? WHERE id=? AND estado=?`, [yo, motivo, id, s.estado]);
    if (u.affectedRows !== 1) return fail(res, 'La solicitud cambió de estado; recarga', 409);
    auditar({ req, accion: 'RECHAZAR', modulo: 'rrhh', entidad: 'rh_ingreso', entidad_id: id, detalle: `Rechazó ingreso de ${s.nombre} ${s.apellido}: ${motivo}` });
    const [[cr]] = await pool.query('SELECT email FROM usuarios WHERE id_usuario=?', [s.creado_por]);
    avisar(cr?.email, `❌ Contratación rechazada — ${s.nombre} ${s.apellido}`, `<p style="margin:0 0 12px">Motivo: <b>${motivo.replace(/</g, '&lt;')}</b></p>${ficha(s)}`);
    ok(res, { estado: 'RECHAZADA' });
  } catch (e) { fail(res, e.message); }
};
