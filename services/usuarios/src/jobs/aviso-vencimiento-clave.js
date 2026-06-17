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
const { enviarCorreo, mailConfigurado } = require('../../../../shared/mailer');

const APP_URL = (process.env.APP_URL || 'https://credit-system-45em.onrender.com').replace(/\/+$/, '');
const DIAS_AVISO = 5; // avisar cuando falten 5 días o menos

(async () => {
  try {
    // Registro de "último aviso enviado" por usuario → un correo por día
    await pool.query(`CREATE TABLE IF NOT EXISTS avisos_clave_vencimiento (
      id_usuario INT PRIMARY KEY,
      last_sent  DATE NOT NULL
    )`);
  } catch (e) { console.error('[aviso-venc-clave migration]', e.message); }
})();

function correoVencimiento(nombre, dias) {
  const login = `${APP_URL}/login.html`;
  const cuando = dias <= 1 ? 'mañana' : `en ${dias} días`;
  const subject = `Tu contraseña vence ${cuando} — AutoFácil Business Suite`;
  const text = `Hola ${nombre},\n\nTu contraseña del sistema vence ${cuando}. Por seguridad, cámbiala antes de que expire.\n\nIngresa en ${login}, abre el menú de tu usuario (arriba a la derecha) y elige "Cambiar contraseña".\n\nSi no la cambias antes del vencimiento, el sistema te pedirá hacerlo en tu próximo ingreso.\n\nSeguirás recibiendo este aviso a diario hasta que cambies la contraseña.`;
  const html = `
    <div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:auto;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden">
      <div style="background:linear-gradient(135deg,#012d70,#0141A2 60%,#009AFE);color:#fff;padding:22px 26px">
        <div style="font-size:1.15rem;font-weight:700">AutoFácil Business Suite</div>
        <div style="font-size:.85rem;opacity:.85">Vencimiento de contraseña</div>
      </div>
      <div style="padding:24px 26px;color:#1e293b;font-size:.92rem;line-height:1.6">
        <p>Hola <b>${nombre}</b>,</p>
        <p>Tu contraseña del sistema <b>vence ${cuando}</b>. Por seguridad, cámbiala antes de que expire.</p>
        <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:12px 16px;margin:14px 0;color:#9a3412;font-size:.88rem">
          <i>⏰</i> Para cambiarla: ingresa al sistema, abre el menú de tu usuario (arriba a la derecha) y elige <b>“Cambiar contraseña”</b>.
        </div>
        <p style="text-align:center;margin:22px 0">
          <a href="${login}" style="background:#0141A2;color:#fff;text-decoration:none;padding:11px 26px;border-radius:8px;font-weight:600;display:inline-block">Ingresar al sistema</a>
        </p>
        <p style="font-size:.8rem;color:#94a3b8">Si no la cambias antes del vencimiento, el sistema te pedirá hacerlo en tu próximo ingreso. Seguirás recibiendo este aviso a diario hasta que la cambies.</p>
      </div>
    </div>`;
  return { subject, text, html };
}

let corriendo = false;
async function revisar() {
  if (corriendo) return; corriendo = true;
  try {
    if (!mailConfigurado()) return; // sin correo configurado no hay nada que enviar

    const [[cfg]] = await pool.query("SELECT valor FROM config_seguridad WHERE clave = 'dias_venc_clave'");
    const diasVenc = parseInt(cfg && cfg.valor) || 0;
    if (diasVenc <= 0) return; // sin política de vencimiento → no se avisa

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
      [diasVenc, DIAS_AVISO]);

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
