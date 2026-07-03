'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Módulo WhatsApp — bot de respuestas configurables + bandeja de agentes +
   campañas de salida + triggers (problema/riesgo/oportunidad) con derivación.
   TODO paramétrico (respuestas, triggers, horario, mensajes) — cero hardcode.
   Transporte: shared/whatsapp.js (Meta Cloud API directa). Sin credenciales el
   envío queda SIMULADO y el módulo funciona completo con el Simulador del panel.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { enviarWhatsApp, normalizarFono } = require('../../../../shared/whatsapp');
const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');
const ia = require('../../../../shared/ia');
const anthropic = require('../../../../shared/anthropic');

const PROMPT_IA_DEF = `Eres el asistente de WhatsApp de AutoFácil Crédito Automotriz (Chile), empresa de créditos automotrices.
Tono: cercano, chileno formal, mensajes CORTOS (estilo WhatsApp, máximo 3-4 líneas), un emoji ocasional.
Puedes: orientar sobre requisitos y documentos, explicar cómo funciona el crédito automotriz, tomar datos para una simulación (monto, pie, plazo) y coordinar el contacto con un ejecutivo.
NO puedes: prometer aprobaciones, dar tasas o montos de cuota exactos, entregar datos de otros clientes, ni negociar deudas. Ante consultas de saldo o pagos específicos, deriva a un ejecutivo.
Si el cliente muestra molestia seria, urgencia de pago o intención concreta de compra, deriva.`;

