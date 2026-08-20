'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   VACACIONES PROGRESIVAS (art. 68 CT) — autoservicio con revisor IA.

   El colaborador sube su certificado de cotizaciones AFP; la IA EXTRAE los
   meses cotizados y el CÓDIGO decide (la regla nunca es probabilística):
   · No corresponde → se le informa desde qué fecha, y que cargue un
     certificado nuevo emitido después de esa fecha (el AFP vence a 30 días).
   · Corresponde → queda PENDIENTE de RRHH: campana + mail con el informe y
     el certificado adjuntos, plazo 48 horas hábiles, link a Por Aprobar.
   Al APROBAR: se escriben los años previos en la ficha (rh_fichas.
   anos_trabajados_previos — el MISMO campo que ya usa el motor de devengos),
   el certificado va a la carpeta digital (tipo CERTIFICADO AFP) y
   generarDevengos() deposita solo los días progresivos por período.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });
const nombreDe = u => [u?.nombre, u?.apellido].filter(Boolean).join(' ') || u?.usuario || 'Sistema';
const isoF = f => f == null ? null
  : (f instanceof Date ? new Date(f.getTime() - f.getTimezoneOffset() * 60000).toISOString() : String(f)).slice(0, 10);
const fLarga = v => v ? new Date(String(v).slice(0, 10) + 'T12:00:00').toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';

require('../../../../shared/migrate').enFila('rrhh-vac-progresivas', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_vac_prog_solicitudes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_usuario INT NOT NULL,
    nombre VARCHAR(200) NULL,
    meses_previos INT NULL,           -- meses cotizados ANTES del ingreso (según certificado)
    anos_previos TINYINT NULL,        -- años a escribir en la ficha (cap legal 10)
    dias_actuales TINYINT NULL,       -- días progresivos que le corresponden HOY
    resultado VARCHAR(16) NOT NULL,   -- CORRESPONDE | NO_CORRESPONDE
    fecha_desde DATE NULL,            -- si no corresponde: desde cuándo
    informe MEDIUMTEXT NULL,
    estado VARCHAR(12) NOT NULL DEFAULT 'PENDIENTE',  -- PENDIENTE | APROBADA | RECHAZADA | INFORMADA
    resuelto_por VARCHAR(160) NULL, resuelto_fecha DATETIME NULL, resuelto_motivo VARCHAR(400) NULL,
    cert_nombre VARCHAR(200) NULL, cert_mime VARCHAR(100) NULL,
    archivo LONGBLOB NULL, doc_storage VARCHAR(10) NULL, doc_ruta VARCHAR(500) NULL, doc_bytes BIGINT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_u (id_usuario), INDEX idx_estado (estado)
  )`);
  require('../../../../shared/ia').registrarFuncionalidad({
    codigo: 'rrhh_vac_progresivas', nombre: 'Vacaciones progresivas — lector de certificado AFP',
    descripcion: 'Extrae los meses cotizados del certificado de cotizaciones AFP que sube el colaborador para el feriado progresivo (art. 68). La IA solo EXTRAE; la regla la calcula el sistema.',
  });
});

async function esRRHH(idUsuario) {
  try { const { tieneFunc } = require('../../../../shared/middleware/permisos'); return await tieneFunc(idUsuario, 'rh_aprobar'); }
  catch { return false; }
}

/* La MISMA aritmética del motor de devengos (vac-cuenta.progresivoDelPeriodo,
   convención al CIERRE del período desde 20-08-2026):
   días del período N = floor((previos + N − 10) / 3). */
const progDelPeriodo = (previos, n) => Math.max(0, Math.floor(((previos || 0) + n - 10) / 3));

/* ── POST /analizar { nombre, mime, base64 } ── */
const analizar = async (req, res) => {
  try {
    const u = req.usuario || {}; const b = req.body || {};
    if (!b.base64) return fail(res, 'Sube tu certificado AFP en PDF', 400);
    const buffer = Buffer.from(b.base64, 'base64');
    if (!buffer.length || buffer.length > 7 * 1024 * 1024) return fail(res, 'El archivo debe pesar máximo 7 MB', 400);

    const [[yo]] = await pool.query(
      `SELECT u.id_usuario, TRIM(CONCAT_WS(' ', u.nombre, u.apellido, u.apellido_materno)) nombre, u.rut,
              DATE_FORMAT(u.fecha_ingreso,'%Y-%m-%d') fecha_ingreso, COALESCE(f.anos_trabajados_previos,0) previos_actuales
         FROM usuarios u LEFT JOIN rh_fichas f ON f.id_usuario=u.id_usuario WHERE u.id_usuario=?`, [u.id_usuario]);
    if (!yo?.fecha_ingreso) return fail(res, 'Tu ficha no tiene fecha de ingreso registrada — pídele a RRHH que la complete primero', 409);
    const [[dup]] = await pool.query("SELECT id FROM rh_vac_prog_solicitudes WHERE id_usuario=? AND estado='PENDIENTE' LIMIT 1", [u.id_usuario]);
    if (dup) return fail(res, 'Ya tienes una solicitud de vacaciones progresivas esperando a RRHH', 409);

    /* IA: solo EXTRACCIÓN de datos del certificado */
    const AI = require('../../../../shared/anthropic');
    if (!AI.disponible()) return fail(res, 'El lector IA no está disponible en este momento — intenta más tarde o entrega el certificado directamente a RRHH', 503);
    const { datos } = await AI.analizar({
      codigo: 'rrhh_vac_progresivas', id_usuario: u.id_usuario, json: true, max_tokens: 1500,
      system: 'Eres un lector de certificados de cotizaciones previsionales chilenos (AFP/IPS). Extraes datos EXACTOS del documento; no calculas beneficios ni interpretas leyes.',
      prompt: `Extrae del certificado adjunto y responde SOLO este JSON:
{"es_certificado_cotizaciones": true|false, "titular_nombre": "...", "titular_rut": "...", "afp": "...", "fecha_emision": "YYYY-MM-DD",
 "meses_total": <suma de TODOS los meses cotizados de la tabla año/meses>,
 "meses_antes_de": <suma de meses cotizados en años ANTERIORES a ${yo.fecha_ingreso.slice(0, 4)} (sin incluir ese año)>}
