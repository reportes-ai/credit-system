'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   AVISO DE VENCIMIENTO por WhatsApp (automático) — cartera propia AutoFácil.
   N días antes del vencimiento (default 2) envía la plantilla HSM aprobada
   `aviso_vencimiento` (o `aviso_vencimiento_mora` si además tiene cuotas
   impagas, con el monto AL DÍA calculado por el MOTOR ÚNICO cobranzaFullMap).
   - Nace DESACTIVADO (wsp_config.aviso_venc_activo). Paramétrico: días antes.
   - Las plantillas se crean en Meta desde el propio sistema (quedan PENDING
     hasta que Meta apruebe); solo se envía con plantilla APPROVED.
   - Respeta Modo Desarrollo (no envía a clientes reales → queda SIMULADO).
   - Idempotente: 1 aviso por cuota (UNIQUE id_cuota en wsp_avisos_vencimiento).
   - Cada envío queda como gestión de cobranza en el CRM.
   ───────────────────────────────────────────────────────────────────────── */
const pool = require('../../../shared/config/database');

const GRAPH = 'https://graph.facebook.com/v21.0';
const TPL_SIMPLE = 'aviso_vencimiento';
const TPL_MORA   = 'aviso_vencimiento_mora';

/* ── Migración ── */
require('../../../shared/migrate').enFila('aviso-vencimiento', async () => {
  try {
    for (const col of ["aviso_venc_activo TINYINT(1) NOT NULL DEFAULT 0", "aviso_venc_dias INT NOT NULL DEFAULT 2"]) {
      await pool.query(`ALTER TABLE wsp_config ADD COLUMN IF NOT EXISTS ${col}`);
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wsp_avisos_vencimiento (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_cuota INT NOT NULL UNIQUE,
        id_credito INT NOT NULL,
        rut VARCHAR(15) NULL, nombre VARCHAR(160) NULL, telefono VARCHAR(20) NULL,
        numero_cuota INT NULL, fecha_vencimiento DATE NULL,
        monto_cuota DECIMAL(15,2) NULL,
        cuotas_impagas INT NOT NULL DEFAULT 0,
        monto_impagas DECIMAL(15,2) NULL, total_hoy DECIMAL(15,2) NULL,
        plantilla VARCHAR(60) NULL,
        estado VARCHAR(12) NOT NULL,          -- ENVIADO | ERROR | SIMULADO
        error_msg VARCHAR(300) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
    console.log('[aviso-vencimiento] listo (nace desactivado)');
  } catch (e) { console.error('[aviso-vencimiento migration]', e.message); }
});

/* ── Utilidades ── */
const CLP = v => '$' + Math.round(Number(v || 0)).toLocaleString('es-CL');
function hoyChile() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
}
function fechaLarga(iso) {
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00Z');
  return new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(d).replace(',', '');
}
function normTel(t) {
  let d = String(t || '').replace(/\D/g, '');
  if (d.startsWith('56')) d = d.slice(2);
  if (d.length === 9 && d.startsWith('9')) return '56' + d;
  if (d.length === 8) return '569' + d;
  return d.length >= 11 ? d : null;
}
async function getCfg() {
  const [[c]] = await pool.query('SELECT * FROM wsp_config LIMIT 1');
  return c || {};
}
async function wabaId() {
  const c = await getCfg();
  return c.waba_id || '1044493808034066';
}

/* ── Cuerpos de las plantillas (bloque bancario desde la FUENTE ÚNICA) ── */
async function bloqueBanco() {
  try {
    const [[b]] = await pool.query('SELECT * FROM cuentas_bancarias WHERE activo=1 ORDER BY id_cuenta LIMIT 1');
    if (!b) return '';
    return `Agradecemos realizar la transferencia a:\nTitular: ${b.razon_social || b.nombre}\nRUT: ${b.rut}\nBanco: ${b.banco}\n${b.tipo_cuenta}: ${b.numero_cuenta}\nMail: cobranza@autofacilchile.cl`;
  } catch (e) { return ''; }
}
async function cuerposPlantillas() {
  const banco = await bloqueBanco();
  const pie = `Para mayor información acceda a su cuenta de cliente en clientes.autofacilchile.cl\n\n${banco}\n\nSaludos,\nCobranzas AutoFácil\n\nMensaje generado automáticamente.`;
  return {
    [TPL_SIMPLE]: {
      body: `Estimado(a) {{1}}:\n\nJunto con saludarle, le informamos que el día {{2}} vence la cuota N°{{3}} de su crédito automotriz por un monto de {{4}}.\n\n${pie}`,
      ejemplos: ['Juan Pérez Soto', 'jueves 15 de julio', '34', '$340.000'],
    },
    [TPL_MORA]: {
      body: `Estimado(a) {{1}}:\n\nJunto con saludarle, le informamos que el día {{2}} vence la cuota N°{{3}} de su crédito automotriz por un monto de {{4}}.\n\nAprovechamos de recordarle que a la fecha mantiene {{5}} cuota(s) impaga(s) por un monto al día de hoy de {{6}}, lo que sumado a la cuota por vencer suma {{7}} al día de hoy.\n\n${pie}`,
      ejemplos: ['Juan Pérez Soto', 'jueves 15 de julio', '34', '$340.000', '2', '$715.000', '$1.055.000'],
    },
  };
}

/* ── Estado/creación de las plantillas en Meta ── */
async function estadoPlantillas() {
  const token = process.env.WSP_TOKEN;
  if (!token) return { conectado: false, [TPL_SIMPLE]: 'SIN CONEXIÓN', [TPL_MORA]: 'SIN CONEXIÓN' };
  const r = await fetch(`${GRAPH}/${await wabaId()}/message_templates?limit=100&fields=name,status,language`, {
    headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || 'Error de Meta');
  const est = n => (j.data || []).find(t => t.name === n)?.status || 'NO EXISTE';
  return { conectado: true, [TPL_SIMPLE]: est(TPL_SIMPLE), [TPL_MORA]: est(TPL_MORA) };
}
async function crearPlantillas() {
  const token = process.env.WSP_TOKEN;
  if (!token) throw new Error('Sin conexión Meta (WSP_TOKEN)');
  const cuerpos = await cuerposPlantillas();
  const estados = await estadoPlantillas();
  const out = {};
  for (const nombre of [TPL_SIMPLE, TPL_MORA]) {
    if (estados[nombre] !== 'NO EXISTE') { out[nombre] = estados[nombre]; continue; }
    const c = cuerpos[nombre];
    const r = await fetch(`${GRAPH}/${await wabaId()}/message_templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({
        name: nombre, language: 'es', category: 'UTILITY',
        components: [{ type: 'BODY', text: c.body, example: { body_text: [c.ejemplos] } }],
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${nombre}: ${j.error?.error_user_msg || j.error?.message || 'error Meta'}`);
    out[nombre] = j.status || 'PENDING';
  }
  return out;
}

/* ── Candidatos del día: cuotas que vencen dentro de la VENTANA [hoy .. hoy+N días]
   (impagas, sin aviso previo). Es un RANGO, no un día exacto: si el día -N cayó
   domingo/feriado y no se envió, se recupera el siguiente día hábil (-N+1, -N+2…);
   y como es 1 aviso por cuota (UNIQUE id_cuota), el que ya recibió a -N no vuelve
   a recibir a -N+1. ── */
async function candidatos(dias) {
  const [rows] = await pool.query(`
    SELECT cu.id_cuota, cu.numero_cuota, DATE_FORMAT(cu.fecha_vencimiento,'%Y-%m-%d') fecha_vencimiento,
           cu.valor_cuota, cr.id id_credito,
           cl.rut, COALESCE(cl.nombre_completo, CONCAT_WS(' ', cl.nombres, cl.apellido_paterno, cl.apellido_materno)) nombre,
           COALESCE(cl.telefono_movil, cl.telefono) telefono
    FROM cuotas_credito cu
    JOIN creditos cr ON cr.id = cu.id_credito
    JOIN clientes cl ON cl.id_cliente = cr.id_cliente
    WHERE cu.fecha_pago IS NULL AND COALESCE(cu.estado_cuota,'') NOT IN ('PAGADA','ANULADA')
      AND cu.fecha_vencimiento BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)
      AND NOT EXISTS (SELECT 1 FROM wsp_avisos_vencimiento av WHERE av.id_cuota = cu.id_cuota AND av.estado IN ('ENVIADO','SIMULADO'))
    ORDER BY cu.id_cuota`, [Number(dias) || 2]);

  const hoy = hoyChile();
  // Cupo semanal Ley del Consumidor: máx 2 remotas/semana calendario, separadas ≥2 días
  const { creditosSinCupoRemota } = require('../../../shared/horario-cobranza');
  const enTope = await creditosSinCupoRemota(rows.map(r => r.id_credito));
  const { cobranzaFullMap } = require('../../creditos/src/controllers/pagos-credito.controller');
  const out = [];
  for (const c of rows) {
    if (enTope.has(c.id_credito)) continue;
    // cuotas en mora del mismo crédito, valorizadas AL DÍA con el motor único
    const [vencidas] = await pool.query(`
      SELECT numero_cuota, valor_cuota monto_cuota, DATE_FORMAT(fecha_vencimiento,'%Y-%m-%d') fecha_vencimiento
      FROM cuotas_credito
      WHERE id_credito=? AND fecha_pago IS NULL AND COALESCE(estado_cuota,'') NOT IN ('PAGADA','ANULADA')
        AND fecha_vencimiento < CURDATE()`, [c.id_credito]);
    let montoImpagas = 0;
    if (vencidas.length) {
      const full = await cobranzaFullMap(c.id_credito, vencidas, hoy);
      for (const v of vencidas) {
        const extra = full.get(Number(v.numero_cuota)) || { mora: 0, gastos: 0 };
        montoImpagas += Number(v.monto_cuota) + extra.mora + extra.gastos;
      }
    }
    const conMora = vencidas.length > 0;
    out.push({
      ...c,
      telefono_norm: normTel(c.telefono),
      con_mora: conMora,
      cuotas_impagas: vencidas.length,
      monto_impagas: Math.round(montoImpagas),
      total_hoy: Math.round(Number(c.valor_cuota) + montoImpagas),
      plantilla: conMora ? TPL_MORA : TPL_SIMPLE,
      fecha_texto: fechaLarga(c.fecha_vencimiento),
      params: conMora
        ? [c.nombre, fechaLarga(c.fecha_vencimiento), String(c.numero_cuota), CLP(c.valor_cuota),
           String(vencidas.length), CLP(montoImpagas), CLP(Number(c.valor_cuota) + montoImpagas)]
        : [c.nombre, fechaLarga(c.fecha_vencimiento), String(c.numero_cuota), CLP(c.valor_cuota)],
    });
  }
  return out;
}

/* ── Correr el motor (real o simulación) ── */
async function correr({ real = false } = {}) {
  const cfg = await getCfg();
  const dias = Number(cfg.aviso_venc_dias) || 2;
  const lista = await candidatos(dias);
  if (!real) return { simulado: true, dias, candidatos: lista };

  let devMode = false;
  try { devMode = !!(await require('../../../shared/dev-mode').getDevMode()).activo; } catch (e) {}
  // Ley 21.320: gestiones de cobranza solo L-S hábiles 8:00-20:00 (en Modo Desarrollo
  // se permite porque nada sale a clientes — queda SIMULADO)
  if (!devMode) {
    const { motivoFueraHorario } = require('../../../shared/horario-cobranza');
    const motivo = motivoFueraHorario();
    if (motivo) throw new Error(`Horario legal de cobranza (Ley 21.320): no se puede enviar en ${motivo}. Permitido: lunes a sábado hábiles, 8:00 a 20:00.`);
  }
  const token = process.env.WSP_TOKEN, phoneId = process.env.WSP_PHONE_ID;
  const estados = await estadoPlantillas().catch(() => null);
  const resultados = [];
  for (const c of lista) {
    let estado = 'ERROR', err = null;
    if (!c.telefono_norm) err = 'Sin teléfono válido';
    else if (devMode) { estado = 'SIMULADO'; err = 'Modo Desarrollo activo — no se envía a clientes reales'; }
    else if (!token || !phoneId) err = 'WhatsApp no configurado';
    else if (!estados || estados[c.plantilla] !== 'APPROVED') err = `Plantilla ${c.plantilla} no está APROBADA en Meta (${estados ? estados[c.plantilla] : 's/i'})`;
    else {
      try {
        const resp = await fetch(`${GRAPH}/${phoneId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            messaging_product: 'whatsapp', to: c.telefono_norm, type: 'template',
            template: { name: c.plantilla, language: { code: 'es' },
              components: [{ type: 'body', parameters: c.params.map(t => ({ type: 'text', text: String(t) })) }] },
          }),
        });
        const j = await resp.json().catch(() => ({}));
        if (resp.ok) estado = 'ENVIADO';
        else err = j.error?.message || `HTTP ${resp.status}`;
      } catch (e) { err = e.message; }
    }
    await pool.query(`
      INSERT IGNORE INTO wsp_avisos_vencimiento
        (id_cuota, id_credito, rut, nombre, telefono, numero_cuota, fecha_vencimiento, monto_cuota,
         cuotas_impagas, monto_impagas, total_hoy, plantilla, estado, error_msg)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [c.id_cuota, c.id_credito, c.rut, c.nombre, c.telefono_norm || c.telefono, c.numero_cuota, c.fecha_vencimiento,
       c.valor_cuota, c.cuotas_impagas, c.monto_impagas, c.total_hoy, c.plantilla, estado, err && String(err).slice(0, 290)]);
    // Bitácora de COBRANZAS del crédito (cuenta en el recuento semanal de gestiones,
    // Ley 21.320) con el tipo de mensaje enviado (aviso simple o con mora).
    if (estado === 'ENVIADO') {
      try {
        await pool.query(`
          INSERT INTO cobranza_gestiones (id_credito, rut_cliente, nombre_cliente,
            tipo_gestion, canal, cuotas_mora, monto_mora, mensaje, resultado, id_usuario, nombre_usuario)
          VALUES (?, ?, ?, 'WHATSAPP', 'REMOTA', ?, ?, ?, 'ENVIADO', 0, 'Business Suite (automático)')`,
          [c.id_credito, c.rut, c.nombre, c.cuotas_impagas, c.monto_impagas,
           `Aviso de vencimiento automático — plantilla "${c.plantilla}": cuota N°${c.numero_cuota} vence el ${c.fecha_texto} (${CLP(c.valor_cuota)})${c.con_mora ? ` + ${c.cuotas_impagas} impaga(s) ${CLP(c.monto_impagas)}` : ''}`]);
      } catch (e) { console.error('[aviso-venc bitacora]', e.message); }
    }
    resultados.push({ id_cuota: c.id_cuota, nombre: c.nombre, estado, error: err });
  }
  return { simulado: false, dias, resultados };
}

/* ── Scheduler: diario a las 10:00 (hora Chile) si está activo ── */
let _ultimaCorrida = null;
async function tick() {
  try {
    const cfg = await getCfg();
    if (!cfg.aviso_venc_activo) return;
    const ahora = new Date();
    const horaChile = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Santiago', hour: 'numeric', hour12: false }).format(ahora));
    const hoy = hoyChile();
    if (horaChile !== 10 || _ultimaCorrida === hoy) return;
    if (!require('../../../shared/horario-cobranza').esHorarioLegalCobranza()) return; // domingo/feriado: reintenta el próximo día hábil
    _ultimaCorrida = hoy;
    const r = await correr({ real: true });
    console.log(`[aviso-vencimiento] corrida ${hoy}: ${r.resultados.length} avisos`, r.resultados.map(x => x.estado).join(','));
  } catch (e) { console.error('[aviso-vencimiento tick]', e.message); }
}
setInterval(tick, 10 * 60 * 1000);   // revisa cada 10 min; corre 1 vez al día a las 10:00 Chile

module.exports = { correr, candidatos, estadoPlantillas, crearPlantillas, cuerposPlantillas };
