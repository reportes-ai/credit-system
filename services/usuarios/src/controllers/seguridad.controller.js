const pool = require('../../../../shared/config/database');
const { enviarCorreo, mailConfigurado, remitente } = require('../../../../shared/mailer');

/* ─── Migración ──────────────────────────────────────────────────────────── */
(async () => {
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
})();

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
    const r = await enviarCorreo({
      to,
      subject: 'AutoFácil — Correo de prueba',
      text: 'Este es un correo de prueba del sistema AutoFácil. Si lo recibiste, el envío de correos quedó configurado correctamente.',
      html: '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1e293b">'
          + '<h2 style="color:#0141A2">AutoFácil — Correo de prueba</h2>'
          + '<p>Este es un correo de prueba del sistema. Si lo recibiste, el envío de correos quedó <b>configurado correctamente</b>.</p>'
          + '<p style="color:#64748b;font-size:12px">Enviado desde ' + remitente() + '</p></div>',
    });
    if (!r.ok) return res.status(400).json({ success: false, data: null, error: r.error });
    res.json({ success: true, data: { to, messageId: r.messageId }, error: null });
  } catch (e) {
    (console.error('[testEmail]', e), res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }));
  }
};

module.exports = { getConfig, putConfig, mailStatus, testEmail };
