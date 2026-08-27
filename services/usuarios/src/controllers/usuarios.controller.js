const pool = require('../../../../shared/config/database');
const RUT = require('../../../../api-gateway/public/js/rut-core');  // enforcement: RUT canónico
const bcrypt = require('bcryptjs');
const { auditar } = require('../../../../shared/audit');
const { tieneFunc } = require('../../../../shared/middleware/permisos');
const { cerrarSesiones } = require('../../../../shared/middleware/auth');
const { enviarCorreo, envolverHTML } = require('../../../../shared/mailer');
// Job en segundo plano: avisa por correo el vencimiento de clave (carga al boot)
require('../jobs/aviso-vencimiento-clave');

// URL base para los enlaces de los correos (configurable por env, fallback a producción)
const APP_URL = (process.env.APP_URL || 'https://afbs.autofacilchile.cl').replace(/\/+$/, '');

// Clave temporal aleatoria (alta entropía, sin caracteres ambiguos)
/* Clave temporal para altas y reseteos. Dos cosas que antes no se cumplían:
   · `crypto.randomInt` en vez de `Math.random()`, que no es criptográfico — es
     una clave que da acceso al sistema, aunque sea de un solo uso.
   · Se garantiza una mayúscula, una minúscula, un dígito y un símbolo, para que
     la temporal cumpla la política del mantenedor Seguridad de Usuarios sea
     cual sea su configuración (antes salía al azar y podía no traer ninguno).
   Sin caracteres ambiguos (I, l, 1, O, 0): se dicta por teléfono. */
const generarClaveTemporal = () => {
  const { randomInt } = require('crypto');
  const MAY = 'ABCDEFGHJKLMNPQRSTUVWXYZ', MIN = 'abcdefghjkmnpqrstuvwxyz';
  const NUM = '23456789', ESP = '!@#$%*-_';
  const todo = MAY + MIN + NUM + ESP;
  const pick = s => s[randomInt(s.length)];
  const chars = [pick(MAY), pick(MIN), pick(NUM), pick(ESP)];
  while (chars.length < 12) chars.push(pick(todo));
  // Barajado Fisher-Yates: sin esto los cuatro obligatorios quedan siempre al inicio.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
};

// Correo con la clave (alta de usuario o reset). El usuario la cambia en su primer ingreso.
const correoClave = (nombre, email, clave, esReset = false) => {
  const login = `${APP_URL}/login.html`;
  const subject = esReset
    ? 'Restablecimiento de contraseña — AutoFácil Business Suite'
    : 'Tu acceso a AutoFácil Business Suite';
  const intro = esReset
    ? 'Se restableció la contraseña de tu cuenta. Estos son tus nuevos datos de acceso:'
    : 'Te damos la bienvenida a AutoFácil Business Suite. Tu cuenta ya está creada; estos son tus datos de acceso:';
  const text = `Hola ${nombre},\n\n${intro}\n\nUsuario (correo): ${email}\nContraseña temporal: ${clave}\n\nPor seguridad, el sistema te pedirá cambiar la contraseña en tu primer ingreso.\nIngresa en ${login}\n\nSi no esperabas este correo, avísale a tu administrador.\n\nSaludos,\nAutoFácil Business Suite`;
  const cuerpo = `
    <p style="margin:0 0 14px">Hola ${nombre},</p>
    <p style="margin:0 0 18px">${intro}</p>
    <table role="presentation" width="100%" style="border-collapse:collapse;background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px">
      <tr><td style="padding:16px 18px 6px">
        <div style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.4px">Usuario (correo)</div>
        <div style="font-size:15px;font-weight:600;color:#0f172a">${email}</div>
      </td></tr>
      <tr><td style="padding:6px 18px 18px">
        <div style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.4px">Contraseña temporal</div>
        <div style="font-family:'Courier New',monospace;font-size:22px;font-weight:700;color:#0141A2;letter-spacing:2px;background:#ffffff;border:1px dashed #93c5fd;border-radius:8px;padding:11px 14px;margin-top:6px;text-align:center;-webkit-user-select:all;user-select:all">${clave}</div>
        <div style="font-size:11px;color:#94a3b8;margin-top:6px;text-align:center">En el celular, mantén presionada la clave para copiarla.</div>
      </td></tr>
    </table>
    <p style="margin:18px 0 0">Por seguridad, <b>el sistema te pedirá cambiar esta contraseña</b> en tu primer ingreso.</p>
    <p style="text-align:center;margin:24px 0 4px">
      <a href="${login}" style="background:#0141A2;color:#fff;text-decoration:none;padding:12px 30px;border-radius:8px;font-weight:600;display:inline-block;font-size:15px">Ingresar al sistema</a>
    </p>
    <p style="font-size:12px;color:#94a3b8;margin:14px 0 0">Si no esperabas este correo, avísale a tu administrador.</p>`;
  return { subject, text, html: envolverHTML(cuerpo) };
};

