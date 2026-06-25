'use strict';
/* ════════════════════════════════════════════════════════════════
   CORREOS PROGRAMADOS — envíos automáticos por horario (cron propio).
   Cada correo se activa/suspende desde el mantenedor. El scheduler corre
   cada 60s y dispara los activos cuyo horario (hora Chile + día) coincide,
   con dedup diario (no reenvía el mismo día).
   ════════════════════════════════════════════════════════════════ */
const pool = require('../../../../shared/config/database');
const { enviarCorreo, cuentasRemitente, remitentePorClave } = require('../../../../shared/mailer');

const APP_URL = (process.env.APP_URL || 'https://credit-system-45em.onrender.com').replace(/\/+$/, '');
const DIAS_NOMBRE = { '1': 'Lun', '2': 'Mar', '3': 'Mié', '4': 'Jue', '5': 'Vie', '6': 'Sáb', '7': 'Dom' };
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/* ── Migración + seed (Informe Diario de Ventas, DESACTIVADO) ── */
(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS correos_programados (
      codigo VARCHAR(50) PRIMARY KEY,
      nombre VARCHAR(120) NOT NULL,
      descripcion VARCHAR(400),
      hora VARCHAR(5) NOT NULL DEFAULT '08:30',
      dias VARCHAR(20) NOT NULL DEFAULT '1,2,3,4,5,6',
      destinatarios TEXT,
      activo TINYINT(1) NOT NULL DEFAULT 0,
      ultimo_envio DATETIME DEFAULT NULL,
      ultimo_envio_fecha VARCHAR(10) DEFAULT NULL,
      ultimo_estado VARCHAR(250) DEFAULT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
    // Cuenta remitente ("Desde") por correo — evita enviar desde la cuenta equivocada.
    try { await pool.query("ALTER TABLE correos_programados ADD COLUMN IF NOT EXISTS remitente VARCHAR(20) NOT NULL DEFAULT 'sistema'"); } catch (_) {}
    await pool.query(
      `INSERT IGNORE INTO correos_programados (codigo, nombre, descripcion, hora, dias, destinatarios, activo)
       VALUES (?,?,?,?,?,?,0)`,
      ['informe_ventas_diario', 'Informe Diario de Ventas',
        'Créditos otorgados acumulados del mes por Ejecutivo Comercial, ordenados de mayor a menor cantidad de operaciones.',
        '08:30', '1,2,3,4,5,6',
        'grupo.comercial@autofacilchile.cl, operaciones@autofacilchile.cl, validacion@autofacilchile.cl']);
    // Registrar el mantenedor en el menú (funcionalidad) si no existe
    const [[ex]] = await pool.query("SELECT 1 ok FROM funcionalidades WHERE codigo='mantenedores_correos_programados' LIMIT 1");
    if (!ex) await pool.query(
      `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
       VALUES (30001, 'Correos Programados', 'mantenedores_correos_programados', '/mantenedores/correos-programados/', 'bi-envelope-at')`);
    console.log('[correos-programados] tabla OK');
  } catch (e) { console.error('[correos-programados migration]', e.message); }
})();

