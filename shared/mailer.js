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

// URL base para imágenes/enlaces de los correos
const APP_URL = (process.env.APP_URL || 'https://credit-system-45em.onrender.com').replace(/\/+$/, '');

// Envuelve el contenido en la plantilla corporativa: barra superior, cierre "Saludos,"
// y el logo de Business Suite al pie. `cuerpoHtml` es el contenido específico del correo.
function envolverHTML(cuerpoHtml) {
  const logo = `${APP_URL}/img/logo-bs.png`;
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

// Nunca lanza: devuelve { ok, error?, messageId? } para no romper el flujo que lo llama.
// `bcc` (copia oculta) y `from` (remitente puntual, ej. cobranza@) son opcionales.
async function enviarCorreo({ to, cc, bcc, subject, html, text, replyTo, from } = {}) {
  try {
    if (!nodemailer) return { ok: false, error: 'Falta la dependencia nodemailer en el servidor' };
    const tx = getTransporter();
    if (!tx) return { ok: false, error: 'Correo no configurado (faltan variables MAIL_* en el servidor)' };
    if (!to) return { ok: false, error: 'Destinatario (to) requerido' };

    let toFinal = to, ccFinal = cc, bccFinal = bcc;
    let subjectFinal = subject || '(sin asunto)', htmlFinal = html, textFinal = text;

    // ── Modo DESARROLLO: redirige TODO a los correos de prueba (no sale a clientes) ──
    let dev = { activo: false };
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
    });
    return { ok: true, messageId: info.messageId };
  } catch (e) {
    console.error('[mailer]', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { enviarCorreo, mailConfigurado, remitente, envolverHTML };