La tabla del certificado lista año y meses cotizados por año. Si el documento no es un certificado de cotizaciones, es_certificado_cotizaciones=false.`,
      documentos: [{ tipo: 'pdf', data: b.base64 }],
    });
    if (!datos || datos.es_certificado_cotizaciones === false)
      return fail(res, 'El documento no parece un certificado de cotizaciones AFP. Descárgalo desde el sitio de tu AFP (opción "certificado de cotizaciones" o "feriado progresivo") y súbelo de nuevo.', 400);

    /* La REGLA la calcula el sistema (no la IA) */
    const mesesPrevios = Math.max(0, parseInt(datos.meses_antes_de, 10) || 0);
    const anosPrevios = Math.min(10, Math.floor(mesesPrevios / 12));   // tope legal: 10 años con otros empleadores
    const fi = new Date(yo.fecha_ingreso + 'T12:00:00');
    const hoy = new Date();
    let aniosEmpresa = hoy.getFullYear() - fi.getFullYear();
    const aniv = new Date(fi); aniv.setFullYear(fi.getFullYear() + aniosEmpresa);
    if (aniv > hoy) aniosEmpresa--;
    const diasHoy = aniosEmpresa >= 1 ? progDelPeriodo(anosPrevios, aniosEmpresa) : 0;

    let fechaDesde = null;
    if (!diasHoy) {
      for (let n = Math.max(1, aniosEmpresa + 1); n <= 60; n++) {
        if (progDelPeriodo(anosPrevios, n) > 0) {
          const f = new Date(fi); f.setFullYear(fi.getFullYear() + n);
          fechaDesde = isoF(f); break;
        }
      }
    }
    const corresponde = diasHoy > 0;

    const informe = `
      <div style="font-family:Arial,sans-serif;font-size:13px;color:#1e293b;border:1.5px solid #cbd5e1;border-radius:10px;padding:16px 20px">
        <h3 style="color:#012d70;margin:0 0 10px">Informe — Vacaciones Progresivas (art. 68 CT)</h3>
        <p><b>Colaborador:</b> ${yo.nombre} · <b>Ingreso a AutoFácil:</b> ${fLarga(yo.fecha_ingreso)} (${aniosEmpresa} año(s) cumplidos)</p>
        <p><b>Certificado:</b> ${datos.afp || 'AFP'} · titular ${datos.titular_nombre || '—'} (${datos.titular_rut || '—'}) · emitido el ${fLarga(datos.fecha_emision)}</p>
        <table style="border-collapse:collapse;font-size:12.5px;margin:10px 0">
          <tr><td style="border:1px solid #cbd5e1;padding:4px 10px;background:#f8fafc"><b>Meses cotizados en total</b></td><td style="border:1px solid #cbd5e1;padding:4px 10px">${datos.meses_total ?? '—'} (${((datos.meses_total || 0) / 12).toFixed(1)} años)</td></tr>
          <tr><td style="border:1px solid #cbd5e1;padding:4px 10px;background:#f8fafc"><b>Meses cotizados ANTES del ingreso</b></td><td style="border:1px solid #cbd5e1;padding:4px 10px">${mesesPrevios} (${(mesesPrevios / 12).toFixed(1)} años)</td></tr>
          <tr><td style="border:1px solid #cbd5e1;padding:4px 10px;background:#f8fafc"><b>Años previos reconocibles (tope legal 10)</b></td><td style="border:1px solid #cbd5e1;padding:4px 10px">${anosPrevios}</td></tr>
          <tr><td style="border:1px solid #cbd5e1;padding:4px 10px;background:#f8fafc"><b>Días progresivos que corresponden HOY</b></td><td style="border:1px solid #cbd5e1;padding:4px 10px;font-weight:800;color:${corresponde ? '#15803d' : '#b91c1c'}">${diasHoy}</td></tr>
        </table>
        <p style="background:${corresponde ? '#f0fdf4' : '#fef2f2'};border-left:4px solid ${corresponde ? '#16a34a' : '#dc2626'};padding:8px 12px;border-radius:6px">
          ${corresponde
            ? `<b>CORRESPONDE.</b> Con ${anosPrevios} años previos acreditados más su antigüedad en la empresa, el colaborador tiene derecho a <b>${diasHoy} día(s) adicional(es)</b> de feriado. Derivado a Recursos Humanos para revisión y aprobación.`
            : `<b>AÚN NO CORRESPONDE.</b> El derecho nace a partir del <b>${fLarga(fechaDesde)}</b>. Debe volver a cargar un certificado AFP emitido después de esa fecha (los certificados vencen a los 30 días).`}
        </p>
        <p style="font-size:11px;color:#64748b">Regla aplicada por el sistema (art. 68 CT): con 10 años de trabajo acreditados (máx. 10 con otros empleadores), 1 día adicional por cada 3 nuevos años con el empleador actual. La IA solo extrajo los datos del certificado; el cálculo es del sistema. Los días se depositan por período junto al devengo anual.</p>
      </div>`;

    /* Guardar la solicitud (siempre queda traza) */
    const alm = require('../../../../shared/almacen-docs');
    const col = await alm.colocar({ ambito: 'rrhh-vac-prog', clave: u.id_usuario, buffer, mime: b.mime, nombre: b.nombre });
    const [r] = await pool.query(
      `INSERT INTO rh_vac_prog_solicitudes (id_usuario, nombre, meses_previos, anos_previos, dias_actuales, resultado, fecha_desde, informe, estado,
        cert_nombre, cert_mime, archivo, doc_storage, doc_ruta, doc_bytes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [u.id_usuario, yo.nombre, mesesPrevios, anosPrevios, diasHoy, corresponde ? 'CORRESPONDE' : 'NO_CORRESPONDE', fechaDesde, informe,
       corresponde ? 'PENDIENTE' : 'INFORMADA', String(b.nombre || 'certificado.pdf').slice(0, 200), b.mime || null,
       col.blob, col.storage, col.ruta, col.bytes]);
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'vac_progresivas', entidad_id: r.insertId,
      detalle: `Vacaciones progresivas: ${corresponde ? `CORRESPONDE (${diasHoy} día/s) — derivado a RRHH` : `aún no corresponde (desde ${fechaDesde})`}` });

    if (corresponde) {
      // Campana a RRHH
      const [rr] = await pool.query(
        `SELECT DISTINCT u.id_usuario FROM usuarios u
          JOIN permisos_perfil pp ON pp.id_perfil=u.id_perfil AND pp.habilitado=1
          JOIN funcionalidades f ON f.id_funcionalidad=pp.id_funcionalidad
         WHERE f.codigo='rh_aprobar' AND u.estado='activo'`);
      if (rr.length) notificar(rr.map(x => x.id_usuario), {
        tipo: 'RRHH', prioridad: 'alta', titulo: '🏖️ Vacaciones progresivas por aprobar',
        mensaje: `${yo.nombre} acredita ${anosPrevios} años previos (certificado AFP validado): ${diasHoy} día(s) progresivo(s). Plazo: 48 horas hábiles.`,
        href: '/recursos-humanos/solicitudes/',
      }).catch(() => {});
      // Mail a RRHH con informe + certificado adjuntos (paramétrico; nunca frena)
      (async () => {
        try {
          const env = await require('../../../../shared/plantillas-correo').enviar({
            codigo: 'vac_progresivas_rrhh',
            datos: { NOMBRE: yo.nombre, DIAS: String(diasHoy), ANOS_PREVIOS: String(anosPrevios),
                     LINK: 'https://afbs.autofacilchile.cl/recursos-humanos/solicitudes/' },
            adjuntos: [
              { filename: `Informe vacaciones progresivas ${yo.nombre}.html`, content: `<html><meta charset="utf-8"><body>${informe}</body></html>` },
              { filename: b.nombre || 'certificado-afp.pdf', content: buffer },
            ],
          });
          if (!env.enviado) console.warn('[vac-prog mail rrhh]', env.motivo);
        } catch (e) { console.error('[vac-prog mail rrhh]', e.message); }
      })();
    }
    ok(res, { id: r.insertId, corresponde, dias: diasHoy, fecha_desde: fechaDesde, informe });
  } catch (e) {
    console.error('[vac-prog analizar]', e.message);
    // 503 y no 500: el gateway reescribe los 500 a un texto genérico y el
    // usuario no vería el motivo real (IA desactivada, PDF ilegible, etc.)
    if (e.code === 'IA_OFF') return fail(res, 'El lector IA de este trámite está desactivado en el mantenedor de IA — actívalo o entrega el certificado directamente a RRHH', 503);
    fail(res, 'No se pudo analizar el certificado: ' + e.message, 503);
  }
};

