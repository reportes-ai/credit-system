'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   PORTAL DEL POSTULANTE (RRHH)

   · RRHH publica un AVISO (cargo, descripción, preguntas propias y requisitos
     con escala de cumplimiento 0/25/50/75/100%). Cada aviso genera un LINK
     público /postula/?a=<slug> para enviar a los candidatos.
   · El postulante sube su CV y la IA (shared/anthropic, modelo económico)
     pre-llena la ficha: nombre, RUT, nacimiento, estudios por nivel, trabajos,
     idiomas, habilidades. Lo que la IA no encontró queda marcado para llenar
     a mano. El CV original se guarda (Máxima del almacén: al bucket, nunca
     LONGBLOB nuevo salvo fallback).
   · Al postular sale el correo de ACUSE; al descartar, el correo cortés de
     "quedas en nuestra base para futuras oportunidades". Todo por
     shared/mailer (respeta Modo Desarrollo) y queda en correos_log.
   · La base de postulantes es PERMANENTE: descartado ≠ borrado.
   ───────────────────────────────────────────────────────────────────────────── */
const crypto = require('crypto');
const pool = require('../../../../shared/config/database');
const almacen = require('../../../../shared/almacen-docs');
const { auditar } = require('../../../../shared/audit');

const ok = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });
const nombreDe = req => [req.usuario?.nombre, req.usuario?.apellido].filter(Boolean).join(' ') || 'Sistema';
const CV_MAX = 8 * 1024 * 1024;   // body del gateway 10mb; base64 infla ~37%
const NIVELES_REQ = [0, 25, 50, 75, 100];

