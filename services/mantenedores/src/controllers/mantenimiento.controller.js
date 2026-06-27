const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { leerAnuncio } = require('../../../../shared/anuncios');

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
    // Modo DESARROLLO: redirige TODAS las comunicaciones a correos de prueba (no salen a clientes/dealers/proveedores).
    await pool.query(`INSERT IGNORE INTO mantenimiento_config (clave, valor) VALUES
      ('dev_activo','0'),
      ('dev_correo1',''),('dev_correo1_rol','to'),
      ('dev_correo2',''),('dev_correo2_rol','cc'),
      ('dev_correo3',''),('dev_correo3_rol','bcc'),
      ('dev_whatsapp','')`);
    // Humoradas (BG-ADMIN): juego flotante que aparece en la pantalla de TODOS los usuarios.
    await pool.query(`INSERT IGNORE INTO mantenimiento_config (clave, valor) VALUES
      ('juego_activo','0'),('juego_nombre',''),('juego_mensaje',''),('juego_nonce','')`);
  } catch (e) { console.error('[mantenimiento migration]', e.message); }
})();

const JUEGOS_OK = ['snake', 'runner', 'breakout', 'topo', 'catapulta', 'comeletras', 'escapistas', 'vidrio', 'terminal', 'clickloco'];
async function leerJuego() {
  const [rows] = await pool.query("SELECT clave, valor FROM mantenimiento_config WHERE clave LIKE 'juego_%'");
  const m = {}; rows.forEach(r => { m[r.clave] = r.valor; });
  return { activo: m.juego_activo === '1', nombre: m.juego_nombre || '', mensaje: m.juego_mensaje || '', nonce: m.juego_nonce || '' };
}

async function esBreakGlass(id) {
  try { const [[u]] = await pool.query('SELECT protegido FROM usuarios WHERE id_usuario = ? LIMIT 1', [id]); return !!(u && u.protegido); }
  catch { return false; }
}

async function leerConfig() {
  const [rows] = await pool.query('SELECT clave, valor FROM mantenimiento_config');
  const m = {}; rows.forEach(r => { m[r.clave] = r.valor; });
  return { activo: m.activo === '1', mensaje: m.mensaje || MSG_DEFAULT };
}

// Config del Modo Desarrollo (3 correos con rol to/cc/bcc + whatsapp de prueba).
async function leerDev() {
  const [rows] = await pool.query("SELECT clave, valor FROM mantenimiento_config WHERE clave LIKE 'dev_%'");
  const m = {}; rows.forEach(r => { m[r.clave] = r.valor; });
  const def = { 1: 'to', 2: 'cc', 3: 'bcc' };
  const correos = [1, 2, 3].map(i => ({
    email: m['dev_correo' + i] || '',
    rol:   (m['dev_correo' + i + '_rol'] || def[i]).toLowerCase(),
  }));
  return { activo: m.dev_activo === '1', correos, whatsapp: m.dev_whatsapp || '' };
}