/* ─── Migraciones ──────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('usuarios', async () => {
  try {
    await pool.query(`ALTER TABLE usuarios ADD COLUMN telefono VARCHAR(20) NULL DEFAULT NULL`);
  } catch (e) { if (e.errno !== 1060) console.error('[usuarios migration telefono]', e.message); }
  try {
    await pool.query(`ALTER TABLE usuarios ADD COLUMN apellido_materno VARCHAR(100) NULL DEFAULT NULL`);
  } catch (e) { if (e.errno !== 1060) console.error('[usuarios migration ap_materno]', e.message); }
  try {
    await pool.query(`ALTER TABLE usuarios ADD COLUMN centro_costo VARCHAR(100) NULL DEFAULT NULL`);
  } catch (e) { if (e.errno !== 1060) console.error('[usuarios migration centro_costo]', e.message); }
  try {
    await pool.query(`ALTER TABLE usuarios ADD COLUMN debe_cambiar_clave TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (e) { if (e.errno !== 1060) console.error('[usuarios migration debe_cambiar_clave]', e.message); }
  // Cuentas de propósito fijo (ej. pantalla TV): a dónde entra tras el login y cuánto
  // dura su sesión (horas; NULL = las 8 h estándar). Lo usa auth.controller.
  try {
    await pool.query(`ALTER TABLE usuarios ADD COLUMN pagina_inicio VARCHAR(120) NULL DEFAULT NULL`);
  } catch (e) { if (e.errno !== 1060) console.error('[usuarios migration pagina_inicio]', e.message); }
  try {
    await pool.query(`ALTER TABLE usuarios ADD COLUMN sesion_horas INT NULL DEFAULT NULL`);
  } catch (e) { if (e.errno !== 1060) console.error('[usuarios migration sesion_horas]', e.message); }
  try {
    // Bloqueo por intentos fallidos de login
    await pool.query(`ALTER TABLE usuarios ADD COLUMN intentos_fallidos INT NOT NULL DEFAULT 0`);
  } catch (e) { if (e.errno !== 1060) console.error('[usuarios migration intentos_fallidos]', e.message); }
  try {
    await pool.query(`ALTER TABLE usuarios ADD COLUMN bloqueado TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (e) { if (e.errno !== 1060) console.error('[usuarios migration bloqueado]', e.message); }
  try {
    // Revocación de sesiones (hallazgo A-7): el token lleva esta versión y
    // subirla mata todas las sesiones abiertas del usuario en el acto.
    // Arranca en 0 a propósito: los tokens ya emitidos no traen `tv` y valen 0,
    // así que instalar esto no desloguea a nadie.
    await pool.query(`ALTER TABLE usuarios ADD COLUMN token_version INT NOT NULL DEFAULT 0`);
  } catch (e) { if (e.errno !== 1060) console.error('[usuarios migration token_version]', e.message); }
  try {
    // Fecha del último cambio de clave (para calcular el vencimiento). Backfill a la creación.
    await pool.query(`ALTER TABLE usuarios ADD COLUMN password_updated_at DATETIME NULL DEFAULT NULL`);
    await pool.query(`UPDATE usuarios SET password_updated_at = COALESCE(fecha_creacion, NOW()) WHERE password_updated_at IS NULL`);
  } catch (e) { if (e.errno !== 1060) console.error('[usuarios migration password_updated_at]', e.message); }
  // RRHH: datos para certificado de antigüedad y cumpleaños (v78.0)
  try {
    await pool.query(`ALTER TABLE usuarios ADD COLUMN fecha_ingreso DATE NULL DEFAULT NULL`);
  } catch (e) { if (e.errno !== 1060) console.error('[usuarios migration fecha_ingreso]', e.message); }
  try {
    await pool.query(`ALTER TABLE usuarios ADD COLUMN fecha_nacimiento DATE NULL DEFAULT NULL`);
  } catch (e) { if (e.errno !== 1060) console.error('[usuarios migration fecha_nacimiento]', e.message); }
  try {
    await pool.query(`ALTER TABLE usuarios ADD COLUMN cargo VARCHAR(120) NULL DEFAULT NULL`);
  } catch (e) { if (e.errno !== 1060) console.error('[usuarios migration cargo]', e.message); }
  try {
    // M/F: para don/doña en el certificado de antigüedad y saludos
    await pool.query(`ALTER TABLE usuarios ADD COLUMN sexo CHAR(1) NULL DEFAULT NULL`);
  } catch (e) { if (e.errno !== 1060) console.error('[usuarios migration sexo]', e.message); }
  try {
    // Bono Jefe Comercial: mes (YYYY-MM) desde el que rige la jefatura. También la crea
    // bono-jefe.controller, pero usuarios se monta ANTES en el gateway y sus queries la
    // nombran sin fallback: el ALTER idempotente acá evita 500 en hosts nuevos.
    await pool.query(`ALTER TABLE usuarios ADD COLUMN jefatura_desde CHAR(7) NULL DEFAULT NULL`);
  } catch (e) { if (e.errno !== 1060) console.error('[usuarios migration jefatura_desde]', e.message); }
  try {
    /* EXTERNO (Pato, 19-08-2026): usuario de fuera de la organización (directores,
       asesores). NO se considera en: avisos/correos por perfil o funcionalidad,
       escalamientos de workflows, suplencias, directorio ni organigrama. Sí puede
       ingresar y operar según su perfil. */
    await pool.query(`ALTER TABLE usuarios ADD COLUMN externo TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (e) { if (e.errno !== 1060) console.error('[usuarios migration externo]', e.message); }
  try {
    // Trazabilidad de la suspensión: cuándo y quién (se muestran en Usuarios Suspendidos)
    await pool.query(`ALTER TABLE usuarios ADD COLUMN suspendido_en DATETIME NULL DEFAULT NULL`);
    await pool.query(`ALTER TABLE usuarios ADD COLUMN suspendido_por VARCHAR(150) NULL DEFAULT NULL`);
  } catch (e) { if (e.errno !== 1060) console.error('[usuarios migration suspendido]', e.message); }
});

/* Backfill: fecha y autor de las suspensiones YA hechas, desde la auditoría
   (accion ELIMINAR, detalle 'Usuario suspendido'). Sin rastro en auditoría,
   queda al menos la fecha_baja. */
require('../../../../shared/migrate').migrar('usuarios-suspendido-backfill-v1', async () => {
  await pool.query(`
    UPDATE usuarios u
    JOIN (SELECT entidad_id, MAX(id) mx FROM auditoria_movimientos
           WHERE modulo='usuarios' AND entidad='usuario' AND accion='ELIMINAR' AND detalle LIKE '%suspendido%'
           GROUP BY entidad_id) x ON x.entidad_id = CAST(u.id_usuario AS CHAR)
    JOIN auditoria_movimientos a ON a.id = x.mx
     SET u.suspendido_en = a.fecha, u.suspendido_por = a.usuario
   WHERE u.estado <> 'activo' AND u.suspendido_en IS NULL`).catch(e => console.error('[backfill suspendido]', e.message));
  await pool.query(`UPDATE usuarios SET suspendido_en = fecha_baja WHERE estado <> 'activo' AND suspendido_en IS NULL AND fecha_baja IS NOT NULL`);
});

/* One-shot (Pato, 19-08-2026): reenviar el correo de BIENVENIDA (URL + usuario +
   clave temporal, el mismo del alta) a Mauricio Torres, Director. Nunca ha
   ingresado (ultimo_acceso NULL — condición de seguridad: si ya entró, no se
   toca su clave). Genera clave temporal nueva + debe_cambiar_clave, igual que
   el alta. Si el correo no sale (host sin MAIL_*), lanza y el claim se libera
   para reintentar en el próximo arranque. */
require('../../../../shared/migrate').migrar('bienvenida-mauricio-torres-v1', async () => {
  const email = 'mauricio.torres@cfccorporacion.com';
  const [[u]] = await pool.query(
    "SELECT id_usuario, nombre, apellido FROM usuarios WHERE email=? AND estado='activo' AND ultimo_acceso IS NULL", [email]);
  if (!u) { console.log('[usuarios] bienvenida M.Torres: no aplica (ya ingresó o no existe)'); return; }
  const clave = generarClaveTemporal();
  const hash = await bcrypt.hash(clave, 10);
  await pool.query(
    'UPDATE usuarios SET password_hash=?, debe_cambiar_clave=1, password_updated_at=NOW(), intentos_fallidos=0, bloqueado=0 WHERE id_usuario=?',
    [hash, u.id_usuario]);
  const c = correoClave(u.nombre, email, clave, false);   // false = correo de ALTA (bienvenida)
  const envio = await enviarCorreo({ to: email, subject: c.subject, html: c.html, text: c.text });
  if (!envio.ok) throw new Error('correo no enviado: ' + (envio.error || 'sin detalle'));
  console.log('[usuarios] bienvenida reenviada a', email);
});

// Tabla de permisos individuales por usuario (excepciones al perfil base)
require('../../../../shared/migrate').enFila('usuarios', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS permisos_usuario (
        id_usuario       INT NOT NULL,
        id_funcionalidad INT NOT NULL,
        habilitado       TINYINT(1) NOT NULL,
        PRIMARY KEY (id_usuario, id_funcionalidad),
        INDEX idx_pu_usuario (id_usuario)
      )
    `);
  } catch (e) { console.error('[permisos_usuario migration]', e.message); }
});

