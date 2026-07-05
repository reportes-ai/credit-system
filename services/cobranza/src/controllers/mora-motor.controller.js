'use strict';
/* ════════════════════════════════════════════════════════════════════════════
   AUTOMATIZACIÓN DE COBRANZA POR MORA — motor + plantillas por tramo de días.

   Corre 1 vez al día (hora/días configurables), recorre la cartera AutoFácil en mora
   y a cada crédito le envía la plantilla cuyo tramo [dias_desde, dias_hasta] contiene
   sus días de mora — sin reenviar el mismo tramo dentro del cooldown.

   SEGURO: nace DESACTIVADO (mora_activo=0). El envío respeta Modo Desarrollo (el mailer
   redirige a los correos de prueba). Reusa la query de mora y los helpers de cobranza.
   ════════════════════════════════════════════════════════════════════════════ */
const pool = require('../../../../shared/config/database');
const { enviarCorreo, remitentePorClave, envolverHTML, cuentasRemitente } = require('../../../../shared/mailer');
const cob = require('./cobranza.controller');
const { MORA_SQL, getCobranzaConfig, rellenar, tratamiento, titleCase } = cob._motor;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const APP_URL = (process.env.APP_URL || 'https://credit-system-45em.onrender.com').replace(/\/+$/, '');
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Email "pro" de cobranza: shell con branding AutoFácil. Mismo render para envío y vista previa.
function emailHTMLCobranza(cuerpoTxt) {
  const parrafos = String(cuerpoTxt || '').split(/\n\s*\n/).filter(p => p.trim() !== '')
    .map(p => `<p style="margin:0 0 14px;font-size:14px;line-height:1.65;color:#1e293b">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  return `<div style="background:#eef2f7;padding:26px 12px;font-family:Arial,Helvetica,sans-serif">
    <div style="max-width:580px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 10px rgba(2,45,112,.12)">
      <div style="padding:20px 26px 14px;background:#fff">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="vertical-align:middle"><img src="${APP_URL}/img/logo-autofacil.png" alt="AutoFácil — Crédito Automotriz" height="36" style="height:36px;display:block;border:0"></td>
          <td align="right" style="vertical-align:middle"><span style="background:#eff6ff;color:#0141A2;font-size:11px;font-weight:800;padding:5px 12px;border-radius:20px;letter-spacing:.5px;border:1px solid #bfdbfe">COBRANZA</span></td>
        </tr></table>
      </div>
      <div style="height:4px;background:linear-gradient(90deg,#012d70,#0141A2 50%,#009AFE)"></div>
      <div style="padding:24px 26px">${parrafos}</div>
      <div style="background:#f8fafc;border-top:1px solid #e9eef5;padding:15px 26px;color:#64748b;font-size:11px;line-height:1.6">
        Mensaje automático de <b>AutoFácil SpA</b> &middot; cobranza@autofacilchile.cl<br>
        Si ya regularizaste tu pago, por favor omite este correo.
      </div>
    </div>
  </div>`;
}

/* ── Migración + seed (3 tramos) + config (desactivada) + funcionalidad ── */
(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS cobranza_mora_plantillas (
      codigo     VARCHAR(30) PRIMARY KEY,
      nombre     VARCHAR(120) NOT NULL,
      dias_desde INT NOT NULL DEFAULT 0,
      dias_hasta INT NOT NULL DEFAULT 9999,
      asunto     VARCHAR(200) NOT NULL,
      cuerpo     TEXT NOT NULL,
      activo     TINYINT(1) NOT NULL DEFAULT 1,
      orden      INT NOT NULL DEFAULT 0
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS cobranza_mora_envios (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      id_credito       INT NOT NULL,
      codigo_plantilla VARCHAR(30) NOT NULL,
      dias_mora        INT,
      email            VARCHAR(200),
      estado           VARCHAR(140),
      fecha_envio      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_cred (id_credito), INDEX idx_fecha (fecha_envio)
    )`);
    const datos = '\n\nTitular: AUTOFACIL SpA · RUT: 76.545.638-K · Banco de Chile · Cta Cte 8001829208 · cobranza@autofacilchile.cl';
    const seed = [
      ['tramo1', 'Recordatorio amable', 1, 7, '[AutoFácil] Recordatorio de pago — Crédito N° {numero}',
        '{trato} {nombre},\n\nNotamos que su cuota del crédito N° {numero} quedó pendiente ({dias} día(s) de atraso). Puede regularizarla fácilmente con los siguientes datos:\n{datos}\n\nSi ya realizó el pago, por favor omita este mensaje.\n\nEquipo de Cobranza AutoFácil', 1],
      ['tramo2', 'Aviso firme (vencida)', 8, 20, '[AutoFácil] Cuota vencida — Crédito N° {numero}',
        '{trato} {nombre},\n\nSu crédito N° {numero} registra {cuotas} cuota(s) impaga(s) por un total de ${monto}, con {dias} días de atraso. Le solicitamos regularizar a la brevedad para evitar gastos de cobranza adicionales:\n{datos}\n\nEquipo de Cobranza AutoFácil', 2],
      ['tramo3', 'Aviso serio / pre-gestión', 21, 9999, '[AutoFácil] Deuda en mora — Crédito N° {numero}',
        '{trato} {nombre},\n\nSu crédito N° {numero} mantiene una deuda en mora de {dias} días ({cuotas} cuota(s), ${monto}). Le pedimos contactarnos a la brevedad para regularizar y evitar gestiones mayores:\n{datos}\n\nEquipo de Cobranza AutoFácil', 3],
    ];
    for (const s of seed)
      await pool.query(`INSERT IGNORE INTO cobranza_mora_plantillas (codigo,nombre,dias_desde,dias_hasta,asunto,cuerpo,activo,orden) VALUES (?,?,?,?,?,?,1,?)`,
        [s[0], s[1], s[2], s[3], s[4], s[5].replace('{datos}', datos), s[6]]);
    const cfg = { mora_activo: '0', mora_hora: '10:00', mora_dias: '1,2,3,4,5', mora_remitente: 'cobranza', mora_cooldown_dias: '7', mora_max: '200', mora_pausa_seg: '5' };
    for (const [k, v] of Object.entries(cfg)) await pool.query('INSERT IGNORE INTO cobranza_config (clave,valor) VALUES (?,?)', [k, v]);
    // Funcionalidad del mantenedor, junto al de Parámetros Cobranza
    const [[fp]] = await pool.query("SELECT id_modulo FROM funcionalidades WHERE codigo='mant_cobranza_parametros' LIMIT 1");
    if (fp) {
      const [[ex]] = await pool.query("SELECT 1 ok FROM funcionalidades WHERE codigo='mant_cobranza_mora' LIMIT 1");
      if (!ex) {
        const [r] = await pool.query("INSERT INTO funcionalidades (id_modulo,nombre,codigo,href,icono) VALUES (?,?,?,?,?)",
          [fp.id_modulo, 'Automatización Cobranza (Mora)', 'mant_cobranza_mora', '/mantenedores/cobranza-mora/', 'bi-envelope-heart']);
        const [[admin]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
        if (admin) await pool.query("INSERT IGNORE INTO permisos_perfil (id_perfil,id_funcionalidad,habilitado) VALUES (?,?,1)", [admin.id_perfil, r.insertId]);
      }
      // El mantenedor ahora unifica correo + WhatsApp → renombrar la funcionalidad
      await pool.query("UPDATE funcionalidades SET nombre='Automatizaciones de Cobranza' WHERE codigo='mant_cobranza_mora' AND nombre<>'Automatizaciones de Cobranza'");
    }
    console.log('[cobranza mora-motor] tablas + seed listos');
  } catch (e) { console.error('[cobranza mora-motor migration]', e.message); }
})();