/* ── Migración ─────────────────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wsp_config (
        id                TINYINT PRIMARY KEY DEFAULT 1,
        bot_activo        TINYINT(1)   NOT NULL DEFAULT 1,
        horario_ini       VARCHAR(5)   NOT NULL DEFAULT '09:00',
        horario_fin       VARCHAR(5)   NOT NULL DEFAULT '19:00',
        dias_habiles      VARCHAR(20)  NOT NULL DEFAULT '1,2,3,4,5,6',
        msg_bienvenida    TEXT         NULL,
        msg_fuera_horario TEXT         NULL,
        msg_no_entiendo   TEXT         NULL,
        msg_derivacion    TEXT         NULL
      )`);
    await pool.query(`INSERT IGNORE INTO wsp_config (id, msg_bienvenida, msg_fuera_horario, msg_no_entiendo, msg_derivacion) VALUES (1,
      '¡Hola! 👋 Soy el asistente de AutoFácil Crédito Automotriz. Puedo ayudarte con información de tu crédito, simulaciones y requisitos. ¿En qué te puedo ayudar?',
      'Gracias por escribirnos. Nuestro horario de atención es de lunes a sábado de 09:00 a 19:00 hrs. Te responderemos apenas estemos de vuelta. 🕐',
      'No estoy seguro de haber entendido 🤔. Escribe por ejemplo: *simular*, *requisitos*, *mi crédito* o *ejecutivo* para hablar con una persona.',
      'Te estamos derivando con un ejecutivo, en breve te contactará por este mismo chat. 🙌')`);
    try { await pool.query('ALTER TABLE wsp_config ADD COLUMN IF NOT EXISTS prompt_ia TEXT NULL'); } catch (e) { if (e.errno !== 1060) throw e; }
    // Ventana de envío (regla Meta: fuera de las 24h desde el último mensaje del cliente solo van plantillas)
    try { await pool.query('ALTER TABLE wsp_config ADD COLUMN IF NOT EXISTS ventana_horas INT NOT NULL DEFAULT 23'); } catch (e) { if (e.errno !== 1060) throw e; }
    await pool.query("UPDATE wsp_config SET prompt_ia=? WHERE id=1 AND (prompt_ia IS NULL OR prompt_ia='')", [PROMPT_IA_DEF]);
  } catch (e) { console.error('[wsp_config migration]', e.message); }

  // Funcionalidad IA (arranca desactivada; se prende en el mantenedor IA)
  ia.registrarFuncionalidad({
    codigo: 'wsp_bot', nombre: 'Bot WhatsApp (conversación)',
    descripcion: 'Responde los WhatsApp entrantes conversando con IA (los triggers de derivación siguen mandando); si está apagada, el bot usa solo las respuestas por palabra clave',
    modelo: 'claude-haiku-4-5',
  });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wsp_respuestas (
        id        INT AUTO_INCREMENT PRIMARY KEY,
        nombre    VARCHAR(120) NOT NULL,
        keywords  TEXT         NOT NULL,
        respuesta TEXT         NOT NULL,
        orden     INT          NOT NULL DEFAULT 0,
        activo    TINYINT(1)   NOT NULL DEFAULT 1
      )`);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM wsp_respuestas');
    if (!n) {
      const SEED = [
        ['Saludo',      'hola,buenas,buenos dias,buenas tardes,alo', '¡Hola! 👋 ¿En qué te puedo ayudar? Escribe *simular*, *requisitos*, *mi crédito* o *ejecutivo*.'],
        ['Requisitos',  'requisito,antecedente,documento,papeles,que necesito', 'Para evaluar tu crédito necesitamos:\n• Cédula de identidad vigente\n• Últimas 3 liquidaciones de sueldo (o boletas si eres independiente)\n• Certificado de cotizaciones AFP\nEscribe *ejecutivo* si quieres que te contactemos.'],
        ['Simular',     'simular,simulacion,cotizar,cotizacion,cuota,credito nuevo', 'Para simular tu crédito cuéntanos: monto a financiar, pie disponible y plazo en meses. Un ejecutivo te enviará la simulación. También puedes escribir *ejecutivo* para atención directa.'],
        ['Horario',     'horario,atencion,abierto,cierran', 'Atendemos de lunes a sábado de 09:00 a 19:00 hrs. 🕐'],
      ];
      let o = 0; for (const [nombre, kw, resp] of SEED) await pool.query('INSERT INTO wsp_respuestas (nombre, keywords, respuesta, orden) VALUES (?,?,?,?)', [nombre, kw, resp, ++o]);
    }
  } catch (e) { console.error('[wsp_respuestas migration]', e.message); }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wsp_triggers (
        id        INT AUTO_INCREMENT PRIMARY KEY,
        categoria VARCHAR(15)  NOT NULL DEFAULT 'PROBLEMA',
        nombre    VARCHAR(120) NOT NULL,
        keywords  TEXT         NOT NULL,
        accion    VARCHAR(10)  NOT NULL DEFAULT 'DERIVAR',
        area      VARCHAR(20)  NOT NULL DEFAULT 'COMERCIAL',
        prioridad VARCHAR(10)  NOT NULL DEFAULT 'normal',
        activo    TINYINT(1)   NOT NULL DEFAULT 1
      )`);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM wsp_triggers');
    if (!n) {
      const SEED = [
        ['PROBLEMA',     'Reclamo',           'reclamo,queja,pesimo,mala atencion,sernac,demanda,abogado',           'DERIVAR', 'OPERACIONES', 'alta'],
        ['RIESGO',       'No puede pagar',    'no puedo pagar,sin trabajo,cesante,repactar,refinanciar,me atrase',   'DERIVAR', 'COBRANZA',    'alta'],
        ['OPORTUNIDAD',  'Quiere comprar',    'quiero comprar,busco auto,me interesa,donde compro,recomienda',       'DERIVAR', 'COMERCIAL',   'normal'],
        ['OPORTUNIDAD',  'Pide ejecutivo',    'ejecutivo,persona,humano,hablar con alguien,llamenme',                'DERIVAR', 'COMERCIAL',   'normal'],
      ];
      for (const [cat, nombre, kw, acc, area, prio] of SEED) await pool.query('INSERT INTO wsp_triggers (categoria, nombre, keywords, accion, area, prioridad) VALUES (?,?,?,?,?,?)', [cat, nombre, kw, acc, area, prio]);
    }
  } catch (e) { console.error('[wsp_triggers migration]', e.message); }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wsp_conversaciones (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        telefono        VARCHAR(20)  NOT NULL,
        nombre          VARCHAR(200) NULL,
        rut_cliente     VARCHAR(15)  NULL,
        estado          VARCHAR(12)  NOT NULL DEFAULT 'BOT',
        area            VARCHAR(20)  NULL,
        trigger_cat     VARCHAR(15)  NULL,
        asignada_a      INT          NULL,
        asignada_nombre VARCHAR(200) NULL,
        es_simulada     TINYINT(1)   NOT NULL DEFAULT 0,
        ultima_actividad DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_fono (telefono), INDEX idx_estado (estado)
      )`);
  } catch (e) { console.error('[wsp_conversaciones migration]', e.message); }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wsp_mensajes (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        id_conversacion INT          NOT NULL,
        direccion       VARCHAR(3)   NOT NULL,
        origen          VARCHAR(10)  NOT NULL,
        autor_id        INT          NULL,
        autor_nombre    VARCHAR(200) NULL,
        mensaje         TEXT         NOT NULL,
        estado_envio    VARCHAR(10)  NULL,
        wamid           VARCHAR(120) NULL,
        created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_conv (id_conversacion)
      )`);
  } catch (e) { console.error('[wsp_mensajes migration]', e.message); }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wsp_campanas (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        nombre         VARCHAR(150) NOT NULL,
        mensaje        TEXT         NOT NULL,
        plantilla      VARCHAR(120) NULL,
        audiencia_tipo VARCHAR(15)  NOT NULL DEFAULT 'MANUAL',
        telefonos      MEDIUMTEXT   NULL,
        estado         VARCHAR(10)  NOT NULL DEFAULT 'BORRADOR',
        total          INT          NOT NULL DEFAULT 0,
        enviados       INT          NOT NULL DEFAULT 0,
        errores        INT          NOT NULL DEFAULT 0,
        simulados      INT          NOT NULL DEFAULT 0,
        creado_por     INT          NULL,
        creado_nombre  VARCHAR(200) NULL,
        created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        enviada_at     DATETIME     NULL
      )`);
  } catch (e) { console.error('[wsp_campanas migration]', e.message); }

  // Módulo + funcionalidades + permisos (solo BD, patrón anti-hardcode)
  try {
    const MOD_WSP = 660001;
    await pool.query(`INSERT IGNORE INTO modulos (id_modulo, nombre, icono, ruta, orden) VALUES (?, 'WhatsApp', 'bi-whatsapp', '/whatsapp/', 62)`, [MOD_WSP]);
    const funcs = [
      ['Panel WhatsApp',           'wsp_panel',    '/whatsapp/', 'bi-whatsapp', MOD_WSP],
      ['Atender conversaciones',   'wsp_atender',  null,         null,          MOD_WSP],
      ['Configurar bot WhatsApp',  'wsp_config',   null,         null,          MOD_WSP],
      ['Campañas WhatsApp',        'wsp_campanas', null,         null,          MOD_WSP],
    ];
    const idFunc = {};
    for (const [nombre, codigo, href, icono, idmod] of funcs) {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [codigo]);
      if (ex) { idFunc[codigo] = ex.id_funcionalidad; continue; }
      const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)', [idmod, nombre, codigo, href, icono]);
      idFunc[codigo] = r.insertId;
    }
    const seed = { wsp_panel: [1], wsp_atender: [1], wsp_config: [1], wsp_campanas: [1] };
    for (const [codigo, perfiles] of Object.entries(seed)) {
      const idf = idFunc[codigo]; if (!idf) continue;
      for (const idp of perfiles) {
        const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=? AND id_funcionalidad=? LIMIT 1', [idp, idf]);
        if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
      }
    }
    console.log('[whatsapp] módulo registrado');
  } catch (e) { console.error('[whatsapp permisos]', e.message); }
})();

/* ── Helpers ────────────────────────────────────────────────────────────────── */
const nombreDe = u => `${u?.nombre || ''} ${u?.apellido || ''}`.trim() || u?.email || null;
const normTxt = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// ¿Alguna keyword (CSV) aparece en el texto?
function matchKeywords(texto, keywordsCsv) {
  const t = ' ' + normTxt(texto) + ' ';
  return String(keywordsCsv || '').split(',').map(normTxt).filter(Boolean).some(k => t.includes(k));
}