/* ── Helpers ── */
const fmt = n => '$' + Math.round(Number(n) || 0).toLocaleString('es-CL');
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
// Clave de dedup tolerante al orden nombre/apellido: "BARBAS BRANDON" == "BRANDON BARBAS".
const keyEj = s => norm(s).split(' ').filter(Boolean).sort().join(' ');
const titulo = s => String(s || '').toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Partes de fecha/hora en zona horaria de Chile (independiente del TZ del servidor).
function chileParts(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'long', hour12: false,
  }).formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
  const iso = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7 }[p.weekday];
  return { fecha: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`, dow: iso, year: +p.year, month: +p.month, day: +p.day };
}

/* ── Reporte: Informe Diario de Ventas ── */
async function buildInformeVentas() {
  const ch = chileParts();
  const mesStr = `${ch.year}-${String(ch.month).padStart(2, '0')}`;
  const [rows] = await pool.query(
    `SELECT ejecutivo, financiera, COUNT(*) ops, COALESCE(SUM(monto_financiado),0) monto
       FROM creditos
      WHERE estado_credito='OTORGADO' AND DATE_FORMAT(fecha_otorgado,'%Y-%m')=?
        AND ejecutivo IS NOT NULL AND ejecutivo <> ''
      GROUP BY ejecutivo, financiera`, [mesStr]);
  const [usr] = await pool.query(
    `SELECT CONCAT(u.nombre,' ',u.apellido) AS ejecutivo
       FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
      WHERE p.nombre='Ejecutivo Comercial' AND u.estado='activo'`);

  const map = new Map();
  for (const r of rows) {
    const k = keyEj(r.ejecutivo);
    if (!map.has(k)) map.set(k, { nombre: r.ejecutivo, fins: [], ops: 0, monto: 0 });
    const e = map.get(k);
    e.fins.push({ financiera: r.financiera, ops: Number(r.ops), monto: Number(r.monto) });
    e.ops += Number(r.ops); e.monto += Number(r.monto);
  }
  for (const u of usr) { const k = keyEj(u.ejecutivo); if (!map.has(k)) map.set(k, { nombre: u.ejecutivo, fins: [], ops: 0, monto: 0 }); }
  const lista = [...map.values()].sort((a, b) => b.ops - a.ops || b.monto - a.monto || a.nombre.localeCompare(b.nombre));
  const totalOps = lista.reduce((s, e) => s + e.ops, 0);

  const fechaLarga = new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  const mesNom = MESES[ch.month - 1];
  const acumulado = `Acumulado 1 de ${mesNom} al ${ch.day} de ${mesNom} · ${mesNom} de ${ch.year}`;

  const seccion = (e) => {
    const cero = e.ops === 0;
    const hb = cero ? '#94a3b8' : '#2f6fd0';
    const totBg = cero ? '#f1f5f9' : '#eff6ff';
    const totCol = cero ? '#94a3b8' : '#0f3d8a';
    const th = `color:#fff;padding:7px 12px;font-size:10.5px;font-weight:700;text-transform:uppercase;background:${hb}`;
    const td = 'padding:7px 12px;border-bottom:1px solid #eef2f7;color:#334155';
    const fins = cero
      ? `<tr><td style="${td}color:#94a3b8">—</td><td style="${td};text-align:center;color:#94a3b8">0</td><td style="${td};text-align:right;color:#94a3b8">$0</td></tr>`
      : e.fins.slice().sort((a, b) => b.ops - a.ops || b.monto - a.monto).map(f =>
        `<tr><td style="${td}">${esc(f.financiera || '—')}</td><td style="${td};text-align:center;color:#1d4ed8;font-weight:700">${f.ops}</td><td style="${td};text-align:right">${fmt(f.monto)}</td></tr>`).join('');
    return `
    <div style="margin-bottom:20px">
      <div style="border-left:4px solid ${cero ? '#cbd5e1' : '#0141A2'};padding-left:10px;font-weight:800;color:${cero ? '#94a3b8' : '#0f172a'};font-size:14px;margin-bottom:8px">
        ${esc(titulo(e.nombre))}${cero ? ' <span style="font-weight:600;color:#94a3b8;font-size:11.5px">(sin otorgados)</span>' : ''}
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12.5px">
        <thead><tr>
          <th style="${th};text-align:left">Financiera</th>
          <th style="${th};text-align:center">Otorgados</th>
          <th style="${th};text-align:right">Monto Financiado</th>
        </tr></thead>
        <tbody>${fins}
          <tr>
            <td style="padding:7px 12px;font-weight:800;color:${totCol};background:${totBg}">Total Ejecutivo</td>
            <td style="padding:7px 12px;text-align:center;font-weight:800;color:${totCol};background:${totBg}">${e.ops}</td>
            <td style="padding:7px 12px;text-align:right;font-weight:800;color:${totCol};background:${totBg}">${fmt(e.monto)}</td>
          </tr>
        </tbody>
      </table>
    </div>`;
  };

  const html = `
  <div style="background:#eef2f7;padding:24px 12px;font-family:'Segoe UI',Arial,sans-serif">
    <div style="max-width:620px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 8px 28px rgba(2,32,82,.08)">
      <div style="padding:18px 28px 12px;background:#fff">
        <img src="${APP_URL}/img/logo.png" alt="AutoFácil" height="34" style="height:34px;width:auto;display:block">
      </div>
      <div style="background:#0a1c3e;color:#fff;padding:18px 28px">
        <div style="font-size:18px;font-weight:800;letter-spacing:.2px">Informe Diario de Ventas</div>
        <div style="font-size:13px;color:#cbd5e1;margin-top:4px;text-transform:capitalize">${esc(fechaLarga)}</div>
        <div style="font-size:11.5px;color:#8fa3c4;margin-top:2px">${esc(acumulado)}</div>
      </div>
      <div style="padding:20px 28px">
        <p style="font-size:13px;color:#64748b;margin:0 0 4px">A continuación encontrarán las ventas por Ejecutivo Comercial.</p>
        <p style="font-size:13px;color:#334155;font-weight:700;margin:0 0 18px">Cualquier diferencia levantarla al área de operaciones.</p>
        ${lista.map(seccion).join('')}
      </div>
      <div style="padding:14px 28px;border-top:1px solid #f1f5f9;color:#94a3b8;font-size:11px">
        Correo automático de AutoFácil · generado por el sistema.
      </div>
    </div>
  </div>`;

  const dd = String(ch.day).padStart(2, '0'), mm = String(ch.month).padStart(2, '0');
  const asunto = `💰 Informe Diario de Ventas — ${dd}-${mm}-${ch.year} · ${totalOps} créditos acumulados`;
  return { asunto, html, totalOps };
}

const BUILDERS = { informe_ventas_diario: buildInformeVentas };

