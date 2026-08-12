'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Envío de correo reutilizable (claves, alertas, etc.) vía SMTP.
   Configurable 100% por variables de entorno (en Render) — NUNCA credenciales en
   el código. Variables:
     MAIL_HOST    ej. smtp.resend.com
     MAIL_PORT    ej. 465 (SSL) o 587 (TLS)
     MAIL_USER    ej. resend   (usuario SMTP del proveedor)
     MAIL_PASS    ej. la API key / app password
     MAIL_FROM    ej. "AutoFácil <afbs@autofacilchile.cl>"
     MAIL_SECURE  opcional 'true'/'false' (por defecto true si el puerto es 465)
   Uso:
     const { enviarCorreo } = require('../../../shared/mailer');
     await enviarCorreo({ to, subject, html, text });   // devuelve { ok, error?, messageId? }
   ───────────────────────────────────────────────────────────────────────────── */
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) { /* dependencia aún no instalada */ }

let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  if (!nodemailer) return null;
  const host = process.env.MAIL_HOST, user = process.env.MAIL_USER, pass = process.env.MAIL_PASS;
  if (!host || !user || !pass) return null;
  const port = parseInt(process.env.MAIL_PORT || '465', 10);
  _transporter = nodemailer.createTransport({
    host, port,
    secure: process.env.MAIL_SECURE ? process.env.MAIL_SECURE === 'true' : port === 465,
    auth: { user, pass },
  });
  return _transporter;
}

function mailConfigurado() {
  return !!(process.env.MAIL_HOST && process.env.MAIL_USER && process.env.MAIL_PASS && nodemailer);
}

function remitente() {
  return process.env.MAIL_FROM || 'AutoFácil <afbs@autofacilchile.cl>';
}

// Remitente de los correos de COBRANZA (comprobantes de cuota, etc.). Configurable por
// env MAIL_FROM_COBRANZA; el remitente debe estar verificado en Brevo (o el dominio
// autofacilchile.cl autenticado) para que no rebote.
function remitenteCobranza() {
  return process.env.MAIL_FROM_COBRANZA || 'Cobranza AutoFácil <cobranza@autofacilchile.cl>';
}

// Remitente de los correos de COMISIONES (aviso de pago al dealer, etc.). Igual que
// cobranza: configurable por env MAIL_FROM_COMISIONES y debe estar verificado en Brevo.
function remitenteComisiones() {
  return process.env.MAIL_FROM_COMISIONES || 'Comisiones AutoFácil <comisiones@autofacilchile.cl>';
}

// Cuentas remitentes disponibles (deben estar verificadas en Brevo o el dominio autenticado).
// Para los selectores "Desde" de correos programados / automatizaciones — evita enviar
// desde la cuenta equivocada. Ampliar aquí cuando se verifiquen nuevos remitentes.
function cuentasRemitente() {
  return [
    { clave: 'sistema',  label: 'Sistema (afbs@)',      from: remitente() },
    { clave: 'cobranza', label: 'Cobranza (cobranza@)', from: remitenteCobranza() },
    { clave: 'comisiones', label: 'Comisiones (comisiones@)', from: remitenteComisiones() },
  ];
}
function remitentePorClave(clave) {
  const c = cuentasRemitente().find(x => x.clave === clave);
  return c ? c.from : remitente();
}

// URL base para imágenes/enlaces de los correos
const APP_URL = (process.env.APP_URL || 'https://afbs.autofacilchile.cl').replace(/\/+$/, '');   // dominio oficial de la Suite

// Envuelve el contenido en la plantilla corporativa: barra superior, cierre "Saludos,"
// y el logo de Business Suite al pie. `cuerpoHtml` es el contenido específico del correo.
// El logo va INCRUSTADO (cid:), no como URL: si el servidor está caído o
// desplegando, Gmail cachea la imagen rota y el correo queda sin firma.
const LOGO_CID = 'aflogobs';
const LOGO_PATH = require('path').join(__dirname, '..', 'api-gateway', 'public', 'img', 'logo-bs-mail.png');
let LOGO_BUF;
function logoAdjunto() {
  try {
    if (LOGO_BUF === undefined) LOGO_BUF = require('fs').readFileSync(LOGO_PATH);
    return { filename: 'logo-bs.png', content: LOGO_BUF, cid: LOGO_CID, contentDisposition: 'inline' };
  } catch { LOGO_BUF = null; return null; }
}

