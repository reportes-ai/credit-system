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
require('../../../../shared/migrate').enFila('correos', async () => {
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
    // Alerta de Penetración de Seguros AutoFin (v94.5) — nace desactivado.
    await pool.query(
      `INSERT IGNORE INTO correos_programados (codigo, nombre, descripcion, hora, dias, destinatarios, activo)
       VALUES (?,?,?,?,?,?,0)`,
      ['alerta_penetracion_seguros', 'Alerta Penetración de Seguros (AutoFin)',
        'Avisa cuando la penetración de algún seguro cae bajo el tramo del 40% de comisión (y cuando se recupera): estado por seguro, ejecutivos que no cumplen y cuánto se deja de ganar vs el 40%. Se evalúa a diario pero solo se envía al CAMBIAR de estado.',
        '08:45', '1,2,3,4,5,6', '']);
    // Informe de Salud del Sistema (v111.2) — semanal, chequeos automaticos + recordatorio de rutina manual.
    await pool.query(
      `INSERT IGNORE INTO correos_programados (codigo, nombre, descripcion, hora, dias, destinatarios, activo)
       VALUES (?,?,?,?,?,?,1)`,
      ['informe_salud_sistema', 'Informe de Salud del Sistema',
        'Chequeo semanal automatico: BD (ping, tamano, migraciones fallidas), frescura de indicadores (UF/tasas/dolar), correos programados con error y memoria del proceso. Incluye el recordatorio de la rutina manual (Render Metrics, TiDB SQL Statements, backups).',
        '08:00', '1', 'patricio.escobar@autofacilchile.cl']);
    // Registrar el mantenedor en el menú (funcionalidad) si no existe
    const [[ex]] = await pool.query("SELECT 1 ok FROM funcionalidades WHERE codigo='mantenedores_correos_programados' LIMIT 1");
    if (!ex) await pool.query(
      `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
       VALUES (30001, 'Correos Programados', 'mantenedores_correos_programados', '/mantenedores/correos-programados/', 'bi-envelope-at')`);
    console.log('[correos-programados] tabla OK');
  } catch (e) { console.error('[correos-programados migration]', e.message); }
});

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
    `SELECT TRIM(CONCAT(SUBSTRING_INDEX(TRIM(u.nombre),' ',1),' ',SUBSTRING_INDEX(TRIM(u.apellido),' ',1))) AS ejecutivo
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
    `SELECT TRIM(CONCAT(SUBSTRING_INDEX(TRIM(u.nombre),' ',1),' ',SUBSTRING_INDEX(TRIM(u.apellido),' ',1))) nombre FROM usuarios u WHERE u.estado='activo'`);
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
  // Seguros AutoFin: tramo del mes y CAMBIO DE TRAMO desde el último resumen
  let seguros = null;
  try {
    const dseg = await datosPenSeguros();
    const KEYR = 'seg_pen_tramo_resumen';
    let prevT = null;
    try { const [[row]] = await pool.query('SELECT config_value FROM dashboard_config WHERE config_key=? LIMIT 1', [KEYR]); if (row) prevT = JSON.parse(row.config_value); } catch (_) {}
    const pctPct = Math.round(dseg.pctActual * 100);
    const cambio = (prevT && prevT.mes === dseg.mesStr && prevT.pct !== pctPct) ? { antes_pct: prevT.pct, ahora_pct: pctPct } : null;
    await pool.query(
      `INSERT INTO dashboard_config (config_key, config_value) VALUES (?,?)
       ON DUPLICATE KEY UPDATE config_value=VALUES(config_value), updated_at=NOW()`,
      [KEYR, JSON.stringify({ mes: dseg.mesStr, pct: pctPct })]).catch(() => {});
    seguros = {
      penetracion_pct: { rdh: dseg.pen.rdh, cesantia: dseg.pen.cesantia, reparaciones: dseg.pen.reparacion },
      pct_comision_mes: pctPct, pct_maximo: Math.round(dseg.pctTop * 100),
      dejamos_de_ganar_vs_maximo: dseg.perdida,
      cambio_de_tramo_desde_ultimo_resumen: cambio,
    };
  } catch (e) { /* sin datos de seguros no bloquea el resumen */ }

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
    seguros_autofin: seguros,
    cumpleanos_manana: cumples.map(c => titulo(c.nombre)),
  };

  // Narrativa IA (con red de seguridad: si falla, el correo sale igual)
  let narrativa = '';
  try {
    const { analizar } = require('../../../../shared/anthropic');
    const r = await analizar({
      codigo: 'resumen_ejecutivo',
      system: 'Eres el analista de gestión de AutoFácil (crédito automotriz, Chile). Redacta un resumen ejecutivo BREVE del día para la gerencia: 3 a 5 párrafos cortos en español chileno profesional. Cubre: (1) ventas de ayer, destacando ejecutivos; (2) ritmo del mes por financiera vs mes anterior al mismo día y avance vs presupuesto (presupuesto_mes.monto_mm está en MILLONES de pesos); (3) gestión comercial: qué ejecutivo viene CAÍDO vs el mes pasado al mismo día, quién ha ingresado menos operaciones a análisis y quién acumula aprobados sin otorgar (nómbralos con tino, en tono de gestión, no de funa). Los datos ya vienen acotados al mes pasado y lo que va del mes, y SOLO con ejecutivos vigentes — no menciones a nadie fuera de esas listas; (4) alertas accionables (cartas por vencer, mora) solo si ameritan; si seguros_autofin.cambio_de_tramo_desde_ultimo_resumen NO es null, destácalo SIEMPRE en un párrafo propio: el % de comisión de seguros AutoFin cambió de tramo (antes_pct → ahora_pct), qué seguro está más débil según penetracion_pct y cuánto dejamos de ganar vs el máximo (dejamos_de_ganar_vs_maximo); si es null no menciones seguros salvo que dejamos_de_ganar_vs_maximo sea relevante; (5) si hay cumpleaños mañana, ciérralo con una línea amable recordándolo. Montos en pesos chilenos con separador de miles (punto). Sin saludos ni despedidas ni markdown: devuelve HTML simple usando solo <p> y <b>.',
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

/* ── Reporte: Alerta Penetración de Seguros AutoFin ──────────────────────────
   Se evalúa a diario, pero SOLO se envía al cambiar de estado en el mes:
   OK→BAJO (algún seguro bajo el tramo 40%) manda la ALERTA; BAJO→OK manda la
   RECUPERACIÓN. El estado vive en dashboard_config (seg_pen_alerta_estado). */
async function datosPenSeguros(mesForzado) {
  const ch = chileParts();
  const mesStr = mesForzado || `${ch.year}-${String(ch.month).padStart(2, '0')}`;
  const { getPenComision } = require('../../../creditos/src/utils/penetracion');
  const [tramos] = await pool.query(
    'SELECT tipo, pen_min, pct_comision FROM comisiones_seguro_penetracion WHERE estado="activo" ORDER BY tipo, pen_min');
  // Umbral del tramo TOP (40%) por seguro, y % top — paramétricos
  const topDe = tipo => {
    const filas = tramos.filter(t => t.tipo === tipo);
    if (!filas.length) return { pen: 100, pct: 0.40 };
    const best = filas.reduce((a, b) => +a.pct_comision > +b.pct_comision ? a : b);
    return { pen: +best.pen_min, pct: +best.pct_comision / 100 };
  };
  const U = { rdh: topDe('rdh'), cesantia: topDe('cesantia'), reparacion: topDe('reparacion') };
  const pctTop = Math.max(U.rdh.pct, U.cesantia.pct, U.reparacion.pct);

  const [ops] = await pool.query(`
    SELECT ejecutivo,
           (COALESCE(seguro_rdh,0)>0) tr, (COALESCE(seguro_cesantia,0)>0) tc, (COALESCE(seguro_rep_menor,0)>0) tp,
           COALESCE(seguro_rdh,0) pr, COALESCE(seguro_cesantia,0) pc, COALESCE(seguro_rep_menor,0) pp
    FROM creditos
    WHERE DATE_FORMAT(mes,'%Y-%m')=? AND UPPER(COALESCE(financiera,'')) LIKE '%AUTOFIN%' AND estado IN ('OTORGADO','APROBADO')`, [mesStr]);
  const n = ops.length;
  const pct100 = (a, b) => b ? Math.round(1000 * a / b) / 10 : 0;
  const pen = {
    rdh: pct100(ops.filter(o => +o.tr).length, n),
    cesantia: pct100(ops.filter(o => +o.tc).length, n),
    reparacion: pct100(ops.filter(o => +o.tp).length, n),
  };
  const primas = {
    rdh: ops.reduce((s, o) => s + +o.pr, 0),
    cesantia: ops.reduce((s, o) => s + +o.pc, 0),
    reparacion: ops.reduce((s, o) => s + +o.pp, 0),
  };
  const pctActual = n ? Math.min(
    getPenComision('rdh', pen.rdh, tramos),
    getPenComision('cesantia', pen.cesantia, tramos),
    getPenComision('reparacion', pen.reparacion, tramos)) : pctTop;

  // Ejecutivos que NO cumplen el umbral 40% en algún seguro (con sus ops del mes)
  const porEj = new Map();
  for (const o of ops) {
    const k = keyEj(o.ejecutivo || 'SIN EJECUTIVO');
    if (!porEj.has(k)) porEj.set(k, { nombre: o.ejecutivo || 'Sin ejecutivo', n: 0, r: 0, c: 0, p: 0 });
    const e = porEj.get(k);
    e.n++; e.r += +o.tr; e.c += +o.tc; e.p += +o.tp;
  }
  const incumplen = [...porEj.values()].map(e => ({
    nombre: titulo(e.nombre), ops: e.n,
    rdh: pct100(e.r, e.n), cesantia: pct100(e.c, e.n), reparacion: pct100(e.p, e.n),
  })).filter(e => e.rdh < U.rdh.pen || e.cesantia < U.cesantia.pen || e.reparacion < U.reparacion.pen)
    .sort((a, b) => (a.rdh + a.cesantia + a.reparacion) - (b.rdh + b.cesantia + b.reparacion));

  const totalPrimas = primas.rdh + primas.cesantia + primas.reparacion;
  return {
    mesStr, mesNom: MESES[parseInt(mesStr.slice(5, 7), 10) - 1], n, pen, primas, U, pctTop, pctActual,
    bajo: n > 0 && pctActual < pctTop,
    ingActual: Math.round(totalPrimas * pctActual),
    ingTop: Math.round(totalPrimas * pctTop),
    perdida: Math.round(totalPrimas * (pctTop - pctActual)),
    incumplen,
  };
}

async function buildAlertaPenetracion(opts = {}) {
  const d = await datosPenSeguros(opts.mes);
  const KEY = 'seg_pen_alerta_estado';
  let prev = null;
  try {
    const [[row]] = await pool.query('SELECT config_value FROM dashboard_config WHERE config_key=? LIMIT 1', [KEY]);
    if (row) prev = JSON.parse(row.config_value);
  } catch (_) {}
  const estadoActual = d.bajo ? 'BAJO' : 'OK';
  const guardar = () => pool.query(
    `INSERT INTO dashboard_config (config_key, config_value) VALUES (?,?)
     ON DUPLICATE KEY UPDATE config_value=VALUES(config_value), updated_at=NOW()`,
    [KEY, JSON.stringify({ estado: estadoActual, mes: d.mesStr })]).catch(() => {});

  let variante = opts.variante; // 'ALERTA' | 'RECUPERACION' (preview/ejemplos)
  if (!variante) {
    const mismoMes = prev && prev.mes === d.mesStr;
    if (!opts.forzar) {
      if (mismoMes && prev.estado === estadoActual) return { skip: true, estado: 'Sin cambios (' + estadoActual + ')' };
      if (!mismoMes && estadoActual === 'OK') { await guardar(); return { skip: true, estado: 'Mes parte en OK — sin aviso' }; }
    }
    variante = estadoActual === 'BAJO' ? 'ALERTA' : 'RECUPERACION';
    await guardar();
  }

  const esAlerta = variante === 'ALERTA';
  const pF = v => Number(v).toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
  const segRow = (nombre, pv, u, prima) => {
    const ok = pv >= u.pen;
    return `<tr>
      <td style="padding:7px 12px;border-bottom:1px solid #eef2f7;color:#334155;font-weight:700">${nombre}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #eef2f7;text-align:center;font-weight:800;color:${ok ? '#16a34a' : '#dc2626'}">${pF(pv)} ${ok ? '✅' : '⚠️'}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #eef2f7;text-align:center;color:#64748b">≥ ${pF(u.pen)}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #eef2f7;text-align:right">${fmt(prima)}</td>
    </tr>`;
  };
  const filasEj = d.incumplen.length ? d.incumplen.map(e => `
    <tr>
      <td style="padding:6px 12px;border-bottom:1px solid #eef2f7;color:#334155">${esc(e.nombre)}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eef2f7;text-align:center;color:#64748b">${e.ops}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eef2f7;text-align:center;font-weight:700;color:${e.rdh >= d.U.rdh.pen ? '#16a34a' : '#dc2626'}">${pF(e.rdh)}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eef2f7;text-align:center;font-weight:700;color:${e.cesantia >= d.U.cesantia.pen ? '#16a34a' : '#dc2626'}">${pF(e.cesantia)}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eef2f7;text-align:center;font-weight:700;color:${e.reparacion >= d.U.reparacion.pen ? '#16a34a' : '#dc2626'}">${pF(e.reparacion)}</td>
    </tr>`).join('')
    : '<tr><td colspan="5" style="padding:10px 12px;color:#94a3b8;text-align:center">Todos los ejecutivos cumplen el umbral del 40%</td></tr>';

  const headBg = esAlerta ? 'linear-gradient(135deg,#7f1d1d,#b91c1c)' : 'linear-gradient(135deg,#14532d,#16a34a)';
  const tituloMail = esAlerta ? '⚠️ Penetración de seguros bajo el 40%' : '✅ Penetración de seguros recuperada — volvimos al 40%';
  const intro = esAlerta
    ? `La penetración de seguros AutoFin de <b>${d.mesNom}</b> cayó del tramo máximo: este mes AutoFin nos está pagando el <b>${Math.round(d.pctActual * 100)}%</b> de las primas en vez del <b>${Math.round(d.pctTop * 100)}%</b>. Cada operación que salga sin seguros nos cuesta comisión de TODO el mes.`
    : `Buenas noticias: la penetración de seguros AutoFin de <b>${d.mesNom}</b> volvió al tramo máximo — AutoFin nos paga el <b>${Math.round(d.pctTop * 100)}%</b> de las primas. A mantenerlo hasta el cierre.`;

  const cuadro = `
    <table style="width:100%;border-collapse:separate;border-spacing:6px;margin:14px 0 4px"><tr>
      <td style="padding:12px 10px;background:#f8fafc;border-radius:10px;text-align:center">
        <div style="font-size:10.5px;color:#64748b;text-transform:uppercase;font-weight:700">Como estamos (${Math.round(d.pctActual * 100)}%)</div>
        <div style="font-size:20px;font-weight:800;color:${esAlerta ? '#b91c1c' : '#166534'};margin-top:2px">${fmt(d.ingActual)}</div>
      </td>
      <td style="padding:12px 10px;background:#f8fafc;border-radius:10px;text-align:center">
        <div style="font-size:10.5px;color:#64748b;text-transform:uppercase;font-weight:700">Ganaríamos al ${Math.round(d.pctTop * 100)}%</div>
        <div style="font-size:20px;font-weight:800;color:#0f3d8a;margin-top:2px">${fmt(d.ingTop)}</div>
      </td>
      <td style="padding:12px 10px;background:${esAlerta ? '#fef2f2' : '#f0fdf4'};border-radius:10px;text-align:center">
        <div style="font-size:10.5px;color:#64748b;text-transform:uppercase;font-weight:700">${esAlerta ? 'Dejamos de ganar' : 'Diferencia'}</div>
        <div style="font-size:20px;font-weight:800;color:${esAlerta ? '#b91c1c' : '#166534'};margin-top:2px">${fmt(d.perdida)}</div>
      </td>
    </tr></table>`;

  const th = 'color:#fff;padding:7px 12px;font-size:10.5px;font-weight:700;text-transform:uppercase;background:#2f6fd0';
  const html = `
  <div style="background:#eef2f7;padding:24px 12px;font-family:'Segoe UI',Arial,sans-serif">
    <div style="max-width:620px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 8px 28px rgba(2,32,82,.08)">
      <div style="padding:18px 28px 12px;background:#fff">
        <img src="${APP_URL}/img/logo.png" alt="AutoFácil" height="34" style="height:34px;width:auto;display:block">
      </div>
      <div style="background:${headBg};color:#fff;padding:18px 28px">
        <div style="font-size:18px;font-weight:800;letter-spacing:.2px">${tituloMail}</div>
        <div style="font-size:12px;color:rgba(255,255,255,.8);margin-top:4px;text-transform:capitalize">${esc(d.mesNom)} · ${d.n} operaciones cursadas AutoFin</div>
      </div>
      <div style="padding:20px 28px">
        <p style="font-size:13.5px;color:#1e293b;line-height:1.6;margin:0 0 8px">${intro}</p>
        ${cuadro}
        <div style="font-weight:800;color:#0f172a;font-size:13px;margin:14px 0 8px;border-left:4px solid #0141A2;padding-left:10px">Penetración del mes por seguro</div>
        <table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <thead><tr><th style="${th};text-align:left">Seguro</th><th style="${th};text-align:center">Penetración</th><th style="${th};text-align:center">Meta 40%</th><th style="${th};text-align:right">Primas del mes</th></tr></thead>
          <tbody>
            ${segRow('RDH (incl. desgravamen)', d.pen.rdh, d.U.rdh, d.primas.rdh)}
            ${segRow('Cesantía', d.pen.cesantia, d.U.cesantia, d.primas.cesantia)}
            ${segRow('Reparaciones Menores', d.pen.reparacion, d.U.reparacion, d.primas.reparacion)}
          </tbody>
        </table>
        <div style="font-weight:800;color:#0f172a;font-size:13px;margin:18px 0 8px;border-left:4px solid ${esAlerta ? '#b91c1c' : '#0141A2'};padding-left:10px">Ejecutivos bajo el umbral del 40% en algún seguro</div>
        <table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <thead><tr><th style="${th};text-align:left">Ejecutivo</th><th style="${th};text-align:center">Ops</th><th style="${th};text-align:center">RDH</th><th style="${th};text-align:center">Cesantía</th><th style="${th};text-align:center">Reparac.</th></tr></thead>
          <tbody>${filasEj}</tbody>
        </table>
        <p style="font-size:11.5px;color:#94a3b8;margin:14px 0 0">El % del mes lo define el seguro más débil (tramos 20/30/40%). Detalle en Dashboard → 🛡️ Seguros.</p>
      </div>
      <div style="padding:14px 28px;border-top:1px solid #f1f5f9;color:#94a3b8;font-size:11px">
        Correo automático de AutoFácil · se envía solo al cambiar el estado del mes. Se suspende en Mantenedores → Correos Programados.
      </div>
    </div>
  </div>`;

  const asunto = esAlerta
    ? `⚠️ Seguros AutoFin bajo el 40% — dejamos de ganar ${fmt(d.perdida)} en ${d.mesNom}`
    : `✅ Seguros AutoFin de vuelta al 40% — ${d.mesNom} al máximo tramo`;
  return { asunto, html };
}


/* ── Informe de Salud del Sistema (semanal) ─────────────────────────────────
   Todo lo que la app puede chequear SOLA. Lo que requiere ojos (Render Metrics,
   TiDB SQL Statements, backups) va como checklist-recordatorio en el mismo correo. */
async function buildSalud() {
  const checks = [];
  const add = (nombre, ok, detalle) => checks.push({ nombre, ok, detalle });

  // 1. BD viva + tamaño
  try {
    const [[sz]] = await pool.query(
      "SELECT ROUND(SUM(data_length+index_length)/1048576) mb, COUNT(*) tablas FROM information_schema.tables WHERE table_schema=DATABASE()");
    add('Base de datos', true, `responde OK · ${sz.tablas} tablas · ${Number(sz.mb).toLocaleString('es-CL')} MB`);
  } catch (e) { add('Base de datos', false, 'NO RESPONDE: ' + e.message); }

  // 2. Migraciones fallidas / a medias
  try {
    const [m] = await pool.query("SELECT nombre FROM _migraciones WHERE estado<>'OK' LIMIT 10");
    add('Migraciones', !m.length, m.length ? ('pendientes/fallidas: ' + m.map(x => x.nombre).join(', ')) : 'todas OK');
  } catch (_) { add('Migraciones', true, 'sin tabla aún'); }

  // 3. Frescura de indicadores
  try {
    const [[u]] = await pool.query('SELECT DATEDIFF(CURDATE(), MAX(fecha)) d FROM uf');
    add('UF al día', u.d <= 0, u.d <= 0 ? 'cargada hasta hoy o más' : `última UF hace ${u.d} días`);
  } catch (e) { add('UF al día', false, e.message); }
  try {
    const [[t]] = await pool.query('SELECT COUNT(*) n FROM tasas WHERE CURDATE() BETWEEN fecha_desde AND fecha_hasta');
    add('TMC vigente', t.n > 0, t.n > 0 ? 'hay tasa vigente para hoy' : 'SIN tasa vigente (revisar sincronización CMF)');
  } catch (e) { add('TMC vigente', false, e.message); }
  try {
    const [[dd]] = await pool.query('SELECT DATEDIFF(CURDATE(), MAX(fecha)) d FROM dolar');
    add('Dólar', dd.d <= 5, `último valor hace ${dd.d} día(s)`);
  } catch (_) { add('Dólar', true, 'sin tabla'); }

  // 3b. Coherencia de negocio: tasas de crédito en FRACCIÓN (0.028 en vez de 2.8%).
  // Todas las vías de escritura normalizan (motor único normTasaMensualPct), pero si
  // alguna nueva se salta el blindaje, este vigilante lo acusa al día siguiente.
  try {
    const [[tf]] = await pool.query("SELECT COUNT(*) n, GROUP_CONCAT(num_op SEPARATOR ', ') ops FROM (SELECT num_op FROM creditos WHERE tascli_real > 0 AND tascli_real < 0.2 LIMIT 10) x");
    add('Tasas en % mensual', !tf.n, tf.n ? `${tf.n} crédito(s) con tasa en FRACCIÓN (ops: ${tf.ops}) — normalizar ×100` : 'sin tasas en fracción');
  } catch (e) { add('Tasas en % mensual', false, e.message); }

  // 4. Correos programados con error
  try {
    const [ce] = await pool.query("SELECT nombre, ultimo_estado FROM correos_programados WHERE activo=1 AND ultimo_estado LIKE 'Error%'");
    add('Correos programados', !ce.length, ce.length ? ce.map(x => `${x.nombre}: ${x.ultimo_estado}`).join(' · ') : 'sin errores');
  } catch (e) { add('Correos programados', false, e.message); }

  // 5. Gasto IA del mes (Anthropic) — visibilidad de costo
  try {
    const [[ia]] = await pool.query("SELECT ROUND(COALESCE(SUM(costo_usd),0),2) usd, COUNT(*) n FROM ia_uso WHERE fecha>=DATE_FORMAT(CURDATE(),'%Y-%m-01')");
    add('Gasto IA del mes', Number(ia.usd) < 50, `US$ ${ia.usd} en ${ia.n} análisis` + (Number(ia.usd) >= 50 ? ' — sobre US$50: revisar en Mantenedores → IA' : ''));
  } catch (_) { add('Gasto IA del mes', true, 'sin registro'); }

  // 6. Memoria del proceso (límite Render Starter: 512 MB)
  const rss = Math.round(process.memoryUsage().rss / 1048576);
  add('Memoria del servidor', rss < 360, `${rss} MB de 512 MB (${Math.round(rss / 5.12)}%)` + (rss >= 360 ? ' — sobre 70%: considerar subir plan Render' : ''));

  const malos = checks.filter(c => !c.ok);
  const fila = c => `<tr><td style="padding:7px 12px;border-bottom:1px solid #f1f5f9">${c.ok ? '✅' : '🔴'} <b>${c.nombre}</b></td><td style="padding:7px 12px;border-bottom:1px solid #f1f5f9;color:#475569">${c.detalle}</td></tr>`;
  const html = `
  <div style="font-family:Segoe UI,Arial,sans-serif;background:#f6f8fb;padding:22px">
    <div style="max-width:680px;margin:auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
      <div style="background:${malos.length ? '#b91c1c' : '#0f4c81'};color:#fff;padding:16px 28px"><b style="font-size:16px">${malos.length ? '⚠️' : '💙'} Salud del Sistema — ${malos.length ? malos.length + ' alerta(s)' : 'todo en orden'}</b></div>
      <table style="border-collapse:collapse;width:100%;font-size:13px">${checks.map(fila).join('')}</table>
      <div style="padding:14px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12.5px;color:#475569">
        <b>Rutina manual del mes (10 min)</b> — lo que la app no puede ver sola:<br>
        1. <a href="https://dashboard.render.com">Render → Metrics</a>: memoria base bajo 70%.<br>
        2. <a href="https://tidbcloud.com">TiDB → Diagnosis → SQL Statement</a> (3 días, por Total RU): statements &gt;100K RU → pantallazo a la IA.<br>
        3. <a href="https://github.com/reportes-ai/credit-system/actions">GitHub → Actions → Backup BD nocturno</a>: última corrida verde (GitHub además avisa por correo si falla).<br>
        4. <b>Cada 3 meses</b>: simulacro de restauración — descargar el último backup y restaurarlo en un branch de TiDB (ver Definiciones → "Respaldo de la Base de Datos").<br>
        Guía completa: Mantenedores → Definiciones → "Monitoreo del Sistema".
      </div>
      <div style="padding:12px 28px;border-top:1px solid #f1f5f9;color:#94a3b8;font-size:11px">Correo automático semanal de AutoFácil · se configura en Mantenedores → Correos Programados.</div>
    </div>
  </div>`;
  return { asunto: malos.length ? `⚠️ Salud del Sistema: ${malos.length} alerta(s)` : '💙 Salud del Sistema: todo en orden', html };
}

const BUILDERS = { informe_ventas_diario: buildInformeVentas, resumen_ejecutivo_ia: buildResumenEjecutivo, alerta_penetracion_seguros: buildAlertaPenetracion, informe_salud_sistema: buildSalud };

/* ── Ejecuta y envía un reporte. auto=true marca el dedup diario. ── */
async function ejecutarReporte(r, { auto = false } = {}) {
  const builder = BUILDERS[r.codigo];
  if (!builder) return { ok: false, error: 'Reporte sin generador: ' + r.codigo };
  let built;
  try { built = await builder(auto ? {} : { forzar: true }); } catch (e) { return { ok: false, error: 'Error generando: ' + e.message }; }
  // Reportes por CAMBIO DE ESTADO (ej. penetración de seguros): si no hay cambio, no se envía.
  if (built && built.skip) {
    try { await pool.query('UPDATE correos_programados SET ultimo_estado=? WHERE codigo=?', ['Evaluado, sin envío: ' + (built.estado || 'sin cambios'), r.codigo]); } catch (_) {}
    return { ok: true, skip: true };
  }
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
    // ?variante=ALERTA|RECUPERACION permite previsualizar ambos envíos del reporte de penetración
    const built = await builder({ forzar: true, variante: req.query.variante || undefined, mes: req.query.mes || undefined });
    res.json({ success: true, data: { asunto: built.asunto, html: built.html }, error: null });
  } catch (e) { console.error('[correos preview]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { listar, actualizar, enviarAhora, preview, _buildSalud: buildSalud };
