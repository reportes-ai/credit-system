'use strict';
/* ───────────────────────────────────────────────────────────────────
   Calendario de Visitas de Concesionarios + Bitácora de gestiones.

   - Configuración paramétrica: N° de visitas por día + días de la semana
     habilitados (visitas_config, singleton).
   - Agenda/calendario: visitas programadas a un dealer en una fecha,
     respetando los días habilitados y el tope diario POR USUARIO.
   - Gestión/bitácora: al realizar la visita el usuario registra el
     resultado (POSITIVO/NEGATIVO) + comentarios + seguimiento con fecha.
   - El usuario gestiona lo suyo; Supervisor/Gerentes (visitas_supervisar)
     revisan todas las gestiones y el calendario de todos, y configuran.
   ─────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { tieneFunc } = require('../../../../shared/middleware/permisos');

const DIAS_DEFAULT = '1,2,3,4,5'; // ISO: 1=Lun … 7=Dom

/* ─── Migración + seed de permisos ─────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS visitas_config (
        id          TINYINT      PRIMARY KEY DEFAULT 1,
        visitas_dia INT          NOT NULL DEFAULT 4,
        dias_semana VARCHAR(20)  NOT NULL DEFAULT '1,2,3,4,5',
        updated_at  DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        updated_by  VARCHAR(150) NULL
      )`);
    await pool.query(
      `INSERT IGNORE INTO visitas_config (id, visitas_dia, dias_semana) VALUES (1, 4, ?)`, [DIAS_DEFAULT]);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS visitas_dealers (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        id_dealer        INT          NULL,
        rut_dealer       VARCHAR(20)  NULL,
        nombre_dealer    VARCHAR(200) NULL,
        comuna           VARCHAR(120) NULL,
        fecha_programada DATE         NOT NULL,
        id_usuario       INT          NULL,
        usuario_nombre   VARCHAR(200) NULL,
        estado           VARCHAR(20)  NOT NULL DEFAULT 'PROGRAMADA',
        resultado        VARCHAR(10)  NULL,
        comentarios      TEXT         NULL,
        fecha_realizada  DATETIME     NULL,
        seguimiento_fecha DATE        NULL,
        seguimiento_nota VARCHAR(400) NULL,
        created_at       DATETIME     DEFAULT CURRENT_TIMESTAMP,
        updated_at       DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_fecha (fecha_programada),
        INDEX idx_usuario (id_usuario),
        INDEX idx_dealer (id_dealer),
        INDEX idx_estado (estado),
        INDEX idx_seg (seguimiento_fecha)
      )`);

    // Permisos paramétricos
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' LIMIT 1");
    if (mod) {
      const ensure = async (nombre, codigo, filtroPerfiles) => {
        const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=?', [codigo]);
        let idF = ex?.id_funcionalidad;
        if (!idF) {
          const [ins] = await pool.query(
            'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href) VALUES (?,?,?,?)',
            [mod.id_modulo, nombre, codigo, null]);
          idF = ins.insertId;
        }
        await pool.query(
          `INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
             SELECT id_perfil, ?, 1 FROM perfiles WHERE ${filtroPerfiles}`, [idF]);
        return idF;
      };
      await ensure('Visitas de Dealers — gestionar', 'visitas_dealers',
        "nombre='Administrador' OR nombre LIKE 'Gerente%' OR nombre LIKE 'Supervisor%' OR nombre LIKE 'Ejecutivo%' OR nombre LIKE 'Comercial%'");
      await ensure('Visitas de Dealers — supervisar', 'visitas_supervisar',
        "nombre='Administrador' OR nombre LIKE 'Gerente%' OR nombre LIKE 'Supervisor%'");
    }
    console.log('✓ módulo visitas-dealers: tablas + permisos listos');
  } catch (e) { console.error('[visitas migration]', e.message); }
})();

/* ─── Helpers ──────────────────────────────────────────────────────── */
const ok  = (res, data) => res.json({ success: true, data, error: null });
const err = (res, code, msg) => res.status(code).json({ success: false, data: null, error: msg });
const isoDow = (ymd) => { const d = new Date(ymd + 'T12:00:00'); const n = d.getDay(); return n === 0 ? 7 : n; };
const nombreUsuario = u => [u?.nombre, u?.apellido].filter(Boolean).join(' ') || u?.email || 'Usuario';

