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

// Nunca lanza: devuelve { ok, error?, messageId? } para no romper el flujo que lo llama.
async function enviarCorreo({ to, subject, html, text, replyTo } = {}) {
  try {
    if (!nodemailer) return { ok: false, error: 'Falta la dependencia nodemailer en el servidor' };
    const tx = getTransporter();
    if (!tx) return { ok: false, error: 'Correo no configurado (faltan variables MAIL_* en el servidor)' };
    if (!to) return { ok: false, error: 'Destinatario (to) requerido' };
    const info = await tx.sendMail({
      from: remitente(),
      to,
      subject: subject || '(sin asunto)',
      text: text || undefined,
      html: html || undefined,
      replyTo: replyTo || process.env.MAIL_REPLY_TO || undefined,
    });
    return { ok: true, messageId: info.messageId };
  } catch (e) {
    console.error('[mailer]', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { enviarCorreo, mailConfigurado, remitente };
