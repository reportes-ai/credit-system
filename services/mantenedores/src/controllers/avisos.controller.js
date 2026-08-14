/* ─────────────────────────────────────────────────────────────────────────────
   MANTENEDOR DE AVISOS (campanita) — quién recibe cada aviso, por perfil y/o
   por usuario. La resolución vive en shared/avisos.js (motor único); acá solo
   se lee y se escribe la configuración, y se muestra la lista REAL de personas
   que quedarían recibiendo cada aviso con la config vigente.
   ──────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const A = require('../../../../shared/avisos');
const { auditar } = require('../../../../shared/audit');

const ok  = (res, data) => res.json({ success: true, data, error: null });
const err = (res, code, msg) => res.status(code).json({ success: false, data: null, error: msg });

/* Registro como SUB-ITEM del módulo Mantenedores (30001), igual que el resto:
   una funcionalidad con href, no un módulo aparte. Así aparece solo la card en
   la landing de Mantenedores y respeta la matriz de permisos. */
require('../../../../shared/migrate').enFila('avisos-mantenedor', async () => {
  try {
    const [[f]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mant_avisos' LIMIT 1");
    let idF = f && f.id_funcionalidad;
    if (!idF) {
      const [r] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (30001,'Avisos (campanita)','mant_avisos','/mantenedores/avisos/','bi-bell')");
      idF = r.insertId;
    }
    // Solo Administrador: define quién se entera de qué en toda la empresa.
    const [[p]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    if (p && idF) await pool.query(
      'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [p.id_perfil, idF]);
  } catch (e) { console.error('[avisos mantenedor migration]', e.message); }
});

/* ── GET /api/avisos — eventos + catálogos + destinatarios resueltos ──────── */
const getTodos = async (req, res) => {
  try {
    const [eventos] = await pool.query('SELECT * FROM avisos_config ORDER BY modulo, nombre');
    const [perfiles] = await pool.query('SELECT id_perfil, nombre FROM perfiles ORDER BY nombre');
    const [usuarios] = await pool.query(
      `SELECT u.id_usuario, TRIM(CONCAT(u.nombre,' ',COALESCE(u.apellido,''))) nombre, u.email, p.nombre perfil
         FROM usuarios u LEFT JOIN perfiles p ON p.id_perfil=u.id_perfil
        WHERE u.estado='activo' ORDER BY nombre`);
    const mapaU = {}; usuarios.forEach(u => { mapaU[u.id_usuario] = u; });

    // Lo importante del mantenedor: ver a QUIÉN le llega hoy cada aviso.
    for (const e of eventos) {
      const dest = await A.destinatarios(e.evento);
      e.destinatarios = dest.map(id => mapaU[id] || { id_usuario: id, nombre: '(usuario inactivo o eliminado)', email: '', perfil: '' });
    }
    ok(res, { eventos, perfiles, usuarios, sonidos: A.SONIDOS });
  } catch (e) { console.error('[avisos getTodos]', e.message); err(res, 500, 'Error interno del servidor'); }
};

/* ── PUT /api/avisos/:evento ─────────────────────────────────────────────── */
const guardar = async (req, res) => {
  try {
    const evento = String(req.params.evento || '').trim();
    if (!evento) return err(res, 400, 'Evento requerido');
    const [[actual]] = await pool.query('SELECT * FROM avisos_config WHERE evento=?', [evento]);
    if (!actual) return err(res, 404, 'Ese aviso no existe');

    const b = req.body || {};
    const csv = v => Array.isArray(v) ? v.join(',') : String(v == null ? '' : v);
    const sonTipo = A.SONIDOS.includes(b.sonido_tipo) ? b.sonido_tipo : actual.sonido_tipo;

    await pool.query(
      `UPDATE avisos_config SET usa_func=?, incluir_admin=?, perfiles=?, usuarios=?, excluir=?,
              activo=?, prioridad=?, sonido=?, sonido_tipo=?, banner=?, banner_dur=? WHERE evento=?`,
      [b.usa_func ? 1 : 0, b.incluir_admin ? 1 : 0, csv(b.perfiles), csv(b.usuarios), csv(b.excluir),
       b.activo ? 1 : 0, b.prioridad === 'alta' ? 'alta' : 'normal', b.sonido ? 1 : 0, sonTipo,
       b.banner ? 1 : 0, Math.min(120, Math.max(2, parseInt(b.banner_dur) || 6)), evento]);

    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'aviso', entidad_id: evento,
      detalle: `Configuró destinatarios del aviso "${actual.nombre}"`, meta: b });

    const dest = await A.destinatarios(evento);
    ok(res, { evento, destinatarios: dest.length });
  } catch (e) { console.error('[avisos guardar]', e.message); err(res, 500, 'Error interno del servidor'); }
};

module.exports = { getTodos, guardar };