/* ── Config del motor (claves en cobranza_config) ── */
const CFG_KEYS = ['mora_activo', 'mora_hora', 'mora_dias', 'mora_remitente', 'mora_cooldown_dias', 'mora_max', 'mora_pausa_seg'];
async function getMotorCfg() {
  const [rows] = await pool.query('SELECT clave,valor FROM cobranza_config WHERE clave IN (?)', [CFG_KEYS.concat(['mora_ultimo_envio_fecha'])]);
  const m = {}; rows.forEach(r => { m[r.clave] = r.valor; });
  return m;
}
async function setMotorCfg(obj) {
  for (const k of CFG_KEYS) {
    if (obj[k] === undefined) continue;
    let v = String(obj[k]);
    if (k === 'mora_activo') v = (obj[k] === 1 || obj[k] === '1' || obj[k] === true) ? '1' : '0';
    if (k === 'mora_hora' && !/^\d{2}:\d{2}$/.test(v)) continue;
    if (k === 'mora_dias') v = v.split(',').map(s => s.trim()).filter(d => /^[1-7]$/.test(d)).join(',');
    if (k === 'mora_remitente' && !cuentasRemitente().some(c => c.clave === v)) continue;
    await pool.query('INSERT INTO cobranza_config (clave,valor) VALUES (?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)', [k, v]);
  }
}

