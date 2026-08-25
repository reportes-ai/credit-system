'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   PORTAL DEL POSTULANTE (RRHH) — v2: workflow completo de selección

   · RRHH publica un AVISO (cargo, descripción, jefe directo solicitante y
     PREGUNTAS tipificadas). Cada aviso genera un LINK público /postula/?a=<slug>
     y una MAQUETA (/postula/?a=<slug>&maqueta=1) para ver lo que verá el
     candidato antes de publicar.
   · Tipos de pregunta: sí/no, escalas (no cumple–cumple, bajo/medio/alto,
     nunca…siempre), porcentaje 0-100, alternativas múltiples y texto libre con
     tope de caracteres. Cada una con importancia (excluyente / alta / media /
     baja / solo informativa).
   · MOTOR DE TABULACIÓN (un solo lugar: tabular()): pondera Alta×3, Media×2,
     Baja×1 → % → ESTRELLAS 0-5 (medias estrellas). Una pregunta EXCLUYENTE
     bajo 50% deja al candidato NO APTO (se informa qué preguntas falló).
   · El postulante sube su CV y la IA (shared/anthropic, modelo económico)
     pre-llena la ficha; lo que falte queda marcado para llenar a mano. El CV
     original se guarda (Máxima del almacén: al bucket, nunca LONGBLOB nuevo
     salvo fallback).
   · WORKFLOW: el JEFE DIRECTO del aviso revisa los candidatos (página propia,
     permiso rh_postulaciones_jefe) y marca los que le interesan → eso los envía
     a RRHH y dispara los informes DealerNet del RUT (motor único
     asegurarInformes de services/clientes). RRHH preselecciona, AGENDA
     entrevistas (RRHH y/o Jefe, con correo de invitación), registra el informe
     de entrevista y sube los tests (Ecuador). Con todo eso, "Enviar a
     Jefatura" manda al jefe el resumen comparado + adjuntos.
   · Correos: acuse al postular, invitación a entrevista, informe a jefatura y
     descarte cortés ("tus antecedentes quedan guardados"). Todo por
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
const parseJ = (v, d) => { try { const x = typeof v === 'string' ? JSON.parse(v) : v; return x == null ? d : x; } catch (_) { return d; } };

/* ═══════ MOTOR DE PREGUNTAS Y TABULACIÓN (Máxima 1: un solo motor) ═══════ */

const TIPOS = ['si_no', 'escala', 'porcentaje', 'multiple', 'texto'];
const ESCALAS = {
  cumple:     { nombre: 'No cumple / Cumple',        opciones: ['No cumple', 'Cumple parcialmente', 'Cumple'], pct: [0, 50, 100] },
  nivel:      { nombre: 'Bajo / Medio / Alto',       opciones: ['Bajo', 'Medio', 'Alto'],                      pct: [0, 50, 100] },
  frecuencia: { nombre: 'Nunca … Siempre',           opciones: ['Nunca', 'Pocas veces', 'A menudo', 'Siempre'], pct: [0, 33, 67, 100] },
};
const PESOS = { excluyente: 3, alta: 3, media: 2, baja: 1, info: 0 };

/* Sanea una lista de preguntas venida del builder (o strings legacy) */
function limpiarPreguntas(arr) {
  return (Array.isArray(arr) ? arr : []).slice(0, 25).map((p, i) => {
    if (typeof p === 'string') return { id: 'p' + i, texto: p.trim().slice(0, 300), tipo: 'texto', importancia: 'info', max_chars: 1500 };
    const tipo = TIPOS.includes(p.tipo) ? p.tipo : 'texto';
    const q = { id: String(p.id || 'p' + i).slice(0, 16), texto: String(p.texto || '').trim().slice(0, 300), tipo,
      importancia: PESOS[p.importancia] != null ? p.importancia : 'info' };
    if (tipo === 'escala') q.escala = ESCALAS[p.escala] ? p.escala : 'cumple';
    if (tipo === 'si_no') q.cumple = p.cumple === 'No' ? 'No' : 'Sí';
    if (tipo === 'multiple') q.opciones = (Array.isArray(p.opciones) ? p.opciones : []).slice(0, 8)
      .map(o => ({ texto: String(o.texto || o).trim().slice(0, 150), ok: o.ok ? 1 : 0 })).filter(o => o.texto);
    if (tipo === 'texto') q.max_chars = Math.min(Math.max(parseInt(p.max_chars) || 1000, 50), 3000);
    return q;
  }).filter(q => q.texto);
}

/* Preguntas efectivas de un aviso: las nuevas + los requisitos legacy (0-100%) */
function preguntasDe(aviso) {
  const out = limpiarPreguntas(parseJ(aviso.preguntas, []));
  parseJ(aviso.requisitos, []).forEach((r, i) => {
    const nom = String(r.nombre || r).trim();
    if (nom) out.push({ id: 'r' + i, texto: nom, tipo: 'porcentaje', importancia: 'media' });
  });
  return out;
}

/* Lo que ve el CANDIDATO: sin importancia ni cuál alternativa "cumple" (no se filtra la pauta) */
const vistaPublica = pregs => pregs.map(p => ({
  id: p.id, texto: p.texto, tipo: p.tipo,
  opciones: p.tipo === 'escala' ? ESCALAS[p.escala].opciones
    : p.tipo === 'multiple' ? p.opciones.map(o => o.texto)
    : p.tipo === 'porcentaje' ? NIVELES_REQ
    : p.tipo === 'si_no' ? ['Sí', 'No'] : null,
  max_chars: p.tipo === 'texto' ? p.max_chars : undefined,
}));

function puntuarRespuesta(preg, valor) {   // → 0-100, o null si la pregunta no puntúa
  if (preg.tipo === 'texto') return null;
  if (preg.tipo === 'si_no') return String(valor) === preg.cumple ? 100 : 0;
  if (preg.tipo === 'escala') { const e = ESCALAS[preg.escala]; const ix = e.opciones.indexOf(String(valor)); return ix < 0 ? 0 : e.pct[ix]; }
  if (preg.tipo === 'porcentaje') return NIVELES_REQ.includes(Number(valor)) ? Number(valor) : 0;
  if (preg.tipo === 'multiple') {
    if (!(preg.opciones || []).some(o => o.ok)) return null;   // sin alternativa marcada como "cumple" = solo informativa
    const o = (preg.opciones || []).find(x => x.texto === String(valor));
    return o && o.ok ? 100 : 0;
  }
  return null;
}