// Tabla asignación ejecutivos por usuario
require('../../../../shared/migrate').enFila('usuarios', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuario_ejecutivos (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        id_usuario   INT NOT NULL,
        ejecutivo    VARCHAR(200) NOT NULL,
        INDEX idx_ue_usuario (id_usuario)
      )
    `);
  } catch (e) { console.error('[usuario_ejecutivos migration]', e.message); }
});

/* ─── Migración (UNA sola vez): los ejecutivos del listado viejo (cartas_ejecutivos)
   que no son usuarios se crean como usuarios SUSPENDIDOS (estado='inactivo', perfil
   Ejecutivo Comercial), para que aparezcan en "Usuarios Suspendidos" y su nombre quede
   en el roster. No pueden loguear (inactivo + clave aleatoria). Idempotente por flag. */
require('../../../../shared/migrate').enFila('usuarios', async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS migraciones_aplicadas (
      clave VARCHAR(80) PRIMARY KEY, aplicada_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    const [[ya]] = await pool.query("SELECT 1 ok FROM migraciones_aplicadas WHERE clave='ejecutivos_a_usuarios_v1'");
    if (ya) return;
    // ¿Existe la tabla origen? Si no, marcar como aplicada y salir.
    let ejecs;
    try { [ejecs] = await pool.query('SELECT id, nombre, mail, tel FROM cartas_ejecutivos WHERE activo = 1'); }
    catch (_) { await pool.query("INSERT IGNORE INTO migraciones_aplicadas (clave) VALUES ('ejecutivos_a_usuarios_v1')"); return; }
    const [[perf]] = await pool.query(
      "SELECT id_perfil FROM perfiles WHERE nombre IN ('Ejecutivo Comercial','Ejecutivo') ORDER BY (nombre='Ejecutivo Comercial') DESC LIMIT 1");
    if (!perf) { console.warn('[ejecutivos_a_usuarios_v1] no existe perfil Ejecutivo/Comercial'); return; }
    let creados = 0;
    for (const e of (ejecs || [])) {
      const nombreFull = String(e.nombre || '').trim();
      if (!nombreFull) continue;
      const partes = nombreFull.split(/\s+/);
      const nombre = partes.shift();
      const apellido = partes.join(' ') || '—';
      const email = (e.mail && String(e.mail).trim()) ? String(e.mail).trim() : `exej-${e.id}@autofacilchile.cl`;
      // ¿Ya es usuario? (por email o por nombre+apellido)
      const [[dup]] = await pool.query(
        "SELECT 1 ok FROM usuarios WHERE LOWER(email)=LOWER(?) OR LOWER(TRIM(CONCAT(nombre,' ',COALESCE(apellido,''))))=LOWER(?) LIMIT 1",
        [email, nombreFull]);
      if (dup) continue;
      const hash = await bcrypt.hash('EXEJ-' + Math.random().toString(36).slice(2) + Date.now(), 10);
      try {
        await pool.query(
          `INSERT INTO usuarios (rut, nombre, apellido, email, password_hash, id_perfil, telefono, estado)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'inactivo')`,
          [`EXEJ-${e.id}`, nombre, apellido, email, hash, perf.id_perfil, e.tel || null]);
        creados++;
      } catch (err) { /* rut/email duplicado u otra restricción: saltar */ }
    }
    await pool.query("INSERT IGNORE INTO migraciones_aplicadas (clave) VALUES ('ejecutivos_a_usuarios_v1')");
    if (creados) console.log(`[ejecutivos_a_usuarios_v1] ${creados} ex-ejecutivo(s) creados como usuarios suspendidos`);
  } catch (e) { console.error('[ejecutivos_a_usuarios_v1]', e.message); }
});

/* ─── Cuenta break-glass: administrador GARANTIZADO y PROTEGIDO ──────────────
   Acceso de administrador que no se puede eliminar, suspender ni degradar desde la
   UI (columna usuarios.protegido). Se crea con clave ALEATORIA desconocida; el dueño
   la fija con "Resetear clave" (nadie más la conoce y NO queda en el código). El
   bloque se auto-repara en cada arranque (siempre admin + activo + protegido) y NUNCA
   sobrescribe la clave ya fijada. Auditoría: se registra igual que cualquier cuenta. */
require('../../../../shared/migrate').enFila('usuarios', async () => {
  try {
    await pool.query("ALTER TABLE usuarios ADD COLUMN protegido TINYINT(1) NOT NULL DEFAULT 0").catch(() => {});
    const EMAIL = 'admin@admin.cl';
    // Renombrar (sin duplicar) la cuenta protegida que se haya creado con el mail anterior.
    await pool.query("UPDATE usuarios SET email = ? WHERE email = 'patricio.escobar2@gmail.com' AND protegido = 1", [EMAIL]).catch(() => {});
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre = 'Administrador' LIMIT 1");
    const idAdmin = adm ? adm.id_perfil : 1;
    const [[ex]] = await pool.query('SELECT id_usuario FROM usuarios WHERE email = ? LIMIT 1', [EMAIL]);
    if (!ex) {
      const rnd = require('crypto').randomBytes(24).toString('hex');   // clave que nadie conoce
      const hash = await bcrypt.hash(rnd, 10);
      await pool.query(
        "INSERT INTO usuarios (rut, nombre, apellido, email, password_hash, id_perfil, estado, protegido, debe_cambiar_clave) VALUES (?,?,?,?,?,?, 'activo', 1, 0)",
        ['BG-ADMIN', 'BG-ADMIN', '', EMAIL, hash, idAdmin]);
    } else {
      await pool.query("UPDATE usuarios SET id_perfil = ?, estado = 'activo', protegido = 1, nombre = 'BG-ADMIN', apellido = '' WHERE email = ?", [idAdmin, EMAIL]);
    }
  } catch (e) { console.error('[break-glass admin]', e.message); }
});

// ¿La cuenta es protegida (break-glass)? No se puede borrar/suspender/degradar.
async function esProtegido(id) {
  try { const [[u]] = await pool.query('SELECT protegido FROM usuarios WHERE id_usuario = ? LIMIT 1', [id]); return !!(u && u.protegido); }
  catch { return false; }
}
async function idPerfilAdmin() {
  try { const [[a]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre = 'Administrador' LIMIT 1"); return a ? a.id_perfil : null; }
  catch { return null; }
}

const PERFILES_GLOBALES = ['Administrador', 'Gerente'];

const buildFiltroUsuario = async (usuario) => {
  const { id_usuario, perfil_nombre } = usuario;
  if (PERFILES_GLOBALES.includes(perfil_nombre)) return { where: '', params: [] };
  // Visibilidad global por PERMISO (matriz de Perfiles/Permisos), no por nombre de perfil:
  // quien puede gestionar o ver usuarios ve la lista completa.
  if (await tieneFunc(id_usuario, 'usuarios_gestionar', 'usuarios.ver', 'usuarios_ver'))
    return { where: '', params: [] };
  if (perfil_nombre === 'Supervisor') {
    return { where: 'WHERE u.id_supervisor = ? OR u.id_usuario = ?', params: [id_usuario, id_usuario] };
  }
  return { where: 'WHERE u.id_usuario = ?', params: [id_usuario] };
};

const getAllUsuarios = async (req, res) => {
  try {
    const { where, params } = await buildFiltroUsuario(req.usuario);
    // Ocultar la cuenta break-glass (protegida) de toda la lista.
    let wProt = where ? where + ' AND u.protegido = 0' : 'WHERE u.protegido = 0';
    // "Solo ves lo que tienes": a un no-Admin no se le listan los usuarios con
    // perfil Administrador (su existencia delata el alcance total del sistema).
    const otorgables = await require('../otorgables').funcsOtorgables(req.usuario.id_usuario);
    if (otorgables !== null) wProt += " AND p.nombre <> 'Administrador'";
    const [usuarios] = await pool.query(
      `SELECT u.id_usuario, u.rut, u.nombre, u.apellido, u.apellido_materno, u.centro_costo, u.email, u.telefono,
              u.cargo, u.fecha_ingreso, u.fecha_nacimiento, u.sexo, u.jefatura_desde,
              u.id_perfil, p.nombre AS perfil, u.id_supervisor,
              CONCAT(s.nombre, ' ', s.apellido) AS supervisor_nombre,
              u.estado, u.ultimo_acceso, u.fecha_creacion, u.bloqueado, u.intentos_fallidos,
              COALESCE(u.externo, 0) AS externo, u.suspendido_en, u.suspendido_por,
              cj.id_caja, cj.nombre AS nombre_caja
       FROM usuarios u
       JOIN perfiles p ON u.id_perfil = p.id_perfil
       LEFT JOIN usuarios s ON u.id_supervisor = s.id_usuario
       LEFT JOIN caja_usuarios cu ON cu.id_usuario = u.id_usuario AND cu.activo = 1
       LEFT JOIN cajas cj ON cj.id_caja = cu.id_caja AND cj.activo = 1
       ${wProt}
       ORDER BY u.nombre, u.apellido`,
      params
    );
    res.json({ success: true, data: usuarios, error: null });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: error.message });
  }
};

const getUsuarioById = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id_usuario, u.rut, u.nombre, u.apellido, u.apellido_materno, u.centro_costo, u.email, u.telefono,
              u.cargo, u.fecha_ingreso, u.fecha_nacimiento, u.sexo, u.jefatura_desde,
              u.id_perfil, p.nombre AS perfil, u.id_supervisor,
              CONCAT(s.nombre, ' ', s.apellido) AS supervisor_nombre,
              u.estado, u.ultimo_acceso, u.fecha_creacion, COALESCE(u.externo, 0) AS externo
       FROM usuarios u
       JOIN perfiles p ON u.id_perfil = p.id_perfil
       LEFT JOIN usuarios s ON u.id_supervisor = s.id_usuario
       WHERE u.id_usuario = ?`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, data: null, error: 'Usuario no encontrado' });
    }
    res.json({ success: true, data: rows[0], error: null });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: error.message });
  }
};