/* GET /api/mantenimiento → { activo, mensaje, es_bg }. El mensaje en reposo solo va a BG-ADMIN. */
const getEstado = async (req, res) => {
  try {
    const cfg = await leerConfig();
    const bg = await esBreakGlass(req.usuario.id_usuario);
    const dev = await leerDev();
    const jg = await leerJuego();
    const anuncio = await leerAnuncio();
    res.json({ success: true, data: { activo: cfg.activo, mensaje: (cfg.activo || bg) ? cfg.mensaje : '', es_bg: bg, dev_activo: dev.activo,
      juego: (jg.activo && JUEGOS_OK.includes(jg.nombre)) ? { nombre: jg.nombre, mensaje: jg.mensaje, nonce: jg.nonce } : null,
      anuncio }, error: null });
  } catch (e) { console.error('[mantenimiento getEstado]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* GET /api/mantenimiento/dev → config del Modo Desarrollo. SOLO BG-ADMIN. */
const getDev = async (req, res) => {
  try {
    if (!(await esBreakGlass(req.usuario.id_usuario)))
      return res.status(403).json({ success: false, data: null, error: 'Solo BG-ADMIN puede ver el Modo Desarrollo.' });
    res.json({ success: true, data: await leerDev(), error: null });
  } catch (e) { console.error('[mantenimiento getDev]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* PUT /api/mantenimiento/dev → activa/edita Modo Desarrollo. SOLO BG-ADMIN. */
const setDev = async (req, res) => {
  try {
    if (!(await esBreakGlass(req.usuario.id_usuario)))
      return res.status(403).json({ success: false, data: null, error: 'Solo BG-ADMIN puede modificar el Modo Desarrollo.' });
    const b = req.body || {};
    const activo = b.activo ? '1' : '0';
    const correos = Array.isArray(b.correos) ? b.correos : [];
    const okMail = e => { e = String(e || '').trim().slice(0, 200); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : ''; };
    const okRol  = r => ['to', 'cc', 'bcc'].includes(String(r || '').toLowerCase()) ? String(r).toLowerCase() : 'to';
    const norm   = [0, 1, 2].map(i => ({ email: okMail((correos[i] || {}).email), rol: okRol((correos[i] || {}).rol) }));
    if (activo === '1' && !norm.some(c => c.email))
      return res.status(400).json({ success: false, data: null, error: 'Configura al menos un correo de destino para activar el Modo Desarrollo.' });
    const setKv = (k, v) => pool.query("INSERT INTO mantenimiento_config (clave, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)", [k, v]);
    await setKv('dev_activo', activo);
    for (let i = 0; i < 3; i++) { await setKv('dev_correo' + (i + 1), norm[i].email); await setKv('dev_correo' + (i + 1) + '_rol', norm[i].rol); }
    await setKv('dev_whatsapp', String(b.whatsapp || '').trim().slice(0, 30));
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'modo_desarrollo', entidad_id: 'config',
      detalle: `Modo Desarrollo ${activo === '1' ? 'ACTIVADO' : 'desactivado'}`, meta: { activo, correos: norm.filter(c => c.email).map(c => c.email + '(' + c.rol + ')') } });
    res.json({ success: true, data: await leerDev(), error: null });
  } catch (e) { console.error('[mantenimiento setDev]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
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

/* PUT /api/mantenimiento/juego → enciende/apaga la humorada para todos. SOLO BG-ADMIN. */
const setJuego = async (req, res) => {
  try {
    if (!(await esBreakGlass(req.usuario.id_usuario)))
      return res.status(403).json({ success: false, data: null, error: 'Solo BG-ADMIN puede lanzar humoradas.' });
    const activo = req.body.activo ? '1' : '0';
    const nombre = JUEGOS_OK.includes(req.body.juego) ? req.body.juego : '';
    const mensaje = String(req.body.mensaje == null ? '' : req.body.mensaje).slice(0, 200);
    if (activo === '1' && !nombre)
      return res.status(400).json({ success: false, data: null, error: 'Elige un juego válido.' });
    const setKv = (k, v) => pool.query("INSERT INTO mantenimiento_config (clave, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)", [k, v]);
    await setKv('juego_activo', activo);
    await setKv('juego_nombre', nombre);
    await setKv('juego_mensaje', mensaje);
    if (activo === '1') await setKv('juego_nonce', String(Date.now()));   // instancia nueva → permite relanzar
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'humorada', entidad_id: 'config',
      detalle: `Humorada ${activo === '1' ? 'LANZADA (' + nombre + ')' : 'apagada'}`, meta: { activo, nombre, mensaje } });
    res.json({ success: true, data: await leerJuego(), error: null });
  } catch (e) { console.error('[mantenimiento setJuego]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { getEstado, setEstado, getDev, setDev, setJuego };
