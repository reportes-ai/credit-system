/* ─────────────────────────────────────────────────────────────────────────────
   AVISOS (campanita) — MOTOR ÚNICO DE DESTINATARIOS

   Antes, cada módulo decidía por su cuenta a quién avisar con una query propia
   ("Administrador UNION quien tenga el permiso X"). Eso dejaba la lista de
   destinatarios enterrada en el código: para saber por qué a alguien le sonaba
   la campana había que leer el controller, y para cambiarlo, un programador.

   Acá vive UNA sola resolución de destinatarios, configurable desde el
   mantenedor Avisos (/mantenedores/avisos/) por PERFIL y/o por USUARIO.

   Cómo se arma la lista de un evento:
       (permiso base, si está activado)  ej. todos los que tengan 'aprob_revisar'
     + perfiles marcados                 ej. Gerente de Operaciones y Crédito
     + usuarios agregados uno a uno
     − usuarios excluidos                ej. cuentas de prueba o break-glass
     − el usuario que originó el hecho   (no se avisa a sí mismo)

   Cada emisor se AUTO-REGISTRA al bootear con registrarAviso(), así el
   mantenedor se llena solo y nunca queda un evento invisible. El registro solo
   refresca los textos (nombre, módulo, descripción); jamás pisa lo que el
   Administrador haya configurado.

   Uso desde un módulo:
       const A = require('../../../../shared/avisos');
       A.registrarAviso({ evento:'carta_nueva', nombre:'...', modulo:'Cartas',
                          base_func:'aprob_revisar', prioridad:'alta' });
       await A.avisar('carta_nueva', { titulo:'...', mensaje:'...', href:'...' }, { excluir:[idAutor] });
   ──────────────────────────────────────────────────────────────────────────── */
const pool = require('./config/database');

const SONIDOS = ['campana', 'dingdong', 'alarma', 'aplausos'];
const lista = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
const ids   = s => lista(s).map(x => parseInt(x)).filter(Boolean);

require('./migrate').enFila('avisos', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS avisos_config (
        evento        VARCHAR(60) PRIMARY KEY,
        nombre        VARCHAR(160) NOT NULL,
        modulo        VARCHAR(60)  NOT NULL DEFAULT 'General',
        descripcion   VARCHAR(400),
        base_func     VARCHAR(60)  NULL,
        usa_func      TINYINT(1) NOT NULL DEFAULT 1,
        incluir_admin TINYINT(1) NOT NULL DEFAULT 1,
        perfiles      TEXT,
        usuarios      TEXT,
        excluir       TEXT,
        activo        TINYINT(1) NOT NULL DEFAULT 1,
        prioridad     VARCHAR(10) NOT NULL DEFAULT 'normal',
        sonido        TINYINT(1) NOT NULL DEFAULT 1,
        sonido_tipo   VARCHAR(20) NOT NULL DEFAULT 'campana',
        updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
  } catch (e) { console.error('[avisos migration]', e.message); }
});

/* Registro del evento. Se llama al bootear cada módulo: crea la fila con sus
   defaults la primera vez y después solo refresca los textos descriptivos. */
function registrarAviso(def) {
  // Va por la cadena de migraciones: los módulos llaman a esto al bootear, antes
  // de que la tabla exista. enFila garantiza que corra después del CREATE de arriba.
  return require('./migrate').enFila('avisos-registro', () => _registrar(def));
}

async function _registrar(def) {
  const { evento, nombre, modulo = 'General', descripcion = null, base_func = null,
          prioridad = 'normal', sonido_tipo = 'campana', incluir_admin = 1,
          perfiles = '' } = def || {};
  if (!evento || !nombre) return;
  try {
    // perfiles: SOLO se siembra la primera vez (INSERT IGNORE). Sirve para que el
    // evento nazca con los mismos destinatarios que tenía hardcodeados, sin que
    // nadie deje de recibir su aviso al migrarlo. Después manda el mantenedor.
    await pool.query(
      `INSERT IGNORE INTO avisos_config
         (evento, nombre, modulo, descripcion, base_func, usa_func, incluir_admin, perfiles, usuarios, excluir, activo, prioridad, sonido, sonido_tipo)
       VALUES (?,?,?,?,?,1,?,?,'','',1,?,1,?)`,
      [evento, nombre, modulo, descripcion, base_func, incluir_admin ? 1 : 0,
       Array.isArray(perfiles) ? perfiles.join(',') : String(perfiles || ''),
       prioridad === 'alta' ? 'alta' : 'normal', SONIDOS.includes(sonido_tipo) ? sonido_tipo : 'campana']);
    // Los textos y el permiso base son del código, no del Administrador: se refrescan.
    await pool.query(
      'UPDATE avisos_config SET nombre=?, modulo=?, descripcion=?, base_func=? WHERE evento=?',
      [nombre, modulo, descripcion, base_func, evento]);
  } catch (e) { console.error('[registrarAviso]', evento, e.message); }
}

/* Config de un evento (null si no está registrado todavía). */
async function configDe(evento) {
  try {
    const [[c]] = await pool.query('SELECT * FROM avisos_config WHERE evento=?', [evento]);
    return c || null;
  } catch (e) { return null; }
}

/* Resuelve los id_usuario que deben recibir el aviso.
   opciones: { excluir:[ids], extra:[ids] } */