// Mes válido para jefatura_desde: AAAA-MM con mes real 01–12 ('2026-13' NO pasa —
// un mes imposible deja al jefe como no-vigente para siempre, sin síntoma visible)
const MES_JEFATURA_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const createUsuario = async (req, res) => {
  try {
    const { rut, nombre, apellido, apellido_materno, centro_costo, email, id_perfil, id_supervisor, telefono, fecha_ingreso, fecha_nacimiento, cargo, sexo } = req.body;

    if (!rut || !nombre || !apellido || !email || !id_perfil) {
      return res.status(400).json({ success: false, data: null, error: 'RUT, nombre, apellido, email y perfil son requeridos' });
    }

    // Jefatura desde (Bono Jefe Comercial): vacía = NULL; no vacía debe ser YYYY-MM
    const jdCrear = String(req.body.jefatura_desde || '').trim();
    if (jdCrear && !MES_JEFATURA_RE.test(jdCrear)) {
      return res.status(400).json({ success: false, data: null, error: 'Jefatura desde inválida: usa el formato AAAA-MM con mes 01–12 (ej. 2026-08)' });
    }

    // "Solo otorgas lo que tienes": no-Admin no puede asignar un perfil con permisos que él no tenga
    if (!(await require('../otorgables').perfilOtorgable(req.usuario.id_usuario, id_perfil))) {
      return res.status(403).json({ success: false, data: null, error: 'No puedes asignar ese perfil: tiene permisos que tú no tienes' });
    }

    // La clave se genera automáticamente y se envía por correo; el usuario debe cambiarla en su primer ingreso.
    const claveTemporal = generarClaveTemporal();
    const passwordHash = await bcrypt.hash(claveTemporal, 10);
    const [result] = await pool.query(
      'INSERT INTO usuarios (rut, nombre, apellido, apellido_materno, centro_costo, email, password_hash, id_perfil, id_supervisor, telefono, fecha_ingreso, fecha_nacimiento, cargo, sexo, externo, jefatura_desde, debe_cambiar_clave, password_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())',
      [RUT.normalizar(rut) || rut, nombre, apellido, apellido_materno || null, centro_costo || null, email, passwordHash, id_perfil, id_supervisor || null, telefono || null, fecha_ingreso || null, fecha_nacimiento || null, cargo || null, ['M','F'].includes(sexo) ? sexo : null, req.body.externo ? 1 : 0, jdCrear || null]
    );

    auditar({ req, accion: 'CREAR', modulo: 'usuarios', entidad: 'usuario', entidad_id: result.insertId,
      detalle: `Creó el usuario ${nombre} ${apellido} (${email}) con perfil #${id_perfil}` +
        (jdCrear ? ` — jefatura_desde: ${jdCrear}` : ''),
      rut, meta: { rut, email, id_perfil, ...(jdCrear ? { jefatura_desde: jdCrear } : {}) } });

    // Enviar la clave temporal por correo. Si falla, se devuelve para entrega manual (no aborta la creación).
    const c = correoClave(nombre, email, claveTemporal, false);
    const envio = await enviarCorreo({ to: email, subject: c.subject, html: c.html, text: c.text });

    res.status(201).json({
      success: true,
      data: {
        id_usuario: result.insertId, rut, nombre, apellido, email, id_perfil, estado: 'activo',
        correo_enviado: envio.ok,
        clave_temporal: envio.ok ? null : claveTemporal,
        correo_error: envio.ok ? null : envio.error
      },
      error: null
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, data: null, error: 'El RUT o email ya están registrados' });
    }
    res.status(500).json({ success: false, data: null, error: error.message });
  }
};

