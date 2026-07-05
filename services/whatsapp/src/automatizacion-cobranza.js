'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   AUTOMATIZACIONES DE COBRANZA por WhatsApp — secuencia numerada de mensajes
   automáticos para créditos AutoFácil en mora.
   - Las plantillas que participan son las HSM marcadas tipo=COBRANZA y
     activo=1 en `wsp_plantillas_tipo` (mismo gestor de Plantillas del módulo
     WhatsApp), cada una con un N° de orden.
   - Por cada crédito en mora se recuerda el ÚLTIMO N° enviado
     (wsp_auto_cobranza_envios) y al correr de nuevo se envía el SIGUIENTE de
     la secuencia — nunca se repite el mismo mensaje. Si la secuencia se
     agota para ese crédito, no se le vuelve a enviar nada automático.
   - Nace DESACTIVADO (wsp_config.cobranza_auto_activo). Respeta Modo
     Desarrollo. Cada envío queda como gestión en el CRM con resultado
     ENVIADO → ENTREGADO → LEIDO (actualizado por el webhook de estados de Meta).
   ───────────────────────────────────────────────────────────────────────── */
const pool = require('../../../shared/config/database');

const GRAPH = 'https://graph.facebook.com/v21.0';

/* ── Migración ── */
(async () => {
  try {
    await pool.query(`ALTER TABLE wsp_config ADD COLUMN IF NOT EXISTS cobranza_auto_activo TINYINT(1) NOT NULL DEFAULT 0`);
    // Programación y focalización (a quiénes): hora, días de semana, tramo de mora y monto mínimo
    await pool.query(`ALTER TABLE wsp_config ADD COLUMN IF NOT EXISTS cobranza_auto_hora TINYINT NOT NULL DEFAULT 11`);
    await pool.query(`ALTER TABLE wsp_config ADD COLUMN IF NOT EXISTS cobranza_auto_dias VARCHAR(20) NOT NULL DEFAULT '1,2,3,4,5'`); // 1=Lun … 7=Dom
    await pool.query(`ALTER TABLE wsp_config ADD COLUMN IF NOT EXISTS cobranza_auto_mora_desde INT NOT NULL DEFAULT 1`);
    await pool.query(`ALTER TABLE wsp_config ADD COLUMN IF NOT EXISTS cobranza_auto_mora_hasta INT NULL`);
    await pool.query(`ALTER TABLE wsp_config ADD COLUMN IF NOT EXISTS cobranza_auto_monto_min INT NOT NULL DEFAULT 0`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wsp_plantillas_tipo (
        nombre_plantilla VARCHAR(100) PRIMARY KEY,
        tipo VARCHAR(12) NOT NULL DEFAULT 'GENERAL',
        orden INT NULL,
        activo TINYINT(1) NOT NULL DEFAULT 0,
        mapa_variables JSON NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wsp_auto_cobranza_envios (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_credito INT NOT NULL,
        rut VARCHAR(15) NULL, nombre VARCHAR(160) NULL, telefono VARCHAR(20) NULL,
        nombre_plantilla VARCHAR(100) NULL,
        orden_enviado INT NOT NULL,
        wamid VARCHAR(80) NULL,
        id_crm_gestion INT NULL,
        estado VARCHAR(12) NOT NULL,
        error_msg VARCHAR(300) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_credito (id_credito),
        INDEX idx_wamid (wamid)
      )`);
    // La bitácora de COBRANZAS acepta los resultados de los envíos automáticos
    // (Enviado→Entregado→Leído vía webhook Meta) además de los de gestión manual
    await pool.query(`ALTER TABLE cobranza_gestiones MODIFY resultado
      ENUM('CONTACTADO','NO_CONTESTA','PROMESA_PAGO','RECHAZA_PAGO','NUMERO_ERRADO','SIN_RESULTADO',
           'ENVIADO','ENTREGADO','LEIDO','SIMULADO') DEFAULT 'SIN_RESULTADO'`).catch(() => {});
    console.log('[automatizacion-cobranza] listo (nace desactivado)');
  } catch (e) { console.error('[automatizacion-cobranza migration]', e.message); }
})();

/* ── Utilidades ── */
const CLP = v => '$' + Math.round(Number(v || 0)).toLocaleString('es-CL');
function hoyChile() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date()); }
function normTel(t) {
  let d = String(t || '').replace(/\D/g, '');
  if (d.startsWith('56')) d = d.slice(2);
  if (d.length === 9 && d.startsWith('9')) return '56' + d;
  if (d.length === 8) return '569' + d;
  return d.length >= 11 ? d : null;
}
async function getCfg() { const [[c]] = await pool.query('SELECT * FROM wsp_config LIMIT 1'); return c || {}; }
async function wabaId() { const c = await getCfg(); return c.waba_id || '1044493808034066'; }

/* Campos disponibles para mapear las {{n}} de una plantilla de cobranza */
const CAMPOS = {
  nombre:           d => d.nombre,
  rut:              d => d.rut,
  dias_mora:        d => String(d.dias_mora),
  cuotas_mora:      d => String(d.cuotas_mora),
  monto_mora:       d => CLP(d.monto_mora),
  saldo_insoluto:   d => CLP(d.saldo_insoluto),
  numero_operacion: d => String(d.num_op || ''),
};
const CAMPOS_LABEL = {
  nombre: 'Nombre del cliente', rut: 'RUT', dias_mora: 'Días de mora', cuotas_mora: 'N° cuotas en mora',
  monto_mora: 'Monto en mora ($)', saldo_insoluto: 'Saldo insoluto ($)', numero_operacion: 'N° de operación',
};

/* ── Secuencia activa de plantillas COBRANZA, en orden ── */
async function secuencia() {
  const [rows] = await pool.query(`SELECT * FROM wsp_plantillas_tipo WHERE tipo='COBRANZA' AND activo=1 AND orden IS NOT NULL ORDER BY orden`);
  return rows;
}

/* ── Universo: créditos AutoFácil en mora — MOTOR ÚNICO (MORA_SQL de cobranza.controller,
   el mismo que usa Pre-judicial/Judicial/Dashboard de Cobranza) ── */
async function universoMora() {
  const { MORA_SQL } = require('../../cobranza/src/controllers/cobranza.controller')._motor;
  const [creditos] = await pool.query(MORA_SQL());
  if (!creditos.length) return [];
  const ruts = [...new Set(creditos.map(c => c.rut_cliente).filter(Boolean))];
  const telPorRut = {};
  if (ruts.length) {
    const [tels] = await pool.query(
      `SELECT rut, COALESCE(telefono_movil, telefono) telefono FROM clientes WHERE rut IN (?)`, [ruts]);
    tels.forEach(t => { telPorRut[t.rut] = t.telefono; });
  }
  return creditos.map(c => ({
    id_credito: c.id_credito, num_op: c.num_op, rut: c.rut_cliente, nombre: c.nombre_cliente,
    telefono: telPorRut[c.rut_cliente] || null,
    telefono_norm: normTel(telPorRut[c.rut_cliente]),
    cuotas_mora: Number(c.cuotas_mora) || 0,
    monto_mora: Math.round(Number(c.monto_mora) || 0),
    dias_mora: Number(c.dias_mora) || 0,
    saldo_insoluto: Math.round(Number(c.saldo_insoluto) || 0),
  }));
}

/* ── Candidatos del día: para cada crédito en mora, el SIGUIENTE N° de la secuencia ── */
async function candidatos() {
  const seq = await secuencia();
  if (!seq.length) return [];
  const cfg = await getCfg();
  // A QUIÉNES: filtro configurable del universo (tramo de días de mora + monto mínimo)
  const desde = Number(cfg.cobranza_auto_mora_desde ?? 1);
  const hasta = cfg.cobranza_auto_mora_hasta == null ? null : Number(cfg.cobranza_auto_mora_hasta);
  const montoMin = Number(cfg.cobranza_auto_monto_min || 0);
  let universo = (await universoMora()).filter(c =>
    c.dias_mora >= desde &&
    (hasta === null || c.dias_mora <= hasta) &&
    c.monto_mora >= montoMin);
  // Cupo semanal Ley del Consumidor: máx 2 remotas/semana calendario, separadas ≥2 días
  // (misma regla que las gestiones manuales de Pre-judicial)
  const { creditosSinCupoRemota } = require('../../../shared/horario-cobranza');
  const sinCupo = await creditosSinCupoRemota(universo.map(c => c.id_credito));
  universo = universo.filter(c => !sinCupo.has(c.id_credito));
  const hoy = hoyChile();
  const out = [];
  for (const c of universo) {
    const [[ult]] = await pool.query(
      `SELECT MAX(orden_enviado) maxOrden FROM wsp_auto_cobranza_envios WHERE id_credito=? AND estado IN ('ENVIADO','ENTREGADO','LEIDO','SIMULADO')`,
      [c.id_credito]);
    const [[hoyRow]] = await pool.query(`SELECT COUNT(*) n FROM wsp_auto_cobranza_envios WHERE id_credito=? AND DATE(created_at)=?`, [c.id_credito, hoy]);
    if (hoyRow.n > 0) continue; // ya se le envió algo hoy
    const proximo = (ult.maxOrden || 0) + 1;
    const tpl = seq.find(t => t.orden === proximo);
    if (!tpl) continue; // secuencia agotada para este crédito: NO se repite el último
    const mapa = Array.isArray(tpl.mapa_variables) ? tpl.mapa_variables : [];
    const params = mapa.map(campo => (CAMPOS[campo] ? CAMPOS[campo](c) : ''));
    out.push({ ...c, nombre_plantilla: tpl.nombre_plantilla, orden_enviado: proximo, params });
  }
  return out;
}

/* ── Correr el motor (real o simulación) ── */
async function correr({ real = false } = {}) {
  const lista = await candidatos();
  if (!real) return { simulado: true, candidatos: lista };

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
  const resultados = [];
  for (const c of lista) {
    let estado = 'ERROR', err = null, wamid = null;
    if (!c.telefono_norm) err = 'Sin teléfono válido';
    else if (devMode) { estado = 'SIMULADO'; err = 'Modo Desarrollo activo — no se envía a clientes reales'; }
    else if (!token || !phoneId) err = 'WhatsApp no configurado';
    else {
      try {
        const resp = await fetch(`${GRAPH}/${phoneId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            messaging_product: 'whatsapp', to: c.telefono_norm, type: 'template',
            template: { name: c.nombre_plantilla, language: { code: 'es' },
              ...(c.params.length ? { components: [{ type: 'body', parameters: c.params.map(t => ({ type: 'text', text: String(t) })) }] } : {}) },
          }),
        });
        const j = await resp.json().catch(() => ({}));
        if (resp.ok) { estado = 'ENVIADO'; wamid = j.messages?.[0]?.id || null; }
        else err = j.error?.message || `HTTP ${resp.status}`;
      } catch (e) { err = e.message; }
    }
    // Bitácora de COBRANZAS del crédito: la acción cuenta en el recuento semanal de
    // gestiones permitidas (Ley 21.320), registrando el tipo de mensaje enviado.
    let idCrm = null;
    if (estado === 'ENVIADO' || estado === 'SIMULADO') {
      try {
        const [ins] = await pool.query(`
          INSERT INTO cobranza_gestiones (id_credito, numero_credito, rut_cliente, nombre_cliente,
            tipo_gestion, canal, dias_mora, cuotas_mora, monto_mora, mensaje, resultado, id_usuario, nombre_usuario)
          VALUES (?, ?, ?, ?, 'WHATSAPP', 'REMOTA', ?, ?, ?, ?, ?, 0, 'Business Suite (automático)')`,
          [c.id_credito, String(c.num_op || ''), c.rut, c.nombre,
           c.dias_mora, c.cuotas_mora, c.monto_mora,
           `Mensaje automático N°${c.orden_enviado} — plantilla "${c.nombre_plantilla}" (${c.dias_mora} día(s) de mora, ${CLP(c.monto_mora)})`,
           estado === 'SIMULADO' ? 'SIMULADO' : 'ENVIADO']);
        idCrm = ins.insertId;
      } catch (e) { console.error('[auto-cobranza bitacora]', e.message); }
    }
    await pool.query(`
      INSERT INTO wsp_auto_cobranza_envios (id_credito, rut, nombre, telefono, nombre_plantilla, orden_enviado, wamid, id_crm_gestion, estado, error_msg)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [c.id_credito, c.rut, c.nombre, c.telefono_norm || c.telefono, c.nombre_plantilla, c.orden_enviado, wamid, idCrm, estado, err && String(err).slice(0, 290)]);
    resultados.push({ id_credito: c.id_credito, nombre: c.nombre, orden: c.orden_enviado, plantilla: c.nombre_plantilla, estado, error: err });
  }
  return { simulado: false, resultados };
}

/* ── Webhook de estados de Meta (sent/delivered/read) → refleja en el envío y en el CRM ── */
async function marcarEstado(wamid, status) {
  const estado = status === 'read' ? 'LEIDO' : status === 'delivered' ? 'ENTREGADO' : status === 'failed' ? 'ERROR' : null;
  if (!estado || !wamid) return;
  try {
    const [[row]] = await pool.query('SELECT id, estado, id_crm_gestion FROM wsp_auto_cobranza_envios WHERE wamid=?', [wamid]);
    if (!row) return;
    if (row.estado === 'LEIDO') return; // estado final, no retrocede
    await pool.query('UPDATE wsp_auto_cobranza_envios SET estado=? WHERE id=?', [estado, row.id]);
    if (row.id_crm_gestion) await pool.query('UPDATE cobranza_gestiones SET resultado=? WHERE id_gestion=?', [estado, row.id_crm_gestion]);
  } catch (e) { console.error('[auto-cobranza estado]', e.message); }
}

/* ── Scheduler: corre a la HORA y DÍAS configurados (hora Chile) si está activo ── */
const DIA_ISO = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
let _ultimaCorrida = null;
async function tick() {
  try {
    const cfg = await getCfg();
    if (!cfg.cobranza_auto_activo) return;
    const ahora = new Date();
    const horaChile = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Santiago', hour: 'numeric', hour12: false }).format(ahora));
    const diaChile = DIA_ISO[new Intl.DateTimeFormat('en-US', { timeZone: 'America/Santiago', weekday: 'short' }).format(ahora)];
    const hoy = hoyChile();
    const horaCfg = Number(cfg.cobranza_auto_hora ?? 11);
    const diasCfg = String(cfg.cobranza_auto_dias || '1,2,3,4,5').split(',').map(Number);
    if (!diasCfg.includes(diaChile)) return;
    if (horaChile !== horaCfg || _ultimaCorrida === hoy) return;
    if (!require('../../../shared/horario-cobranza').esHorarioLegalCobranza()) return; // Ley 21.320: nunca domingo/feriado
    _ultimaCorrida = hoy;
    const r = await correr({ real: true });
    console.log(`[automatizacion-cobranza] corrida ${hoy}: ${r.resultados.length} envíos`, r.resultados.map(x => x.estado).join(','));
  } catch (e) { console.error('[automatizacion-cobranza tick]', e.message); }
}
setInterval(tick, 10 * 60 * 1000);

module.exports = { correr, candidatos, secuencia, marcarEstado, CAMPOS, CAMPOS_LABEL, normTel };
