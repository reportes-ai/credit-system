'use strict';
/* ════════════════════════════════════════════════════════════════
   AVISO DE VENCIMIENTO DE CLAVE
   Cuando la política "dias_venc_clave" (config_seguridad) es > 0, este
   job revisa cada hora y, a los usuarios activos cuya clave vence en los
   próximos DIAS_AVISO días, les envía UN correo por día recordándoles
   cambiarla — hasta que la cambien (al cambiarla se reinicia el reloj y
   salen de la ventana). Si la clave ya venció, el login los obliga a
   cambiarla (ver auth.controller.js); aquí solo se avisa antes.
   ════════════════════════════════════════════════════════════════ */
const pool = require('../../../../shared/config/database');
const { enviarCorreo, mailConfigurado, envolverHTML } = require('../../../../shared/mailer');

const APP_URL = (process.env.APP_URL || 'https://afbs.autofacilchile.cl').replace(/\/+$/, '');
const DIAS_AVISO_DEFAULT = 5; // días de anticipación por defecto (configurable en Seguridad)

require('../../../../shared/migrate').enFila('aviso-vencimiento-clave', async () => {
  try {
    // Registro de "último aviso enviado" por usuario → un correo por día
    await pool.query(`CREATE TABLE IF NOT EXISTS avisos_clave_vencimiento (
      id_usuario INT PRIMARY KEY,
      last_sent  DATE NOT NULL
    )`);
  } catch (e) { console.error('[aviso-venc-clave migration]', e.message); }
});

function correoVencimiento(nombre, dias) {
  const login = `${APP_URL}/login.html`;
  const cuando = dias <= 1 ? 'mañana' : `en ${dias} días`;
  const subject = `Tu contraseña vence ${cuando} — AutoFácil Business Suite`;
  const text = `Hola ${nombre},\n\nTu contraseña del sistema vence ${cuando}. Por seguridad, te recomendamos cambiarla antes de que expire.\n\nCómo cambiarla: ingresa al sistema, abre el menú de tu usuario (arriba a la derecha) y elige "Cambiar contraseña".\nIngresa en ${login}\n\nSi no la cambias antes del vencimiento, el sistema te pedirá hacerlo en tu próximo ingreso. Seguirás recibiendo este aviso a diario hasta que la cambies.\n\nSaludos,\nAutoFácil Business Suite`;
  const cuerpo = `
    <p style="margin:0 0 14px">Hola <b>${nombre}</b>,</p>
    <p style="margin:0 0 16px">Tu contraseña del sistema <b>vence ${cuando}</b>. Por seguridad, te recomendamos cambiarla antes de que expire.</p>
    <table role="presentation" width="100%" style="border-collapse:collapse;background:#fff7ed;border:1px solid #fed7aa;border-radius:12px">
      <tr><td style="padding:14px 18px;color:#9a3412;font-size:14px;line-height:1.55">
        <b>Cómo cambiarla:</b> ingresa al sistema, abre el menú de tu usuario (arriba a la derecha) y elige <b>“Cambiar contraseña”</b>.
      </td></tr>
    </table>
    <p style="text-align:center;margin:24px 0 4px">
      <a href="${login}" style="background:#0141A2;color:#fff;text-decoration:none;padding:12px 30px;border-radius:8px;font-weight:600;display:inline-block;font-size:15px">Ingresar al sistema</a>
    </p>
    <p style="font-size:12px;color:#94a3b8;margin:14px 0 0">Si no la cambias antes del vencimiento, el sistema te pedirá hacerlo en tu próximo ingreso. Seguirás recibiendo este aviso a diario hasta que la cambies.</p>`;
  return { subject, text, html: envolverHTML(cuerpo) };
}

let corriendo = false;
async function revisar() {
  if (corriendo) return; corriendo = true;
  try {
    if (!mailConfigurado()) return; // sin correo configurado no hay nada que enviar

    // Política desde Seguridad: vencimiento, si se avisa por correo y la anticipación
    const [cfgRows] = await pool.query(
      "SELECT clave, valor FROM config_seguridad WHERE clave IN ('dias_venc_clave','aviso_venc_correo','aviso_venc_dias')");
    const cfg = {}; cfgRows.forEach(r => { cfg[r.clave] = r.valor; });
    const diasVenc = parseInt(cfg.dias_venc_clave) || 0;
    if (diasVenc <= 0) return;                       // sin política de vencimiento → no se avisa
    if (cfg.aviso_venc_correo === '0') return;       // aviso por correo desactivado
    const diasAviso = Math.min(60, Math.max(1, parseInt(cfg.aviso_venc_dias) || DIAS_AVISO_DEFAULT));

    // Usuarios activos con clave por vencer (1..DIAS_AVISO días) que aún no recibieron aviso hoy
    const [rows] = await pool.query(`
      SELECT u.id_usuario, u.nombre, u.email,
             (? - DATEDIFF(CURDATE(), DATE(u.password_updated_at))) AS dias_restantes
      FROM usuarios u
      LEFT JOIN avisos_clave_vencimiento a ON a.id_usuario = u.id_usuario
      WHERE u.estado = 'activo'
        AND u.email IS NOT NULL AND u.email <> ''
        AND u.debe_cambiar_clave = 0
        AND u.password_updated_at IS NOT NULL
        AND (a.last_sent IS NULL OR a.last_sent < CURDATE())
      HAVING dias_restantes BETWEEN 1 AND ?`,
      [diasVenc, diasAviso]);

    let enviados = 0;
    for (const u of rows) {
      const c = correoVencimiento(u.nombre, Number(u.dias_restantes));
      const envio = await enviarCorreo({ to: u.email, subject: c.subject, html: c.html, text: c.text });
      if (envio.ok) {
        await pool.query(
          `INSERT INTO avisos_clave_vencimiento (id_usuario, last_sent) VALUES (?, CURDATE())
           ON DUPLICATE KEY UPDATE last_sent = CURDATE()`, [u.id_usuario]);
        enviados++;
      }
    }
    if (enviados) console.log(`[aviso-venc-clave] ${enviados} aviso(s) de vencimiento enviados`);
  } catch (e) { console.error('[aviso-venc-clave]', e.message); }
  finally { corriendo = false; }
}

setTimeout(revisar, 15000);            // primera corrida al arrancar
setInterval(revisar, 60 * 60 * 1000); // cada hora (a lo sumo 1 correo/día por usuario)

module.exports = { revisar };