function chileParts() {
  const now = new Date();
  const fecha = now.toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });           // YYYY-MM-DD
  const hhmm = now.toLocaleTimeString('en-GB', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit', hour12: false }).slice(0, 5);
  const wd = now.toLocaleDateString('en-US', { timeZone: 'America/Santiago', weekday: 'short' });
  const map = { Mon: '1', Tue: '2', Wed: '3', Thu: '4', Fri: '5', Sat: '6', Sun: '7' };
  return { fecha, hhmm, dow: map[wd] || '1' };
}

/* ── Motor: recorre la cartera en mora y envía la plantilla del tramo ── */
async function procesar({ dryRun = false } = {}) {
  const cfg = await getMotorCfg();
  if (!dryRun && cfg.mora_activo !== '1') return { ok: false, motivo: 'desactivado' };
  const [plantillas] = await pool.query('SELECT * FROM cobranza_mora_plantillas WHERE activo=1 ORDER BY orden, dias_desde');
  if (!plantillas.length) return { ok: false, motivo: 'sin plantillas activas' };
  const conf = await getCobranzaConfig();
  const from = remitentePorClave(cfg.mora_remitente || 'cobranza');
  const cooldown = Math.max(0, parseInt(cfg.mora_cooldown_dias, 10) || 7);
  const max = Math.min(2000, Math.max(1, parseInt(cfg.mora_max, 10) || 200));
  const pausaMs = Math.max(0, parseInt(cfg.mora_pausa_seg, 10) || 0) * 1000;   // espaciado entre correos
  const [rows] = await pool.query(MORA_SQL('', '') + ' ORDER BY dias_mora DESC LIMIT ' + max);
  const tramoDe = d => plantillas.find(p => d >= p.dias_desde && d <= p.dias_hasta);
  let enviados = 0, saltados = 0, sin_email = 0, sin_tramo = 0; const detalle = [];
  for (const c of rows) {
    const dias = Number(c.dias_mora) || 0;
    const p = tramoDe(dias);
    if (!p) { sin_tramo++; continue; }
    const email = String(c.email_cliente || '').trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { sin_email++; continue; }
    const [[ya]] = await pool.query(
      'SELECT id FROM cobranza_mora_envios WHERE id_credito=? AND codigo_plantilla=? AND fecha_envio >= (NOW() - INTERVAL ? DAY) LIMIT 1',
      [c.id_credito, p.codigo, cooldown]);
    if (ya) { saltados++; continue; }
    const vars = {
      trato: tratamiento(c.sexo_cliente), nombre: titleCase(c.nombre_cliente || 'Cliente'),
      numero: c.numero_credito || c.id_credito, dias, cuotas: Number(c.cuotas_mora) || 0,
      monto: Math.round(Number(c.monto_mora) || 0).toLocaleString('es-CL'), datos: conf.datos_transferencia,
    };
    const asunto = rellenar(p.asunto, vars);
    const cuerpoTxt = rellenar(p.cuerpo, vars);
    if (dryRun) { detalle.push({ id_credito: c.id_credito, numero: vars.numero, dias, tramo: p.codigo, email }); enviados++; continue; }
    const html = emailHTMLCobranza(cuerpoTxt);
    const r = await enviarCorreo({ to: email, from, subject: asunto, html, text: cuerpoTxt });
    await pool.query('INSERT INTO cobranza_mora_envios (id_credito,codigo_plantilla,dias_mora,email,estado) VALUES (?,?,?,?,?)',
      [c.id_credito, p.codigo, dias, email, r.ok ? 'enviado' : ('error: ' + (r.error || '')).slice(0, 140)]);
    // Bitácora del cliente: cada correo automático queda como gestión en el CRM
    // (mismo patrón que las automatizaciones de WhatsApp — el mail no tiene entregado/leído).
    if (r.ok) {
      try {
        await pool.query(`
          INSERT INTO crm_gestiones (tipo_cliente, rut_cliente, nombre_cliente, email, canal, tipo_solicitud,
            descripcion, resultado, id_usuario, nombre_usuario, estado)
          VALUES ('PERSONA', ?, ?, ?, 'EMAIL', 'AUTOMATIZACION COBRANZA', ?, 'ENVIADO', NULL, 'Business Suite (automático)', 'CERRADA')`,
          [c.rut_cliente || null, titleCase(c.nombre_cliente || 'Cliente'), email,
           `Correo automático de cobranza (${p.nombre}) — ${dias} día(s) de mora, ${vars.cuotas} cuota(s), $${vars.monto}`]);
      } catch (e) { console.error('[mora crm]', e.message); }
    }
    if (r.ok) enviados++; else saltados++;
    if (pausaMs && enviados + saltados < rows.length) await sleep(pausaMs);   // espacia los correos (anti-ráfaga)
  }
  return { ok: true, total: rows.length, enviados, saltados, sin_email, sin_tramo, detalle: dryRun ? detalle.slice(0, 100) : undefined };
}