/* ── Migración: tablas + funcionalidad + card + registro IA ── */
require('../../../../shared/migrate').enFila('rh-postulaciones', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_avisos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    slug VARCHAR(24) NOT NULL UNIQUE,
    titulo VARCHAR(200) NOT NULL,
    descripcion TEXT NULL,
    ubicacion VARCHAR(120) NULL,
    jornada VARCHAR(120) NULL,
    preguntas JSON NULL,
    requisitos JSON NULL,
    activo TINYINT NOT NULL DEFAULT 1,
    created_by VARCHAR(160) NULL,
    created_at DATETIME DEFAULT NOW(),
    INDEX ix_slug (slug))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_postulantes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_aviso INT NOT NULL,
    nombre VARCHAR(200) NOT NULL,
    rut VARCHAR(20) NULL,
    email VARCHAR(200) NOT NULL,
    telefono VARCHAR(40) NULL,
    fecha_nacimiento DATE NULL,
    direccion VARCHAR(250) NULL,
    comuna VARCHAR(120) NULL,
    linkedin VARCHAR(250) NULL,
    pretension_renta VARCHAR(60) NULL,
    resumen_ia TEXT NULL,
    estudios JSON NULL,
    trabajos JSON NULL,
    idiomas JSON NULL,
    habilidades JSON NULL,
    respuestas JSON NULL,
    requisitos_eval JSON NULL,
    campos_ia JSON NULL,
    estado VARCHAR(20) NOT NULL DEFAULT 'NUEVA',
    nota_rrhh TEXT NULL,
    cv_nombre VARCHAR(250) NULL, cv_mime VARCHAR(120) NULL, cv_data LONGBLOB NULL,
    acuse_at DATETIME NULL, descarte_at DATETIME NULL,
    created_at DATETIME DEFAULT NOW(), updated_at DATETIME DEFAULT NOW() ON UPDATE NOW(),
    UNIQUE KEY uq_post (id_aviso, email),
    INDEX ix_aviso (id_aviso), INDEX ix_rut (rut), INDEX ix_estado (estado))`);
  for (const ddl of almacen.sqlColumnas('rh_postulantes')) {
    try { await pool.query(ddl); } catch (e) { if (e.errno !== 1060) console.error('[postulantes almacen]', e.message); }
  }
  // Funcionalidad + card (regla anti-hardcode: el menú sale de BD)
  try {
    const [[mod]] = await pool.query(`SELECT id_modulo FROM modulos WHERE ruta='/recursos-humanos/' OR nombre LIKE '%Recursos Humanos%' LIMIT 1`);
    if (mod) {
      const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='rh_postulaciones'");
      let idF = ex && ex.id_funcionalidad;
      if (!idF) {
        const [ins] = await pool.query(
          `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
           VALUES (?, 'Portal del Postulante', 'rh_postulaciones', '/recursos-humanos/postulaciones/', 'bi-person-plus')`,
          [mod.id_modulo]);
        idF = ins.insertId;
        for (const p of ['Administrador', 'Consultora Recursos Humanos', 'Jefe Recursos Humanos', 'Gerente General']) {
          await pool.query(
            `INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad)
             SELECT id_perfil, ? FROM perfiles WHERE nombre = ?`, [idF, p]);
        }
      }
    }
  } catch (e) { console.error('[postulaciones seed]', e.message); }
  try {
    await require('../../../../shared/ia').registrarFuncionalidad({
      codigo: 'cv_postulante',
      nombre: 'Lectura de CV de postulantes',
      descripcion: 'Extrae del currículum los datos personales, estudios, trabajos, idiomas y habilidades para pre-llenar la postulación',
      modelo: 'claude-haiku-4-5',
    });
  } catch (e) { console.error('[postulaciones ia]', e.message); }
});

/* ═══════════════ LADO PÚBLICO (sin token — lo usa el candidato) ═══════════════ */

/* GET /api/postulaciones/aviso/:slug — el aviso publicado, sin datos internos */
const avisoPublico = async (req, res) => {
  try {
    const [[a]] = await pool.query(
      'SELECT id, slug, titulo, descripcion, ubicacion, jornada, preguntas, requisitos, activo FROM rh_avisos WHERE slug=?',
      [String(req.params.slug || '').slice(0, 24)]);
    if (!a) return fail(res, 'Aviso no encontrado', 404);
    if (!a.activo) return fail(res, 'Esta búsqueda ya está cerrada. ¡Gracias por tu interés!', 410);
    ok(res, { titulo: a.titulo, descripcion: a.descripcion, ubicacion: a.ubicacion, jornada: a.jornada,
      preguntas: parseJ(a.preguntas, []), requisitos: parseJ(a.requisitos, []) });
  } catch (e) { console.error('[aviso publico]', e.message); fail(res, 'Error interno del servidor'); }
};

const parseJ = (v, d) => { try { const x = typeof v === 'string' ? JSON.parse(v) : v; return x == null ? d : x; } catch (_) { return d; } };

/* POST /api/postulaciones/aviso/:slug/extraer-cv — la IA lee el CV y devuelve la ficha.
   Acepta PDF e imágenes (JPG/PNG). Nunca falla la postulación: si la IA no está
   disponible devuelve campos vacíos y el candidato llena a mano. */
const extraerCV = async (req, res) => {
  try {
    const [[a]] = await pool.query('SELECT id, activo FROM rh_avisos WHERE slug=?', [String(req.params.slug || '').slice(0, 24)]);
    if (!a || !a.activo) return fail(res, 'Aviso no disponible', 404);
    const { archivo_data, mime } = req.body || {};
    if (!archivo_data) return fail(res, 'Falta el archivo', 400);
    const buf = Buffer.from(String(archivo_data), 'base64');
    if (buf.length > CV_MAX) return fail(res, 'El archivo supera 8 MB', 400);
    const esPdf = /pdf/i.test(mime || '');
    const esImg = /image\/(jpe?g|png)/i.test(mime || '');
    if (!esPdf && !esImg) return ok(res, { campos: null, motivo: 'formato' });   // docx: se guarda igual, ficha a mano

    const { analizar, disponible } = require('../../../../shared/anthropic');
    if (!disponible()) return ok(res, { campos: null, motivo: 'ia_off' });
    const { datos } = await analizar({
      codigo: 'cv_postulante',
      system: 'Eres un asistente de reclutamiento chileno. Lees un currículum y devuelves SOLO un JSON con los datos que el documento REALMENTE contiene. Jamás inventes: un dato que no aparece va como null. Fechas en formato YYYY-MM-DD (o YYYY si solo hay año). RUT con guión y dígito verificador.',
      prompt: `Extrae del currículum adjunto este JSON exacto:
{
 "nombre_completo": string|null, "rut": string|null, "fecha_nacimiento": string|null,
 "email": string|null, "telefono": string|null, "direccion": string|null, "comuna": string|null,
 "linkedin": string|null, "pretension_renta": string|null,
 "resumen": string|null  (2-3 líneas objetivas del perfil, en español),
 "estudios": [{"nivel": "Básica"|"Media"|"Técnico"|"Universitario"|"Postgrado"|"Curso", "institucion": string|null, "titulo": string|null, "desde": string|null, "hasta": string|null, "estado": "Completo"|"Incompleto"|"En curso"|null}],
 "trabajos": [{"empresa": string|null, "cargo": string|null, "desde": string|null, "hasta": string|null, "descripcion": string|null}]  (del más reciente al más antiguo),
 "idiomas": [{"idioma": string, "nivel": string|null}],
 "habilidades": [string]
}`,
      documentos: [{ tipo: esPdf ? 'pdf' : 'imagen', data: buf.toString('base64'), media_type: esPdf ? undefined : mime }],
      json: true, max_tokens: 3000,
    });
    ok(res, { campos: datos || null });
  } catch (e) {
    console.error('[extraer cv]', e.message);
    ok(res, { campos: null, motivo: 'error' });   // la IA nunca bloquea la postulación
  }
};

/* POST /api/postulaciones/aviso/:slug/postular — recibe la postulación completa */
const postular = async (req, res) => {
  try {
    const [[a]] = await pool.query('SELECT * FROM rh_avisos WHERE slug=?', [String(req.params.slug || '').slice(0, 24)]);
    if (!a || !a.activo) return fail(res, 'Esta búsqueda ya está cerrada.', 410);
    const b = req.body || {};
    const nombre = String(b.nombre || '').trim().slice(0, 200);
    const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
    if (!nombre || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return fail(res, 'Nombre y correo válido son obligatorios', 400);
    if (!b.cv_data || !b.cv_nombre) return fail(res, 'El CV es obligatorio', 400);
    const buf = Buffer.from(String(b.cv_data), 'base64');
    if (buf.length > CV_MAX) return fail(res, 'El CV supera 8 MB', 400);

    // Requisitos: solo niveles válidos, solo requisitos del aviso
    const reqsAviso = parseJ(a.requisitos, []).map(r => String(r.nombre || r));
    const evalIn = Array.isArray(b.requisitos_eval) ? b.requisitos_eval : [];
    const requisitos_eval = reqsAviso.map(nom => {
      const e = evalIn.find(x => String(x.nombre) === nom);
      const pct = NIVELES_REQ.includes(Number(e && e.pct)) ? Number(e.pct) : 0;
      return { nombre: nom, pct };
    });

    const j = v => JSON.stringify(Array.isArray(v) || (v && typeof v === 'object') ? v : []);
    const d = await almacen.colocar({ ambito: 'postulaciones', clave: a.id + '-' + email.replace(/[^a-z0-9]/gi, '_'),
      buffer: buf, mime: b.cv_mime || 'application/pdf', nombre: String(b.cv_nombre).slice(0, 200) });

    const campos = [nombre, b.rut ? String(b.rut).trim().toUpperCase().slice(0, 20) : null, email,
      String(b.telefono || '').slice(0, 40) || null,
      /^\d{4}-\d{2}-\d{2}$/.test(b.fecha_nacimiento || '') ? b.fecha_nacimiento : null,
      String(b.direccion || '').slice(0, 250) || null, String(b.comuna || '').slice(0, 120) || null,
      String(b.linkedin || '').slice(0, 250) || null, String(b.pretension_renta || '').slice(0, 60) || null,
      String(b.resumen_ia || '').slice(0, 2000) || null,
      j(b.estudios), j(b.trabajos), j(b.idiomas), j(b.habilidades), j(b.respuestas),
      JSON.stringify(requisitos_eval), j(b.campos_ia),
      String(b.cv_nombre).slice(0, 250), String(b.cv_mime || 'application/pdf').slice(0, 120),
      d.blob, d.storage, d.ruta, d.bytes];

    // Repostular al mismo aviso con el mismo correo ACTUALIZA (no duplica).
    await pool.query(`
      INSERT INTO rh_postulantes (id_aviso, nombre, rut, email, telefono, fecha_nacimiento, direccion, comuna,
        linkedin, pretension_renta, resumen_ia, estudios, trabajos, idiomas, habilidades, respuestas,
        requisitos_eval, campos_ia, cv_nombre, cv_mime, cv_data, doc_storage, doc_ruta, doc_bytes)
      VALUES (?, ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE nombre=VALUES(nombre), rut=VALUES(rut), telefono=VALUES(telefono),
        fecha_nacimiento=VALUES(fecha_nacimiento), direccion=VALUES(direccion), comuna=VALUES(comuna),
        linkedin=VALUES(linkedin), pretension_renta=VALUES(pretension_renta), resumen_ia=VALUES(resumen_ia),
        estudios=VALUES(estudios), trabajos=VALUES(trabajos), idiomas=VALUES(idiomas), habilidades=VALUES(habilidades),
        respuestas=VALUES(respuestas), requisitos_eval=VALUES(requisitos_eval), campos_ia=VALUES(campos_ia),
        cv_nombre=VALUES(cv_nombre), cv_mime=VALUES(cv_mime), cv_data=VALUES(cv_data),
        doc_storage=VALUES(doc_storage), doc_ruta=VALUES(doc_ruta), doc_bytes=VALUES(doc_bytes), updated_at=NOW()`,
      [a.id, ...campos]);

    // Acuse de recibo (fire & forget: el correo nunca frena la postulación)
    enviarAcuse(a, nombre, email).catch(e => console.error('[acuse postulacion]', e.message));
    ok(res, { recibido: true });
  } catch (e) { console.error('[postular]', e.message); fail(res, 'No pudimos registrar tu postulación. Inténtalo de nuevo.'); }
};

async function enviarAcuse(aviso, nombre, email) {
  const { enviarCorreo, mailConfigurado, envolverHTML } = require('../../../../shared/mailer');
  if (!mailConfigurado()) return;
  const primer = nombre.split(' ')[0];
  const html = envolverHTML(`
    <p>Hola ${primer}:</p>
    <p>Recibimos tu postulación al cargo de <b>${aviso.titulo}</b> en AutoFácil. ¡Gracias por tu interés en ser parte de nuestro equipo!</p>
    <p>Nuestro equipo de Recursos Humanos revisará tus antecedentes y, si tu perfil avanza en el proceso, nos pondremos en contacto contigo a este mismo correo o al teléfono que nos dejaste.</p>
    <p style="color:#64748b;font-size:.9em">Este es un mensaje automático de confirmación — no es necesario responderlo.</p>
    <p>Saludos,<br><b>Equipo de Recursos Humanos · AutoFácil</b></p>`);
  await enviarCorreo({ to: email, subject: `Recibimos tu postulación — ${aviso.titulo} · AutoFácil`, html });
  await pool.query('UPDATE rh_postulantes SET acuse_at=NOW() WHERE id_aviso=? AND email=?', [aviso.id, email]);
}

/* ═══════════════ LADO RRHH (con token + rh_postulaciones) ═══════════════ */

const nuevoSlug = () => crypto.randomBytes(8).toString('base64url').replace(/[-_]/g, 'a').slice(0, 12);

const avisosListar = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT a.*, (SELECT COUNT(*) FROM rh_postulantes p WHERE p.id_aviso=a.id) AS postulantes,
             (SELECT COUNT(*) FROM rh_postulantes p WHERE p.id_aviso=a.id AND p.estado='NUEVA') AS nuevas
      FROM rh_avisos a ORDER BY a.activo DESC, a.id DESC`);
    ok(res, rows.map(r => ({ ...r, preguntas: parseJ(r.preguntas, []), requisitos: parseJ(r.requisitos, []) })));
  } catch (e) { console.error('[avisos]', e.message); fail(res, 'Error interno'); }
};