async function leerConfig() {
  const [[c]] = await pool.query('SELECT visitas_dia, dias_semana FROM visitas_config WHERE id=1');
  const dias = String(c?.dias_semana || DIAS_DEFAULT).split(',').map(s => parseInt(s.trim())).filter(n => n >= 1 && n <= 7);
  return { visitas_dia: c?.visitas_dia || 4, dias_semana: dias };
}

/* ─── GET /api/visitas/config ──────────────────────────────────────── */
const getConfig = async (req, res) => {
  try { ok(res, await leerConfig()); }
  catch (e) { console.error('[visitas getConfig]', e); err(res, 500, 'Error interno del servidor'); }
};

/* ─── PUT /api/visitas/config (visitas_supervisar) ─────────────────── */
const putConfig = async (req, res) => {
  try {
    let { visitas_dia, dias_semana } = req.body || {};
    visitas_dia = parseInt(visitas_dia);
    if (!visitas_dia || visitas_dia < 1 || visitas_dia > 50) return err(res, 400, 'N° de visitas por día inválido (1-50).');
    const dias = (Array.isArray(dias_semana) ? dias_semana : String(dias_semana || '').split(','))
      .map(d => parseInt(d)).filter(n => n >= 1 && n <= 7);
    if (!dias.length) return err(res, 400, 'Debes habilitar al menos un día de la semana.');
    await pool.query(
      'UPDATE visitas_config SET visitas_dia=?, dias_semana=?, updated_by=? WHERE id=1',
      [visitas_dia, [...new Set(dias)].sort((a, b) => a - b).join(','), nombreUsuario(req.usuario)]);
    auditar({ req, accion: 'EDITAR', modulo: 'visitas', entidad: 'config', entidad_id: 1,
      detalle: `Config visitas: ${visitas_dia}/día · días ${dias.join(',')}` });
    ok(res, await leerConfig());
  } catch (e) { console.error('[visitas putConfig]', e); err(res, 500, 'Error interno del servidor'); }
};

