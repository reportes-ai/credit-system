const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { leerAnuncio } = require('../../../../shared/anuncios');
const { comunicadosParaUsuario } = require('../../../../shared/comunicados');

/* ─────────────────────────────────────────────────────────────────────────────
   Mantención de Sistema. Estado (activo/mensaje) en tabla propia mantenimiento_config
   (aislada de los config_* genéricos para que NADIE la escriba por otra vía).
   - Lectura: cualquier usuario autenticado (la necesita el overlay), pero el MENSAJE
     en reposo solo se expone a BG-ADMIN; al resto solo cuando está activo.
   - Escritura: SOLO BG-ADMIN (usuarios.protegido). Ni siquiera otro Administrador.
   ───────────────────────────────────────────────────────────────────────────── */

const MSG_DEFAULT = 'AVISO. El sistema se encuentra en Mantención.';

require('../../../../shared/migrate').enFila('mantenimiento', async () => {
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
});

/* ── Caché en memoria de mantenimiento_config (costo de Request Units) ──────────
   Este endpoint lo consulta CADA pestaña de CADA usuario en bucle, y antes hacía
   CUATRO lecturas separadas de esta misma tabla —que tiene un puñado de filas y
   cambia una vez cada varios meses—. Ahora: una sola query con 5 s de caché.
   Con 15 usuarios conectados pasa de ~450 consultas/min a menos de 15.
   Las escrituras invalidan el caché (invalidarCfg), así que activar la mantención,
   el Modo Desarrollo o lanzar un juego sigue surtiendo efecto de inmediato. */
const CFG_TTL_MS = 5000;
let _cfgMap = null, _cfgExp = 0;
async function cfgMap() {
  if (_cfgMap && Date.now() < _cfgExp) return _cfgMap;
  const [rows] = await pool.query('SELECT clave, valor FROM mantenimiento_config');
  const m = {}; rows.forEach(r => { m[r.clave] = r.valor; });
  _cfgMap = m; _cfgExp = Date.now() + CFG_TTL_MS;
  return m;
}
const invalidarCfg = () => { _cfgMap = null; _cfgExp = 0; };

const JUEGOS_OK = ['snake', 'runner', 'breakout', 'topo', 'catapulta', 'comeletras', 'escapistas', 'vidrio', 'terminal', 'clickloco'];
async function leerJuego() {
  const m = await cfgMap();
  return { activo: m.juego_activo === '1', nombre: m.juego_nombre || '', mensaje: m.juego_mensaje || '', nonce: m.juego_nonce || '' };
}

/* El flag break-glass de un usuario no cambia nunca en caliente: caché de 5 min
   por usuario en vez de un SELECT a `usuarios` en cada sondeo. */
const BG_TTL_MS = 5 * 60 * 1000;
const _bgCache = new Map();
async function esBreakGlass(id) {
  const hit = _bgCache.get(id);
  if (hit && Date.now() < hit.exp) return hit.v;
  try {
    const [[u]] = await pool.query('SELECT protegido FROM usuarios WHERE id_usuario = ? LIMIT 1', [id]);
    const v = !!(u && u.protegido);
    _bgCache.set(id, { v, exp: Date.now() + BG_TTL_MS });
    return v;
  } catch { return false; }
}

async function leerConfig() {
  const m = await cfgMap();
  return { activo: m.activo === '1', mensaje: m.mensaje || MSG_DEFAULT };
}

// Config del Modo Desarrollo (3 correos con rol to/cc/bcc + whatsapp de prueba).
async function leerDev() {
  const m = await cfgMap();
  const def = { 1: 'to', 2: 'cc', 3: 'bcc' };
  const correos = [1, 2, 3].map(i => ({
    email: m['dev_correo' + i] || '',
    rol:   (m['dev_correo' + i + '_rol'] || def[i]).toLowerCase(),
  }));
  return { activo: m.dev_activo === '1', correos, whatsapp: m.dev_whatsapp || '' };
}

/* Cambio de TMC (una vez al mes, ~día 15): se avisa a TODOS con un modal que no
   se va hasta apretar ENTENDIDO. Viaja pegado a este endpoint —que ya se pollea—
   para no agregar otra consulta a TiDB por cada usuario y cada página.
   Caché 10 min: la TMC cambia una vez al mes, no hace falta ir a la base seguido. */
let _tmcCache = { ts: 0, val: null };
async function leerTMC() {
  if (_tmcCache.val !== null && Date.now() - _tmcCache.ts < 10 * 60 * 1000) return _tmcCache.val;
  let val = null;
  try {
    const [rows] = await pool.query(
      `SELECT id_tasa, fecha_desde, fecha_hasta, tasa_anual_menor, tasa_mensual_menor,
              tasa_anual_mayor, tasa_mensual_mayor, fecha_creacion
         FROM tasas ORDER BY fecha_desde DESC LIMIT 2`);
    const n = rows[0], a = rows[1];
    // Solo se avisa dentro de los 15 días siguientes al cambio: pasado eso ya es noticia vieja.
    if (n && (Date.now() - new Date(n.fecha_creacion || n.fecha_desde).getTime()) < 15 * 24 * 3600 * 1000) {
      const num = v => (v == null ? null : Number(v));
      val = {
        id: n.id_tasa,
        desde: n.fecha_desde, hasta: n.fecha_hasta,
        nueva: { anual_menor: num(n.tasa_anual_menor), mensual_menor: num(n.tasa_mensual_menor),
                 anual_mayor: num(n.tasa_anual_mayor), mensual_mayor: num(n.tasa_mensual_mayor) },
        anterior: a ? { anual_menor: num(a.tasa_anual_menor), mensual_menor: num(a.tasa_mensual_menor),
                        anual_mayor: num(a.tasa_anual_mayor), mensual_mayor: num(a.tasa_mensual_mayor),
                        desde: a.fecha_desde, hasta: a.fecha_hasta } : null,
      };
    }
  } catch (e) { console.error('[mantenimiento tmc]', e.message); }
  _tmcCache = { ts: Date.now(), val };
  return val;
}

/* GET /api/mantenimiento → { activo, mensaje, es_bg }. El mensaje en reposo solo va a BG-ADMIN. */
const getEstado = async (req, res) => {
  try {
    const cfg = await leerConfig();
    const bg = await esBreakGlass(req.usuario.id_usuario);
    const dev = await leerDev();
    const jg = await leerJuego();
    // El cliente manda el id del último anuncio que ya mostró (localStorage): así los
    // que ocurrieron con la pestaña cerrada le suenan al volver.
    const anuncio = await leerAnuncio(req.query.anuncio_desde);
    const comunicados = await comunicadosParaUsuario(req.usuario);
    res.json({ success: true, data: { activo: cfg.activo, mensaje: (cfg.activo || bg) ? cfg.mensaje : '', es_bg: bg, dev_activo: dev.activo,
      juego: (jg.activo && JUEGOS_OK.includes(jg.nombre)) ? { nombre: jg.nombre, mensaje: jg.mensaje, nonce: jg.nonce } : null,
      anuncio, comunicados, tmc: await leerTMC() }, error: null });
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
    invalidarCfg();
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
    invalidarCfg();
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
    invalidarCfg();
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'humorada', entidad_id: 'config',
      detalle: `Humorada ${activo === '1' ? 'LANZADA (' + nombre + ')' : 'apagada'}`, meta: { activo, nombre, mensaje } });
    res.json({ success: true, data: await leerJuego(), error: null });
  } catch (e) { console.error('[mantenimiento setJuego]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { getEstado, setEstado, getDev, setDev, setJuego };