/* ── GET /pendientes (RRHH) + mis solicitudes ── */
const listar = async (req, res) => {
  try {
    const u = req.usuario || {}; const rrhh = await esRRHH(u.id_usuario);
    const [mias] = await pool.query('SELECT id, resultado, dias_actuales, fecha_desde, estado, resuelto_por, resuelto_motivo, created_at FROM rh_vac_prog_solicitudes WHERE id_usuario=? ORDER BY id DESC LIMIT 20', [u.id_usuario]);
    let pendientes = [];
    if (rrhh) [pendientes] = await pool.query(
      `SELECT id, id_usuario, nombre, anos_previos, dias_actuales, informe, cert_nombre, created_at
         FROM rh_vac_prog_solicitudes WHERE estado='PENDIENTE' ORDER BY created_at`);
    ok(res, { mias, pendientes, es_rrhh: rrhh });
  } catch (e) { fail(res, 'Error interno del servidor'); }
};

/* ── POST /:id/resolver { decision, motivo } (RRHH) ── */
const resolver = async (req, res) => {
  try {
    const u = req.usuario || {}; const b = req.body || {};
    if (!(await esRRHH(u.id_usuario))) return fail(res, 'Solo RRHH resuelve', 403);
    const decision = String(b.decision || '').toUpperCase();
    if (!['APROBAR', 'RECHAZAR'].includes(decision)) return fail(res, 'Decisión inválida', 400);
    if (decision === 'RECHAZAR' && !String(b.motivo || '').trim()) return fail(res, 'El motivo del rechazo es obligatorio', 400);
    const [[s]] = await pool.query("SELECT * FROM rh_vac_prog_solicitudes WHERE id=? AND estado='PENDIENTE'", [req.params.id]);
    if (!s) return fail(res, 'Solicitud no encontrada o ya resuelta', 404);

    if (decision === 'APROBAR') {
      // 1) Años previos a la FICHA (el mismo campo que lee el motor de devengos)
      await pool.query('INSERT INTO rh_fichas (id_usuario, anos_trabajados_previos) VALUES (?,?) ON DUPLICATE KEY UPDATE anos_trabajados_previos=VALUES(anos_trabajados_previos)',
        [s.id_usuario, s.anos_previos]).catch(async () => {
          await pool.query('UPDATE rh_fichas SET anos_trabajados_previos=? WHERE id_usuario=?', [s.anos_previos, s.id_usuario]);
        });
      // 2) Certificado a la carpeta digital (calla el alegato semanal "sin certificado AFP")
      const alm = require('../../../../shared/almacen-docs');
      const buf = await alm.obtener({ ruta: s.doc_ruta, blob: s.archivo }).catch(() => null);
      if (buf) {
        const col = await alm.colocar({ ambito: 'rrhh-docs', clave: s.id_usuario, buffer: buf, mime: s.cert_mime, nombre: s.cert_nombre });
        await pool.query(
          `INSERT INTO rh_documentos (id_usuario, tipo, nombre_archivo, mime_type, archivo_data, subido_por, doc_storage, doc_ruta, doc_bytes)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [s.id_usuario, 'CERTIFICADO AFP (AÑOS COTIZADOS)', s.cert_nombre, s.cert_mime, col.blob, nombreDe(u), col.storage, col.ruta, col.bytes]);
      }
      // 3) El motor deposita los días progresivos por período
      await require('./vac-cuenta.controller').generarDevengos();
      await pool.query("UPDATE rh_vac_prog_solicitudes SET estado='APROBADA', resuelto_por=?, resuelto_fecha=NOW() WHERE id=?", [nombreDe(u), s.id]);
      notificar([s.id_usuario], { tipo: 'RRHH', titulo: '🏖️ Vacaciones progresivas APROBADAS',
        mensaje: `RRHH aprobó tu solicitud: ${s.anos_previos} años previos acreditados. Tus ${s.dias_actuales} día(s) progresivo(s) ya están en tu cuenta de vacaciones.`,
        href: '/recursos-humanos/vacaciones/' }).catch(() => {});
    } else {
      await pool.query("UPDATE rh_vac_prog_solicitudes SET estado='RECHAZADA', resuelto_por=?, resuelto_fecha=NOW(), resuelto_motivo=? WHERE id=?",
        [nombreDe(u), String(b.motivo).trim().slice(0, 400), s.id]);
      notificar([s.id_usuario], { tipo: 'RRHH', titulo: 'Vacaciones progresivas rechazadas',
        mensaje: `RRHH rechazó tu solicitud: ${String(b.motivo).trim()}`, href: '/recursos-humanos/solicitudes/' }).catch(() => {});
    }
    auditar({ req, accion: decision === 'APROBAR' ? 'APROBAR' : 'RECHAZAR', modulo: 'rrhh', entidad: 'vac_progresivas', entidad_id: s.id,
      detalle: `Vacaciones progresivas de ${s.nombre}: ${decision}${b.motivo ? ' — ' + b.motivo : ''} (${s.anos_previos} años previos, ${s.dias_actuales} día/s)` });
    ok(res, { id: s.id, decision });
  } catch (e) { console.error('[vac-prog resolver]', e.message); fail(res, 'Error interno del servidor'); }
};

/* ── GET /:id/certificado — ver el AFP adjunto (RRHH o el dueño) ── */
const verCertificado = async (req, res) => {
  try {
    const u = req.usuario || {};
    const [[s]] = await pool.query('SELECT * FROM rh_vac_prog_solicitudes WHERE id=?', [req.params.id]);
    if (!s) return fail(res, 'No existe', 404);
    if (s.id_usuario !== u.id_usuario && !(await esRRHH(u.id_usuario))) return fail(res, 'Sin permiso', 403);
    await require('../../../../shared/almacen-docs').servir(res, { ruta: s.doc_ruta, blob: s.archivo, nombre: s.cert_nombre, mime: s.cert_mime });
  } catch (e) { fail(res, 'Error interno del servidor'); }
};

module.exports = { analizar, listar, resolver, verCertificado };
