'use strict';
const pool = require('../../../../shared/config/database');
const ia = require('../../../../shared/ia');
const { auditar } = require('../../../../shared/audit');

/* ─────────────────────────────────────────────────────────────────────────────
   Mantenedor "Inteligencia Artificial". Activa/desactiva la IA (Anthropic) global,
   prende/apaga cada funcionalidad de IA por separado y edita los textos de branding.
   - Lectura (GET): cualquier usuario autenticado (la usa el componente de branding).
   - Escritura (PUT): requireFunc('mant_ia') → Administrador (bypass) o quien tenga
     la funcionalidad asignada en la matriz de Perfiles.
   El núcleo (tablas, helpers, caché) vive en shared/ia.js.
   ───────────────────────────────────────────────────────────────────────────── */

// Card en Mantenedores (funcionalidad + permiso Administrador)
(async () => {
  try {
    const [[m]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre = 'Mantenedores' LIMIT 1");
    if (!m) return;
    let [[f]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo = 'mant_ia' LIMIT 1");
    if (!f) {
      const [r] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)",
        [m.id_modulo, 'Inteligencia Artificial', 'mant_ia', '/mantenedores/inteligencia-artificial/', 'bi-robot']);
      f = { id_funcionalidad: r.insertId };
    }
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre = 'Administrador' LIMIT 1");
    if (adm) await pool.query("INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)", [adm.id_perfil, f.id_funcionalidad]);
  } catch (e) { console.error('[ia-config migration]', e.message); }
})();

/* GET /api/ia-config → { activa, texto_analizando, texto_analizado, mostrar_logo, funcionalidades[] } */
const getConfig = async (req, res) => {
  try { res.json({ success: true, data: await ia.getConfig(), error: null }); }
  catch (e) { console.error('[ia-config getConfig]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* PUT /api/ia-config → guardar config (gate requireFunc('mant_ia') en la ruta) */
const setConfig = async (req, res) => {
  try {
    const nueva = await ia.setConfig(req.body || {});
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'ia_config', entidad_id: 'config',
      detalle: `Configuración de IA actualizada (IA ${nueva.activa ? 'ACTIVADA' : 'desactivada'})`, meta: { activa: nueva.activa } });
    res.json({ success: true, data: nueva, error: null });
  } catch (e) { console.error('[ia-config setConfig]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { getConfig, setConfig };