function tabular(preguntas, respuestas) {
  const detalle = [], excluyentes = [];
  let suma = 0, pesos = 0;
  for (const preg of preguntas) {
    const r = respuestas.find(x => String(x.id) === preg.id);
    const pct = puntuarRespuesta(preg, r ? r.valor : undefined);
    const peso = PESOS[preg.importancia] || 0;
    detalle.push({ id: preg.id, texto: preg.texto, tipo: preg.tipo, importancia: preg.importancia,
      valor: r ? r.valor : null, pct, peso: (pct == null ? 0 : peso) });
    if (pct == null || !peso) continue;
    suma += pct * peso; pesos += peso;
    if (preg.importancia === 'excluyente' && pct < 50) excluyentes.push(preg.texto);
  }
  const pct = pesos ? Math.round(suma / pesos) : null;
  const estrellas = pct == null ? null : Math.round(pct / 10) / 2;   // 0-5 en medias estrellas
  return { pct, estrellas, apto: excluyentes.length ? 0 : 1, excluyentes, detalle };
}

/* ── Migración: tablas + funcionalidades + registro IA ── */
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
  // v2: jefe directo del aviso + tabulación, workflow y anexos del postulante
  const alters = [
    "ALTER TABLE rh_avisos ADD COLUMN id_jefe INT NULL",
    "ALTER TABLE rh_postulantes ADD COLUMN estrellas DECIMAL(3,1) NULL",
    "ALTER TABLE rh_postulantes ADD COLUMN apto TINYINT NULL",
    "ALTER TABLE rh_postulantes ADD COLUMN puntaje JSON NULL",
    "ALTER TABLE rh_postulantes ADD COLUMN jefe_marca TINYINT NOT NULL DEFAULT 0",
    "ALTER TABLE rh_postulantes ADD COLUMN jefe_marca_por VARCHAR(160) NULL",
    "ALTER TABLE rh_postulantes ADD COLUMN jefe_marca_at DATETIME NULL",
    "ALTER TABLE rh_postulantes ADD COLUMN jefe_nota TEXT NULL",
    "ALTER TABLE rh_postulantes ADD COLUMN dealernet JSON NULL",
    "ALTER TABLE rh_postulantes ADD COLUMN dealernet_at DATETIME NULL",
    "ALTER TABLE rh_postulantes ADD COLUMN entrevistas JSON NULL",
    "ALTER TABLE rh_postulantes ADD COLUMN informe_rrhh TEXT NULL",
    "ALTER TABLE rh_postulantes ADD COLUMN jefatura_at DATETIME NULL",
    "ALTER TABLE rh_postulantes ADD COLUMN analisis_ia JSON NULL",
    "ALTER TABLE rh_postulantes ADD COLUMN analisis_ia_at DATETIME NULL",
  ];
  for (const ddl of alters) {
    try { await pool.query(ddl); } catch (e) { if (e.errno !== 1060) console.error('[postulantes v2]', e.message); }
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_postulante_docs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_postulante INT NOT NULL,
    tipo VARCHAR(20) NOT NULL DEFAULT 'TEST',
    nombre VARCHAR(250) NOT NULL,
    mime VARCHAR(120) NULL,
    data LONGBLOB NULL,
    subido_por VARCHAR(160) NULL,
    created_at DATETIME DEFAULT NOW(),
    INDEX ix_post (id_postulante))`);
  for (const t of ['rh_postulantes', 'rh_postulante_docs']) {
    for (const ddl of almacen.sqlColumnas(t)) {
      try { await pool.query(ddl); } catch (e) { if (e.errno !== 1060) console.error('[postulantes almacen]', e.message); }
    }
  }
  // Funcionalidades + cards (regla anti-hardcode: el menú sale de BD)
  try {
    const [[mod]] = await pool.query(`SELECT id_modulo FROM modulos WHERE ruta='/recursos-humanos/' OR nombre LIKE '%Recursos Humanos%' LIMIT 1`);
    if (mod) {
      const sembrar = async (codigo, nombre, href, icono, perfiles) => {
        const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=?', [codigo]);
        if (ex) return;
        const [ins] = await pool.query(
          'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
          [mod.id_modulo, nombre, codigo, href, icono]);
        for (const p of perfiles) {
          await pool.query(
            `INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
             SELECT id_perfil, ?, 1 FROM perfiles WHERE nombre = ?`, [ins.insertId, p]);
        }
      };
      await sembrar('rh_postulaciones', 'Portal del Postulante', '/recursos-humanos/postulaciones/', 'bi-person-plus',
        ['Administrador', 'Consultora Recursos Humanos', 'Jefe Recursos Humanos', 'Gerente General']);
      await sembrar('rh_postulaciones_jefe', 'Revisión de Postulantes (Jefatura)', '/recursos-humanos/postulantes-jefe/', 'bi-person-check',
        ['Administrador', 'Gerente General']);
    }
  } catch (e) { console.error('[postulaciones seed]', e.message); }
  try {
    await require('../../../../shared/ia').registrarFuncionalidad({
      codigo: 'cv_postulante',
      nombre: 'Lectura de CV de postulantes',
      descripcion: 'Extrae del currículum los datos personales, estudios, trabajos, idiomas y habilidades para pre-llenar la postulación',
      modelo: 'claude-haiku-4-5',
    });
    await require('../../../../shared/ia').registrarFuncionalidad({
      codigo: 'analisis_postulante',
      nombre: 'Análisis de perfil del postulante',
      descripcion: 'Analiza el CV y la ficha del candidato: perfil, fortalezas, riesgos, ajuste al cargo, POSIBLES INCONSISTENCIAS (fechas, traslapes, títulos, CV vs lo declarado) y preguntas sugeridas para la entrevista',
      modelo: 'claude-sonnet-5',
    });
  } catch (e) { console.error('[postulaciones ia]', e.message); }
});

/* ═══════════════ LADO PÚBLICO (sin token — lo usa el candidato) ═══════════════ */

/* GET /api/postulaciones/aviso/:slug — el aviso publicado, sin datos internos.
   ?maqueta=1: la vista previa de RRHH (también sirve para avisos aún cerrados). */
const avisoPublico = async (req, res) => {
  try {
    const [[a]] = await pool.query(
      'SELECT id, slug, titulo, descripcion, ubicacion, jornada, preguntas, requisitos, activo FROM rh_avisos WHERE slug=?',
      [String(req.params.slug || '').slice(0, 24)]);
    if (!a) return fail(res, 'Aviso no encontrado', 404);
    const maqueta = String(req.query.maqueta || '') === '1';
    if (!a.activo && !maqueta) return fail(res, 'Esta búsqueda ya está cerrada. ¡Gracias por tu interés!', 410);
    ok(res, { titulo: a.titulo, descripcion: a.descripcion, ubicacion: a.ubicacion, jornada: a.jornada,
      preguntas: vistaPublica(preguntasDe(a)) });
  } catch (e) { console.error('[aviso publico]', e.message); fail(res, 'Error interno del servidor'); }
};

/* POST /api/postulaciones/aviso/:slug/extraer-cv — la IA lee el CV y devuelve la ficha.
   Acepta PDF, imágenes (JPG/PNG) y Word .docx (texto vía mammoth). Nunca falla la
   postulación: si la IA no está disponible devuelve campos vacíos y el candidato llena a mano. */
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
    const esDocx = /wordprocessingml/i.test(mime || '');   // .docx moderno (.doc legado sigue a mano)
    if (!esPdf && !esImg && !esDocx) return ok(res, { campos: null, motivo: 'formato' });

    // La API solo acepta PDF/imagen como adjunto: el .docx se convierte a texto plano
    let textoDocx = null;
    if (esDocx) {
      try {
        textoDocx = (await require('mammoth').extractRawText({ buffer: buf })).value.trim().slice(0, 40000);
      } catch (_) {}
      if (!textoDocx) return ok(res, { campos: null, motivo: 'formato' });
    }

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
}` + (textoDocx ? `\n\nCurrículum (texto extraído del Word):\n${textoDocx}` : ''),
      documentos: textoDocx ? [] : [{ tipo: esPdf ? 'pdf' : 'imagen', data: buf.toString('base64'), media_type: esPdf ? undefined : mime }],
      json: true, max_tokens: 8000,   // CVs largos: con 3000 la ficha JSON salía truncada y se perdía todo
    });
    ok(res, { campos: datos || null, motivo: datos ? undefined : 'error' });
  } catch (e) {
    console.error('[extraer cv]', e.message);
    ok(res, { campos: null, motivo: 'error' });   // la IA nunca bloquea la postulación
  }
};

