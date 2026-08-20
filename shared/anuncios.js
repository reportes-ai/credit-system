'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Anuncios "push" a TODA la app (banner que baja desde arriba).
   - Config PARAMÉTRICA por evento en tabla anuncios_config (mantenedor de Alertas):
     activo, mensaje (plantilla con tokens {ejecutivo}…), colores, ancho, sonido,
     segundos antes del banner y duración visible.
   - Canal de entrega: COLA en tabla anuncios_cola. El front (app-version.js) manda en
     su poll de /api/mantenimiento el id del último anuncio que ya mostró y recibe los
     posteriores. Así el que tenía la pestaña cerrada los escucha al volver — antes se
     publicaba un solo anuncio "fresco" por 45s y quien no estaba conectado en esa
     ventana no se enteraba nunca (pedido de Pato, 16-08-2026: todos deben saber que
     un ejecutivo colocó un crédito).
   - Acotado por VENTANA_HORAS y MAX_PENDIENTES: al volver tras dos días no se
     encadenan veinte campanas, suenan los últimos y listo.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('./config/database');

const VENTANA_HORAS   = 12;   // más viejo que esto ya no se anuncia al reconectar
const MAX_PENDIENTES  = 5;    // tope de anuncios encadenados en una misma vuelta
const RETENCION_DIAS  = 7;    // la cola se poda sola

// Eventos que pueden disparar un anuncio (extensible). tokens = variables del mensaje.
const EVENTOS = [
  {
    evento: 'credito_otorgado', label: 'Crédito otorgado', tokens: ['{ejecutivo}'], icono: '🎉',
    default: {
      activo: 1, mensaje: '{ejecutivo} acaba de colocar un nuevo crédito',
      color_fondo: '#0a0a0a', color_texto: '#ffffff', ancho_pct: 33,
      sonido: 'anuncio', segundos_antes: 2, duracion_seg: 6,
    },
  },
  {
    evento: 'operacion_anulada', label: 'Operación anulada', icono: '😭',
    tokens: ['{op}', '{ejecutivo}', '{usuario}'],
    default: {
      activo: 1, mensaje: 'Se anuló la operación {op} de {ejecutivo}',
      color_fondo: '#7f1d1d', color_texto: '#ffffff', ancho_pct: 33,
      sonido: 'trompeta', segundos_antes: 2, duracion_seg: 6,
    },
  },
];

// Sonidos disponibles (sintetizados en app-version.js / reproducir()).
const SONIDOS = [
  { id: 'anuncio',  label: '🛫 Aeropuerto (4 notas)' },
  { id: 'campana',  label: '🛎️ Campana' },
  { id: 'dingdong', label: '🔔 Timbre' },
  { id: 'aplausos', label: '👏 Aplausos' },
  { id: 'alarma',   label: '🚨 Alarma' },
  { id: 'redoble',  label: '🥁 Redoble de tambores' },
  { id: 'trompeta', label: '🎺 Trompeta' },
  { id: 'none',     label: '🔇 Sin sonido' },
];

const ready = (async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS anuncios_config (
      evento         VARCHAR(40)  PRIMARY KEY,
      activo         TINYINT(1)   NOT NULL DEFAULT 1,
      mensaje        VARCHAR(200) NOT NULL,
      color_fondo    VARCHAR(20)  NOT NULL DEFAULT '#0a0a0a',
      color_texto    VARCHAR(20)  NOT NULL DEFAULT '#ffffff',
      ancho_pct      INT          NOT NULL DEFAULT 33,
      sonido         VARCHAR(20)  NOT NULL DEFAULT 'anuncio',
      segundos_antes INT          NOT NULL DEFAULT 2,
      duracion_seg   INT          NOT NULL DEFAULT 6,
      updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS anuncios_cola (
      id        BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
      evento    VARCHAR(40)  NOT NULL,
      texto     VARCHAR(200) NOT NULL,
      opts      VARCHAR(500) NOT NULL DEFAULT '{}',
      creado_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_cola_fecha (creado_at)
    )`);
    for (const e of EVENTOS) {
      const d = e.default;
      await pool.query(
        `INSERT IGNORE INTO anuncios_config
           (evento, activo, mensaje, color_fondo, color_texto, ancho_pct, sonido, segundos_antes, duracion_seg)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [e.evento, d.activo, d.mensaje, d.color_fondo, d.color_texto, d.ancho_pct, d.sonido, d.segundos_antes, d.duracion_seg]);
    }
  } catch (e) { console.error('[anuncios migration]', e.message); }
})();