async function getCfg() {
  const [[c]] = await pool.query('SELECT * FROM wsp_config WHERE id=1');
  return c || {};
}

// ¿Estamos dentro del horario de atención configurado? (hora Chile)
function enHorario(cfg) {
  try {
    const now = new Date(new Date().toLocaleString('sv-SE', { timeZone: 'America/Santiago' }));
    const dia = now.getDay() === 0 ? 7 : now.getDay(); // 1=lun … 7=dom
    if (!String(cfg.dias_habiles || '').split(',').map(s => parseInt(s, 10)).includes(dia)) return false;
    const hm = now.getHours() * 60 + now.getMinutes();
    const [hi, mi] = String(cfg.horario_ini || '09:00').split(':').map(Number);
    const [hf, mf] = String(cfg.horario_fin || '19:00').split(':').map(Number);
    return hm >= hi * 60 + mi && hm <= hf * 60 + mf;
  } catch { return true; }
}

// Pool de usuarios que atienden WhatsApp (permiso wsp_atender) + Administradores
async function poolAtencion() {
  const [rows] = await pool.query(
    `SELECT u.id_usuario FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
       WHERE p.nombre='Administrador' AND u.estado='activo'
     UNION
     SELECT u.id_usuario FROM usuarios u
       JOIN permisos_perfil pp ON pp.id_perfil=u.id_perfil JOIN funcionalidades f ON f.id_funcionalidad=pp.id_funcionalidad
      WHERE f.codigo='wsp_atender' AND pp.habilitado=1 AND u.estado='activo'`);
  return rows.map(r => r.id_usuario);
}

/* Ventana de envío: minutos restantes desde el último mensaje IN del cliente.
   null = el cliente nunca ha escrito (solo campaña saliente) → también cerrada. */
async function ventanaRestante(idConv, cfg) {
  const horas = Math.max(1, parseInt(cfg.ventana_horas) || 23);
  const [[r]] = await pool.query("SELECT TIMESTAMPDIFF(MINUTE, MAX(created_at), NOW()) mins FROM wsp_mensajes WHERE id_conversacion=? AND direccion='IN'", [idConv]);
  if (!r || r.mins == null) return { abierta: false, mins_restantes: 0, horas };
  const rest = horas * 60 - r.mins;
  return { abierta: rest > 0, mins_restantes: Math.max(0, rest), horas };
}

async function guardarMensaje(idConv, { direccion, origen, mensaje, autor_id = null, autor_nombre = null, estado_envio = null, wamid = null }) {
  await pool.query('INSERT INTO wsp_mensajes (id_conversacion, direccion, origen, autor_id, autor_nombre, mensaje, estado_envio, wamid) VALUES (?,?,?,?,?,?,?,?)',
    [idConv, direccion, origen, autor_id, autor_nombre, mensaje, estado_envio, wamid]);
  await pool.query('UPDATE wsp_conversaciones SET ultima_actividad=NOW() WHERE id=?', [idConv]);
}

// Envía por el canal real (o simulado) y registra el mensaje OUT
async function responder(conv, texto, origen = 'BOT', autor = null) {
  if (!texto) return;
  let estado = 'SIMULADO', wamid = null;
  if (!conv.es_simulada) {
    const r = await enviarWhatsApp({ telefono: conv.telefono, texto });
    estado = r.simulado ? 'SIMULADO' : (r.ok ? 'ENVIADO' : 'ERROR');
    wamid = r.wamid || null;
  }
  await guardarMensaje(conv.id, { direccion: 'OUT', origen, mensaje: texto, autor_id: autor?.id_usuario || null, autor_nombre: autor ? nombreDe(autor) : null, estado_envio: estado, wamid });
  return estado;
}

/* ── Herramienta simulación: cuota aproximada con el MOTOR ÚNICO (rentabilidad-core)
      y la tasa vigente del mantenedor Tasas (tramo por 200 UF). La IA NUNCA calcula. */
async function simularCuota(monto, plazo) {
  const m = Math.round(+monto || 0), n = parseInt(plazo) || 0;
  if (!(m >= 500000 && m <= 200000000 && n >= 6 && n <= 60)) return null;
  const CORE = require('../../../../api-gateway/public/js/rentabilidad-core');
  const { getUF } = require('../../../../shared/uf');
  const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
  const uf = await getUF(hoy);
  const [[t]] = await pool.query('SELECT tasa_mensual_menor, tasa_mensual_mayor FROM tasas WHERE fecha_desde<=CURDATE() ORDER BY fecha_desde DESC LIMIT 1');
  if (!t) return null;
  const esMayor = uf ? m > 200 * uf : false;
  const tasa = parseFloat(esMayor ? t.tasa_mensual_mayor : t.tasa_mensual_menor);
  if (!(tasa > 0)) return null;
  const cuota = Math.round(CORE.cuotaFrancesa(m, tasa / 100, n));
  return { monto: m, plazo: n, tasa, cuota };
}