const updateUsuario = async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, apellido, apellido_materno, centro_costo, email, id_perfil, id_supervisor, estado, telefono, fecha_ingreso, fecha_nacimiento, cargo, sexo } = req.body;

    if (!nombre || !apellido || !email || !id_perfil) {
      return res.status(400).json({ success: false, data: null, error: 'Nombre, apellido, email y perfil son requeridos' });
    }

    // "Solo otorgas lo que tienes": si el editor no-Admin CAMBIA el perfil, el nuevo
    // perfil debe estar contenido en sus propios permisos (mantener el actual sí se permite).
    const [[act]] = await pool.query('SELECT id_perfil, estado, jefatura_desde FROM usuarios WHERE id_usuario=?', [id]);
    if (!act) return res.status(404).json({ success: false, data: null, error: 'Usuario no encontrado' });
    if (act && Number(act.id_perfil) !== Number(id_perfil) &&
        !(await require('../otorgables').perfilOtorgable(req.usuario.id_usuario, id_perfil))) {
      return res.status(403).json({ success: false, data: null, error: 'No puedes asignar ese perfil: tiene permisos que tú no tienes' });
    }

    // Cuenta protegida (break-glass): nunca se suspende ni se degrada de Administrador.
    let estadoFinal = estado || 'activo';
    let perfilFinal = id_perfil;
    if (await esProtegido(id)) {
      estadoFinal = 'activo';
      const ap = await idPerfilAdmin();
      if (ap) perfilFinal = ap;
    }

    // jefatura_desde (Bono Jefe Comercial): si el form no la envía (undefined) se
    // preserva; enviada vacía se limpia; enviada YYYY-MM se escribe. Un valor no
    // vacío malformado se RECHAZA (nunca limpiar por un typo: mueve bonos cerrados).
    const jdSet = req.body.jefatura_desde !== undefined ? 1 : null;
    const jdRaw = String(req.body.jefatura_desde || '').trim();
    if (jdSet && jdRaw && !MES_JEFATURA_RE.test(jdRaw)) {
      return res.status(400).json({ success: false, data: null, error: 'Jefatura desde inválida: usa el formato AAAA-MM con mes 01–12 (ej. 2026-08)' });
    }
    const jdVal = jdRaw || null;

    await pool.query(
      // COALESCE: si el form no envía los campos RRHH (undefined), se preservan los existentes
      'UPDATE usuarios SET nombre = ?, apellido = ?, apellido_materno = ?, centro_costo = ?, email = ?, id_perfil = ?, id_supervisor = ?, estado = ?, telefono = ?, fecha_ingreso = COALESCE(?, fecha_ingreso), fecha_nacimiento = COALESCE(?, fecha_nacimiento), cargo = COALESCE(?, cargo), sexo = COALESCE(?, sexo), externo = COALESCE(?, externo), jefatura_desde = CASE WHEN ? IS NULL THEN jefatura_desde ELSE ? END WHERE id_usuario = ?',
      [nombre, apellido, apellido_materno || null, centro_costo || null, email, perfilFinal, id_supervisor || null, estadoFinal, telefono || null, fecha_ingreso || null, fecha_nacimiento || null, cargo || null, ['M','F'].includes(sexo) ? sexo : null, req.body.externo === undefined ? null : (req.body.externo ? 1 : 0), jdSet, jdVal, id]
    );

    // Trazabilidad de la suspensión también cuando el cambio de estado viene del form de edición
    if (act && act.estado === 'activo' && estadoFinal !== 'activo') {
      const quien = `${req.usuario?.nombre || ''} ${req.usuario?.apellido || ''}`.trim() || req.usuario?.email || null;
      await pool.query('UPDATE usuarios SET suspendido_en = NOW(), suspendido_por = ? WHERE id_usuario = ?', [quien, id]).catch(() => {});
    } else if (act && act.estado !== 'activo' && estadoFinal === 'activo') {
      await pool.query('UPDATE usuarios SET suspendido_en = NULL, suspendido_por = NULL WHERE id_usuario = ?', [id]).catch(() => {});
    }

    // A-7: al suspender, sus sesiones abiertas mueren ya — no al vencer el token.
    // También al cambiarle el perfil: el token viejo lleva el perfil anterior y
    // varias pantallas se dibujan con ese dato.
    if (estadoFinal !== 'activo' || (act && Number(act.id_perfil) !== Number(perfilFinal))) {
      try { await cerrarSesiones(id); } catch (e) { console.error('[usuarios] cerrarSesiones:', e.message); }
    }

    // La jefatura mueve dinero (Bono Jefe): el cambio queda con valor anterior y nuevo
    const jdCambio = jdSet && String(act?.jefatura_desde || '') !== String(jdVal || '');
    auditar({ req, accion: 'EDITAR', modulo: 'usuarios', entidad: 'usuario', entidad_id: id,
      detalle: `Editó el usuario ${nombre} ${apellido} (${email}) — perfil #${perfilFinal}, estado ${estadoFinal}` +
        (jdCambio ? ` — jefatura_desde: ${act?.jefatura_desde || '(histórica)'} → ${jdVal || '(histórica)'}` : ''),
      meta: { email, id_perfil: perfilFinal, estado: estadoFinal,
        ...(jdCambio ? { jefatura_desde_antes: act?.jefatura_desde || null, jefatura_desde_ahora: jdVal } : {}) } });
    res.json({ success: true, data: { id_usuario: id, nombre, apellido, email, id_perfil: perfilFinal, estado: estadoFinal }, error: null });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: error.message });
  }
};

