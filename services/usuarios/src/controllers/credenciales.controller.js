'use strict';
/* ───────────────────────────────────────────────────────────────────────────
 * CREDENCIALES CORPORATIVAS — generador interno de tarjetas imprimibles:
 * anverso (logo, foto, nombre, cargo, RUT, expiración) y reverso con QR vCard
 * ("escanea y guarda mi contacto": nombre, cargo, empresa, teléfono, email).
 * Los datos maestros salen de `usuarios` (una sola fuente); acá solo se guarda
 * lo propio de la credencial: foto y fecha de expiración.
 * ─────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');

require('../../../../shared/migrate').enFila('credenciales', async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS credenciales_usuario (
      id_usuario INT PRIMARY KEY,
      foto LONGTEXT NULL,                 -- dataURL (jpeg/png) de la foto carnet
      expira DATE NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS credenciales_empresa (
      id TINYINT PRIMARY KEY,
      organizacion VARCHAR(120) NULL,
      direccion VARCHAR(200) NULL,
      web VARCHAR(200) NULL,
      telefono VARCHAR(30) NULL,
      email VARCHAR(120) NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
    await pool.query(`INSERT IGNORE INTO credenciales_empresa (id, organizacion, web) VALUES (1, 'AutoFácil Crédito Automotriz', 'https://www.autofacilchile.cl')`);
    // token público del vCard con foto (el QR apunta a /api/credenciales/vcf/<token>)
    await pool.query('ALTER TABLE credenciales_usuario ADD COLUMN IF NOT EXISTS token VARCHAR(32) NULL').catch(() => {});
    await pool.query('ALTER TABLE credenciales_usuario ADD UNIQUE INDEX idx_token (token)').catch(() => {});
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='credenciales' LIMIT 1");
    if (!ex) {
      await pool.query("INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (1,'Credenciales Corporativas','credenciales','/credenciales/','bi-person-badge')");
      const [[nf]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='credenciales' LIMIT 1");
      await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
                        SELECT id_perfil, ?, 1 FROM perfiles WHERE nombre='Administrador'`, [nf.id_funcionalidad]);
    }
  } catch (e) { console.error('[credenciales migration]', e.message); }
});

/* Token público por usuario (32 hex): se crea la primera vez que se necesita y no cambia,
   así una credencial impresa sigue sirviendo. Una foto no cabe en un QR (aunque sea chica
   son varios KB → código ilegible), por eso el QR lleva una URL corta y el teléfono descarga
   el .vcf con la foto incrustada (iPhone y Android lo abren en Contactos). */
async function asegurarTokens(ids) {
  if (!ids.length) return {};
  const [rows] = await pool.query('SELECT id_usuario, token FROM credenciales_usuario WHERE id_usuario IN (?)', [ids]);
  const map = {}; rows.forEach(r => { map[r.id_usuario] = r.token; });
  for (const id of ids) {
    if (map[id]) continue;
    const t = require('crypto').randomBytes(16).toString('hex');
    await pool.query('INSERT INTO credenciales_usuario (id_usuario, token) VALUES (?,?) ON DUPLICATE KEY UPDATE token=COALESCE(token, VALUES(token))', [id, t]);
    const [[r]] = await pool.query('SELECT token FROM credenciales_usuario WHERE id_usuario=?', [id]);
    map[id] = r.token;
  }
  return map;
}

/* JPEG sin segmentos APP1/APP2 (EXIF, perfil ICC): Chrome incrusta un perfil ICC al exportar
   el canvas y algunos importadores de contactos (iOS) descartan la foto. Recorre los segmentos
   hasta el inicio del scan y copia solo lo necesario. Si algo no calza, devuelve el original. */
function jpegLimpio(buf) {
  try {
    if (buf[0] !== 0xFF || buf[1] !== 0xD8) return buf;
    const partes = [Buffer.from([0xFF, 0xD8])]; let i = 2;
    while (i + 4 <= buf.length && buf[i] === 0xFF) {
      const marker = buf[i + 1];
      if (marker === 0xDA) { partes.push(buf.subarray(i)); return Buffer.concat(partes); }   // SOS: el resto va entero
      const len = buf.readUInt16BE(i + 2);
      if (!(marker === 0xE1 || marker === 0xE2)) partes.push(buf.subarray(i, i + 2 + len));  // salta APP1/APP2
      i += 2 + len;
    }
    return buf;
  } catch (_) { return buf; }
}