const fmtCLP = v => '$' + Math.round(+v || 0).toLocaleString('es-CL');

/* ── IA conversacional (Haiku): arma el contexto y pide JSON ───────────────── */
async function respuestaIA(conv, texto, cfg) {
  // Base de conocimiento: las respuestas configuradas del bot (paramétricas)
  const [resps] = await pool.query('SELECT nombre, respuesta FROM wsp_respuestas WHERE activo=1 ORDER BY orden, id');
  const conocimiento = resps.map(r => `• ${r.nombre}: ${r.respuesta}`).join('\n');
  // Historial reciente (para conversar con memoria)
  const [hist] = await pool.query('SELECT direccion, origen, mensaje FROM wsp_mensajes WHERE id_conversacion=? ORDER BY id DESC LIMIT 12', [conv.id]);
  const historial = hist.reverse().map(m => (m.direccion === 'IN' ? 'CLIENTE' : (m.origen || 'BOT')) + ': ' + m.mensaje).join('\n');

  const system = (cfg.prompt_ia || PROMPT_IA_DEF) + `

INFORMACIÓN OFICIAL (usa SOLO esto como datos duros; si no está aquí, no lo inventes — deriva):
${conocimiento || '(sin respuestas configuradas)'}

Horario de atención humana: ${cfg.horario_ini}–${cfg.horario_fin}, días ${cfg.dias_habiles} (1=lunes…7=domingo).${conv.nombre ? `\nEl cliente se llama ${conv.nombre}; puedes saludarlo por su primer nombre.` : ''}

SIMULACIÓN DE CUOTA: tú NUNCA calculas cuotas ni das cifras. Si el cliente quiere saber la cuota y ya tienes MONTO A FINANCIAR (en pesos) y PLAZO (meses), agrega al JSON "simulacion":{"monto":X,"plazo":N} y el sistema calculará el valor exacto con la tasa vigente (tu "respuesta" va antes del cálculo, sin cifras). Si falta el monto o el plazo, pídelos. Si el cliente da presupuesto de cuota (cuánto puede pagar al mes), pide confirmar monto y plazo para simular.

Responde SOLO con JSON: {"respuesta": "texto para el cliente", "derivar": true/false, "area": "COMERCIAL"|"COBRANZA"|"OPERACIONES", "motivo": "por qué derivas (si derivas)", "simulacion": {"monto": pesos, "plazo": meses} (solo si corresponde)}`;

  const { datos } = await anthropic.analizar({
    codigo: 'wsp_bot', json: true, max_tokens: 400,
    system,
    prompt: `Conversación hasta ahora:\n${historial}\n\nÚltimo mensaje del CLIENTE: ${texto}`,
  });
  if (!datos || typeof datos.respuesta !== 'string') return null;
  let respuesta = datos.respuesta.trim().slice(0, 1500);
  // Cálculo determinístico de la cuota (motor único, tasa del mantenedor)
  if (datos.simulacion && datos.simulacion.monto && datos.simulacion.plazo) {
    try {
      const s = await simularCuota(datos.simulacion.monto, datos.simulacion.plazo);
      if (s) respuesta += `\n\n💰 *Cuota aproximada: ${fmtCLP(s.cuota)}*\nMonto ${fmtCLP(s.monto)} · ${s.plazo} meses · tasa ${String(s.tasa.toFixed(2)).replace('.', ',')}% mensual\n_Valor referencial, sujeto a evaluación crediticia. No incluye seguros ni gastos._`;
    } catch (e) { console.error('[wsp simulacion]', e.message); }
  }
  return { respuesta, derivar: !!datos.derivar, area: datos.area, motivo: datos.motivo };
}