const deleteUsuario = async (req, res) => {
  try {
    const { id } = req.params;
    if (parseInt(id) === req.usuario.id_usuario) {
      return res.status(400).json({ success: false, data: null, error: 'No puedes eliminar tu propio usuario' });
    }
    if (await esProtegido(id)) {
      return res.status(403).json({ success: false, data: null, error: 'Cuenta protegida: no puede suspenderse ni eliminarse.' });
    }
    // fecha_baja = fuente única del evento "egresó" (la leen rotación/egresos de Indicadores RRHH)
    const quien = `${req.usuario?.nombre || ''} ${req.usuario?.apellido || ''}`.trim() || req.usuario?.email || null;
    await pool.query("UPDATE usuarios SET estado = ?, fecha_baja = COALESCE(fecha_baja, CURDATE()), suspendido_en = NOW(), suspendido_por = ? WHERE id_usuario = ?", ['inactivo', quien, id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'usuarios', entidad: 'usuario', entidad_id: id, detalle: 'Usuario suspendido (baja lógica)' });
    res.json({ success: true, data: { mensaje: 'Usuario suspendido correctamente' }, error: null });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: error.message });
  }
};

// Borrado DEFINITIVO (hard delete). Solo sobre usuarios ya suspendidos.
// El nombre del ejecutivo se guarda como TEXTO en créditos/cartas/cotizaciones,
// así que borrar el usuario NO altera el histórico.
const eliminarDefinitivo = async (req, res) => {
  try {
    const { id } = req.params;
    if (parseInt(id) === req.usuario.id_usuario) {
      return res.status(400).json({ success: false, data: null, error: 'No puedes eliminar tu propio usuario' });
    }
    if (await esProtegido(id)) {
      return res.status(403).json({ success: false, data: null, error: 'Cuenta protegida: no puede eliminarse.' });
    }
    const [[u]] = await pool.query('SELECT nombre, apellido, email, estado FROM usuarios WHERE id_usuario = ?', [id]);
    if (!u) return res.status(404).json({ success: false, data: null, error: 'Usuario no encontrado' });
    if ((u.estado || '') === 'activo') {
      return res.status(400).json({ success: false, data: null, error: 'Primero debes suspender al usuario; solo se eliminan los suspendidos.' });
    }

    // Limpiar dependencias para no dejar huérfanos (tablas sin FK formal)
    await pool.query('UPDATE usuarios SET id_supervisor = NULL WHERE id_supervisor = ?', [id]).catch(() => {});
    await pool.query('DELETE FROM permisos_usuario WHERE id_usuario = ?', [id]).catch(() => {});
    await pool.query('DELETE FROM usuario_ejecutivos WHERE id_usuario = ?', [id]).catch(() => {});
    await pool.query('DELETE FROM avisos_clave_vencimiento WHERE id_usuario = ?', [id]).catch(() => {});
    await pool.query('DELETE FROM caja_usuarios WHERE id_usuario = ?', [id]).catch(() => {});
    await pool.query('DELETE FROM notificaciones WHERE id_usuario = ?', [id]).catch(() => {});
    await pool.query('DELETE FROM usuarios WHERE id_usuario = ?', [id]);

    auditar({ req, accion: 'ELIMINAR', modulo: 'usuarios', entidad: 'usuario', entidad_id: id,
      detalle: `Eliminó DEFINITIVAMENTE al usuario ${u.nombre} ${u.apellido} (${u.email})`, meta: { email: u.email } });
    res.json({ success: true, data: { mensaje: 'Usuario eliminado definitivamente' }, error: null });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: error.message });
  }
};

