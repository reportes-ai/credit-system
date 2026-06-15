'use strict';
/**
 * Servidor WebSocket de Atención Remota — se cuelga del mismo HTTP server del
 * api-gateway (path /ws/atencion). Maneja: chat en tiempo real, presencia,
 * toma de conversaciones desde la cola (hasta N en paralelo por ejecutivo) y
 * el relay de señalización WebRTC (audio/video/compartir pantalla). La media
 * va peer-to-peer entre dealer y ejecutivo; por acá sólo viaja la señalización.
 *
 * Estado en memoria (instancia única en Render). Si algún día se escala a
 * múltiples instancias, este estado debe migrar a Redis pub/sub.
 */
const { WebSocketServer } = require('ws');
const jwt  = require('jsonwebtoken');
const url  = require('url');
const pool = require('../../../shared/config/database');
const { JWT_SECRET } = require('../../../shared/middleware/auth');
const { tieneFunc } = require('../../../shared/middleware/permisos');
const C = require('./controllers/atencion.controller');

const execs = new Map();   // id_usuario → Set<ws>   (ejecutivos conectados)
const rooms = new Map();   // id_conversacion → Set<ws> (participantes en sala)

const send = (ws, obj) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (_) {} };
const roomSet = (id) => rooms.get(Number(id)) || new Set();
function joinRoom(id, ws) { id = Number(id); if (!rooms.has(id)) rooms.set(id, new Set()); rooms.get(id).add(ws); ws.rooms.add(id); }
function leaveRoom(id, ws) { id = Number(id); const s = rooms.get(id); if (s) { s.delete(ws); if (!s.size) rooms.delete(id); } ws.rooms.delete(id); }
function relayRoom(id, obj, exceptWs) { for (const w of roomSet(id)) if (w !== exceptWs) send(w, obj); }

async function broadcastCola() {
  const espera = await C.colaEspera();
  for (const set of execs.values()) for (const w of set) send(w, { t: 'cola', espera });
}
async function enviarActivas(id_usuario) {
  const activas = await C.activasDe(id_usuario);
  const set = execs.get(id_usuario); if (set) for (const w of set) send(w, { t: 'activas', activas });
}

function initAtencionWS(server) {
  const wss = new WebSocketServer({ server, path: '/ws/atencion' });

  wss.on('connection', async (ws, req) => {
    let ident;
    try {
      const { token } = url.parse(req.url, true).query;
      const d = jwt.verify(token, JWT_SECRET);
      ident = d.tipo === 'dealer'
        ? { tipo: 'dealer', id: d.id_cuenta, id_cuenta: d.id_cuenta, id_dealer: d.id_dealer, rut: d.rut, nombre: d.nombre || 'Dealer' }
        : { tipo: 'user', id: d.id_usuario, nombre: [d.nombre, d.apellido].filter(Boolean).join(' ') || 'Ejecutivo' };
    } catch { return ws.close(4001, 'auth'); }

    // El ejecutivo interno necesita el permiso del módulo para operar la consola.
    if (ident.tipo === 'user' && !(await tieneFunc(ident.id, 'atencion_remota'))) return ws.close(4003, 'forbidden');

    ws.ident = ident; ws.rooms = new Set(); ws.isAlive = true; ws.disponible = false;
    ws.on('pong', () => { ws.isAlive = true; });

    const cfg = await C.getCfg().catch(() => ({ max_chats: 3 }));
    send(ws, { t: 'ready', perfil: ident.tipo, nombre: ident.nombre, max_chats: cfg.max_chats });

    if (ident.tipo === 'user') {
      if (!execs.has(ident.id)) execs.set(ident.id, new Set());
      execs.get(ident.id).add(ws);
      send(ws, { t: 'cola', espera: await C.colaEspera() });
      await enviarActivas(ident.id);
    } else {
      // Dealer: reanuda su conversación abierta si existe (ESPERA/ACTIVA).
      const [[abierta]] = await pool.query(
        "SELECT * FROM ar_conversaciones WHERE id_cuenta=? AND estado IN ('ESPERA','ACTIVA') ORDER BY id DESC LIMIT 1",
        [ident.id_cuenta]);
      if (abierta) {
        joinRoom(abierta.id, ws);
        send(ws, { t: 'started', conversacion: abierta, reanudada: true });
        relayRoom(abierta.id, { t: 'presencia', id_conversacion: abierta.id, parte: 'dealer', online: true }, ws);
      }
    }

    ws.on('message', async (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      try { await handle(ws, m); } catch (e) { console.error('[ws atencion]', e.message); send(ws, { t: 'error', msg: 'Error procesando la solicitud' }); }
    });

    ws.on('close', () => {
      for (const id of ws.rooms) {
        const parte = ident.tipo === 'dealer' ? 'dealer' : 'ejecutivo';
        relayRoom(id, { t: 'presencia', id_conversacion: id, parte, online: false }, ws);
        const s = rooms.get(id); if (s) { s.delete(ws); if (!s.size) rooms.delete(id); }
      }
      if (ident.tipo === 'user') { const set = execs.get(ident.id); if (set) { set.delete(ws); if (!set.size) execs.delete(ident.id); } }
    });
  });

  // Heartbeat: descarta sockets muertos para que la presencia sea fiable.
  const hb = setInterval(() => {
    wss.clients.forEach(ws => { if (ws.isAlive === false) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch (_) {} });
  }, 30000);
  wss.on('close', () => clearInterval(hb));

  console.log('✓ WS Atención Remota en /ws/atencion');
  return wss;
}