const avisoGuardar = async (req, res) => {
  try {
    const b = req.body || {};
    const titulo = String(b.titulo || '').trim().slice(0, 200);
    if (!titulo) return fail(res, 'El título del cargo es obligatorio', 400);
    const preguntas = (Array.isArray(b.preguntas) ? b.preguntas : []).map(p => String(p).trim().slice(0, 300)).filter(Boolean).slice(0, 10);
    const requisitos = (Array.isArray(b.requisitos) ? b.requisitos : []).map(r => ({ nombre: String(r.nombre || r).trim().slice(0, 150) })).filter(r => r.nombre).slice(0, 15);
    const vals = [titulo, String(b.descripcion || '').slice(0, 8000) || null, String(b.ubicacion || '').slice(0, 120) || null,
      String(b.jornada || '').slice(0, 120) || null, JSON.stringify(preguntas), JSON.stringify(requisitos), b.activo === 0 || b.activo === false ? 0 : 1];
    let id = parseInt(req.params.id) || null, slug;
    if (id) {
      await pool.query('UPDATE rh_avisos SET titulo=?, descripcion=?, ubicacion=?, jornada=?, preguntas=?, requisitos=?, activo=? WHERE id=?', [...vals, id]);
      const [[r]] = await pool.query('SELECT slug FROM rh_avisos WHERE id=?', [id]); slug = r && r.slug;
    } else {
      slug = nuevoSlug();
      const [ins] = await pool.query(
        'INSERT INTO rh_avisos (slug, titulo, descripcion, ubicacion, jornada, preguntas, requisitos, activo, created_by) VALUES (?,?,?,?,?,?,?,?,?)',
        [slug, ...vals, nombreDe(req)]);
      id = ins.insertId;
    }
    auditar({ req, accion: id ? 'GUARDAR' : 'CREAR', modulo: 'postulaciones', entidad: 'aviso', entidad_id: id, detalle: `Aviso "${titulo}"` });
    ok(res, { id, slug, link: '/postula/?a=' + slug });
  } catch (e) { console.error('[aviso guardar]', e.message); fail(res, 'Error interno'); }
};

