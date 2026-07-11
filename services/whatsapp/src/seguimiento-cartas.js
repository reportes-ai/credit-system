'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   SEGUIMIENTO DE CARTAS DE APROBACIÓN por WhatsApp (Facilito) — a DEALERS.
   El día ANTES de que venza la carta (fecha + vigencia_carta_dias), Facilito
   escribe al móvil (+569) registrado del dealer: se identifica, recuerda el
   negocio aprobado (cliente, vehículo, saldo precio) y pregunta si el negocio
   sigue vigente o ya se vendió el auto. La conversación la sigue la IA del bot
   (modo seguimiento): si se perdió con otro financiamiento, tabula el motivo
   (calidad, tiempo de respuesta, comisión, tasa, otro); si sigue vigente,
   entrega el contacto del Ejecutivo Comercial de la carta.
   - Nace DESACTIVADO (wsp_config.seg_cartas_activo).
   - Plantilla HSM `seguimiento_carta` (Meta debe aprobarla) para abrir la
     conversación fuera de la ventana de 24 h.
   - Respeta Modo Desarrollo (queda SIMULADO).
   - Idempotente: 1 seguimiento por carta (UNIQUE id_carta).
   ───────────────────────────────────────────────────────────────────────── */
const pool = require('../../../shared/config/database');

const GRAPH = 'https://graph.facebook.com/v21.0';
const TPL = 'seguimiento_carta';