/* ── Router de mensajes ──────────────────────────────────────────────────── */
async function handle(ws, m) {
  const I = ws.ident;

  // ── Dealer abre/asegura su conversación ──
  if (m.t === 'start' && I.tipo === 'dealer') {
    const [[abierta]] = await pool.query(
      "SELECT * FROM ar_conversaciones WHERE id_cuenta=? AND estado IN ('ESPERA','ACTIVA') ORDER BY id DESC LIMIT 1", [I.id_cuenta]);
    let conv = abierta;
    if (!conv) {
      conv = await C.crearConversacion({ id_dealer: I.id_dealer, id_cuenta: I.id_cuenta, rut: I.rut, nombre: I.nombre, asunto: m.asunto, canal: 'CHAT' });
    }
    joinRoom(conv.id, ws);
    send(ws, { t: 'started', conversacion: conv, reanudada: !!abierta });
    if (conv.estado === 'ESPERA') await broadcastCola();
    return;
  }

  // ── Ejecutivo toma una conversación de la cola ──
  if (m.t === 'claim' && I.tipo === 'user') {
    const conv = await C.getConversacion(m.id);
    if (!conv || conv.estado !== 'ESPERA') { send(ws, { t: 'error', msg: 'La conversación ya no está en espera' }); await broadcastCola(); return; }
    const cfg = await C.getCfg();
    const n = await C.contarActivas(I.id);
    if (n >= (cfg.max_chats || 3)) { send(ws, { t: 'error', msg: `Máximo ${cfg.max_chats} chats en paralelo` }); return; }
    const asignada = await C.asignarConversacion(conv.id, I.id, I.nombre);
    joinRoom(conv.id, ws);
    const sys = await C.persistMensaje({ id_conversacion: conv.id, emisor: 'SISTEMA', cuerpo: `Te atiende ${I.nombre}.`, tipo: 'SISTEMA' });
    send(ws, { t: 'asignada', conversacion: asignada });
    relayRoom(conv.id, { t: 'asignada', conversacion: asignada }, ws);
    relayRoom(conv.id, { t: 'mensaje', id_conversacion: conv.id, mensaje: sys }, null);
    await broadcastCola();
    await enviarActivas(I.id);
    return;
  }

  // ── Ejecutivo (re)abre el panel de una conversación activa suya ──
  if (m.t === 'join' && I.tipo === 'user') {
    const conv = await C.getConversacion(m.id);
    if (conv && conv.id_ejecutivo === I.id) {
      joinRoom(conv.id, ws);
      relayRoom(conv.id, { t: 'presencia', id_conversacion: conv.id, parte: 'ejecutivo', online: true }, ws);
    }
    return;
  }
  if (m.t === 'leave') { leaveRoom(m.id, ws); return; }

  // ── Validación de pertenencia para chat / typing / rtc / close ──
  const conv = await C.getConversacion(m.id);
  if (!conv) return;
  const esDueno = I.tipo === 'dealer' ? conv.id_cuenta === I.id_cuenta : conv.id_ejecutivo === I.id;
  if (!esDueno) { send(ws, { t: 'error', msg: 'Sin acceso a esta conversación' }); return; }

  if (m.t === 'chat') {
    const cuerpo = String(m.cuerpo || '').slice(0, 4000).trim();
    if (!cuerpo) return;
    const emisor = I.tipo === 'dealer' ? 'DEALER' : 'EJECUTIVO';
    const mensaje = await C.persistMensaje({ id_conversacion: conv.id, emisor, id_usuario: I.tipo === 'user' ? I.id : null, autor_nombre: I.nombre, cuerpo, tipo: 'TEXTO' });
    send(ws, { t: 'mensaje', id_conversacion: conv.id, mensaje });
    relayRoom(conv.id, { t: 'mensaje', id_conversacion: conv.id, mensaje }, ws);
    return;
  }

  if (m.t === 'typing') {
    relayRoom(conv.id, { t: 'typing', id_conversacion: conv.id, emisor: I.tipo, on: !!m.on }, ws);
    return;
  }

  // ── Señalización WebRTC: relay 1-a-1 al otro participante de la sala ──
  if (m.t === 'rtc') {
    relayRoom(conv.id, { t: 'rtc', id_conversacion: conv.id, kind: m.kind, payload: m.payload, from: I.tipo }, ws);
    return;
  }

  if (m.t === 'close') {
    const cerrada = await C.cerrarConversacion(conv.id);
    relayRoom(conv.id, { t: 'cerrada', id_conversacion: conv.id }, null);
    send(ws, { t: 'cerrada', id_conversacion: conv.id });
    for (const w of roomSet(conv.id)) leaveRoom(conv.id, w);
    if (I.tipo === 'user') await enviarActivas(I.id);
    await broadcastCola();
    return;
  }
}

/* Empuja a la sala un mensaje ya persistido (lo llama el controller REST tras
   subir un adjunto, para que ambos lados lo vean en tiempo real). */
function relayMensaje(id_conversacion, mensaje) {
  relayRoom(id_conversacion, { t: 'mensaje', id_conversacion: Number(id_conversacion), mensaje }, null);
}

module.exports = { initAtencionWS, relayMensaje };