/* ─── GET /api/visitas/dealers — selector ──────────────────────────── */
const getDealers = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id_dealer, rut,
              COALESCE(NULLIF(TRIM(nombre_indexa),''), NULLIF(TRIM(nombre_razon),''), rut) AS nombre,
              comuna
         FROM dealers ORDER BY nombre LIMIT 5000`);
    ok(res, rows);
  } catch (e) { console.error('[visitas getDealers]', e); err(res, 500, 'Error interno del servidor'); }
};

/* ─── GET /api/visitas?desde=&hasta=&estado=&resultado=&usuario=&scope= ─ */
const listar = async (req, res) => {
  try {
    const uid = req.usuario.id_usuario;
    const esRevisor = await tieneFunc(uid, 'visitas_supervisar');
    const { desde, hasta, estado, resultado, usuario } = req.query;
    const scopeTodos = esRevisor && String(req.query.scope || '') === 'todos';

    const where = [], pars = [];
    if (!esRevisor) { where.push('id_usuario = ?'); pars.push(uid); }
    else if (!scopeTodos && !usuario) { where.push('id_usuario = ?'); pars.push(uid); }   // por defecto el revisor ve lo suyo
    else if (usuario) { where.push('id_usuario = ?'); pars.push(parseInt(usuario) || 0); }
    if (desde) { where.push('fecha_programada >= ?'); pars.push(desde); }
    if (hasta) { where.push('fecha_programada <= ?'); pars.push(hasta); }
    if (estado) { where.push('estado = ?'); pars.push(estado); }
    if (resultado) { where.push('resultado = ?'); pars.push(resultado); }

    const [rows] = await pool.query(
      `SELECT * FROM visitas_dealers
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY fecha_programada DESC, id DESC LIMIT 2000`, pars);

    // Lista de usuarios con visitas (para el filtro del revisor)
    let usuarios = [];
    if (esRevisor) {
      const [u] = await pool.query(
        'SELECT DISTINCT id_usuario, usuario_nombre FROM visitas_dealers WHERE id_usuario IS NOT NULL ORDER BY usuario_nombre');
      usuarios = u;
    }
    ok(res, { rows, esRevisor, usuarios });
  } catch (e) { console.error('[visitas listar]', e); err(res, 500, 'Error interno del servidor'); }
};

/* ─── POST /api/visitas (visitas_dealers) — agendar ────────────────── */
const crear = async (req, res) => {
  try {
    const { id_dealer, rut_dealer, nombre_dealer, comuna, fecha_programada } = req.body || {};
    if (!fecha_programada || !/^\d{4}-\d{2}-\d{2}$/.test(fecha_programada)) return err(res, 400, 'Fecha de visita inválida.');
    if (!nombre_dealer && !id_dealer && !rut_dealer) return err(res, 400, 'Debes seleccionar un concesionario.');

    const cfg = await leerConfig();
    if (!cfg.dias_semana.includes(isoDow(fecha_programada)))
      return err(res, 400, 'Ese día de la semana no está habilitado para visitas.');

    const uid = req.usuario.id_usuario;
    const [[cnt]] = await pool.query(
      'SELECT COUNT(*) AS n FROM visitas_dealers WHERE id_usuario=? AND fecha_programada=?', [uid, fecha_programada]);
    if (cnt.n >= cfg.visitas_dia)
      return err(res, 400, `Tope alcanzado: ya tienes ${cfg.visitas_dia} visita(s) ese día.`);

    const [r] = await pool.query(
      `INSERT INTO visitas_dealers
         (id_dealer, rut_dealer, nombre_dealer, comuna, fecha_programada, id_usuario, usuario_nombre, estado)
       VALUES (?,?,?,?,?,?,?, 'PROGRAMADA')`,
      [id_dealer || null, rut_dealer || null, nombre_dealer || null, comuna || null,
       fecha_programada, uid, nombreUsuario(req.usuario)]);
    auditar({ req, accion: 'CREAR', modulo: 'visitas', entidad: 'visita', entidad_id: r.insertId,
      detalle: `Visita agendada a ${nombre_dealer || rut_dealer || '—'} para ${fecha_programada}`, rut: rut_dealer });
    ok(res, { id: r.insertId });
  } catch (e) { console.error('[visitas crear]', e); err(res, 500, 'Error interno del servidor'); }
};

/* ─── PUT /api/visitas/:id/gestion (visitas_dealers) — registrar ──── */
const gestionar = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { resultado, comentarios, seguimiento_fecha, seguimiento_nota } = req.body || {};
    if (!['POSITIVO', 'NEGATIVO'].includes(resultado)) return err(res, 400, 'Resultado debe ser POSITIVO o NEGATIVO.');
    if (seguimiento_fecha && !/^\d{4}-\d{2}-\d{2}$/.test(seguimiento_fecha)) return err(res, 400, 'Fecha de seguimiento inválida.');

    const [[v]] = await pool.query('SELECT id_usuario FROM visitas_dealers WHERE id=?', [id]);
    if (!v) return err(res, 404, 'Visita no encontrada.');
    const uid = req.usuario.id_usuario;
    if (v.id_usuario !== uid && !(await tieneFunc(uid, 'visitas_supervisar')))
      return err(res, 403, 'Solo puedes registrar tus propias visitas.');

    await pool.query(
      `UPDATE visitas_dealers
          SET estado='REALIZADA', resultado=?, comentarios=?, fecha_realizada=NOW(),
              seguimiento_fecha=?, seguimiento_nota=?
        WHERE id=?`,
      [resultado, comentarios || null, seguimiento_fecha || null, seguimiento_nota || null, id]);
    auditar({ req, accion: 'GESTION', modulo: 'visitas', entidad: 'visita', entidad_id: id,
      detalle: `Visita ${resultado}${seguimiento_fecha ? ' · seguimiento ' + seguimiento_fecha : ''}` });
    ok(res, { id });
  } catch (e) { console.error('[visitas gestionar]', e); err(res, 500, 'Error interno del servidor'); }
};

/* ─── DELETE /api/visitas/:id ──────────────────────────────────────── */
const eliminar = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [[v]] = await pool.query('SELECT id_usuario, estado, nombre_dealer FROM visitas_dealers WHERE id=?', [id]);
    if (!v) return err(res, 404, 'Visita no encontrada.');
    const uid = req.usuario.id_usuario;
    const esRevisor = await tieneFunc(uid, 'visitas_supervisar');
    if (v.id_usuario !== uid && !esRevisor) return err(res, 403, 'Sin permiso para eliminar esta visita.');
    if (v.estado === 'REALIZADA' && !esRevisor) return err(res, 403, 'Una visita realizada solo la puede eliminar un supervisor.');
    await pool.query('DELETE FROM visitas_dealers WHERE id=?', [id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'visitas', entidad: 'visita', entidad_id: id,
      detalle: `Visita eliminada (${v.nombre_dealer || '—'})` });
    ok(res, { id });
  } catch (e) { console.error('[visitas eliminar]', e); err(res, 500, 'Error interno del servidor'); }
};

module.exports = { getConfig, putConfig, getDealers, listar, crear, gestionar, eliminar };