/* ── Ejecuta y envía un reporte. auto=true marca el dedup diario. ── */
async function ejecutarReporte(r, { auto = false } = {}) {
  const builder = BUILDERS[r.codigo];
  if (!builder) return { ok: false, error: 'Reporte sin generador: ' + r.codigo };
  let built;
  try { built = await builder(); } catch (e) { return { ok: false, error: 'Error generando: ' + e.message }; }
  const to = String(r.destinatarios || '').split(/[,;]/).map(s => s.trim()).filter(Boolean).join(',');
  if (!to) return { ok: false, error: 'Sin destinatarios configurados' };
  const res = await enviarCorreo({ to, from: remitentePorClave(r.remitente), subject: built.asunto, html: built.html });
  const ch = chileParts();
  const estado = res.ok ? `Enviado OK a ${to}` : ('Error: ' + (res.error || ''));
  try {
    if (auto) await pool.query('UPDATE correos_programados SET ultimo_envio=NOW(), ultimo_envio_fecha=?, ultimo_estado=? WHERE codigo=?', [ch.fecha, estado, r.codigo]);
    else await pool.query('UPDATE correos_programados SET ultimo_envio=NOW(), ultimo_estado=? WHERE codigo=?', [estado, r.codigo]);
  } catch (_) {}
  return res;
}

/* ── Scheduler ── */
let _busy = false;
async function tick() {
  if (_busy) return; _busy = true;
  try {
    const ch = chileParts();
    const [reps] = await pool.query('SELECT * FROM correos_programados WHERE activo=1');
    for (const r of reps) {
      if (String(r.hora || '').slice(0, 5) !== ch.hhmm) continue;
      const dias = String(r.dias || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!dias.includes(String(ch.dow))) continue;
      if (r.ultimo_envio_fecha === ch.fecha) continue;       // ya se envió hoy
      console.log('[correos-programados] disparando', r.codigo, ch.fecha, ch.hhmm);
      await ejecutarReporte(r, { auto: true });
    }
  } catch (e) { console.error('[correos tick]', e.message); }
  finally { _busy = false; }
}
setTimeout(tick, 15000);
setInterval(tick, 60000);

/* ── Endpoints ── */
const esAdmin = req => req.usuario && req.usuario.perfil_nombre === 'Administrador';

const listar = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM correos_programados ORDER BY nombre');
    const data = rows.map(r => ({ ...r, dias_label: String(r.dias || '').split(',').map(d => DIAS_NOMBRE[d.trim()] || d).join(' ') }));
    const cuentas = cuentasRemitente().map(c => ({ clave: c.clave, label: c.label }));
    res.json({ success: true, data, cuentas, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const actualizar = async (req, res) => {
  try {
    if (!esAdmin(req)) return res.status(403).json({ success: false, data: null, error: 'Solo Administrador puede configurar correos programados' });
    const { activo, hora, dias, destinatarios, remitente } = req.body || {};
    const sets = [], vals = [];
    if (activo !== undefined) { sets.push('activo=?'); vals.push(activo ? 1 : 0); }
    if (hora !== undefined && /^\d{2}:\d{2}$/.test(hora)) { sets.push('hora=?'); vals.push(hora); }
    if (dias !== undefined) { sets.push('dias=?'); vals.push(String(dias).split(',').map(s => s.trim()).filter(d => /^[1-7]$/.test(d)).join(',')); }
    if (destinatarios !== undefined) { sets.push('destinatarios=?'); vals.push(String(destinatarios || '').trim()); }
    if (remitente !== undefined && cuentasRemitente().some(c => c.clave === remitente)) { sets.push('remitente=?'); vals.push(remitente); }
    if (!sets.length) return res.status(400).json({ success: false, data: null, error: 'Nada que actualizar' });
    vals.push(req.params.codigo);
    await pool.query(`UPDATE correos_programados SET ${sets.join(', ')} WHERE codigo=?`, vals);
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[correos actualizar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const enviarAhora = async (req, res) => {
  try {
    if (!esAdmin(req)) return res.status(403).json({ success: false, data: null, error: 'Solo Administrador' });
    const [[r]] = await pool.query('SELECT * FROM correos_programados WHERE codigo=?', [req.params.codigo]);
    if (!r) return res.status(404).json({ success: false, data: null, error: 'Reporte no encontrado' });
    const result = await ejecutarReporte(r, { auto: false });
    if (!result.ok) return res.status(422).json({ success: false, data: null, error: result.error || 'No se pudo enviar' });
    res.json({ success: true, data: { enviado: true }, error: null });
  } catch (e) { console.error('[correos enviarAhora]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const preview = async (req, res) => {
  try {
    const builder = BUILDERS[req.params.codigo];
    if (!builder) return res.status(404).json({ success: false, data: null, error: 'Reporte sin vista previa' });
    const built = await builder();
    res.json({ success: true, data: { asunto: built.asunto, html: built.html }, error: null });
  } catch (e) { console.error('[correos preview]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { listar, actualizar, enviarAhora, preview };