/* ── MOTOR del bot: procesa un mensaje entrante ────────────────────────────── */
async function procesarEntrante({ telefono, nombre = null, texto, esSimulada = false }) {
  const fono = normalizarFono(telefono) || String(telefono);

  // Conversación abierta más reciente para este número, o crear una nueva
  let [[conv]] = await pool.query("SELECT * FROM wsp_conversaciones WHERE telefono=? AND estado!='CERRADA' AND es_simulada=? ORDER BY id DESC LIMIT 1", [fono, esSimulada ? 1 : 0]);
  if (!conv) {
    // Identificar cliente por teléfono (fuente única: clientes)
    let rut = null, nom = nombre;
    try {
      const [[cli]] = await pool.query(
        `SELECT rut, nombre_completo FROM clientes
          WHERE REPLACE(REPLACE(REPLACE(COALESCE(telefono_movil,''),' ',''),'+',''),'-','') LIKE CONCAT('%', ?)
             OR REPLACE(REPLACE(REPLACE(COALESCE(telefono,''),' ',''),'+',''),'-','') LIKE CONCAT('%', ?) LIMIT 1`,
        [fono.slice(-8), fono.slice(-8)]);
      if (cli) { rut = cli.rut; nom = cli.nombre_completo || nom; }
    } catch (_) {}
    const [r] = await pool.query('INSERT INTO wsp_conversaciones (telefono, nombre, rut_cliente, es_simulada) VALUES (?,?,?,?)', [fono, nom, rut, esSimulada ? 1 : 0]);
    [[conv]] = await pool.query('SELECT * FROM wsp_conversaciones WHERE id=?', [r.insertId]);
    conv._esNueva = true;
  }
  if (nombre && !conv.nombre) await pool.query('UPDATE wsp_conversaciones SET nombre=? WHERE id=?', [nombre, conv.id]);

  await guardarMensaje(conv.id, { direccion: 'IN', origen: 'CLIENTE', mensaje: texto });

  const cfg = await getCfg();

  // Conversación ya derivada → no responde el bot; avisar al agente asignado (o al pool)
  if (conv.estado === 'DERIVADA') {
    const ids = conv.asignada_a ? [conv.asignada_a] : await poolAtencion();
    notificar(ids, { tipo: 'whatsapp', titulo: '💬 WhatsApp: mensaje nuevo', mensaje: `${conv.nombre || conv.telefono}: "${String(texto).slice(0, 90)}"`, href: '/whatsapp/?conv=' + conv.id, clave: 'wsp:' + conv.id }).catch(() => {});
    return { conv, accion: 'AGENTE' };
  }

  // 1) TRIGGERS (problema/riesgo/oportunidad) — mandan sobre las respuestas
  const [triggers] = await pool.query('SELECT * FROM wsp_triggers WHERE activo=1 ORDER BY id');
  const trg = triggers.find(t => matchKeywords(texto, t.keywords));
  if (trg) {
    const deriva = trg.accion === 'DERIVAR';
    await pool.query('UPDATE wsp_conversaciones SET trigger_cat=?, area=?, estado=? WHERE id=?',
      [trg.categoria, trg.area, deriva ? 'DERIVADA' : conv.estado, conv.id]);
    const ids = await poolAtencion();
    notificar(ids, {
      tipo: 'whatsapp', prioridad: trg.prioridad === 'alta' ? 'alta' : 'normal',
      titulo: deriva ? `📲 Cliente esperando en WhatsApp (${trg.area}) — ¿quién lo toma?` : `💬 WhatsApp ${trg.categoria}: ${trg.nombre}`,
      mensaje: `${trg.categoria} · ${conv.nombre || conv.telefono}: "${String(texto).slice(0, 90)}"`,
      href: '/whatsapp/?conv=' + conv.id, clave: 'wsp:' + conv.id,
    }).catch(() => {});
    if (deriva) {
      await responder({ ...conv }, enHorario(cfg) ? (cfg.msg_derivacion || '') : (cfg.msg_fuera_horario || cfg.msg_derivacion || ''));
      return { conv, accion: 'DERIVADA', trigger: trg.nombre };
    }
    // accion ALERTA: avisó pero el bot sigue — cae a respuestas
  }

  if (!cfg.bot_activo) return { conv, accion: 'BOT_OFF' };

  // 2) IA conversacional (Haiku) — si la funcionalidad wsp_bot está activa.
  //    Los triggers ya corrieron (regla dura); la IA además puede pedir derivar.
  try {
    if (anthropic.disponible() && await ia.iaActiva('wsp_bot')) {
      const out = await respuestaIA(conv, texto, cfg);
      if (out && out.respuesta) {
        if (out.derivar) {
          const area = ['COMERCIAL', 'COBRANZA', 'OPERACIONES'].includes(String(out.area || '').toUpperCase()) ? String(out.area).toUpperCase() : 'COMERCIAL';
          await pool.query("UPDATE wsp_conversaciones SET estado='DERIVADA', area=? WHERE id=?", [area, conv.id]);
          notificar(await poolAtencion(), {
            tipo: 'whatsapp', titulo: `📲 Cliente esperando en WhatsApp (${area}) — ¿quién lo toma?`,
            mensaje: `${conv.nombre || conv.telefono}: ${String(out.motivo || texto).slice(0, 90)}`,
            href: '/whatsapp/?conv=' + conv.id, clave: 'wsp:' + conv.id,
          }).catch(() => {});
        }
        await responder(conv, out.respuesta);
        return { conv, accion: out.derivar ? 'IA_DERIVA' : 'IA', motivo: out.motivo };
      }
    }
  } catch (e) { console.error('[wsp ia]', e.message); } // cae al matching por keywords

  // 3) RESPUESTAS configuradas
  const [resps] = await pool.query('SELECT * FROM wsp_respuestas WHERE activo=1 ORDER BY orden, id');
  const resp = resps.find(x => matchKeywords(texto, x.keywords));
  if (resp) { await responder(conv, resp.respuesta); return { conv, accion: 'RESPUESTA', respuesta: resp.nombre }; }

  // 4) Fuera de horario / bienvenida / no entiendo
  if (!enHorario(cfg)) { await responder(conv, cfg.msg_fuera_horario); return { conv, accion: 'FUERA_HORARIO' }; }
  if (conv._esNueva)   { await responder(conv, cfg.msg_bienvenida);    return { conv, accion: 'BIENVENIDA' }; }
  await responder(conv, cfg.msg_no_entiendo);
  return { conv, accion: 'NO_ENTIENDO' };
}

/* ═══ ENDPOINTS ═══════════════════════════════════════════════════════════── */

/* ── Webhook Meta (público: Meta lo llama sin nuestro JWT) ─────────────────── */
exports.webhookVerify = (req, res) => {
  const verify = process.env.WSP_VERIFY || 'autofacil-wsp';
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verify) return res.send(req.query['hub.challenge']);
  res.sendStatus(403);
};

exports.webhookReceive = async (req, res) => {
  res.sendStatus(200); // responder al tiro: Meta reintenta si demora
  try {
    for (const entry of req.body?.entry || []) {
      for (const ch of entry.changes || []) {
        const v = ch.value || {};
        const contactos = {}; (v.contacts || []).forEach(c => { contactos[c.wa_id] = c.profile?.name; });
        for (const m of v.messages || []) {
          if (m.type !== 'text') continue; // fase 1: solo texto
          await procesarEntrante({ telefono: m.from, nombre: contactos[m.from] || null, texto: m.text?.body || '' });
        }
      }
    }
  } catch (e) { console.error('[wsp webhook]', e.message); }
};

