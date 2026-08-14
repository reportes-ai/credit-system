/* ─────────────────────────────────────────────────────────────────
   MANTENEDOR — Permisos de edición de dealers por perfil y por campo

   Alimenta la pestaña "Permisos de edición" de Mantenedores › Dealers.
   Las reglas (y el porqué de cada una) viven en shared/dealer-campos.js,
   que es el motor único que consultan las dos pantallas y los guardados.
   ───────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const DC = require('../../../../shared/dealer-campos');

/* GET /api/dealer-campos — catálogo + perfiles + lo que hoy está bloqueado */
const getMatriz = async (_req, res) => {
  try {
    const [perfiles] = await pool.query('SELECT id_perfil, nombre FROM perfiles ORDER BY nombre');
    const [rows] = await pool.query('SELECT id_perfil, pantalla, campo, puede_editar FROM dealer_campos_permisos');
    res.json({ success: true, data: { perfiles, campos: DC.CAMPOS, acceso: DC.ACCESO, reglas: rows }, error: null });
  } catch (e) { console.error('[dealer-campos matriz]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* PUT /api/dealer-campos — reemplaza las reglas de UN perfil (envía solo lo bloqueado).
   Guardar por perfil evita pisar el trabajo de otro administrador editando otra fila. */
const guardar = async (req, res) => {
  try {
    const idPerfil = parseInt(req.body.id_perfil);
    const bloqueos = req.body.bloqueos || {};   // { FICHA:[campos], DEALER:[campos] }
    if (!idPerfil) return res.status(400).json({ success: false, data: null, error: 'Falta el perfil' });
    const [[p]] = await pool.query('SELECT nombre FROM perfiles WHERE id_perfil=?', [idPerfil]);
    if (!p) return res.status(404).json({ success: false, data: null, error: 'Perfil no encontrado' });
    if (p.nombre === 'Administrador')
      return res.status(400).json({ success: false, data: null, error: 'El perfil Administrador no se restringe (convención del sistema)' });

    const validos = {};
    DC.PANTALLAS.forEach(pa => { validos[pa] = new Set([DC.ACCESO, ...(DC.CAMPOS[pa] || []).map(c => c.campo)]); });
    const filas = [];
    const quien = [req.usuario.nombre, req.usuario.apellido].filter(Boolean).join(' ') || req.usuario.email;
    DC.PANTALLAS.forEach(pa => {
      (bloqueos[pa] || []).forEach(campo => {
        if (validos[pa].has(campo)) filas.push([idPerfil, pa, campo, 0, quien]);
      });
    });

    await pool.query('DELETE FROM dealer_campos_permisos WHERE id_perfil=?', [idPerfil]);
    if (filas.length)
      await pool.query('INSERT INTO dealer_campos_permisos (id_perfil, pantalla, campo, puede_editar, actualizado_por, actualizado) VALUES ' +
        filas.map(() => '(?,?,?,?,?,NOW())').join(','), filas.flat());
    DC.invalidarCache();

    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'dealer_campos_permisos', entidad_id: idPerfil,
      detalle: `Permisos de edición de dealers del perfil ${p.nombre}: ${filas.length} restricción(es)`, meta: bloqueos });
    res.json({ success: true, data: { id_perfil: idPerfil, restricciones: filas.length }, error: null });
  } catch (e) { console.error('[dealer-campos guardar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* GET /api/dealer-campos/mios — lo que puede el usuario que pregunta (lo usan
   la ficha y el modal Editar Dealer para pintar en gris lo que no se toca). */
const mios = async (req, res) => {
  try { res.json({ success: true, data: await DC.permisosDe(req.usuario), error: null }); }
  catch (e) { console.error('[dealer-campos mios]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { getMatriz, guardar, mios };