const aplicarVars = (tpl, vars) =>
  String(tpl == null ? '' : tpl).replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null) ? String(vars[k]) : '');

// Dispara el anuncio de un evento, aplicando su plantilla y opciones de presentación.
async function publicarAnuncio(evento, vars) {
  try {
    await ready;
    const [[cfg]] = await pool.query('SELECT * FROM anuncios_config WHERE evento = ? LIMIT 1', [evento]);
    if (!cfg || !cfg.activo) return;                 // desactivado en el mantenedor → no molesta
    const texto = aplicarVars(cfg.mensaje, vars).trim().slice(0, 200);
    if (!texto) return;
    // El ícono es propio del evento (celebrar un crédito ≠ anunciar una anulación)
    const icono = (EVENTOS.find(e => e.evento === evento) || {}).icono || '🎉';
    const opts = { bg: cfg.color_fondo, fg: cfg.color_texto, ancho: cfg.ancho_pct, icon: icono,
                   sonido: cfg.sonido, antes: cfg.segundos_antes, dur: cfg.duracion_seg };
    await pool.query('INSERT INTO anuncios_cola (evento, texto, opts) VALUES (?,?,?)',
      [evento, texto, JSON.stringify(opts).slice(0, 500)]);
    await pool.query('DELETE FROM anuncios_cola WHERE creado_at < NOW() - INTERVAL ? DAY', [RETENCION_DIAS]);
  } catch (e) { console.error('[anuncios publicar]', e.message); }
}

/* Anuncios que el cliente todavía no mostró. `desde` = id del último que ya mostró
   (lo guarda en localStorage, así sobrevive a cerrar la pestaña).
   Devuelve SIEMPRE `ultimo` para que un navegador nuevo parta desde el presente y no
   le suene el historial completo la primera vez. */
async function leerAnuncio(desde) {
  try {
    const [[mx]] = await pool.query('SELECT MAX(id) AS ultimo FROM anuncios_cola');
    const ultimo = mx && mx.ultimo != null ? Number(mx.ultimo) : 0;
    const d = Number.parseInt(desde, 10);
    if (!Number.isFinite(d) || d < 0) return { ultimo, lista: [] };   // primera vez → solo la marca
    if (d >= ultimo) return { ultimo, lista: [] };
    const [rows] = await pool.query(
      `SELECT id, texto, opts FROM anuncios_cola
        WHERE id > ? AND creado_at >= NOW() - INTERVAL ? HOUR
        ORDER BY id DESC LIMIT ?`, [d, VENTANA_HORAS, MAX_PENDIENTES]);
    const lista = rows.reverse().map(r => {
      let opts = {}; try { opts = typeof r.opts === 'object' && r.opts ? r.opts : JSON.parse(r.opts || '{}'); } catch (_) {}
      return { id: Number(r.id), texto: r.texto, opts };
    });
    return { ultimo, lista };
  } catch (e) { return { ultimo: 0, lista: [] }; }
}

// Para el mantenedor: lista de eventos con su config actual.
async function getAnunciosConfig() {
  await ready;
  const [rows] = await pool.query('SELECT * FROM anuncios_config');
  const byEv = {}; rows.forEach(r => { byEv[r.evento] = r; });
  return EVENTOS.map(e => ({ evento: e.evento, label: e.label, tokens: e.tokens, cfg: byEv[e.evento] || null }));
}

async function saveAnunciosConfig(evento, c) {
  await ready;
  if (!EVENTOS.find(e => e.evento === evento)) throw new Error('Evento inválido');
  const sonido = SONIDOS.find(s => s.id === c.sonido) ? c.sonido : 'anuncio';
  await pool.query(
    `UPDATE anuncios_config SET activo=?, mensaje=?, color_fondo=?, color_texto=?, ancho_pct=?, sonido=?, segundos_antes=?, duracion_seg=? WHERE evento=?`,
    [c.activo ? 1 : 0, String(c.mensaje || '').slice(0, 200),
     String(c.color_fondo || '#0a0a0a').slice(0, 20), String(c.color_texto || '#ffffff').slice(0, 20),
     Math.min(100, Math.max(15, parseInt(c.ancho_pct) || 33)), sonido,
     Math.min(10, Math.max(0, parseInt(c.segundos_antes) || 0)),
     Math.min(30, Math.max(2, parseInt(c.duracion_seg) || 6)), evento]);
}

module.exports = { publicarAnuncio, leerAnuncio, getAnunciosConfig, saveAnunciosConfig, EVENTOS, SONIDOS };
