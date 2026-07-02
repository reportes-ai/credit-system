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
    // Resumen Ejecutivo Diario con IA (v79.4) — nace desactivado; se activa en el mantenedor.
    await pool.query(
      `INSERT IGNORE INTO correos_programados (codigo, nombre, descripcion, hora, dias, destinatarios, activo)
       VALUES (?,?,?,?,?,?,0)`,
      ['resumen_ejecutivo_ia', 'Resumen Ejecutivo Diario (IA)',
        'Narrativa de gestión generada por IA: ventas de ayer y del mes, cartas por vencer y mora de la cartera. No solo cifras: contexto y alertas.',
        '09:00', '1,2,3,4,5,6', '']);
    try {
      require('../../../../shared/ia').registrarFuncionalidad({
        codigo: 'resumen_ejecutivo', nombre: 'Resumen Ejecutivo Diario',
        descripcion: 'Redacta la narrativa del correo diario de gestión (ventas, cartas, mora)' });
    } catch (_) {}
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

/* ── Reporte: Resumen Ejecutivo Diario (IA) ──
   Junta los datos duros del negocio y le pide a la IA una narrativa corta de
   gestión. Si la IA está apagada o falla, el correo sale igual con las cifras. */
async function buildResumenEjecutivo() {
  const ch = chileParts();
  const mesStr = `${ch.year}-${String(ch.month).padStart(2, '0')}`;
  // "ayer" en Chile (el correo sale en la mañana y comenta el día anterior)
  const ayerD = new Date(`${ch.fecha}T12:00:00`); ayerD.setDate(ayerD.getDate() - 1);
  const ayer = `${ayerD.getFullYear()}-${String(ayerD.getMonth() + 1).padStart(2, '0')}-${String(ayerD.getDate()).padStart(2, '0')}`;

  const [ventasAyer] = await pool.query(
    `SELECT ejecutivo, COUNT(*) ops, COALESCE(SUM(monto_financiado),0) monto
       FROM creditos WHERE estado_credito='OTORGADO' AND DATE(fecha_otorgado)=? AND ejecutivo IS NOT NULL AND ejecutivo<>''
      GROUP BY ejecutivo ORDER BY ops DESC, monto DESC`, [ayer]);
  const [[mes]] = await pool.query(
    `SELECT COUNT(*) ops, COALESCE(SUM(monto_financiado),0) monto
       FROM creditos WHERE estado_credito='OTORGADO' AND DATE_FORMAT(fecha_otorgado,'%Y-%m')=?`, [mesStr]);
  const [[mesAnt]] = await pool.query(
    `SELECT COUNT(*) ops FROM creditos WHERE estado_credito='OTORGADO'
      AND DATE_FORMAT(fecha_otorgado,'%Y-%m')=DATE_FORMAT(DATE_SUB(?, INTERVAL 1 MONTH),'%Y-%m')`, [ch.fecha]);
  // Cartas de aprobación vigentes y las que están al borde del vencimiento
  let vigDias = 5;
  try { const [[v]] = await pool.query("SELECT valor FROM parametros_credito WHERE clave='vigencia_carta_dias' LIMIT 1"); if (v) vigDias = parseInt(v.valor, 10) || 5; } catch (_) {}
  const [[cartas]] = await pool.query(
    `SELECT COUNT(*) vigentes,
            SUM(CASE WHEN DATEDIFF(?, fecha) >= ?-1 THEN 1 ELSE 0 END) por_vencer
       FROM cartas_aprobacion WHERE status='APROBADA' AND COALESCE(otorgado,0)=0 AND desistido_por IS NULL`, [ch.fecha, vigDias]);
  // Mora de la cartera propia (cuotas vencidas impagas)
  const [[mora]] = await pool.query(
    `SELECT COUNT(DISTINCT id_credito) ops, COALESCE(SUM(valor_cuota),0) monto
       FROM cuotas_credito WHERE estado_cuota<>'PAGADA' AND fecha_vencimiento < ?`, [ch.fecha]);
  // Cumpleaños de MAÑANA (para que la gerencia salude)
  const mnnD = new Date(`${ch.fecha}T12:00:00`); mnnD.setDate(mnnD.getDate() + 1);
  const manana = `${mnnD.getFullYear()}-${String(mnnD.getMonth() + 1).padStart(2, '0')}-${String(mnnD.getDate()).padStart(2, '0')}`;
  const [cumples] = await pool.query(
    `SELECT CONCAT_WS(' ', nombre, apellido) nombre FROM usuarios
      WHERE fecha_nacimiento IS NOT NULL AND estado='activo' AND MONTH(fecha_nacimiento)=MONTH(?) AND DAY(fecha_nacimiento)=DAY(?) LIMIT 10`, [manana, manana]);
  // Ritmo por ejecutivo: mes actual vs mes anterior AL MISMO DÍA (detecta caídos)
  const [ejMes] = await pool.query(
    `SELECT ejecutivo, COUNT(*) ops FROM creditos WHERE estado_credito='OTORGADO' AND DATE_FORMAT(fecha_otorgado,'%Y-%m')=? AND ejecutivo<>'' GROUP BY ejecutivo`, [mesStr]);
  const [ejMesAntMismoDia] = await pool.query(
    `SELECT ejecutivo, COUNT(*) ops FROM creditos WHERE estado_credito='OTORGADO'
      AND DATE_FORMAT(fecha_otorgado,'%Y-%m')=DATE_FORMAT(DATE_SUB(?, INTERVAL 1 MONTH),'%Y-%m')
      AND DAY(fecha_otorgado) <= ? AND ejecutivo<>'' GROUP BY ejecutivo`, [ch.fecha, ch.day]);
  // Flujo del embudo por ejecutivo — SOLO mes anterior y mes en curso (la base
  // histórica migrada distorsiona; el análisis de gestión es de corto plazo).
  const mesActualDate = mesStr + '-01';
  const [ejIngresadas] = await pool.query(
    `SELECT ejecutivo, COUNT(*) ops FROM creditos WHERE mes=? AND ejecutivo<>'' GROUP BY ejecutivo`, [mesActualDate]);
  const [ejAprobSinCerrar] = await pool.query(
    `SELECT ejecutivo, COUNT(*) ops FROM creditos WHERE estado_credito='APROBADO'
      AND mes >= DATE_SUB(?, INTERVAL 1 MONTH) AND ejecutivo<>'' GROUP BY ejecutivo ORDER BY ops DESC LIMIT 10`, [mesActualDate]);
  // Solo EJECUTIVOS VIGENTES: filtrar contra usuarios activos (ex-ejecutivos fuera)
  const [usrAct] = await pool.query(
    `SELECT CONCAT(u.nombre,' ',u.apellido) nombre FROM usuarios u WHERE u.estado='activo'`);
  const vigentes = new Set(usrAct.map(u => keyEj(u.nombre)));
  const soloVigentes = rows => rows.filter(r => vigentes.has(keyEj(r.ejecutivo)));
  // Colocaciones por financiera: mes actual vs mes anterior al mismo día
  const [finMes] = await pool.query(
    `SELECT COALESCE(financiera,'—') financiera, COUNT(*) ops, COALESCE(SUM(monto_financiado),0) monto
       FROM creditos WHERE estado_credito='OTORGADO' AND DATE_FORMAT(fecha_otorgado,'%Y-%m')=? GROUP BY financiera ORDER BY ops DESC`, [mesStr]);
  const [finMesAnt] = await pool.query(
    `SELECT COALESCE(financiera,'—') financiera, COUNT(*) ops FROM creditos WHERE estado_credito='OTORGADO'
      AND DATE_FORMAT(fecha_otorgado,'%Y-%m')=DATE_FORMAT(DATE_SUB(?, INTERVAL 1 MONTH),'%Y-%m')
      AND DAY(fecha_otorgado) <= ? GROUP BY financiera`, [ch.fecha, ch.day]);
  // Presupuesto del mes (dashboard_config, mismo del Dashboard; monto en MM$)
  let ppto = null;
  try {
    const [[p]] = await pool.query("SELECT config_value FROM dashboard_config WHERE config_key='presupuesto' LIMIT 1");
    if (p) ppto = (JSON.parse(p.config_value) || []).find(x => x.mes === mesStr) || null;
  } catch (_) {}

  const totAyer = ventasAyer.reduce((s, r) => s + Number(r.ops), 0);
  const montoAyer = ventasAyer.reduce((s, r) => s + Number(r.monto), 0);
  const mapAnt = new Map(soloVigentes(ejMesAntMismoDia).map(r => [keyEj(r.ejecutivo), Number(r.ops)]));
  const mapAct = new Map(soloVigentes(ejMes).map(r => [keyEj(r.ejecutivo), { nombre: r.ejecutivo, ops: Number(r.ops) }]));
  // Unión: incluye también a los que colocaron el mes pasado y este mes llevan 0
  for (const [k, ops] of mapAnt) if (!mapAct.has(k)) { const src = ejMesAntMismoDia.find(r => keyEj(r.ejecutivo) === k); mapAct.set(k, { nombre: src.ejecutivo, ops: 0 }); }
  const ritmoEj = [...mapAct.entries()].map(([k, v]) => ({ ejecutivo: titulo(v.nombre), mes_actual: v.ops, mes_anterior_mismo_dia: mapAnt.get(k) || 0 }))
    .map(x => ({ ...x, variacion: x.mes_actual - x.mes_anterior_mismo_dia }))
    .sort((a, b) => a.variacion - b.variacion);
  const mapFinAnt = new Map(finMesAnt.map(r => [r.financiera, Number(r.ops)]));
  const finanzas = finMes.map(r => ({ financiera: r.financiera, ops: Number(r.ops), monto: Number(r.monto), mes_anterior_mismo_dia: mapFinAnt.get(r.financiera) || 0 }));
  const datos = {
    fecha_ayer: ayer,
    ventas_ayer: { total_creditos: totAyer, monto: montoAyer, por_ejecutivo: ventasAyer.map(r => ({ ejecutivo: titulo(r.ejecutivo), creditos: Number(r.ops), monto: Number(r.monto) })) },
    acumulado_mes: { creditos: Number(mes.ops), monto: Number(mes.monto), dia_del_mes: ch.day },
    mes_anterior_total_creditos: Number(mesAnt.ops),
    presupuesto_mes: ppto ? { creditos: Number(ppto.ops), monto_mm: Number(ppto.monto) } : null,
    colocaciones_por_financiera: finanzas,
    ritmo_ejecutivos_vs_mes_anterior_mismo_dia: ritmoEj,
    ingresadas_a_analisis_mes_por_ejecutivo: soloVigentes(ejIngresadas).map(r => ({ ejecutivo: titulo(r.ejecutivo), ingresadas: Number(r.ops) })).sort((a, b) => a.ingresadas - b.ingresadas),
    aprobados_sin_otorgar_por_ejecutivo: soloVigentes(ejAprobSinCerrar).map(r => ({ ejecutivo: titulo(r.ejecutivo), pendientes: Number(r.ops) })),
    cartas_aprobacion: { vigentes: Number(cartas.vigentes || 0), por_vencer_hoy_o_manana: Number(cartas.por_vencer || 0), vigencia_dias: vigDias },
    mora_cartera: { creditos_en_mora: Number(mora.ops), monto_vencido: Number(mora.monto) },
    cumpleanos_manana: cumples.map(c => titulo(c.nombre)),
  };

  // Narrativa IA (con red de seguridad: si falla, el correo sale igual)
  let narrativa = '';
  try {
    const { analizar } = require('../../../../shared/anthropic');
    const r = await analizar({
      codigo: 'resumen_ejecutivo',
      system: 'Eres el analista de gestión de AutoFácil (crédito automotriz, Chile). Redacta un resumen ejecutivo BREVE del día para la gerencia: 3 a 5 párrafos cortos en español chileno profesional. Cubre: (1) ventas de ayer, destacando ejecutivos; (2) ritmo del mes por financiera vs mes anterior al mismo día y avance vs presupuesto (presupuesto_mes.monto_mm está en MILLONES de pesos); (3) gestión comercial: qué ejecutivo viene CAÍDO vs el mes pasado al mismo día, quién ha ingresado menos operaciones a análisis y quién acumula aprobados sin otorgar (nómbralos con tino, en tono de gestión, no de funa). Los datos ya vienen acotados al mes pasado y lo que va del mes, y SOLO con ejecutivos vigentes — no menciones a nadie fuera de esas listas; (4) alertas accionables (cartas por vencer, mora) solo si ameritan; (5) si hay cumpleaños mañana, ciérralo con una línea amable recordándolo. Montos en pesos chilenos con separador de miles (punto). Sin saludos ni despedidas ni markdown: devuelve HTML simple usando solo <p> y <b>.',
      prompt: 'Datos del negocio:\n' + JSON.stringify(datos, null, 2),
      max_tokens: 1100,
    });
    narrativa = String(r.texto || '').trim();
  } catch (e) { console.error('[resumen ejecutivo IA]', e.message); }
  if (!narrativa) narrativa = `<p>Ayer se otorgaron <b>${totAyer}</b> créditos por <b>${fmt(montoAyer)}</b>. El mes acumula <b>${datos.acumulado_mes.creditos}</b> operaciones (mes anterior completo: ${datos.mes_anterior_total_creditos}).</p>`;

  const kpi = (label, valor, sub) => `
    <td style="padding:12px 10px;background:#f8fafc;border-radius:10px;text-align:center">
      <div style="font-size:10.5px;color:#64748b;text-transform:uppercase;font-weight:700">${label}</div>
      <div style="font-size:20px;font-weight:800;color:#0f3d8a;margin-top:2px">${valor}</div>
      ${sub ? `<div style="font-size:10.5px;color:#94a3b8;margin-top:1px">${sub}</div>` : ''}
    </td>`;
  const fechaLarga = new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  const filasEj = ventasAyer.length
    ? ventasAyer.map(r => `<tr><td style="padding:6px 12px;border-bottom:1px solid #eef2f7;color:#334155">${esc(titulo(r.ejecutivo))}</td><td style="padding:6px 12px;border-bottom:1px solid #eef2f7;text-align:center;font-weight:700;color:#1d4ed8">${r.ops}</td><td style="padding:6px 12px;border-bottom:1px solid #eef2f7;text-align:right">${fmt(r.monto)}</td></tr>`).join('')
    : `<tr><td colspan="3" style="padding:10px 12px;color:#94a3b8;text-align:center">Sin créditos otorgados ayer</td></tr>`;

  const html = `
  <div style="background:#eef2f7;padding:24px 12px;font-family:'Segoe UI',Arial,sans-serif">
    <div style="max-width:620px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 8px 28px rgba(2,32,82,.08)">
      <div style="padding:18px 28px 12px;background:#fff">
        <img src="${APP_URL}/img/logo.png" alt="AutoFácil" height="34" style="height:34px;width:auto;display:block">
      </div>
      <div style="background:#012d70;background:linear-gradient(135deg,#012d70,#0141A2 50%,#009AFE);color:#fff;padding:18px 28px">
        <div style="font-size:18px;font-weight:800;letter-spacing:.2px">Resumen Ejecutivo Diario</div>
        <div style="font-size:13px;color:#cbd5e1;margin-top:4px;text-transform:capitalize">${esc(fechaLarga)}</div>
        <div style="font-size:11px;color:#8fa3c4;margin-top:2px">Redactado con ${narrativa && narrativa.includes('<p>') ? 'Inteligencia Artificial sobre' : ''} datos en vivo del sistema</div>
      </div>
      <div style="padding:20px 28px">
        <div style="font-size:13.5px;color:#1e293b;line-height:1.65">${narrativa}</div>
        <table style="width:100%;border-collapse:separate;border-spacing:6px;margin:16px 0 6px"><tr>
          ${kpi('Créditos ayer', String(totAyer), fmt(montoAyer))}
          ${kpi('Acumulado mes', String(datos.acumulado_mes.creditos), fmt(datos.acumulado_mes.monto))}
          ${kpi('Cartas por vencer', String(datos.cartas_aprobacion.por_vencer_hoy_o_manana), `${datos.cartas_aprobacion.vigentes} vigentes`)}
          ${kpi('Créditos en mora', String(datos.mora_cartera.creditos_en_mora), fmt(datos.mora_cartera.monto_vencido) + ' vencido')}
        </tr></table>
        <div style="font-weight:800;color:#0f172a;font-size:13px;margin:14px 0 8px;border-left:4px solid #0141A2;padding-left:10px">Ventas de ayer por ejecutivo</div>
        <table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <thead><tr>
            <th style="color:#fff;padding:7px 12px;font-size:10.5px;font-weight:700;text-transform:uppercase;background:#2f6fd0;text-align:left">Ejecutivo</th>
            <th style="color:#fff;padding:7px 12px;font-size:10.5px;font-weight:700;text-transform:uppercase;background:#2f6fd0;text-align:center">Otorgados</th>
            <th style="color:#fff;padding:7px 12px;font-size:10.5px;font-weight:700;text-transform:uppercase;background:#2f6fd0;text-align:right">Monto</th>
          </tr></thead>
          <tbody>${filasEj}</tbody>
        </table>
        <div style="font-weight:800;color:#0f172a;font-size:13px;margin:18px 0 8px;border-left:4px solid #0141A2;padding-left:10px">Colocaciones por financiera — ${esc(MESES[ch.month - 1])} (vs mes anterior al día ${ch.day})</div>
        <table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <thead><tr>
            <th style="color:#fff;padding:7px 12px;font-size:10.5px;font-weight:700;text-transform:uppercase;background:#2f6fd0;text-align:left">Financiera</th>
            <th style="color:#fff;padding:7px 12px;font-size:10.5px;font-weight:700;text-transform:uppercase;background:#2f6fd0;text-align:center">Mes actual</th>
            <th style="color:#fff;padding:7px 12px;font-size:10.5px;font-weight:700;text-transform:uppercase;background:#2f6fd0;text-align:center">Mes ant. (mismo día)</th>
            <th style="color:#fff;padding:7px 12px;font-size:10.5px;font-weight:700;text-transform:uppercase;background:#2f6fd0;text-align:right">Monto</th>
          </tr></thead>
          <tbody>
            ${finanzas.map(f => { const dif = f.ops - f.mes_anterior_mismo_dia; const c = dif >= 0 ? '#16a34a' : '#dc2626'; return `<tr><td style="padding:6px 12px;border-bottom:1px solid #eef2f7;color:#334155">${esc(f.financiera)}</td><td style="padding:6px 12px;border-bottom:1px solid #eef2f7;text-align:center;font-weight:700;color:#1d4ed8">${f.ops}</td><td style="padding:6px 12px;border-bottom:1px solid #eef2f7;text-align:center;color:#64748b">${f.mes_anterior_mismo_dia} <span style="color:${c};font-weight:700">(${dif >= 0 ? '+' : ''}${dif})</span></td><td style="padding:6px 12px;border-bottom:1px solid #eef2f7;text-align:right">${fmt(f.monto)}</td></tr>`; }).join('')}
            ${ppto ? `<tr><td style="padding:7px 12px;font-weight:800;color:#0f3d8a;background:#eff6ff">Presupuesto del mes</td><td style="padding:7px 12px;text-align:center;font-weight:800;color:#0f3d8a;background:#eff6ff">${Number(ppto.ops)} ops <span style="font-weight:600;color:#64748b">(avance ${Math.round(datos.acumulado_mes.creditos / Number(ppto.ops) * 100)}%)</span></td><td style="padding:7px 12px;background:#eff6ff"></td><td style="padding:7px 12px;text-align:right;font-weight:800;color:#0f3d8a;background:#eff6ff">MM ${fmt(Number(ppto.monto))} <span style="font-weight:600;color:#64748b">(${Math.round(datos.acumulado_mes.monto / (Number(ppto.monto) * 1000000) * 100)}%)</span></td></tr>` : ''}
          </tbody>
        </table>
        ${datos.cumpleanos_manana.length ? `<div style="margin-top:16px;background:#fff8e6;border:1px solid #fde68a;border-radius:10px;padding:10px 14px;font-size:12.5px;color:#7a5b00">🎂 <b>Cumpleaños de mañana:</b> ${datos.cumpleanos_manana.map(esc).join(', ')} — ¡no olviden saludar!</div>` : ''}
      </div>
      <div style="padding:14px 28px;border-top:1px solid #f1f5f9;color:#94a3b8;font-size:11px">
        Correo automático de AutoFácil · cifras del sistema al momento del envío.
      </div>
    </div>
  </div>`;

  const dd = String(ch.day).padStart(2, '0'), mm = String(ch.month).padStart(2, '0');
  const asunto = `📊 Resumen Ejecutivo — ${dd}-${mm}-${ch.year} · ${totAyer} otorgados ayer, ${datos.acumulado_mes.creditos} en el mes`;
  return { asunto, html };
}

const BUILDERS = { informe_ventas_diario: buildInformeVentas, resumen_ejecutivo_ia: buildResumenEjecutivo };

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