/* POST /api/postulaciones/aviso/:slug/postular — recibe la postulación completa
   y la TABULA al tiro (estrellas + aptitud, motor tabular()). */
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

    // Respuestas contra las preguntas REALES del aviso (nunca contra lo que mande el cliente)
    const pregs = preguntasDe(a);
    const rin = Array.isArray(b.respuestas) ? b.respuestas : [];
    let respuestas, tab = { pct: null, estrellas: null, apto: 1, excluyentes: [], detalle: [] };
    if (pregs.length) {
      respuestas = pregs.map(pg => {
        const r = rin.find(x => String(x.id) === pg.id);
        let valor = r == null ? null : r.valor;
        if (pg.tipo === 'texto') valor = String(valor || '').slice(0, pg.max_chars);
        else if (valor != null) valor = String(valor).slice(0, 200);
        return { id: pg.id, pregunta: pg.texto, tipo: pg.tipo, valor };
      });
      tab = tabular(pregs, respuestas);
    } else {
      // Aviso sin preguntas: van las 2 "de la casa" que arma el frontend
      respuestas = rin.slice(0, 6).map(r => ({ pregunta: String(r.pregunta || '').slice(0, 300),
        tipo: 'texto', valor: String(r.respuesta ?? r.valor ?? '').slice(0, 3000) }));
    }
    // Compatibilidad: el "cumplimiento %" del listado sale de las preguntas de porcentaje
    const requisitos_eval = tab.detalle.filter(d => d.tipo === 'porcentaje')
      .map(d => ({ nombre: d.texto, pct: d.pct == null ? 0 : d.pct }));

    const j = v => JSON.stringify(Array.isArray(v) || (v && typeof v === 'object') ? v : []);
    const d = await almacen.colocar({ ambito: 'postulaciones', clave: a.id + '-' + email.replace(/[^a-z0-9]/gi, '_'),
      buffer: buf, mime: b.cv_mime || 'application/pdf', nombre: String(b.cv_nombre).slice(0, 200) });

    const campos = [nombre, b.rut ? String(b.rut).trim().toUpperCase().slice(0, 20) : null, email,
      String(b.telefono || '').slice(0, 40) || null,
      /^\d{4}-\d{2}-\d{2}$/.test(b.fecha_nacimiento || '') ? b.fecha_nacimiento : null,
      String(b.direccion || '').slice(0, 250) || null, String(b.comuna || '').slice(0, 120) || null,
      String(b.linkedin || '').slice(0, 250) || null, String(b.pretension_renta || '').slice(0, 60) || null,
      String(b.resumen_ia || '').slice(0, 2000) || null,
      j(b.estudios), j(b.trabajos), j(b.idiomas), j(b.habilidades), JSON.stringify(respuestas),
      JSON.stringify(requisitos_eval), j(b.campos_ia),
      tab.estrellas, tab.apto, JSON.stringify({ pct: tab.pct, excluyentes: tab.excluyentes, detalle: tab.detalle }),
      String(b.cv_nombre).slice(0, 250), String(b.cv_mime || 'application/pdf').slice(0, 120),
      d.blob, d.storage, d.ruta, d.bytes];

    // Repostular al mismo aviso con el mismo correo ACTUALIZA (no duplica).
    await pool.query(`
      INSERT INTO rh_postulantes (id_aviso, nombre, rut, email, telefono, fecha_nacimiento, direccion, comuna,
        linkedin, pretension_renta, resumen_ia, estudios, trabajos, idiomas, habilidades, respuestas,
        requisitos_eval, campos_ia, estrellas, apto, puntaje, cv_nombre, cv_mime, cv_data, doc_storage, doc_ruta, doc_bytes)
      VALUES (?, ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE nombre=VALUES(nombre), rut=VALUES(rut), telefono=VALUES(telefono),
        fecha_nacimiento=VALUES(fecha_nacimiento), direccion=VALUES(direccion), comuna=VALUES(comuna),
        linkedin=VALUES(linkedin), pretension_renta=VALUES(pretension_renta), resumen_ia=VALUES(resumen_ia),
        estudios=VALUES(estudios), trabajos=VALUES(trabajos), idiomas=VALUES(idiomas), habilidades=VALUES(habilidades),
        respuestas=VALUES(respuestas), requisitos_eval=VALUES(requisitos_eval), campos_ia=VALUES(campos_ia),
        estrellas=VALUES(estrellas), apto=VALUES(apto), puntaje=VALUES(puntaje),
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
      SELECT a.*, TRIM(CONCAT(IFNULL(u.nombre,''),' ',IFNULL(u.apellido,''))) AS jefe,
             (SELECT COUNT(*) FROM rh_postulantes p WHERE p.id_aviso=a.id) AS postulantes,
             (SELECT COUNT(*) FROM rh_postulantes p WHERE p.id_aviso=a.id AND p.estado='NUEVA') AS nuevas
      FROM rh_avisos a LEFT JOIN usuarios u ON u.id_usuario = a.id_jefe
      ORDER BY a.activo DESC, a.id DESC`);
    ok(res, rows.map(r => ({ ...r, preguntas: preguntasDe(r), requisitos: [] })));
  } catch (e) { console.error('[avisos]', e.message); fail(res, 'Error interno'); }
};