function envolverHTML(cuerpoHtml) {
  const logo = `cid:${LOGO_CID}`;
  return `
  <div style="background:#eef2f7;padding:26px 12px;font-family:'Segoe UI',Arial,sans-serif">
    <div style="max-width:540px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;box-shadow:0 8px 28px rgba(2,32,82,.08)">
      <div style="height:6px;background:linear-gradient(90deg,#012d70,#0141A2 55%,#009AFE)"></div>
      <div style="padding:30px 32px;color:#1e293b;font-size:15px;line-height:1.65">
        ${cuerpoHtml}
        <p style="margin:28px 0 8px;color:#1e293b">Saludos,</p>
        <img src="${logo}" alt="AutoFácil Business Suite" width="160" style="display:block;height:auto;max-width:160px;margin-top:2px">
      </div>
    </div>
    <p style="max-width:540px;margin:14px auto 0;text-align:center;color:#94a3b8;font-size:11px;line-height:1.5">
      Correo automático de AutoFácil Business Suite · por favor no respondas a este mensaje.
    </p>
  </div>`;
}

/* ── Log de correos enviados (Auditoría → Correos Enviados) ──────────────────
   TODO correo que pasa por este motor queda registrado: remitente, quién lo
   disparó (usuario del request via usuarioActual(), o "Sistema" si fue un motor
   automático), destinatarios, asunto, el HTML final y el resultado. */