require('../../../shared/migrate').enFila('seguimiento-cartas', async () => {
  try {
    await pool.query("ALTER TABLE wsp_config ADD COLUMN IF NOT EXISTS seg_cartas_activo TINYINT(1) NOT NULL DEFAULT 0");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wsp_seguimiento_cartas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_carta INT NOT NULL UNIQUE,
        op_carta VARCHAR(30) NULL,
        rut_dealer VARCHAR(15) NULL, dealer VARCHAR(200) NULL, telefono VARCHAR(20) NULL,
        cliente VARCHAR(200) NULL, vehiculo VARCHAR(120) NULL, saldo DECIMAL(15,0) NULL,
        vence DATE NULL,
        id_conversacion INT NULL,
        estado VARCHAR(12) NOT NULL,          -- ENVIADO | SIMULADO | ERROR
        error_msg VARCHAR(300) NULL,
        resultado VARCHAR(30) NULL,           -- VIGENTE | VENDIDO_CREDITO_OTRO | VENDIDO_CONTADO | NO_VENDIDO | OTRO
        financiado_por VARCHAR(120) NULL,     -- quién financió si se perdió
        motivo VARCHAR(30) NULL,              -- calidad | tiempo_respuesta | comision | tasa | otro
        resumen VARCHAR(400) NULL,
        cerrado_at DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
    await pool.query('ALTER TABLE wsp_conversaciones ADD COLUMN IF NOT EXISTS seguimiento_carta_id INT NULL');
    // Card bajo el módulo WhatsApp (anti-hardcode)
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='wsp_seg_cartas' LIMIT 1");
    if (!ex) {
      await pool.query("INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (660001,'Seguimiento de Cartas (Facilito)','wsp_seg_cartas','/whatsapp/seguimiento-cartas.html','bi-envelope-heart')");
      const [[nf]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='wsp_seg_cartas' LIMIT 1");
      await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
                        SELECT id_perfil, ?, 1 FROM perfiles WHERE nombre='Administrador'`, [nf.id_funcionalidad]);
    }
  } catch (e) { console.error('[seguimiento-cartas migration]', e.message); }
});

const CLP = n => '$' + Math.round(+n || 0).toLocaleString('es-CL');
function hoyChile() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' }); }
/* Móvil chileno normalizado 569XXXXXXXX, o null si no es móvil */
function normMovil(t) {
  const d = String(t || '').replace(/\D/g, '');
  if (/^569\d{8}$/.test(d)) return d;
  if (/^9\d{8}$/.test(d)) return '56' + d;
  if (/^56569\d{8}$/.test(d)) return d.slice(2);
  return null;
}
async function getCfg() { const [[c]] = await pool.query('SELECT * FROM wsp_config WHERE id=1'); return c || {}; }
async function wabaId() { const cfg = await getCfg(); return cfg.waba_id || '1044493808034066'; }

/* ── Plantilla HSM (cuerpo = guion aprobado por Pato) ── */
function cuerpoPlantilla() {
  return 'Hola, soy Facilito de AutoFácil 🤖. Te escribo porque hace unos días aprobamos un crédito automotriz a nombre de {{1}} para la compra de un {{2}} por un saldo precio de {{3}}. Esta carta vence mañana y queríamos saber cómo te ha ido con este negocio o cómo podemos ayudarte. ¿Está vigente el negocio o ya vendiste el auto?';
}
async function estadoPlantilla() {
  const token = process.env.WSP_TOKEN; if (!token) return null;
  const r = await fetch(`${GRAPH}/${await wabaId()}/message_templates?limit=100&fields=name,status,language`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  const p = (j.data || []).find(x => x.name === TPL);
  return p ? p.status : 'NO_EXISTE';
}
async function crearPlantilla() {
  const token = process.env.WSP_TOKEN; if (!token) throw new Error('WSP_TOKEN no configurado');
  const r = await fetch(`${GRAPH}/${await wabaId()}/message_templates`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: TPL, category: 'UTILITY', language: 'es',
      components: [
        { type: 'BODY', text: cuerpoPlantilla(),
          example: { body_text: [['Juan Pérez', 'Ford Territory 2022', '$7.780.000']] } },
      ],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
  return j;
}

/* ── Candidatos: cartas APROBADAS no otorgadas que VENCEN MAÑANA, con móvil
   del dealer y sin seguimiento previo ── */
async function candidatos() {
  const [[v]] = await pool.query("SELECT valor FROM parametros_credito WHERE clave='vigencia_carta_dias' LIMIT 1");
  const dias = Math.max(parseInt(v && v.valor) || 5, 1);
  const [rows] = await pool.query(`
    SELECT ca.id, ca.op_carta, ca.cliente, ca.marca, ca.modelo, ca.anio, ca.saldo,
           ca.rut_dealer, ca.nombre_dealer, ca.ejecutivo, ca.ejecutivo_tel,
           DATE_FORMAT(DATE_ADD(DATE(ca.fecha), INTERVAL ? DAY),'%Y-%m-%d') vence,
           d.telefono tel_dealer, d.contacto contacto_dealer
    FROM cartas_aprobacion ca
    LEFT JOIN dealers d ON REPLACE(REPLACE(REPLACE(UPPER(d.rut),'.',''),'-',''),' ','') = REPLACE(REPLACE(REPLACE(UPPER(COALESCE(ca.rut_dealer,'')),'.',''),'-',''),' ','')
    WHERE ca.status='APROBADA' AND ca.otorgado=0 AND ca.fecha IS NOT NULL
      AND DATE_ADD(DATE(ca.fecha), INTERVAL ? DAY) = DATE_ADD(CURDATE(), INTERVAL 1 DAY)
      AND NOT EXISTS (SELECT 1 FROM wsp_seguimiento_cartas s WHERE s.id_carta = ca.id AND s.estado IN ('ENVIADO','SIMULADO'))`,
    [dias, dias]);
  return rows.map(c => ({
    ...c,
    vehiculo: [c.marca, c.modelo, c.anio].filter(Boolean).join(' '),
    movil: normMovil(c.tel_dealer),
    params: [c.cliente || 'nuestro cliente', [c.marca, c.modelo, c.anio].filter(Boolean).join(' ') || 'vehículo', CLP(c.saldo)],
  }));
}

/* ── Correr (real o simulación de lista) ── */
async function correr({ real = false } = {}) {
  const lista = await candidatos();
  if (!real) return { simulado: true, candidatos: lista };

  let devMode = false;
  try { devMode = !!(await require('../../../shared/dev-mode').getDevMode()).activo; } catch (e) {}
  const token = process.env.WSP_TOKEN, phoneId = process.env.WSP_PHONE_ID;
  const tplEstado = await estadoPlantilla().catch(() => null);
  const resultados = [];
  for (const c of lista) {
    let estado = 'ERROR', err = null, wamid = null;
    if (!c.movil) err = 'Dealer sin teléfono móvil (+569) registrado';
    else if (devMode) { estado = 'SIMULADO'; err = 'Modo Desarrollo activo'; }
    else if (!token || !phoneId) err = 'WhatsApp no configurado';
    else if (tplEstado !== 'APPROVED') err = `Plantilla ${TPL} no aprobada en Meta (${tplEstado || 's/i'})`;
    else {
      try {
        const resp = await fetch(`${GRAPH}/${phoneId}/messages`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            messaging_product: 'whatsapp', to: c.movil, type: 'template',
            template: { name: TPL, language: { code: 'es' },
              components: [{ type: 'body', parameters: c.params.map(t => ({ type: 'text', text: String(t) })) }] },
          }),
        });
        const j = await resp.json().catch(() => ({}));
        if (resp.ok) { estado = 'ENVIADO'; wamid = j.messages && j.messages[0] && j.messages[0].id || null; }
        else err = j.error?.message || `HTTP ${resp.status}`;
      } catch (e) { err = e.message; }
    }

    const [ins] = await pool.query(`
      INSERT IGNORE INTO wsp_seguimiento_cartas
        (id_carta, op_carta, rut_dealer, dealer, telefono, cliente, vehiculo, saldo, vence, estado, error_msg)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [c.id, c.op_carta, c.rut_dealer, c.nombre_dealer, c.movil || c.tel_dealer, c.cliente, c.vehiculo, c.saldo, c.vence, estado, err && String(err).slice(0, 290)]);

    // Conversación del bot: crear/reusar por teléfono y marcarla en modo seguimiento
    if ((estado === 'ENVIADO' || estado === 'SIMULADO') && c.movil && ins.insertId) {
      try {
        let [[conv]] = await pool.query("SELECT id FROM wsp_conversaciones WHERE telefono=? AND estado!='CERRADA' AND es_simulada=0 ORDER BY id DESC LIMIT 1", [c.movil]);
        if (!conv) {
          const [r] = await pool.query('INSERT INTO wsp_conversaciones (telefono, nombre, es_simulada) VALUES (?,?,0)', [c.movil, c.contacto_dealer || c.nombre_dealer]);
          conv = { id: r.insertId };
        }
        await pool.query('UPDATE wsp_conversaciones SET seguimiento_carta_id=? WHERE id=?', [ins.insertId, conv.id]);
        await pool.query('UPDATE wsp_seguimiento_cartas SET id_conversacion=? WHERE id=?', [conv.id, ins.insertId]);
        const texto = cuerpoPlantilla().replace('{{1}}', c.params[0]).replace('{{2}}', c.params[1]).replace('{{3}}', c.params[2]);
        await pool.query("INSERT INTO wsp_mensajes (id_conversacion, direccion, origen, mensaje, estado_envio, wamid) VALUES (?,?,?,?,?,?)",
          [conv.id, 'OUT', 'BOT', texto, estado, wamid]);
        await pool.query('UPDATE wsp_conversaciones SET ultima_actividad=NOW() WHERE id=?', [conv.id]);
      } catch (e) { console.error('[seg-cartas conv]', e.message); }
    }
    resultados.push({ id_carta: c.id, dealer: c.nombre_dealer, estado, error: err });
  }
  return { simulado: false, resultados };
}

/* ── API ── */
exports.listar = async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM wsp_seguimiento_cartas ORDER BY id DESC LIMIT 300');
    const cfg = await getCfg();
    res.json({ success: true, data: { activo: !!cfg.seg_cartas_activo, seguimientos: rows }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};
exports.setActivo = async (req, res) => {
  try {
    await pool.query('UPDATE wsp_config SET seg_cartas_activo=? WHERE id=1', [req.body && req.body.activo ? 1 : 0]);
    res.json({ success: true, data: null, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};
exports.simularCorrida = async (_req, res) => {
  try { res.json({ success: true, data: await correr({ real: false }), error: null }); }
  catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};
exports.correrAhora = async (_req, res) => {
  try { res.json({ success: true, data: await correr({ real: true }), error: null }); }
  catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};
exports.plantilla = async (_req, res) => {
  try { res.json({ success: true, data: { nombre: TPL, cuerpo: cuerpoPlantilla(), estado: await estadoPlantilla() }, error: null }); }
  catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};
exports.crearPlantillaHttp = async (_req, res) => {
  try { res.json({ success: true, data: await crearPlantilla(), error: null }); }
  catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

/* ── Scheduler: diario a las 11:00 Chile si está activo ── */
let _ultimaCorrida = null;
async function tick() {
  try {
    const cfg = await getCfg();
    if (!cfg.seg_cartas_activo) return;
    const horaChile = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Santiago', hour: 'numeric', hour12: false }).format(new Date()));
    const hoy = hoyChile();
    if (horaChile !== 11 || _ultimaCorrida === hoy) return;
    _ultimaCorrida = hoy;
    const r = await correr({ real: true });
    console.log(`[seguimiento-cartas] corrida ${hoy}: ${r.resultados.length} envíos`, r.resultados.map(x => x.estado).join(','));
  } catch (e) { console.error('[seguimiento-cartas tick]', e.message); }
}
setInterval(tick, 10 * 60 * 1000);

module.exports.correr = correr;
module.exports.candidatos = candidatos;