/* Usuarios activos para elegir al jefe directo del aviso */
const jefesLista = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT id_usuario, TRIM(CONCAT(IFNULL(nombre,''),' ',IFNULL(apellido,''))) AS nombre
      FROM usuarios WHERE estado='activo' ORDER BY nombre`);
    ok(res, rows);
  } catch (e) { console.error('[jefes lista]', e.message); fail(res, 'Error interno'); }
};

const avisoGuardar = async (req, res) => {
  try {
    const b = req.body || {};
    const titulo = String(b.titulo || '').trim().slice(0, 200);
    if (!titulo) return fail(res, 'El título del cargo es obligatorio', 400);
    const preguntas = limpiarPreguntas(b.preguntas);
    // El modelo v2 absorbe los requisitos dentro de preguntas: al guardar quedan en un solo lugar
    const vals = [titulo, String(b.descripcion || '').slice(0, 8000) || null, String(b.ubicacion || '').slice(0, 120) || null,
      String(b.jornada || '').slice(0, 120) || null, JSON.stringify(preguntas), '[]',
      parseInt(b.id_jefe) || null, b.activo === 0 || b.activo === false ? 0 : 1];
    let id = parseInt(req.params.id) || null, slug;
    if (id) {
      await pool.query('UPDATE rh_avisos SET titulo=?, descripcion=?, ubicacion=?, jornada=?, preguntas=?, requisitos=?, id_jefe=?, activo=? WHERE id=?', [...vals, id]);
      const [[r]] = await pool.query('SELECT slug FROM rh_avisos WHERE id=?', [id]); slug = r && r.slug;
    } else {
      slug = nuevoSlug();
      const [ins] = await pool.query(
        'INSERT INTO rh_avisos (slug, titulo, descripcion, ubicacion, jornada, preguntas, requisitos, id_jefe, activo, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [slug, ...vals, nombreDe(req)]);
      id = ins.insertId;
    }
    auditar({ req, accion: id ? 'GUARDAR' : 'CREAR', modulo: 'postulaciones', entidad: 'aviso', entidad_id: id, detalle: `Aviso "${titulo}"` });
    ok(res, { id, slug, link: '/postula/?a=' + slug });
  } catch (e) { console.error('[aviso guardar]', e.message); fail(res, 'Error interno'); }
};

/* Resumen liviano del informe DealerNet para listados */
function resumenDN(raw) {
  const d = parseJ(raw, null);
  if (!d) return null;
  const items = d.items || [];
  return { grave: items.some(i => i.grave), negativo: items.some(i => i.severidad === 'negativo' || i.severidad === 'grave'),
    disponibles: items.filter(i => i.disponible).length, total: items.length, error: d.error || null };
}

const postulantesListar = async (req, res) => {
  try {
    const idAviso = parseInt(req.query.aviso) || null;
    const [rows] = await pool.query(`
      SELECT p.id, p.id_aviso, a.titulo AS aviso, p.nombre, p.rut, p.email, p.telefono, p.comuna,
             p.fecha_nacimiento, p.pretension_renta, p.resumen_ia, p.estado, p.estudios, p.trabajos,
             p.idiomas, p.habilidades, p.requisitos_eval, p.estrellas, p.apto, p.jefe_marca, p.jefe_marca_por,
             p.dealernet, p.entrevistas, p.informe_rrhh IS NOT NULL AND p.informe_rrhh <> '' AS con_informe,
             p.jefatura_at, p.created_at, p.acuse_at, p.descarte_at, p.cv_nombre
      FROM rh_postulantes p JOIN rh_avisos a ON a.id = p.id_aviso
      ${idAviso ? 'WHERE p.id_aviso = ?' : ''} ORDER BY p.created_at DESC LIMIT 1000`,
      idAviso ? [idAviso] : []);
    ok(res, rows.map(r => {
      const ev = parseJ(r.requisitos_eval, []);
      const prom = ev.length ? Math.round(ev.reduce((s, x) => s + (Number(x.pct) || 0), 0) / ev.length) : null;
      return { ...r, estudios: parseJ(r.estudios, []), trabajos: parseJ(r.trabajos, []), idiomas: parseJ(r.idiomas, []),
        habilidades: parseJ(r.habilidades, []), requisitos_eval: ev, cumplimiento: prom,
        estrellas: r.estrellas == null ? null : Number(r.estrellas),
        dealernet: resumenDN(r.dealernet), entrevistas: parseJ(r.entrevistas, []).length };
    }));
  } catch (e) { console.error('[postulantes]', e.message); fail(res, 'Error interno'); }
};

const postulanteFicha = async (req, res) => {
  try {
    const [[p]] = await pool.query(`
      SELECT p.*, a.titulo AS aviso, a.id_jefe, a.preguntas AS aviso_preguntas,
             TRIM(CONCAT(IFNULL(u.nombre,''),' ',IFNULL(u.apellido,''))) AS jefe
      FROM rh_postulantes p
      JOIN rh_avisos a ON a.id = p.id_aviso
      LEFT JOIN usuarios u ON u.id_usuario = a.id_jefe
      WHERE p.id=?`, [parseInt(req.params.id)]);
    if (!p) return fail(res, 'Postulante no encontrado', 404);
    delete p.cv_data;
    for (const k of ['estudios', 'trabajos', 'idiomas', 'habilidades', 'respuestas', 'requisitos_eval', 'campos_ia', 'aviso_preguntas', 'entrevistas'])
      p[k] = parseJ(p[k], []);
    p.puntaje = parseJ(p.puntaje, null);
    p.dealernet = parseJ(p.dealernet, null);
    p.analisis_ia = parseJ(p.analisis_ia, null);
    p.estrellas = p.estrellas == null ? null : Number(p.estrellas);
    const [docs] = await pool.query(
      'SELECT id, tipo, nombre, mime, subido_por, created_at FROM rh_postulante_docs WHERE id_postulante=? ORDER BY id', [p.id]);
    p.docs = docs;
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

const ESTADOS = ['NUEVA', 'EN REVISION', 'PRESELECCIONADA', 'ENTREVISTA', 'INFORME ENVIADO', 'DESCARTADA', 'CONTRATADA'];
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

/* POST /postulantes/:id/analisis-ia — la IA analiza el CV + la ficha completa:
   perfil, fortalezas, riesgos, ajuste al cargo, INCONSISTENCIAS (fechas que no
   cuadran, traslapes, títulos sin respaldo, CV vs lo que digitó) y preguntas
   sugeridas para la entrevista. El resultado queda guardado en la ficha. */
const analisisIA = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [[p]] = await pool.query(`
      SELECT p.*, a.titulo AS aviso, a.descripcion AS aviso_desc
      FROM rh_postulantes p JOIN rh_avisos a ON a.id=p.id_aviso WHERE p.id=?`, [id]);
    if (!p) return fail(res, 'Postulante no encontrado', 404);
    const { analizar, disponible } = require('../../../../shared/anthropic');
    if (!disponible()) return fail(res, 'La IA no está disponible — actívala en Mantenedores › IA', 503);

    // El CV original va adjunto si es PDF o imagen; si no (docx), se analiza solo la ficha
    let documentos;
    try {
      const buf = await almacen.obtener({ ruta: p.doc_ruta, blob: p.cv_data });
      const esPdf = /pdf/i.test(p.cv_mime || '');
      const esImg = /image\/(jpe?g|png)/i.test(p.cv_mime || '');
      if (buf && (esPdf || esImg))
        documentos = [{ tipo: esPdf ? 'pdf' : 'imagen', data: buf.toString('base64'), media_type: esPdf ? undefined : p.cv_mime }];
    } catch (e) { console.error('[analisis cv]', e.message); }

    const ficha = {
      cargo: p.aviso, descripcion_cargo: String(p.aviso_desc || '').slice(0, 2000),
      nombre: p.nombre, rut: p.rut, fecha_nacimiento: p.fecha_nacimiento,
      comuna: p.comuna, pretension_renta: p.pretension_renta,
      estudios: parseJ(p.estudios, []), trabajos: parseJ(p.trabajos, []),
      idiomas: parseJ(p.idiomas, []), habilidades: parseJ(p.habilidades, []),
      respuestas: parseJ(p.respuestas, []).map(r => ({ pregunta: r.pregunta, respuesta: r.valor ?? r.respuesta })),
    };
    const { datos } = await analizar({
      codigo: 'analisis_postulante',
      system: 'Eres un analista de reclutamiento chileno riguroso y justo. Analizas al candidato SOLO con la evidencia entregada (CV adjunto si viene, y la ficha que él mismo digitó). Jamás inventas datos ni supones mala fe: una inconsistencia es una DIFERENCIA VERIFICABLE entre fuentes o dentro del CV (fechas que no cuadran o se traslapan de forma imposible, lagunas laborales largas sin explicar, títulos o instituciones sin respaldo, cargos que no calzan con la experiencia, diferencias entre el CV y lo que digitó en la ficha o respondió en las preguntas). Si no hay inconsistencias, dilo explícitamente con la lista vacía. Español chileno, tuteo, tono profesional.',
      prompt: `Cargo al que postula y ficha digitada por el candidato (contrástala con el CV adjunto${documentos ? '' : ' — OJO: no hay CV legible, analiza solo la ficha'}):