const reactivarUsuario = async (req, res) => {
  try {
    const { id } = req.params;
    const [r] = await pool.query('UPDATE usuarios SET estado = ?, fecha_baja = NULL, suspendido_en = NULL, suspendido_por = NULL WHERE id_usuario = ?', ['activo', id]);
    if (!r.affectedRows) return res.status(404).json({ success: false, data: null, error: 'Usuario no encontrado' });
    auditar({ req, accion: 'EDITAR', modulo: 'usuarios', entidad: 'usuario', entidad_id: id, detalle: 'Usuario reactivado' });
    res.json({ success: true, data: { mensaje: 'Usuario reactivado correctamente' }, error: null });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: error.message });
  }
};

const resetClave = async (req, res) => {
  try {
    const { id } = req.params;

    /* Auditoría 05-08-2026 (C-3): no se validaba NADA sobre el objetivo. Quien
       tuviera el permiso de resetear —típicamente RRHH o soporte— podía
       resetear la clave de un Administrador, leerla en la respuesta y entrar
       con su perfil. `createUsuario` y `updateUsuario` ya aplicaban la regla
       "solo otorgas lo que tienes"; acá faltaba. */
    if (await esProtegido(id)) {
      return res.status(403).json({ success: false, data: null,
        error: 'Cuenta protegida: su clave no se resetea desde acá.' });
    }
    const [[objetivo]] = await pool.query('SELECT id_perfil FROM usuarios WHERE id_usuario = ?', [id]);
    if (!objetivo) return res.status(404).json({ success: false, data: null, error: 'Usuario no encontrado' });
    if (!(await require('../otorgables').perfilOtorgable(req.usuario.id_usuario, objetivo.id_perfil))) {
      return res.status(403).json({ success: false, data: null,
        error: 'No puedes resetear la clave de un usuario con más permisos que los tuyos.' });
    }

    const nuevaClave = generarClaveTemporal();

    const hash = await bcrypt.hash(nuevaClave, 10);
    // Forzar cambio en el próximo ingreso (igual que en el alta) y desbloquear la cuenta.
    await pool.query('UPDATE usuarios SET password_hash = ?, debe_cambiar_clave = 1, password_updated_at = NOW(), intentos_fallidos = 0, bloqueado = 0 WHERE id_usuario = ?', [hash, id]);
    // A-7: si la clave se resetea es porque se sospecha del acceso o se perdió.
    // Dejar viva la sesión anterior haría inútil el reseteo.
    try { await cerrarSesiones(id); } catch (e) { console.error('[usuarios] cerrarSesiones:', e.message); }

    auditar({ req, accion: 'EDITAR', modulo: 'usuarios', entidad: 'usuario', entidad_id: id, detalle: `Reseteó la contraseña del usuario #${id}` });

    // Enviar la nueva clave por correo al usuario (si tiene email). Se sigue devolviendo la clave como respaldo.
    let correo_enviado = false;
    try {
      const [[u]] = await pool.query('SELECT nombre, email FROM usuarios WHERE id_usuario = ?', [id]);
      if (u && u.email) {
        const c = correoClave(u.nombre, u.email, nuevaClave, true);
        const envio = await enviarCorreo({ to: u.email, subject: c.subject, html: c.html, text: c.text });
        correo_enviado = envio.ok;
      }
    } catch (_) { /* el envío no debe romper el reset */ }

    res.json({ success: true, data: {
      nueva_clave: nuevaClave, correo_enviado,
      mensaje: correo_enviado
        ? 'Contraseña reseteada y enviada al correo del usuario.'
        : 'Contraseña reseteada. Comparte esta clave con el usuario.'
    }, error: null });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: error.message });
  }
};

/* ─── Desbloquear cuenta (sin resetear la clave) ───────────────── */
const desbloquearUsuario = async (req, res) => {
  try {
    const { id } = req.params;
    const [r] = await pool.query('UPDATE usuarios SET intentos_fallidos = 0, bloqueado = 0 WHERE id_usuario = ?', [id]);
    if (!r.affectedRows) return res.status(404).json({ success: false, data: null, error: 'Usuario no encontrado' });
    auditar({ req, accion: 'EDITAR', modulo: 'usuarios', entidad: 'usuario', entidad_id: id, detalle: `Desbloqueó la cuenta del usuario #${id}` });
    res.json({ success: true, data: { mensaje: 'Cuenta desbloqueada. El usuario ya puede ingresar con su contraseña actual.' }, error: null });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: error.message });
  }
};