async function destinatarios(evento, { excluir = [], extra = [], soloA = null } = {}) {
  /* `soloA` — aviso DIRIGIDO: cuando el hecho tiene un dueño identificable (el
     ejecutivo de la operación), va solo a él y NO al pool de la funcionalidad.
     Los suplentes se agregan igual después, en notificar(). Si viene vacío se
     ignora y manda la configuración normal, para que un aviso nunca se pierda. */
  if (Array.isArray(soloA) && soloA.filter(Boolean).length) {
    const set = new Set(soloA.filter(Boolean).map(Number));
    (extra || []).filter(Boolean).forEach(i => set.add(Number(i)));
    (excluir || []).filter(Boolean).forEach(i => set.delete(parseInt(i)));
    return [...set];
  }
  const cfg = await configDe(evento);
  // Sin config (evento aún no registrado): no se pierde el aviso, van los
  // Administradores activos. Es el mismo criterio que tenía el código antes.
  if (!cfg) return await porPerfiles(['Administrador']);
  if (!cfg.activo) return [];

  const set = new Set();
  if (cfg.usa_func && cfg.base_func) (await porFuncionalidad(cfg.base_func)).forEach(i => set.add(i));
  if (cfg.incluir_admin)             (await porPerfiles(['Administrador'])).forEach(i => set.add(i));
  const perfiles = lista(cfg.perfiles);
  if (perfiles.length)               (await porPerfiles(perfiles)).forEach(i => set.add(i));
  ids(cfg.usuarios).forEach(i => set.add(i));
  (extra || []).filter(Boolean).forEach(i => set.add(i));

  ids(cfg.excluir).forEach(i => set.delete(i));
  (excluir || []).filter(Boolean).forEach(i => set.delete(parseInt(i)));
  return [...set];
}

/* base_func admite varios permisos separados por coma: hay pools que se definen
   por más de una funcionalidad (p.ej. fundantes_validar + fundantes_operaciones). */
async function porFuncionalidad(codigos) {
  const cods = lista(codigos);
  if (!cods.length) return [];
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT u.id_usuario FROM usuarios u
         JOIN permisos_perfil pp ON pp.id_perfil = u.id_perfil
         JOIN funcionalidades f  ON f.id_funcionalidad = pp.id_funcionalidad
        WHERE f.codigo IN (?) AND pp.habilitado = 1 AND u.estado = 'activo'`, [cods]);
    return rows.map(r => r.id_usuario);
  } catch (e) { return []; }
}

async function porPerfiles(nombres) {
  if (!nombres || !nombres.length) return [];
  try {
    const [rows] = await pool.query(
      `SELECT u.id_usuario FROM usuarios u JOIN perfiles p ON p.id_perfil = u.id_perfil
        WHERE p.nombre IN (?) AND u.estado = 'activo'`, [nombres]);
    return rows.map(r => r.id_usuario);
  } catch (e) { return []; }
}

/* Emite el aviso: resuelve destinatarios y delega en el núcleo de notificaciones.
   La prioridad y el sonido salen de la config, salvo que el emisor los fuerce. */
async function avisar(evento, opciones = {}, { excluir = [], extra = [], soloA = null } = {}) {
  try {
    const dest = await destinatarios(evento, { excluir, extra, soloA });
    if (!dest.length) return 0;
    const cfg = await configDe(evento);
    const { notificar } = require('../services/notificaciones/src/controllers/notificaciones.controller');
    await notificar(dest, {
      ...opciones,
      prioridad: opciones.prioridad || (cfg && cfg.prioridad) || 'normal',
      sonar:     opciones.sonar !== undefined && opciones.sonar !== null ? opciones.sonar : (cfg ? (cfg.sonido ? 1 : 0) : 1),
      son_tipo:  opciones.son_tipo || (cfg && cfg.sonido_tipo) || 'campana',
    });
    return dest.length;
  } catch (e) { console.error('[avisar]', evento, e.message); return 0; }
}

/* Retira de la campanita un aviso de "acción pendiente" cuando alguien YA lo atendió.
   Los avisos que piden una acción a un POOL se emiten con una `clave` única del hecho
   (ej. 'anulacion:87'); al resolverse, esta función los borra para TODOS — si no, cada
   miembro del pool sigue viendo (y oyendo) un pendiente que ya no existe.
   Fire & forget: nunca frena la operación. */
async function retirar(clave) {
  if (!clave) return 0;
  try {
    const pool = require('./config/database');
    const [r] = await pool.query('DELETE FROM notificaciones WHERE clave = ?', [clave]);
    return r.affectedRows || 0;
  } catch (e) { console.error('[avisos retirar]', clave, e.message); return 0; }
}

/* Igual que retirar(), pero por PREFIJO de clave. Sirve para avisos que se
   emiten uno por período (ej. 'pvalert:fondos_cargados:2026-07-31'): al llegar
   el del día nuevo, los de los días anteriores ya no piden nada y solo hacen
   ruido. Requiere un prefijo no vacío para no borrar la campanita entera. */
async function retirarPrefijo(prefijo, { excepto } = {}) {
  const p = String(prefijo || '').trim();
  if (!p) return 0;
  try {
    const pool = require('./config/database');
    const args = [p + '%'];
    let sql = 'DELETE FROM notificaciones WHERE clave LIKE ?';
    if (excepto) { sql += ' AND clave <> ?'; args.push(excepto); }
    const [r] = await pool.query(sql, args);
    return r.affectedRows || 0;
  } catch (e) { console.error('[avisos retirarPrefijo]', prefijo, e.message); return 0; }
}

module.exports = { registrarAviso, destinatarios, avisar, retirar, retirarPrefijo, configDe, porFuncionalidad, porPerfiles, SONIDOS };