${JSON.stringify(ficha)}

Devuelve SOLO este JSON exacto:
{
 "perfil": string (análisis del perfil en 4-7 líneas: trayectoria, seniority, foco, estabilidad laboral),
 "fortalezas": [string] (3-6, concretas y citando la evidencia),
 "riesgos": [string] (0-5, riesgos u observaciones para el cargo — no inconsistencias, sino debilidades del perfil),
 "ajuste_cargo": { "nota": number (1 a 10), "comentario": string (por qué esa nota, contra la descripción del cargo) },
 "inconsistencias": [ { "tema": string (corto), "detalle": string (qué no cuadra y entre qué fuentes), "gravedad": "alta"|"media"|"baja" } ],
 "preguntas_entrevista": [string] (4-6 preguntas específicas para este candidato: profundizar fortalezas, aclarar riesgos y RESOLVER cada inconsistencia detectada)
}`,
      documentos, json: true, max_tokens: 2500,
    });
    if (!datos) return fail(res, 'La IA no devolvió un análisis válido — inténtalo de nuevo', 502);
    await pool.query('UPDATE rh_postulantes SET analisis_ia=?, analisis_ia_at=NOW() WHERE id=?', [JSON.stringify(datos), id]);
    auditar({ req, accion: 'ANALISIS_IA', modulo: 'postulaciones', entidad: 'postulante', entidad_id: id,
      detalle: `${p.nombre}: análisis IA (${(datos.inconsistencias || []).length} inconsistencias)` });
    ok(res, datos);
  } catch (e) {
    console.error('[analisis ia]', e.message);
    fail(res, e.code === 'IA_OFF' ? 'La funcionalidad "Análisis de perfil del postulante" está desactivada en Mantenedores › IA' : 'No se pudo generar el análisis');
  }
};

/* ═══════════════ WORKFLOW: DealerNet · entrevistas · informe · jefatura ═══════════════ */

/* Pide (o refresca) los informes DealerNet del RUT del postulante — MOTOR ÚNICO
   asegurarInformes de services/clientes (repositorio compartido + vigencia). */
async function pedirDealernet(idPostulante, usuario) {
  const [[p]] = await pool.query('SELECT id, rut FROM rh_postulantes WHERE id=?', [idPostulante]);
  if (!p) return { error: 'Postulante no encontrado' };
  if (!p.rut) return { error: 'El postulante no registró RUT — pídeselo antes de consultar' };
  const [prods] = await pool.query('SELECT codigo FROM dealernet_productos WHERE activo=1 ORDER BY orden');
  if (!prods.length) return { error: 'No hay productos DealerNet activos (mantenedor DealerNet)' };
  const dw = require('../../../clientes/src/controllers/dealernet-ws.controller');
  const out = await dw.asegurarInformes({ rut: p.rut, productos: prods.map(x => String(x.codigo)), usuario });
  const resumen = { items: (out.items || []).map(i => ({ codigo: i.codigo, nombre: i.nombre, disponible: i.disponible,
    severidad: i.severidad, grave: i.grave, nota: i.nota, fecha: i.fecha })), error: out.error || null };
  await pool.query('UPDATE rh_postulantes SET dealernet=?, dealernet_at=NOW() WHERE id=?', [JSON.stringify(resumen), idPostulante]);
  return resumen;
}

/* POST /postulantes/:id/dealernet — RRHH pide/actualiza los informes a demanda */
const dealernetPedir = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const r = await pedirDealernet(id, req.usuario);
    auditar({ req, accion: 'DEALERNET', modulo: 'postulaciones', entidad: 'postulante', entidad_id: id,
      detalle: r.error ? 'Consulta DealerNet: ' + r.error : `Consulta DealerNet: ${(r.items || []).length} informes` });
    r.error && !(r.items || []).length ? fail(res, r.error, 400) : ok(res, r);
  } catch (e) { console.error('[dealernet postulante]', e.message); fail(res, 'Error interno'); }
};

/* POST /postulantes/:id/entrevistas — agenda una entrevista y avisa por correo */
const entrevistaCrear = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const b = req.body || {};
    const tipo = b.tipo === 'JEFE' ? 'JEFE' : 'RRHH';
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(b.fecha || '') ? b.fecha : null;
    const hora = /^\d{2}:\d{2}$/.test(b.hora || '') ? b.hora : null;
    if (!fecha || !hora) return fail(res, 'Fecha y hora son obligatorias', 400);
    const [[p]] = await pool.query(`
      SELECT p.*, a.titulo AS aviso, a.id_jefe, u.email AS jefe_email,
             TRIM(CONCAT(IFNULL(u.nombre,''),' ',IFNULL(u.apellido,''))) AS jefe
      FROM rh_postulantes p JOIN rh_avisos a ON a.id=p.id_aviso
      LEFT JOIN usuarios u ON u.id_usuario=a.id_jefe WHERE p.id=?`, [id]);
    if (!p) return fail(res, 'No encontrado', 404);
    const ev = { tipo, fecha, hora, lugar: String(b.lugar || '').slice(0, 250),
      notas: String(b.notas || '').slice(0, 500), creada_por: nombreDe(req),
      creada_at: new Date().toISOString().slice(0, 16).replace('T', ' '), realizada: 0, resultado: null };
    const evs = parseJ(p.entrevistas, []); evs.push(ev);
    await pool.query(`UPDATE rh_postulantes SET entrevistas=?,
      estado=IF(estado IN ('NUEVA','EN REVISION','PRESELECCIONADA'),'ENTREVISTA',estado) WHERE id=?`,
      [JSON.stringify(evs), id]);
    auditar({ req, accion: 'ENTREVISTA', modulo: 'postulaciones', entidad: 'postulante', entidad_id: id,
      detalle: `${p.nombre}: entrevista ${tipo} ${fecha} ${hora}` });
    enviarInvitacion(p, ev).catch(e => console.error('[invitacion mail]', e.message));
    ok(res, { id, entrevistas: evs });
  } catch (e) { console.error('[entrevista crear]', e.message); fail(res, 'Error interno'); }
};

async function enviarInvitacion(p, ev) {
  const { enviarCorreo, mailConfigurado, envolverHTML } = require('../../../../shared/mailer');
  if (!mailConfigurado()) return;
  const primer = String(p.nombre || '').split(' ')[0];
  const con = ev.tipo === 'JEFE' ? 'la jefatura del área' : 'nuestro equipo de Recursos Humanos';
  const fdh = ev.fecha.split('-').reverse().join('-') + ' a las ' + ev.hora + ' hrs';
  const html = envolverHTML(`
    <p>Hola ${primer}:</p>
    <p>¡Buenas noticias! Tu postulación al cargo de <b>${p.aviso}</b> sigue avanzando y queremos conocerte en persona.</p>
    <p>Te invitamos a una <b>entrevista con ${con}</b>:</p>
    <p style="background:#f0f6ff;border-left:4px solid #0141A2;padding:10px 14px;border-radius:6px">
      📅 <b>${fdh}</b>${ev.lugar ? `<br>📍 ${ev.lugar}` : ''}${ev.notas ? `<br>📝 ${ev.notas}` : ''}</p>
    <p>Si el horario no te acomoda, responde este correo y buscamos otro juntos.</p>
    <p>¡Nos vemos!<br><b>Equipo de Recursos Humanos · AutoFácil</b></p>`);
  const cc = ev.tipo === 'JEFE' && p.jefe_email ? p.jefe_email : undefined;
  await enviarCorreo({ to: p.email, cc, subject: `Entrevista ${p.aviso} — ${fdh} · AutoFácil`, html });
}

/* PUT /postulantes/:id/entrevistas/:ix — marcar realizada / registrar resultado */
const entrevistaActualizar = async (req, res) => {
  try {
    const id = parseInt(req.params.id), ix = parseInt(req.params.ix);
    const [[p]] = await pool.query('SELECT entrevistas FROM rh_postulantes WHERE id=?', [id]);
    if (!p) return fail(res, 'No encontrado', 404);
    const evs = parseJ(p.entrevistas, []);
    if (!evs[ix]) return fail(res, 'Entrevista no encontrada', 404);
    const b = req.body || {};
    if (b.realizada != null) evs[ix].realizada = b.realizada ? 1 : 0;
    if (b.resultado != null) evs[ix].resultado = String(b.resultado).slice(0, 2000);
    await pool.query('UPDATE rh_postulantes SET entrevistas=? WHERE id=?', [JSON.stringify(evs), id]);
    ok(res, { id, entrevistas: evs });
  } catch (e) { console.error('[entrevista upd]', e.message); fail(res, 'Error interno'); }
};

/* POST /postulantes/:id/informe — el informe de entrevista de RRHH */
const informeGuardar = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const texto = String((req.body || {}).informe_rrhh || '').slice(0, 8000);
    await pool.query('UPDATE rh_postulantes SET informe_rrhh=? WHERE id=?', [texto, id]);
    auditar({ req, accion: 'INFORME', modulo: 'postulaciones', entidad: 'postulante', entidad_id: id, detalle: 'Informe de entrevista RRHH guardado' });
    ok(res, { id });
  } catch (e) { console.error('[informe]', e.message); fail(res, 'Error interno'); }
};

/* POST /postulantes/:id/docs — anexos (tests Ecuador, certificados). Al bucket. */
const docSubir = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const b = req.body || {};
    if (!b.data || !b.nombre) return fail(res, 'Falta el archivo', 400);
    const buf = Buffer.from(String(b.data), 'base64');
    if (buf.length > CV_MAX) return fail(res, 'El archivo supera 8 MB', 400);
    const [[p]] = await pool.query('SELECT id FROM rh_postulantes WHERE id=?', [id]);
    if (!p) return fail(res, 'Postulante no encontrado', 404);
    const tipo = String(b.tipo || 'TEST').toUpperCase().slice(0, 20);
    const d = await almacen.colocar({ ambito: 'postulaciones-docs', clave: id + '-' + crypto.randomBytes(3).toString('hex'),
      buffer: buf, mime: b.mime || 'application/pdf', nombre: String(b.nombre).slice(0, 200) });
    const [ins] = await pool.query(
      `INSERT INTO rh_postulante_docs (id_postulante, tipo, nombre, mime, data, doc_storage, doc_ruta, doc_bytes, subido_por)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, tipo, String(b.nombre).slice(0, 250), String(b.mime || 'application/pdf').slice(0, 120), d.blob, d.storage, d.ruta, d.bytes, nombreDe(req)]);
    auditar({ req, accion: 'DOC', modulo: 'postulaciones', entidad: 'postulante', entidad_id: id, detalle: `Anexo ${tipo}: ${b.nombre}` });
    ok(res, { id: ins.insertId });
  } catch (e) { console.error('[doc subir]', e.message); fail(res, 'Error interno'); }
};