/* ─── Permisos individuales por usuario ────────────────────────── */

const getPermisosUsuario = async (req, res) => {
  try {
    const { id } = req.params;

    const [[u]] = await pool.query('SELECT id_perfil FROM usuarios WHERE id_usuario = ?', [id]);
    if (!u) return res.status(404).json({ success: false, data: null, error: 'Usuario no encontrado' });

    // Base del perfil
    const [baseRows] = await pool.query(
      'SELECT id_funcionalidad, habilitado FROM permisos_perfil WHERE id_perfil = ?',
      [u.id_perfil]
    );
    const base = {};
    baseRows.forEach(p => { base[p.id_funcionalidad] = p.habilitado === 1; });

    // Overrides individuales del usuario
    const [ovRows] = await pool.query(
      'SELECT id_funcionalidad, habilitado FROM permisos_usuario WHERE id_usuario = ?',
      [id]
    );
    const overrides = {};
    ovRows.forEach(o => { overrides[o.id_funcionalidad] = o.habilitado === 1; });

    res.json({ success: true, data: { base, overrides }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const updatePermisosUsuario = async (req, res) => {
  try {
    const { id } = req.params;
    const { permisos } = req.body; // [{ id_funcionalidad, habilitado, es_override }]

    if (!Array.isArray(permisos)) {
      return res.status(400).json({ success: false, data: null, error: 'Formato inválido' });
    }

    // "Solo otorgas lo que tienes": no-Admin solo puede tocar overrides de
    // funcionalidades que él mismo tenga habilitadas; el resto se conserva intacto.
    const otorgables = await require('../otorgables').funcsOtorgables(req.usuario.id_usuario);
    if (otorgables === null) {
      // Administrador: reemplaza todos los overrides
      await pool.query('DELETE FROM permisos_usuario WHERE id_usuario = ?', [id]);
    } else {
      const ids = [...otorgables];
      if (ids.length) await pool.query('DELETE FROM permisos_usuario WHERE id_usuario = ? AND id_funcionalidad IN (?)', [id, ids]);
    }

    // Insertar solo los que difieren del base (es_override = true) — un solo INSERT masivo
    const inserts = permisos.filter(p => p.es_override && p.id_funcionalidad != null &&
      (otorgables === null || otorgables.has(Number(p.id_funcionalidad))));
    if (inserts.length) {
      await pool.query(
        'INSERT INTO permisos_usuario (id_usuario, id_funcionalidad, habilitado) VALUES ?',
        [inserts.map(p => [id, p.id_funcionalidad, p.habilitado ? 1 : 0])]
      );
    }

    require('../../../../shared/middleware/permisos').limpiarCachePermisos();   // efecto inmediato en las APIs (auditoría 2026-08-08)
    auditar({ req, accion: 'PERMISOS', modulo: 'usuarios', entidad: 'usuario', entidad_id: id,
      detalle: `Actualizó permisos individuales del usuario #${id} (${inserts.length} override/s)`, meta: { overrides: inserts.length } });
    res.json({ success: true, data: { mensaje: 'Permisos de usuario actualizados' }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── GET /usuarios/:id/ejecutivos ─────────────────────────────── */
const getEjecutivosUsuario = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT ejecutivo FROM usuario_ejecutivos WHERE id_usuario = ? ORDER BY ejecutivo`,
      [req.params.id]
    );
    res.json({ success: true, data: rows.map(r => r.ejecutivo), error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ─── PUT /usuarios/:id/ejecutivos ─────────────────────────────── */
const updateEjecutivosUsuario = async (req, res) => {
  try {
    const { ejecutivos } = req.body; // array de strings
    if (!Array.isArray(ejecutivos)) return res.status(400).json({ success: false, data: null, error: 'ejecutivos debe ser un array' });
    await pool.query(`DELETE FROM usuario_ejecutivos WHERE id_usuario = ?`, [req.params.id]);
    if (ejecutivos.length) {
      const vals = ejecutivos.map(e => [req.params.id, e]);
      await pool.query(`INSERT INTO usuario_ejecutivos (id_usuario, ejecutivo) VALUES ?`, [vals]);
    }
    auditar({ req, accion: 'EDITAR', modulo: 'usuarios', entidad: 'usuario', entidad_id: req.params.id,
      detalle: `Asignó ${ejecutivos.length} ejecutivo(s) al usuario #${req.params.id} (visibilidad de comisiones)`, meta: { ejecutivos } });
    res.json({ success: true, data: null, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ─── GET /usuarios/mis-ejecutivos  (para el usuario logueado) ─── */
const misEjecutivos = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT ejecutivo FROM usuario_ejecutivos WHERE id_usuario = ? ORDER BY ejecutivo`,
      [req.usuario.id_usuario]
    );
    res.json({ success: true, data: rows.map(r => r.ejecutivo), error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* GET /api/usuarios/sexos — mapa "NOMBRE APELLIDO" → M/F para personalizar
   saludos (Estimado/Estimada) en correos que solo tienen el nombre del
   destinatario (ej. detalle de comisiones al ejecutivo). Solo activos. */
const getSexos = async (_req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT UPPER(TRIM(CONCAT(nombre,' ',apellido))) n, sexo FROM usuarios WHERE estado='activo' AND sexo IS NOT NULL");
    const mapa = {};
    rows.forEach(r => { mapa[r.n] = r.sexo; });
    res.json({ success: true, data: mapa, error: null });
  } catch (e) { console.error('[sexos]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { getAllUsuarios, getUsuarioById, createUsuario, updateUsuario, deleteUsuario, eliminarDefinitivo, reactivarUsuario, resetClave, desbloquearUsuario, getPermisosUsuario, updatePermisosUsuario, getEjecutivosUsuario, updateEjecutivosUsuario, misEjecutivos, getSexos };
