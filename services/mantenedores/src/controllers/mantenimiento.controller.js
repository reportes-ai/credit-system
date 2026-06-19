const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

/* ─────────────────────────────────────────────────────────────────────────────
   Mantención de Sistema. Estado (activo/mensaje) en tabla propia mantenimiento_config
   (aislada de los config_* genéricos para que NADIE la escriba por otra vía).
   - Lectura: cualquier usuario autenticado (la necesita el overlay), pero el MENSAJE
     en reposo solo se expone a BG-ADMIN; al resto solo cuando está activo.
   - Escritura: SOLO BG-ADMIN (usuarios.protegido). Ni siquiera otro Administrador.
   ───────────────────────────────────────────────────────────────────────────── */

const MSG_DEFAULT = 'AVISO. El sistema se encuentra en Mantención.';

(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS mantenimiento_config (
      clave VARCHAR(40) PRIMARY KEY, valor TEXT )`);
    await pool.query("INSERT IGNORE INTO mantenimiento_config (clave, valor) VALUES ('activo','0'), ('mensaje', ?)", [MSG_DEFAULT]);
  } catch (e) { console.error('[mantenimiento migration]', e.message); }
})();

async function esBreakGlass(id) {
  try { const [[u]] = await pool.query('SELECT protegido FROM usuarios WHERE id_usuario = ? LIMIT 1', [id]); return !!(u && u.protegido); }
  catch { return false; }
}

async function leerConfig() {
  const [rows] = await pool.query('SELECT clave, valor FROM mantenimiento_config');
  const m = {}; rows.forEach(r => { m[r.clave] = r.valor; });
  return { activo: m.activo === '1', mensaje: m.mensaje || MSG_DEFAULT };
}

/* GET /api/mantenimiento → { activo, mensaje, es_bg }. El mensaje en reposo solo va a BG-ADMIN. */
const getEstado = async (req, res) => {
  try {
    const cfg = await leerConfig();
    const bg = await esBreakGlass(req.usuario.id_usuario);
    res.json({ success: true, data: { activo: cfg.activo, mensaje: (cfg.activo || bg) ? cfg.mensaje : '', es_bg: bg }, error: null });
  } catch (e) { console.error('[mantenimiento getEstado]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* PUT /api/mantenimiento → activa/desactiva + mensaje. SOLO BG-ADMIN. */
const setEstado = async (req, res) => {
  try {
    if (!(await esBreakGlass(req.usuario.id_usuario)))
      return res.status(403).json({ success: false, data: null, error: 'Solo BG-ADMIN puede modificar la mantención.' });
    const activo = req.body.activo ? '1' : '0';
    let mensaje = String(req.body.mensaje == null ? '' : req.body.mensaje).slice(0, 500);
    if (!mensaje.trim()) mensaje = MSG_DEFAULT;
    await pool.query("INSERT INTO mantenimiento_config (clave, valor) VALUES ('activo', ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)", [activo]);
    await pool.query("INSERT INTO mantenimiento_config (clave, valor) VALUES ('mensaje', ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)", [mensaje]);
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'mantenimiento_sistema', entidad_id: 'config',
      detalle: `Mantención ${activo === '1' ? 'ACTIVADA' : 'desactivada'}`, meta: { activo, mensaje } });
    res.json({ success: true, data: { activo: activo === '1', mensaje }, error: null });
  } catch (e) { console.error('[mantenimiento setEstado]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { getEstado, setEstado };