const docVer = async (req, res) => {
  try {
    const [[d]] = await pool.query('SELECT nombre, mime, data, doc_ruta FROM rh_postulante_docs WHERE id=?', [parseInt(req.params.idDoc)]);
    if (!d) return fail(res, 'No encontrado', 404);
    await almacen.servir(res, { ruta: d.doc_ruta, blob: d.data, nombre: d.nombre, mime: d.mime, adjunto: false });
  } catch (e) { console.error('[doc ver]', e.message); fail(res, 'Error interno'); }
};

const estrellasTxt = e => e == null ? '—' : (String(e).replace('.', ',') + ' / 5 ★');

/* POST /jefatura — el paquete de candidatos preseleccionados al jefe directo:
   resumen comparado + informe de entrevista RRHH + nota DealerNet + tests adjuntos */
const enviarJefatura = async (req, res) => {
  try {
    const b = req.body || {};
    const idAviso = parseInt(b.id_aviso);
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Boolean).slice(0, 20);
    if (!idAviso || !ids.length) return fail(res, 'Elige el aviso y al menos un candidato', 400);
    const [[a]] = await pool.query(`
      SELECT a.*, u.email AS jefe_email, TRIM(CONCAT(IFNULL(u.nombre,''),' ',IFNULL(u.apellido,''))) AS jefe
      FROM rh_avisos a LEFT JOIN usuarios u ON u.id_usuario=a.id_jefe WHERE a.id=?`, [idAviso]);
    if (!a) return fail(res, 'Aviso no encontrado', 404);
    if (!a.jefe_email) return fail(res, 'El aviso no tiene jefe directo asignado — edítalo y elige al solicitante', 400);
    const [cands] = await pool.query(
      `SELECT * FROM rh_postulantes WHERE id_aviso=? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY estrellas DESC, nombre`,
      [idAviso, ...ids]);
    if (!cands.length) return fail(res, 'Los candidatos no corresponden al aviso', 400);

    const { enviarCorreo, mailConfigurado, envolverHTML } = require('../../../../shared/mailer');
    if (!mailConfigurado()) return fail(res, 'El correo del sistema no está configurado', 500);

    const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const filas = cands.map(p => {
      const dn = resumenDN(p.dealernet);
      const edad = p.fecha_nacimiento ? Math.floor((Date.now() - new Date(p.fecha_nacimiento)) / 3.15576e10) + ' años' : '—';
      return `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb"><b>${esc(p.nombre)}</b><br><span style="color:#64748b;font-size:.85em">${esc(p.comuna || '')} · ${edad}</span></td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;white-space:nowrap"><b>${estrellasTxt(p.estrellas == null ? null : Number(p.estrellas))}</b>${Number(p.apto) === 0 ? '<br><span style="color:#b91c1c;font-weight:700;font-size:.8em">NO APTO (excluyente)</span>' : ''}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${esc(p.pretension_renta || '—')}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:.85em">${dn ? (dn.grave ? '<span style="color:#b91c1c;font-weight:700">⚠ con registros graves</span>' : dn.negativo ? '<span style="color:#b45309;font-weight:700">con observaciones</span>' : '<span style="color:#15803d">sin observaciones</span>') : '<span style="color:#94a3b8">sin consultar</span>'}</td>
      </tr>`;
    }).join('');
    const bloques = cands.map(p => `
      <div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;margin:10px 0">
        <p style="margin:0 0 6px"><b style="color:#012d70">${esc(p.nombre)}</b> — ${estrellasTxt(p.estrellas == null ? null : Number(p.estrellas))}</p>
        ${p.resumen_ia ? `<p style="margin:4px 0;font-size:.9em"><b>Perfil:</b> ${esc(p.resumen_ia)}</p>` : ''}
        ${(() => { const ai = parseJ(p.analisis_ia, null); if (!ai) return '';
          return `${ai.ajuste_cargo ? `<p style="margin:4px 0;font-size:.9em"><b>Análisis IA — ajuste al cargo:</b> ${esc(ai.ajuste_cargo.nota)}/10. ${esc(ai.ajuste_cargo.comentario || '')}</p>` : ''}
          ${(ai.inconsistencias || []).length ? `<p style="margin:4px 0;font-size:.9em;color:#b45309"><b>⚠ Inconsistencias detectadas por la IA:</b> ${ai.inconsistencias.map(x => esc(x.tema + ' (' + x.gravedad + ')')).join(' · ')}</p>` : ''}`; })()}
        ${p.informe_rrhh ? `<p style="margin:4px 0;font-size:.9em"><b>Informe entrevista RRHH:</b> ${esc(p.informe_rrhh)}</p>` : ''}
        ${parseJ(p.entrevistas, []).filter(e => e.realizada && e.resultado).map(e =>
          `<p style="margin:4px 0;font-size:.9em"><b>Entrevista ${esc(e.tipo)} (${esc(e.fecha)}):</b> ${esc(e.resultado)}</p>`).join('')}
      </div>`).join('');

    // Tests (Ecuador) y anexos de los candidatos van adjuntos
    const [docs] = await pool.query(
      `SELECT d.id_postulante, d.nombre, d.mime, d.data, d.doc_ruta FROM rh_postulante_docs d
       WHERE d.id_postulante IN (${cands.map(() => '?').join(',')})`, cands.map(c => c.id));
    const attachments = [];
    for (const d of docs.slice(0, 10)) {
      try {
        const buf = await almacen.obtener({ ruta: d.doc_ruta, blob: d.data });
        if (buf) attachments.push({ filename: d.nombre, content: buf, contentType: d.mime || undefined });
      } catch (e) { console.error('[jefatura adjunto]', e.message); }
    }

    const html = envolverHTML(`
      <p>Hola ${esc((a.jefe || '').split(' ')[0] || '')}:</p>
      <p>Te enviamos los <b>${cands.length} candidato${cands.length > 1 ? 's' : ''} preseleccionado${cands.length > 1 ? 's' : ''}</b> para el cargo de <b>${esc(a.titulo)}</b>.</p>
      ${b.mensaje ? `<p style="background:#fffbeb;border-left:4px solid #f59e0b;padding:8px 12px;border-radius:6px">${esc(String(b.mensaje).slice(0, 2000))}</p>` : ''}
      <table style="border-collapse:collapse;width:100%;font-size:.92em">
        <tr style="background:#f1f5f9"><th style="padding:6px 10px;text-align:left">Candidato</th><th style="padding:6px 10px;text-align:left">Evaluación</th><th style="padding:6px 10px;text-align:left">Pretensión</th><th style="padding:6px 10px;text-align:left">DealerNet</th></tr>
        ${filas}
      </table>
      ${bloques}
      ${attachments.length ? `<p style="font-size:.9em;color:#475569">📎 Van adjuntos ${attachments.length} informe${attachments.length > 1 ? 's' : ''} (tests y anexos).</p>` : ''}
      <p>Puedes revisar cada ficha completa en <a href="${process.env.APP_URL || 'https://www.autofacilchile.cl'}/recursos-humanos/postulantes-jefe/">Revisión de Postulantes</a>.</p>
      <p>Saludos,<br><b>Equipo de Recursos Humanos · AutoFácil</b></p>`);
    await enviarCorreo({ to: a.jefe_email, subject: `Candidatos preseleccionados — ${a.titulo} (${cands.length})`, html, attachments });

    await pool.query(
      `UPDATE rh_postulantes SET jefatura_at=NOW(), estado=IF(estado IN ('PRESELECCIONADA','ENTREVISTA'),'INFORME ENVIADO',estado)
       WHERE id IN (${cands.map(() => '?').join(',')})`, cands.map(c => c.id));
    auditar({ req, accion: 'JEFATURA', modulo: 'postulaciones', entidad: 'aviso', entidad_id: idAviso,
      detalle: `Informe a jefatura (${a.jefe}): ${cands.map(c => c.nombre).join(', ')}` });
    ok(res, { enviados: cands.length, adjuntos: attachments.length, jefe: a.jefe });
  } catch (e) { console.error('[jefatura]', e.message); fail(res, 'Error interno'); }
};