let _logListo = null;
function logCorreo(d) {
  (async () => {
    try {
      const pool = require('./config/database');
      if (!_logListo) _logListo = pool.query(`
        CREATE TABLE IF NOT EXISTS correos_log (
          id            INT AUTO_INCREMENT PRIMARY KEY,
          fecha         DATETIME DEFAULT CURRENT_TIMESTAMP,
          remitente     VARCHAR(160) NULL,
          enviado_por   VARCHAR(120) NULL,
          id_usuario    INT NULL,
          destinatarios TEXT NULL,
          cc            TEXT NULL,
          bcc           TEXT NULL,
          asunto        VARCHAR(300) NULL,
          html          MEDIUMTEXT NULL,
          ok            TINYINT NOT NULL DEFAULT 1,
          error         VARCHAR(400) NULL,
          dev           TINYINT NOT NULL DEFAULT 0,
          message_id    VARCHAR(200) NULL,
          INDEX ix_correos_fecha (fecha),
          INDEX ix_correos_rem (remitente)
        )`);
      await _logListo;
      const j = v => v == null ? null : (Array.isArray(v) ? v.join(', ') : String(v));
      let quien = null;
      try { quien = require('./middleware/auth').usuarioActual(); } catch (_) {}
      await pool.query(
        `INSERT INTO correos_log (remitente, enviado_por, id_usuario, destinatarios, cc, bcc, asunto, html, ok, error, dev, message_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [String(d.from || '').slice(0, 160), (quien && quien.nombre) || 'Sistema', (quien && quien.id_usuario) || null,
         j(d.to), j(d.cc), j(d.bcc), String(d.subject || '').slice(0, 300), d.html || null,
         d.ok ? 1 : 0, d.error ? String(d.error).slice(0, 400) : null, d.dev ? 1 : 0, d.messageId || null]);
    } catch (e) { console.error('[mailer log]', e.message); }
  })();
}

// Nunca lanza: devuelve { ok, error?, messageId? } para no romper el flujo que lo llama.
// `bcc` (copia oculta) y `from` (remitente puntual, ej. cobranza@) son opcionales.
async function enviarCorreo({ to, cc, bcc, subject, html, text, replyTo, from, attachments } = {}) {
  try {
    if (!nodemailer) return { ok: false, error: 'Falta la dependencia nodemailer en el servidor' };
    const tx = getTransporter();
    if (!tx) return { ok: false, error: 'Correo no configurado (faltan variables MAIL_* en el servidor)' };
    if (!to) return { ok: false, error: 'Destinatario (to) requerido' };

    let toFinal = to, ccFinal = cc, bccFinal = bcc;
    let subjectFinal = subject || '(sin asunto)', htmlFinal = html, textFinal = text;

    // ── Modo DESARROLLO: redirige TODO a los correos de prueba (no sale a clientes) ──
    // FAIL-SAFE (auditoria B-1): si no se puede confirmar el estado se asume ACTIVO;
    // el mailer no enviara sin correos de prueba, que es el resultado seguro.
    let dev = { activo: true, correos: [], whatsapp: '' };
    try { dev = await require('./dev-mode').getDevMode(); } catch (_) {}
    if (dev.activo) {
      const { destinosDev } = require('./dev-mode');
      const d = destinosDev(dev);
      if (!d.to) return { ok: false, error: 'Modo Desarrollo activo pero sin correos de prueba configurados.' };
      const orig = `TO: ${to}${cc ? ' · CC: ' + cc : ''}${bcc ? ' · BCC: ' + bcc : ''}`;
      toFinal = d.to; ccFinal = d.cc; bccFinal = d.bcc;
      subjectFinal = '[DESARROLLO] ' + subjectFinal;
      const escH = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const banner = `<div style="background:#fef3c7;border:1px solid #f59e0b;color:#92400e;padding:9px 13px;border-radius:8px;margin-bottom:14px;font-size:13px;font-family:Arial,sans-serif"><b>&#9888; MODO DESARROLLO.</b> Correo redirigido — destinatario(s) original(es): <b>${escH(orig)}</b></div>`;
      if (htmlFinal) htmlFinal = banner + htmlFinal;
      textFinal = `[MODO DESARROLLO] Correo redirigido. Destinatario original → ${orig}\n\n` + (textFinal || '');
    } else {
      // Suplencias (solo fuera de modo dev): agrega al CC los suplentes activos (categoría Correos).
      try {
        const { ccCorreos } = require('./backups');
        const extra = await ccCorreos(to);
        if (extra && extra.length) {
          const base = (Array.isArray(cc) ? cc : String(cc || '').split(/[,;]/)).map(s => String(s).trim()).filter(Boolean);
          ccFinal = [...new Set([...base, ...extra].map(s => s.toLowerCase()))].join(',');
        }
      } catch (_) { /* backups opcional */ }
    }

    const info = await tx.sendMail({
      from: from || remitente(),
      to: toFinal,
      cc: ccFinal || undefined,
      bcc: bccFinal || undefined,
      subject: subjectFinal,
      text: textFinal || undefined,
      html: htmlFinal || undefined,
      replyTo: replyTo || process.env.MAIL_REPLY_TO || undefined,
      // El logo de la firma viaja incrustado cuando el HTML lo referencia por cid.
      attachments: (() => {
        const adj = [...(attachments || [])];
        if (htmlFinal && htmlFinal.includes(`cid:${LOGO_CID}`)) { const l = logoAdjunto(); if (l) adj.push(l); }
        return adj.length ? adj : undefined;
      })(),   // [{filename, content(Buffer)|path}]
    });
    // `to` = destinatario EFECTIVO (en Modo Desarrollo es el correo de prueba, no el original).
    logCorreo({ from: from || remitente(), to, cc, bcc, subject: subjectFinal, html: htmlFinal,
                ok: true, dev: dev.activo, messageId: info.messageId });
    return { ok: true, messageId: info.messageId, to: toFinal, dev: !!dev.activo };
  } catch (e) {
    console.error('[mailer]', e.message);
    logCorreo({ from: from || remitente(), to, cc, bcc, subject, html, ok: false, error: e.message });
    return { ok: false, error: e.message };
  }
}

module.exports = { enviarCorreo, mailConfigurado, remitente, remitenteCobranza, remitenteComisiones, cuentasRemitente, remitentePorClave, envolverHTML };