/* ── GET /api/credenciales/vcf/:token — PÚBLICO: la tarjeta de contacto con foto ── */
exports.vcf = async (req, res) => {
  try {
    const token = String(req.params.token || '').replace(/[^a-f0-9]/g, '');
    if (token.length !== 32) return res.status(404).send('No encontrado');
    const [[u]] = await pool.query(`
      SELECT u.nombre, u.apellido, u.apellido_materno, u.cargo, u.telefono, u.email, c.foto
        FROM credenciales_usuario c JOIN usuarios u ON u.id_usuario=c.id_usuario
       WHERE c.token=? AND u.estado='activo'`, [token]);
    if (!u) return res.status(404).send('Credencial no vigente');
    const [[e]] = await pool.query('SELECT organizacion, web, telefono, email FROM credenciales_empresa WHERE id=1');
    const EMP = e || {};
    const nom = String(u.nombre || '').trim(), ape = [u.apellido, u.apellido_materno].filter(Boolean).join(' ').trim();
    const tel = String(u.telefono || '').replace(/[^\d+]/g, '');
    const lineas = ['BEGIN:VCARD', 'VERSION:3.0', `N:${ape};${nom};;;`, `FN:${nom} ${ape}`.trim(),
      `ORG:${EMP.organizacion || 'AutoFácil Crédito Automotriz'}`, u.cargo ? `TITLE:${u.cargo}` : '',
      // SOLO los datos de la persona: si va el teléfono/correo de la empresa, el iPhone cruza el
      // número con un contacto existente (09-09-2026: el "teléfono de la empresa" era el de Pato y
      // el vCard de Noelia aparecía como Patricio Escobar, sin su foto).
      tel ? `TEL;TYPE=CELL:${tel}` : '', u.email ? `EMAIL:${u.email}` : '',
      EMP.web ? `URL:${EMP.web}` : ''];
    const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(String(u.foto || ''));
    if (m) {
      const tipo = m[1].toLowerCase() === 'png' ? 'PNG' : (m[1].toLowerCase() === 'webp' ? 'WEBP' : 'JPEG');
      let b64 = m[2].replace(/[\r\n]/g, '');
      if (tipo === 'JPEG') b64 = jpegLimpio(Buffer.from(b64, 'base64')).toString('base64');
      // plegado a 75 caracteres (RFC 2426): primera línea con la propiedad, siguientes con un espacio.
      // ENCODING=BASE64 (forma 2.1) la entienden todos los importadores, incluido iOS; "b" no siempre.
      const cab = `PHOTO;ENCODING=BASE64;TYPE=${tipo}:`;
      let out = cab + b64.slice(0, 75 - cab.length);
      for (let i = 75 - cab.length; i < b64.length; i += 74) out += '\r\n ' + b64.slice(i, i + 74);
      lineas.push(out);
    }
    lineas.push('END:VCARD');
    const body = lineas.filter(Boolean).join('\r\n') + '\r\n';
    const nombreArchivo = (`${nom} ${ape}`.trim() || 'contacto').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 ]/g, '').replace(/\s+/g, '-');
    res.set({ 'Content-Type': 'text/vcard; charset=utf-8', 'Content-Disposition': `inline; filename="${nombreArchivo}.vcf"`, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
    res.send(body);
  } catch (e) { console.error('[credenciales vcf]', e.message); res.status(500).send('Error'); }
};

const errSrv = (res, e, tag) => { console.error(`[${tag}]`, e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); };