/* ═══════════════ LADO JEFE DIRECTO (permiso rh_postulaciones_jefe) ═══════════════ */

/* null = ve todo (Admin o RRHH completo); [] o [ids] = solo sus avisos */
async function avisosDelJefe(req) {
  if (req.usuario?.perfil_nombre === 'Administrador') return null;
  const { tieneFunc } = require('../../../../shared/middleware/permisos');
  if (await tieneFunc(req.usuario?.id_usuario, 'rh_postulaciones')) return null;
  const [rows] = await pool.query('SELECT id FROM rh_avisos WHERE id_jefe=?', [req.usuario?.id_usuario || 0]);
  return rows.map(r => r.id);
}

/* GET /jefe/postulantes — los candidatos de los avisos a cargo del jefe */
const jefePostulantes = async (req, res) => {
  try {
    const ids = await avisosDelJefe(req);
    if (ids && !ids.length) return ok(res, { avisos: [], postulantes: [] });
    const filtro = ids ? `WHERE a.id IN (${ids.map(() => '?').join(',')})` : '';
    const [avisos] = await pool.query(
      `SELECT a.id, a.titulo, a.activo, (SELECT COUNT(*) FROM rh_postulantes p WHERE p.id_aviso=a.id) AS postulantes
       FROM rh_avisos a ${filtro} ORDER BY a.activo DESC, a.id DESC`, ids || []);
    const [rows] = await pool.query(`
      SELECT p.id, p.id_aviso, a.titulo AS aviso, p.nombre, p.comuna, p.fecha_nacimiento, p.pretension_renta,
             p.resumen_ia, p.estado, p.estudios, p.trabajos, p.requisitos_eval, p.estrellas, p.apto,
             p.jefe_marca, p.jefe_nota, p.created_at
      FROM rh_postulantes p JOIN rh_avisos a ON a.id = p.id_aviso ${filtro}
      ORDER BY p.estrellas DESC, p.created_at DESC LIMIT 500`, ids || []);
    ok(res, { avisos, postulantes: rows.map(r => {
      const ev = parseJ(r.requisitos_eval, []);
      return { ...r, estudios: parseJ(r.estudios, []), trabajos: parseJ(r.trabajos, []),
        cumplimiento: ev.length ? Math.round(ev.reduce((s, x) => s + (Number(x.pct) || 0), 0) / ev.length) : null,
        estrellas: r.estrellas == null ? null : Number(r.estrellas) };
    }) });
  } catch (e) { console.error('[jefe postulantes]', e.message); fail(res, 'Error interno'); }
};