const postulantesListar = async (req, res) => {
  try {
    const idAviso = parseInt(req.query.aviso) || null;
    const [rows] = await pool.query(`
      SELECT p.id, p.id_aviso, a.titulo AS aviso, p.nombre, p.rut, p.email, p.telefono, p.comuna,
             p.fecha_nacimiento, p.pretension_renta, p.resumen_ia, p.estado, p.estudios, p.trabajos,
             p.idiomas, p.habilidades, p.requisitos_eval, p.created_at, p.acuse_at, p.descarte_at, p.cv_nombre
      FROM rh_postulantes p JOIN rh_avisos a ON a.id = p.id_aviso
      ${idAviso ? 'WHERE p.id_aviso = ?' : ''} ORDER BY p.created_at DESC LIMIT 1000`,
      idAviso ? [idAviso] : []);
    ok(res, rows.map(r => {
      const ev = parseJ(r.requisitos_eval, []);
      const prom = ev.length ? Math.round(ev.reduce((s, x) => s + (Number(x.pct) || 0), 0) / ev.length) : null;
      return { ...r, estudios: parseJ(r.estudios, []), trabajos: parseJ(r.trabajos, []), idiomas: parseJ(r.idiomas, []),
        habilidades: parseJ(r.habilidades, []), requisitos_eval: ev, cumplimiento: prom };
    }));
  } catch (e) { console.error('[postulantes]', e.message); fail(res, 'Error interno'); }
};