/* ── GET /api/credenciales — usuarios activos con sus datos de credencial ── */
exports.listar = async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.id_usuario, u.nombre, u.apellido, u.apellido_materno, u.rut, u.cargo, u.telefono, u.email,
             c.expira, (c.foto IS NOT NULL) tiene_foto
      FROM usuarios u LEFT JOIN credenciales_usuario c ON c.id_usuario = u.id_usuario
      WHERE u.estado='activo'
        AND COALESCE(u.protegido, 0) = 0   -- las cuentas de sistema no llevan credencial
      ORDER BY u.nombre, u.apellido`);
    const tokens = await asegurarTokens(rows.map(r => r.id_usuario));
    rows.forEach(r => { r.token = tokens[r.id_usuario] || null; });
    res.json({ success: true, data: rows, error: null });
  } catch (e) { errSrv(res, e, 'credenciales listar'); }
};

/* ── Datos comunes de la empresa (van al vCard del QR, no impresos en la tarjeta) ── */
exports.empresaGet = async (_req, res) => {
  try {
    const [[e]] = await pool.query('SELECT organizacion, direccion, web, telefono, email FROM credenciales_empresa WHERE id=1');
    res.json({ success: true, data: e || {}, error: null });
  } catch (e) { errSrv(res, e, 'credenciales empresaGet'); }
};
exports.empresaPut = async (req, res) => {
  try {
    const b = req.body || {};
    const v = c => String(b[c] ?? '').trim().slice(0, 200) || null;
    await pool.query(`INSERT INTO credenciales_empresa (id, organizacion, direccion, web, telefono, email) VALUES (1,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE organizacion=VALUES(organizacion), direccion=VALUES(direccion), web=VALUES(web), telefono=VALUES(telefono), email=VALUES(email)`,
      [v('organizacion'), v('direccion'), v('web'), v('telefono'), v('email')]);
    res.json({ success: true, data: null, error: null });
  } catch (e) { errSrv(res, e, 'credenciales empresaPut'); }
};

/* ── GET /api/credenciales/mi-firma — datos para la firma de correo del usuario logueado.
   Fuente única: ficha de Usuarios (nombre, cargo, teléfono corporativo, correo) + datos de la
   empresa de Credenciales Corporativas (web, dirección, teléfono). La firma se arma en /mi-firma/. */
exports.miFirma = async (req, res) => {
  try {
    const [[u]] = await pool.query('SELECT nombre, apellido, apellido_materno, cargo, telefono, email FROM usuarios WHERE id_usuario=?', [req.usuario.id_usuario]);
    if (!u) return res.status(404).json({ success: false, data: null, error: 'Usuario no encontrado' });
    const [[e]] = await pool.query('SELECT organizacion, direccion, web, telefono, email FROM credenciales_empresa WHERE id=1');
    res.json({ success: true, data: { ...u, empresa: e || {} }, error: null });
  } catch (e) { errSrv(res, e, 'credenciales miFirma'); }
};

/* ── GET /api/credenciales/mi-foto — foto del usuario logueado (avatar topnav) ── */
exports.miFoto = async (req, res) => {
  try {
    const [[c]] = await pool.query('SELECT foto FROM credenciales_usuario WHERE id_usuario=?', [req.usuario.id_usuario]);
    res.json({ success: true, data: { foto: (c && c.foto) || null }, error: null });
  } catch (e) { errSrv(res, e, 'credenciales miFoto'); }
};

/* ── GET /api/credenciales/fotos — fotos de todos los usuarios activos.
   Para el Directorio de colaboradores: cualquier usuario logueado (la foto
   carnet es información de directorio, no sensible). */
exports.fotos = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.id_usuario, c.foto FROM credenciales_usuario c
        JOIN usuarios u ON u.id_usuario = c.id_usuario AND u.estado='activo'
       WHERE c.foto IS NOT NULL`);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { console.error('[credenciales fotos]', e.message); res.status(500).json({ success:false, data:null, error:'Error interno del servidor' }); }
};

/* ── GET /api/credenciales/:id — con foto (para el render) ───────────────── */
exports.una = async (req, res) => {
  try {
    const id = parseInt(req.params.id) || 0;
    const [[u]] = await pool.query(`
      SELECT u.id_usuario, u.nombre, u.apellido, u.apellido_materno, u.rut, u.cargo, u.telefono, u.email,
             c.expira, c.foto
      FROM usuarios u LEFT JOIN credenciales_usuario c ON c.id_usuario = u.id_usuario
      WHERE u.id_usuario=?`, [id]);
    if (!u) return res.status(404).json({ success: false, data: null, error: 'Usuario no encontrado' });
    res.json({ success: true, data: u, error: null });
  } catch (e) { errSrv(res, e, 'credenciales una'); }
};

/* ── PUT /api/credenciales/:id — guardar foto/expiración (y cargo en usuarios) ── */
exports.guardar = async (req, res) => {
  try {
    const id = parseInt(req.params.id) || 0;
    const b = req.body || {};
    /* La expresión validaba SOLO el prefijo (sin `$`), así que cualquier texto
       podía viajar después de `base64,` — incluido `" onerror="…`, que rompe el
       atributo src donde se pinta y ejecuta en el muro de Facilbook de toda la
       empresa. Ahora se exige que el resto sea base64 legítimo de punta a punta
       (auditoría 05-08-2026, M-1). */
    if (b.foto !== undefined && b.foto &&
        !/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/\r\n]+={0,2}$/.test(String(b.foto)))
      return res.status(400).json({ success: false, data: null, error: 'Foto inválida (debe ser imagen)' });
    if (String(b.foto || '').length > 2_000_000)
      return res.status(400).json({ success: false, data: null, error: 'Foto muy pesada (máx ~1,5 MB)' });
    const expira = /^\d{4}-\d{2}-\d{2}$/.test(String(b.expira)) ? b.expira : null;
    await pool.query(`
      INSERT INTO credenciales_usuario (id_usuario, foto, expira) VALUES (?,?,?)
      ON DUPLICATE KEY UPDATE foto=COALESCE(VALUES(foto), foto), expira=COALESCE(VALUES(expira), expira)`,
      [id, b.foto || null, expira]);
    if (b.cargo !== undefined) await pool.query('UPDATE usuarios SET cargo=? WHERE id_usuario=?', [String(b.cargo || '').slice(0, 100) || null, id]);
    res.json({ success: true, data: null, error: null });
  } catch (e) { errSrv(res, e, 'credenciales guardar'); }
};