/* ── Simulador (probar el bot desde el panel, sin Meta) ────────────────────── */
exports.simular = async (req, res) => {
  try {
    const { telefono, texto } = req.body || {};
    if (!texto) return res.status(400).json({ success: false, error: 'Falta el texto' });
    const r = await procesarEntrante({ telefono: telefono || '56900000000', nombre: 'Simulador', texto, esSimulada: true });
    const [msgs] = await pool.query('SELECT * FROM wsp_mensajes WHERE id_conversacion=? ORDER BY id', [r.conv.id]);
    res.json({ success: true, data: { id_conversacion: r.conv.id, accion: r.accion, mensajes: msgs }, error: null });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

/* ── Configuración general ─────────────────────────────────────────────────── */
exports.getConfig = async (_req, res) => {
  try { res.json({ success: true, data: await getCfg(), error: null }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

exports.setConfig = async (req, res) => {
  try {
    const b = req.body || {};
    await pool.query(`UPDATE wsp_config SET bot_activo=?, horario_ini=?, horario_fin=?, dias_habiles=?,
        msg_bienvenida=?, msg_fuera_horario=?, msg_no_entiendo=?, msg_derivacion=?, prompt_ia=?, ventana_horas=? WHERE id=1`,
      [b.bot_activo ? 1 : 0, b.horario_ini || '09:00', b.horario_fin || '19:00', b.dias_habiles || '1,2,3,4,5,6',
       b.msg_bienvenida || '', b.msg_fuera_horario || '', b.msg_no_entiendo || '', b.msg_derivacion || '', b.prompt_ia || PROMPT_IA_DEF,
       Math.min(Math.max(parseInt(b.ventana_horas) || 23, 1), 24)]);
    auditar({ req, accion: 'EDITAR', modulo: 'whatsapp', entidad: 'wsp_config', entidad_id: '1', detalle: 'Configuración del bot WhatsApp actualizada' });
    res.json({ success: true, data: null, error: null });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

/* ── Respuestas del bot (CRUD) ─────────────────────────────────────────────── */
exports.respuestas = async (_req, res) => {
  try { const [rows] = await pool.query('SELECT * FROM wsp_respuestas ORDER BY orden, id'); res.json({ success: true, data: rows, error: null }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

exports.guardarRespuesta = async (req, res) => {
  try {
    const { nombre, keywords, respuesta, orden = 0, activo = 1 } = req.body || {};
    if (!nombre || !keywords || !respuesta) return res.status(400).json({ success: false, error: 'Faltan campos' });
    if (req.params.id) await pool.query('UPDATE wsp_respuestas SET nombre=?, keywords=?, respuesta=?, orden=?, activo=? WHERE id=?', [nombre, keywords, respuesta, orden, activo ? 1 : 0, req.params.id]);
    else await pool.query('INSERT INTO wsp_respuestas (nombre, keywords, respuesta, orden, activo) VALUES (?,?,?,?,?)', [nombre, keywords, respuesta, orden, activo ? 1 : 0]);
    auditar({ req, accion: req.params.id ? 'EDITAR' : 'CREAR', modulo: 'whatsapp', entidad: 'wsp_respuestas', entidad_id: String(req.params.id || ''), detalle: `Respuesta bot: ${nombre}` });
    res.json({ success: true, data: null, error: null });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

exports.eliminarRespuesta = async (req, res) => {
  try { await pool.query('DELETE FROM wsp_respuestas WHERE id=?', [req.params.id]); res.json({ success: true, data: null, error: null }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

/* ── Triggers (CRUD) ───────────────────────────────────────────────────────── */
exports.triggers = async (_req, res) => {
  try { const [rows] = await pool.query('SELECT * FROM wsp_triggers ORDER BY FIELD(categoria,"PROBLEMA","RIESGO","OPORTUNIDAD"), id'); res.json({ success: true, data: rows, error: null }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

exports.guardarTrigger = async (req, res) => {
  try {
    const { categoria, nombre, keywords, accion = 'DERIVAR', area = 'COMERCIAL', prioridad = 'normal', activo = 1 } = req.body || {};
    if (!categoria || !nombre || !keywords) return res.status(400).json({ success: false, error: 'Faltan campos' });
    if (req.params.id) await pool.query('UPDATE wsp_triggers SET categoria=?, nombre=?, keywords=?, accion=?, area=?, prioridad=?, activo=? WHERE id=?', [categoria, nombre, keywords, accion, area, prioridad, activo ? 1 : 0, req.params.id]);
    else await pool.query('INSERT INTO wsp_triggers (categoria, nombre, keywords, accion, area, prioridad, activo) VALUES (?,?,?,?,?,?,?)', [categoria, nombre, keywords, accion, area, prioridad, activo ? 1 : 0]);
    auditar({ req, accion: req.params.id ? 'EDITAR' : 'CREAR', modulo: 'whatsapp', entidad: 'wsp_triggers', entidad_id: String(req.params.id || ''), detalle: `Trigger ${categoria}: ${nombre}` });
    res.json({ success: true, data: null, error: null });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

exports.eliminarTrigger = async (req, res) => {
  try { await pool.query('DELETE FROM wsp_triggers WHERE id=?', [req.params.id]); res.json({ success: true, data: null, error: null }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

/* ── Bandeja: conversaciones ───────────────────────────────────────────────── */
exports.conversaciones = async (req, res) => {
  try {
    const { estado, area, q } = req.query;
    const where = ['1=1'], params = [];
    if (estado) { where.push('c.estado=?'); params.push(estado); }
    if (area)   { where.push('c.area=?');   params.push(area); }
    if (q)      { where.push('(c.telefono LIKE ? OR c.nombre LIKE ? OR c.rut_cliente LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const [rows] = await pool.query(
      `SELECT c.*, (SELECT mensaje FROM wsp_mensajes m WHERE m.id_conversacion=c.id ORDER BY m.id DESC LIMIT 1) ultimo_msg,
              (SELECT COUNT(*) FROM wsp_mensajes m WHERE m.id_conversacion=c.id) n_msgs
         FROM wsp_conversaciones c WHERE ${where.join(' AND ')} ORDER BY c.ultima_actividad DESC LIMIT 300`, params);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

exports.conversacion = async (req, res) => {
  try {
    const [[conv]] = await pool.query('SELECT * FROM wsp_conversaciones WHERE id=?', [req.params.id]);
    if (!conv) return res.status(404).json({ success: false, error: 'No existe' });
    const [msgs] = await pool.query('SELECT * FROM wsp_mensajes WHERE id_conversacion=? ORDER BY id', [req.params.id]);
    const ventana = await ventanaRestante(conv.id, await getCfg());
    res.json({ success: true, data: { ...conv, mensajes: msgs, ventana }, error: null });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

exports.responderConv = async (req, res) => {
  try {
    const { texto } = req.body || {};
    if (!texto) return res.status(400).json({ success: false, error: 'Falta el texto' });
    const [[conv]] = await pool.query('SELECT * FROM wsp_conversaciones WHERE id=?', [req.params.id]);
    if (!conv) return res.status(404).json({ success: false, error: 'No existe' });
    // Ventana Meta: fuera del plazo configurable no se puede escribir en esta conversación
    if (!conv.es_simulada) {
      const v = await ventanaRestante(conv.id, await getCfg());
      if (!v.abierta) return res.status(400).json({ success: false, error: `Ventana de ${v.horas} h cerrada: el cliente debe escribir primero (o contactarlo vía campaña con plantilla).` });
    }
    // Al responder un agente, la conversación queda tomada por él
    if (conv.estado !== 'CERRADA') await pool.query("UPDATE wsp_conversaciones SET estado='DERIVADA', asignada_a=?, asignada_nombre=? WHERE id=? AND asignada_a IS NULL", [req.user.id_usuario, nombreDe(req.user), req.params.id]);
    const estado = await responder(conv, texto, 'AGENTE', req.user);
    res.json({ success: true, data: { estado_envio: estado }, error: null });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

exports.accionConv = async (req, res) => {
  try {
    const { accion, area } = req.body || {};
    const [[conv]] = await pool.query('SELECT * FROM wsp_conversaciones WHERE id=?', [req.params.id]);
    if (!conv) return res.status(404).json({ success: false, error: 'No existe' });
    if (accion === 'TOMAR') {
      // Carrera justa: el PRIMERO que toca "Tomar" se queda con el cliente (update atómico)
      const [r] = await pool.query(
        "UPDATE wsp_conversaciones SET estado='DERIVADA', asignada_a=?, asignada_nombre=? WHERE id=? AND (asignada_a IS NULL OR asignada_a=?)",
        [req.user.id_usuario, nombreDe(req.user), req.params.id, req.user.id_usuario]);
      if (!r.affectedRows) {
        const [[c2]] = await pool.query('SELECT asignada_nombre FROM wsp_conversaciones WHERE id=?', [req.params.id]);
        return res.status(409).json({ success: false, error: `Ya la tomó ${c2?.asignada_nombre || 'otro ejecutivo'}` });
      }
    }
    else if (accion === 'CERRAR') await pool.query("UPDATE wsp_conversaciones SET estado='CERRADA' WHERE id=?", [req.params.id]);
    else if (accion === 'BOT')    await pool.query("UPDATE wsp_conversaciones SET estado='BOT', asignada_a=NULL, asignada_nombre=NULL WHERE id=?", [req.params.id]);
    else if (accion === 'DERIVAR') {
      await pool.query("UPDATE wsp_conversaciones SET estado='DERIVADA', area=? WHERE id=?", [area || conv.area, req.params.id]);
      const ids = await poolAtencion();
      notificar(ids, { tipo: 'whatsapp', titulo: '💬 WhatsApp: conversación derivada', mensaje: `${conv.nombre || conv.telefono} → ${area || conv.area || 'atención'}`, href: '/whatsapp/?conv=' + conv.id, clave: 'wsp:' + conv.id }).catch(() => {});
    } else return res.status(400).json({ success: false, error: 'Acción inválida' });
    auditar({ req, accion: 'EDITAR', modulo: 'whatsapp', entidad: 'wsp_conversaciones', entidad_id: String(req.params.id), detalle: `Conversación ${req.params.id}: ${accion}` });
    res.json({ success: true, data: null, error: null });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

/* ── Campañas de salida ────────────────────────────────────────────────────── */
// Resuelve la audiencia a una lista de {telefono, nombre, rut}
async function resolverAudiencia(tipo, telefonosManual) {
  if (tipo === 'MANUAL') {
    return String(telefonosManual || '').split(/[\n,;]+/).map(s => s.trim()).filter(Boolean)
      .map(t => ({ telefono: t, nombre: null, rut: null }));
  }
  if (tipo === 'MORA') {
    const [rows] = await pool.query(
      `SELECT DISTINCT cl.telefono_movil telefono, cl.nombre_completo nombre, cl.rut
         FROM creditos c JOIN clientes cl ON cl.rut = c.rut_cliente
        WHERE c.financiera='AUTOFACIL' AND c.estado_cartera IN ('MORA','EN MORA','VENCIDO')
          AND COALESCE(cl.telefono_movil,'') != ''`);
    return rows;
  }
  if (tipo === 'VIGENTES') {
    const [rows] = await pool.query(
      `SELECT DISTINCT cl.telefono_movil telefono, cl.nombre_completo nombre, cl.rut
         FROM creditos c JOIN clientes cl ON cl.rut = c.rut_cliente
        WHERE c.financiera='AUTOFACIL' AND c.estado_cartera IN ('VIGENTE','MORA','EN MORA','VENCIDO')
          AND COALESCE(cl.telefono_movil,'') != ''`);
    return rows;
  }
  return [];
}

exports.campanas = async (_req, res) => {
  try { const [rows] = await pool.query('SELECT * FROM wsp_campanas ORDER BY id DESC LIMIT 100'); res.json({ success: true, data: rows, error: null }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

exports.guardarCampana = async (req, res) => {
  try {
    const { nombre, mensaje, plantilla = null, audiencia_tipo = 'MANUAL', telefonos = '' } = req.body || {};
    if (!nombre || !mensaje) return res.status(400).json({ success: false, error: 'Faltan campos' });
    const aud = await resolverAudiencia(audiencia_tipo, telefonos);
    if (req.params.id) {
      const [[c]] = await pool.query('SELECT estado FROM wsp_campanas WHERE id=?', [req.params.id]);
      if (!c || c.estado !== 'BORRADOR') return res.status(400).json({ success: false, error: 'Solo se editan borradores' });
      await pool.query('UPDATE wsp_campanas SET nombre=?, mensaje=?, plantilla=?, audiencia_tipo=?, telefonos=?, total=? WHERE id=?', [nombre, mensaje, plantilla, audiencia_tipo, telefonos, aud.length, req.params.id]);
    } else {
      await pool.query('INSERT INTO wsp_campanas (nombre, mensaje, plantilla, audiencia_tipo, telefonos, total, creado_por, creado_nombre) VALUES (?,?,?,?,?,?,?,?)',
        [nombre, mensaje, plantilla, audiencia_tipo, telefonos, aud.length, req.user.id_usuario, nombreDe(req.user)]);
    }
    res.json({ success: true, data: { total: aud.length }, error: null });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

exports.previewAudiencia = async (req, res) => {
  try {
    const aud = await resolverAudiencia(req.query.tipo || 'MANUAL', req.query.telefonos || '');
    res.json({ success: true, data: { total: aud.length, muestra: aud.slice(0, 10) }, error: null });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

exports.enviarCampana = async (req, res) => {
  try {
    const [[camp]] = await pool.query('SELECT * FROM wsp_campanas WHERE id=?', [req.params.id]);
    if (!camp) return res.status(404).json({ success: false, error: 'No existe' });
    if (camp.estado !== 'BORRADOR') return res.status(400).json({ success: false, error: 'La campaña ya fue enviada' });
    const aud = await resolverAudiencia(camp.audiencia_tipo, camp.telefonos);
    if (!aud.length) return res.status(400).json({ success: false, error: 'Audiencia vacía' });
    await pool.query("UPDATE wsp_campanas SET estado='ENVIANDO', total=? WHERE id=?", [aud.length, camp.id]);
    res.json({ success: true, data: { total: aud.length }, error: null }); // responder al tiro; el envío sigue en background

    let enviados = 0, errores = 0, simulados = 0;
    for (const dest of aud) {
      try {
        const fono = normalizarFono(dest.telefono);
        if (!fono) { errores++; continue; }
        const r = await enviarWhatsApp({ telefono: fono, texto: camp.mensaje, plantilla: camp.plantilla || undefined, variables: [] });
        // Registrar en la conversación del número (crea si no existe)
        let [[conv]] = await pool.query("SELECT * FROM wsp_conversaciones WHERE telefono=? AND es_simulada=0 ORDER BY id DESC LIMIT 1", [fono]);
        if (!conv) {
          const [ins] = await pool.query('INSERT INTO wsp_conversaciones (telefono, nombre, rut_cliente) VALUES (?,?,?)', [fono, dest.nombre, dest.rut]);
          conv = { id: ins.insertId };
        }
        await guardarMensaje(conv.id, { direccion: 'OUT', origen: 'CAMPANA', mensaje: camp.mensaje, estado_envio: r.simulado ? 'SIMULADO' : (r.ok ? 'ENVIADO' : 'ERROR'), wamid: r.wamid || null });
        if (r.simulado) simulados++; else if (r.ok) enviados++; else errores++;
        await new Promise(ok => setTimeout(ok, 150)); // no gatillar rate limit de Meta
      } catch (_) { errores++; }
    }
    await pool.query("UPDATE wsp_campanas SET estado='ENVIADA', enviados=?, errores=?, simulados=?, enviada_at=NOW() WHERE id=?", [enviados, errores, simulados, camp.id]);
    auditar({ req, accion: 'CREAR', modulo: 'whatsapp', entidad: 'wsp_campanas', entidad_id: String(camp.id), detalle: `Campaña "${camp.nombre}" enviada: ${enviados} ok, ${simulados} simulados, ${errores} errores de ${aud.length}` });
  } catch (e) {
    try { await pool.query("UPDATE wsp_campanas SET estado='BORRADOR' WHERE id=?", [req.params.id]); } catch (_) {}
    if (!res.headersSent) res.status(500).json({ success: false, error: e.message });
  }
};

exports.eliminarCampana = async (req, res) => {
  try {
    const [r] = await pool.query("DELETE FROM wsp_campanas WHERE id=? AND estado='BORRADOR'", [req.params.id]);
    if (!r.affectedRows) return res.status(400).json({ success: false, error: 'Solo se eliminan borradores' });
    res.json({ success: true, data: null, error: null });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
};
