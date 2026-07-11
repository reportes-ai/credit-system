const pool = require('../../../../shared/config/database');
const { enviarCorreo, mailConfigurado, remitente, remitenteCobranza, envolverHTML } = require('../../../../shared/mailer');
const { auditar } = require('../../../../shared/audit');

/* ─── Migración ──────────────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('seguridad', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS config_seguridad (
        clave      VARCHAR(60) PRIMARY KEY,
        valor      TEXT        NOT NULL,
        updated_at DATETIME    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Valores por defecto (solo inserta si no existen)
    const defaults = [
      ['timeout_inactividad',   '60'],   // minutos (0 = nunca)
      ['dias_venc_clave',       '0'],    // días (0 = nunca)
      ['aviso_venc_correo',     '1'],    // avisar por correo antes del vencimiento (1/0)
      ['aviso_venc_dias',       '5'],    // días de anticipación del aviso
      ['longitud_minima',       '6'],
      ['req_mayusculas',        '0'],
      ['req_numeros',           '0'],
      ['req_especiales',        '0'],
      ['permitir_misma_clave',  '1'],
      ['historial_claves',      '0'],    // 0 = sin restricción, N = no reutilizar hasta N cambios
    ];
    for (const [clave, valor] of defaults) {
      await pool.query(
        `INSERT IGNORE INTO config_seguridad (clave, valor) VALUES (?, ?)`,
        [clave, valor]
      );
    }
  } catch (e) {
    console.error('[config_seguridad migration]', e.message);
  }
});

/* ─── GET config ─────────────────────────────────────────────────────────── */
const getConfig = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT clave, valor FROM config_seguridad');
    const cfg = {};
    rows.forEach(r => { cfg[r.clave] = r.valor; });
    res.json({ success: true, data: cfg, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── PUT config ─────────────────────────────────────────────────────────── */
const putConfig = async (req, res) => {
  try {
    const allowed = [
      'timeout_inactividad', 'dias_venc_clave', 'aviso_venc_correo', 'aviso_venc_dias',
      'longitud_minima', 'req_mayusculas', 'req_numeros', 'req_especiales',
      'permitir_misma_clave', 'historial_claves',
    ];
    const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
    if (!updates.length) return res.status(400).json({ success: false, data: null, error: 'Sin campos válidos' });

    for (const [clave, valor] of updates) {
      await pool.query(
        `INSERT INTO config_seguridad (clave, valor) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE valor = VALUES(valor), updated_at = CURRENT_TIMESTAMP`,
        [clave, String(valor)]
      );
    }
    res.json({ success: true, data: null, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── Estado del correo del sistema ──────────────────────────────────────── */
const mailStatus = async (req, res) => {
  res.json({ success: true, data: { configurado: mailConfigurado(), from: remitente() }, error: null });
};

/* ─── Enviar correo de prueba (verifica la configuración SMTP) ────────────── */
const testEmail = async (req, res) => {
  try {
    const to = (req.body && req.body.to && String(req.body.to).trim()) || req.usuario?.email;
    if (!to) return res.status(400).json({ success: false, data: null, error: 'No hay destinatario (indica un correo)' });
    // Permite probar el remitente de Cobranza (cobranza@) para verificar su configuración en Brevo.
    const esCobranza = req.body && req.body.from === 'cobranza';
    const from = esCobranza ? remitenteCobranza() : remitente();
    const r = await enviarCorreo({
      to, from,
      subject: esCobranza ? 'AutoFácil Cobranza — Correo de prueba' : 'AutoFácil — Correo de prueba',
      text: 'Este es un correo de prueba del sistema AutoFácil. Si lo recibiste, el envío de correos quedó configurado correctamente.',
      html: '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1e293b">'
          + '<h2 style="color:#0141A2">AutoFácil — Correo de prueba' + (esCobranza ? ' (Cobranza)' : '') + '</h2>'
          + '<p>Este es un correo de prueba del sistema. Si lo recibiste, el envío de correos quedó <b>configurado correctamente</b>.</p>'
          + '<p style="color:#64748b;font-size:12px">Enviado desde ' + from + '</p></div>',
    });
    if (!r.ok) return res.status(400).json({ success: false, data: null, error: r.error });
    // r.to = destinatario efectivo (en Modo Desarrollo, el correo de prueba, no el solicitado).
    res.json({ success: true, data: { to: r.to || to, solicitado: to, from, dev: !!r.dev, messageId: r.messageId }, error: null });
  } catch (e) {
    (console.error('[testEmail]', e), res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }));
  }
};

/* ─── Envío de correos a usuarios (por perfil / individuales / combinación) ──── */
const enviarMails = async (req, res) => {
  try {
    const { perfiles = [], usuarios = [], asunto, mensaje } = req.body || {};
    if (!asunto || !String(asunto).trim()) return res.status(400).json({ success: false, data: null, error: 'El asunto es requerido' });
    if (!mensaje || !String(mensaje).trim()) return res.status(400).json({ success: false, data: null, error: 'El mensaje es requerido' });
    if (!perfiles.length && !usuarios.length) return res.status(400).json({ success: false, data: null, error: 'Selecciona al menos un perfil o usuario' });
    if (!mailConfigurado()) return res.status(400).json({ success: false, data: null, error: 'El correo del sistema no está configurado (faltan variables MAIL_*).' });

    // Resolver destinatarios: activos, con email; dedupe por email
    const conds = [], params = [];
    if (perfiles.length) { conds.push('id_perfil IN (?)'); params.push(perfiles.map(Number)); }
    if (usuarios.length) { conds.push('id_usuario IN (?)'); params.push(usuarios.map(Number)); }
    const [rows] = await pool.query(
      `SELECT DISTINCT nombre, email FROM usuarios
       WHERE estado='activo' AND email IS NOT NULL AND email <> '' AND (${conds.join(' OR ')})`,
      params);
    if (!rows.length) return res.status(400).json({ success: false, data: null, error: 'No hay destinatarios activos con correo.' });

    // Mensaje (texto plano del admin) → HTML seguro con párrafos
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const cuerpoMsg = esc(mensaje).split(/\n{2,}/).map(p => `<p style="margin:0 0 12px">${p.replace(/\n/g, '<br>')}</p>`).join('');

    let enviados = 0, fallidos = 0;
    for (const u of rows) {
      const primerNombre = (String(u.nombre || '').trim().split(/\s+/)[0]) || 'usuario';
      const cuerpo = `<p style="margin:0 0 14px">Hola <b>${esc(primerNombre)}</b>,</p>${cuerpoMsg}`;
      const r = await enviarCorreo({ to: u.email, subject: String(asunto).trim(), html: envolverHTML(cuerpo), text: `Hola ${primerNombre},\n\n${mensaje}\n\nSaludos,\nAutoFácil Business Suite` });
      if (r.ok) enviados++; else fallidos++;
    }

    auditar({ req, accion: 'EDITAR', modulo: 'usuarios', entidad: 'correo', entidad_id: null,
      detalle: `Envió un correo "${String(asunto).trim()}" a ${enviados} destinatario(s)`, meta: { enviados, fallidos, total: rows.length } });
    res.json({ success: true, data: { enviados, fallidos, total: rows.length }, error: null });
  } catch (e) {
    (console.error('[enviarMails]', e), res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }));
  }
};

module.exports = { getConfig, putConfig, mailStatus, testEmail, enviarMails };