/* ── Scheduler: 1 vez al día (hora/días configurados), dedup por fecha ── */
let _busy = false;
async function tick() {
  if (_busy) return; _busy = true;
  try {
    const cfg = await getMotorCfg();
    if (cfg.mora_activo !== '1') return;
    const ch = chileParts();
    if (String(cfg.mora_hora || '10:00').slice(0, 5) !== ch.hhmm) return;
    const dias = String(cfg.mora_dias || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!dias.includes(String(ch.dow))) return;
    if (cfg.mora_ultimo_envio_fecha === ch.fecha) return;   // ya corrió hoy
    await pool.query("INSERT INTO cobranza_config (clave,valor) VALUES ('mora_ultimo_envio_fecha',?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)", [ch.fecha]);
    console.log('[cobranza mora-motor] corriendo', ch.fecha, ch.hhmm);
    const res = await procesar({ dryRun: false });
    console.log('[cobranza mora-motor] resultado', JSON.stringify(res));
  } catch (e) { console.error('[cobranza mora-motor tick]', e.message); }
  finally { _busy = false; }
}
setTimeout(tick, 20000);
setInterval(tick, 60000);

/* ── Endpoints (mantenedor) ── */
exports.getTodo = async (req, res) => {
  try {
    const [plantillas] = await pool.query('SELECT * FROM cobranza_mora_plantillas ORDER BY orden, dias_desde');
    const config = await getMotorCfg();
    const [[ult]] = await pool.query("SELECT MAX(fecha_envio) AS f, COUNT(*) AS n FROM cobranza_mora_envios WHERE fecha_envio >= (NOW() - INTERVAL 7 DAY)");
    const [historial] = await pool.query(`
      SELECT e.*, p.nombre nombre_plantilla, cl.nombre_completo nombre_cliente
      FROM cobranza_mora_envios e
      LEFT JOIN cobranza_mora_plantillas p ON p.codigo = e.codigo_plantilla
      LEFT JOIN creditos cr ON cr.id = e.id_credito
      LEFT JOIN clientes cl ON cl.id_cliente = cr.id_cliente
      ORDER BY e.id DESC LIMIT 60`);
    res.json({ success: true, data: { plantillas, config, cuentas: cuentasRemitente().map(c => ({ clave: c.clave, label: c.label })), ultimos7: ult, historial }, error: null });
  } catch (e) { console.error('[mora getTodo]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
exports.guardarPlantilla = async (req, res) => {
  try {
    const { codigo, nombre, dias_desde, dias_hasta, asunto, cuerpo, activo } = req.body || {};
    if (!codigo || !asunto || !cuerpo) return res.status(400).json({ success: false, data: null, error: 'codigo, asunto y cuerpo requeridos' });
    await pool.query(
      `INSERT INTO cobranza_mora_plantillas (codigo,nombre,dias_desde,dias_hasta,asunto,cuerpo,activo)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE nombre=VALUES(nombre),dias_desde=VALUES(dias_desde),dias_hasta=VALUES(dias_hasta),asunto=VALUES(asunto),cuerpo=VALUES(cuerpo),activo=VALUES(activo)`,
      [codigo, nombre || codigo, parseInt(dias_desde, 10) || 0, parseInt(dias_hasta, 10) || 9999, asunto, cuerpo, activo ? 1 : 0]);
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[mora guardarPlantilla]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
exports.guardarConfig = async (req, res) => {
  try { await setMotorCfg(req.body || {}); res.json({ success: true, data: { ok: true }, error: null }); }
  catch (e) { console.error('[mora guardarConfig]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
// Vista previa: renderiza una plantilla (la del body, para reflejar ediciones sin guardar) con datos de ejemplo.
exports.preview = async (req, res) => {
  try {
    const { asunto, cuerpo } = req.body || {};
    const conf = await getCobranzaConfig();
    const vars = { trato: 'Estimada', nombre: 'Sara Fuentes Toro', numero: '2606009', dias: 7, cuotas: 3, monto: '1.347.825', datos: conf.datos_transferencia };
    res.json({ success: true, data: { asunto: rellenar(asunto || '', vars), html: emailHTMLCobranza(rellenar(cuerpo || '', vars)) }, error: null });
  } catch (e) { console.error('[mora preview]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
// Corre el motor a demanda. Por defecto DRY-RUN (no envía, solo muestra a quién iría). ?real=1 envía.
exports.correrAhora = async (req, res) => {
  try {
    const real = req.query.real === '1';
    if (!real) {   // PRUEBA: síncrono, no envía, devuelve el detalle
      const r = await procesar({ dryRun: true });
      return res.json({ success: true, data: r, error: null });
    }
    // REAL: corre en segundo plano (con la pausa entre correos no cuelga el request) y responde de inmediato.
    procesar({ dryRun: false })
      .then(r => console.log('[mora correrAhora] real listo', JSON.stringify(r)))
      .catch(e => console.error('[mora correrAhora] real error', e.message));
    res.json({ success: true, data: { ok: true, lanzado: true, msg: 'Corrida iniciada en segundo plano. Los correos se envían espaciados; revisa el resultado en "envíos últimos 7 días".' }, error: null });
  } catch (e) { console.error('[mora correrAhora]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