/* GET /jefe/postulantes/:id — ficha (validando que el aviso sea suyo) */
const jefeFicha = async (req, res) => {
  try {
    const ids = await avisosDelJefe(req);
    const [[p]] = await pool.query('SELECT id_aviso FROM rh_postulantes WHERE id=?', [parseInt(req.params.id)]);
    if (!p) return fail(res, 'No encontrado', 404);
    if (ids && !ids.includes(p.id_aviso)) return fail(res, 'Este aviso no está a tu cargo', 403);
    return postulanteFicha(req, res);
  } catch (e) { console.error('[jefe ficha]', e.message); fail(res, 'Error interno'); }
};

const jefeCV = async (req, res) => {
  try {
    const ids = await avisosDelJefe(req);
    const [[p]] = await pool.query('SELECT id_aviso FROM rh_postulantes WHERE id=?', [parseInt(req.params.id)]);
    if (!p) return fail(res, 'No encontrado', 404);
    if (ids && !ids.includes(p.id_aviso)) return fail(res, 'Este aviso no está a tu cargo', 403);
    return postulanteCV(req, res);
  } catch (e) { console.error('[jefe cv]', e.message); fail(res, 'Error interno'); }
};

/* POST /jefe/postulantes/:id/marcar — "me interesa: que RRHH avance".
   Marca al candidato y dispara los informes DealerNet (fire & forget). */
const jefeMarcar = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const marcar = (req.body || {}).marcar === 0 || (req.body || {}).marcar === false ? 0 : 1;
    const nota = String((req.body || {}).nota || '').slice(0, 1000);
    const ids = await avisosDelJefe(req);
    const [[p]] = await pool.query('SELECT p.*, a.titulo AS aviso FROM rh_postulantes p JOIN rh_avisos a ON a.id=p.id_aviso WHERE p.id=?', [id]);
    if (!p) return fail(res, 'No encontrado', 404);
    if (ids && !ids.includes(p.id_aviso)) return fail(res, 'Este aviso no está a tu cargo', 403);
    await pool.query(`UPDATE rh_postulantes SET jefe_marca=?, jefe_marca_por=?, jefe_marca_at=NOW(),
      jefe_nota=COALESCE(NULLIF(?,''), jefe_nota),
      estado=IF(? = 1 AND estado='NUEVA', 'EN REVISION', estado) WHERE id=?`,
      [marcar, nombreDe(req), nota, marcar, id]);
    auditar({ req, accion: marcar ? 'MARCAR_JEFE' : 'DESMARCAR_JEFE', modulo: 'postulaciones', entidad: 'postulante', entidad_id: id,
      detalle: `${p.nombre} (${p.aviso})${nota ? ' — ' + nota : ''}` });
    // Al enviarlo a RRHH se solicitan los informes DealerNet (una variable más del análisis)
    if (marcar && p.rut) pedirDealernet(id, req.usuario).catch(e => console.error('[dealernet marca]', e.message));
    ok(res, { id, jefe_marca: marcar, dealernet: marcar && p.rut ? 'solicitado' : (marcar ? 'sin_rut' : null) });
  } catch (e) { console.error('[jefe marcar]', e.message); fail(res, 'Error interno'); }
};

module.exports = { avisoPublico, extraerCV, postular, avisosListar, avisoGuardar, jefesLista,
  postulantesListar, postulanteFicha, postulanteCV, postulanteEstado, analisisIA,
  dealernetPedir, entrevistaCrear, entrevistaActualizar, informeGuardar, docSubir, docVer, enviarJefatura,
  jefePostulantes, jefeFicha, jefeCV, jefeMarcar };