const postulanteFicha = async (req, res) => {
  try {
    const [[p]] = await pool.query(`
      SELECT p.*, a.titulo AS aviso, a.preguntas AS aviso_preguntas FROM rh_postulantes p
      JOIN rh_avisos a ON a.id = p.id_aviso WHERE p.id=?`, [parseInt(req.params.id)]);
    if (!p) return fail(res, 'Postulante no encontrado', 404);
    delete p.cv_data;
    for (const k of ['estudios', 'trabajos', 'idiomas', 'habilidades', 'respuestas', 'requisitos_eval', 'campos_ia', 'aviso_preguntas'])
      p[k] = parseJ(p[k], []);
    ok(res, p);
  } catch (e) { console.error('[ficha postulante]', e.message); fail(res, 'Error interno'); }
};

const postulanteCV = async (req, res) => {
  try {
    const [[p]] = await pool.query('SELECT cv_nombre, cv_mime, cv_data, doc_ruta FROM rh_postulantes WHERE id=?', [parseInt(req.params.id)]);
    if (!p) return fail(res, 'No encontrado', 404);
    await almacen.servir(res, { ruta: p.doc_ruta, blob: p.cv_data, nombre: p.cv_nombre || 'cv.pdf', mime: p.cv_mime, adjunto: false });
  } catch (e) { console.error('[cv postulante]', e.message); fail(res, 'Error interno'); }
};

const ESTADOS = ['NUEVA', 'EN REVISION', 'ENTREVISTA', 'DESCARTADA', 'CONTRATADA'];
const postulanteEstado = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const estado = String((req.body || {}).estado || '').toUpperCase();
    const nota = String((req.body || {}).nota || '').slice(0, 1000);
    if (!ESTADOS.includes(estado)) return fail(res, 'Estado inválido', 400);
    const [[p]] = await pool.query('SELECT p.*, a.titulo AS aviso FROM rh_postulantes p JOIN rh_avisos a ON a.id=p.id_aviso WHERE p.id=?', [id]);
    if (!p) return fail(res, 'No encontrado', 404);
    await pool.query('UPDATE rh_postulantes SET estado=?, nota_rrhh=COALESCE(NULLIF(?,\'\'), nota_rrhh) WHERE id=?', [estado, nota, id]);
    auditar({ req, accion: 'ESTADO', modulo: 'postulaciones', entidad: 'postulante', entidad_id: id,
      detalle: `${p.nombre} (${p.aviso}): ${p.estado} → ${estado}${nota ? ' — ' + nota : ''}` });
    // El correo de descarte sale UNA sola vez, cortés y con la puerta abierta.
    if (estado === 'DESCARTADA' && !p.descarte_at) {
      enviarDescarte(p).catch(e => console.error('[descarte mail]', e.message));
    }
    ok(res, { id, estado });
  } catch (e) { console.error('[estado postulante]', e.message); fail(res, 'Error interno'); }
};

async function enviarDescarte(p) {
  const { enviarCorreo, mailConfigurado, envolverHTML } = require('../../../../shared/mailer');
  if (!mailConfigurado()) return;
  const primer = String(p.nombre || '').split(' ')[0];
  const html = envolverHTML(`
    <p>Estimado/a ${primer}:</p>
    <p>Queremos agradecerte sinceramente el tiempo y el interés que dedicaste a postular al cargo de <b>${p.aviso}</b> en AutoFácil.</p>
    <p>Luego de revisar cuidadosamente todas las postulaciones, en esta oportunidad hemos decidido avanzar con otros candidatos cuyo perfil se ajusta más a los requerimientos específicos de esta búsqueda. Esta decisión no es un juicio sobre tu valía profesional — el nivel de los postulantes fue muy alto.</p>
    <p><b>Tus antecedentes quedarán guardados en nuestra base</b> y serán considerados con prioridad en futuras oportunidades que se ajusten a tu perfil.</p>
    <p>Te deseamos mucho éxito en tus próximos desafíos profesionales.</p>
    <p>Saludos cordiales,<br><b>Equipo de Recursos Humanos · AutoFácil</b></p>`);
  await enviarCorreo({ to: p.email, subject: `Proceso ${p.aviso} — AutoFácil`, html });
  await pool.query('UPDATE rh_postulantes SET descarte_at=NOW() WHERE id=?', [p.id]);
}

module.exports = { avisoPublico, extraerCV, postular, avisosListar, avisoGuardar,
  postulantesListar, postulanteFicha, postulanteCV, postulanteEstado };
