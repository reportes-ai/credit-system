'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Anuncios "push" a TODA la app (banner que baja desde arriba).
   - Config PARAMÉTRICA por evento en tabla anuncios_config (mantenedor de Alertas):
     activo, mensaje (plantilla con tokens {ejecutivo}…), colores, ancho, sonido,
     segundos antes del banner y duración visible.
   - Canal de entrega: tabla mantenimiento_config (la misma que humoradas/mantención),
     claves anuncio_*. El front (app-version.js) lo detecta en su poll de
     /api/mantenimiento. Frescura: solo se entrega si tiene < FRESH_MS (no molestar a
     quien recién abre la app). Dedup por nonce en el cliente.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('./config/database');

const FRESH_MS = 45000;   // 45s: cubre el poll de 12s y no molesta a quien entra tarde

// Eventos que pueden disparar un anuncio (extensible). tokens = variables del mensaje.
const EVENTOS = [
  {
    evento: 'credito_otorgado', label: 'Crédito otorgado', tokens: ['{ejecutivo}'],
    default: {
      activo: 1, mensaje: '{ejecutivo} acaba de colocar un nuevo crédito',
      color_fondo: '#0a0a0a', color_texto: '#ffffff', ancho_pct: 33,
      sonido: 'anuncio', segundos_antes: 2, duracion_seg: 6,
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

const setKv = (k, v) =>
  pool.query("INSERT INTO mantenimiento_config (clave, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)", [k, v]);

// Dispara el anuncio de un evento, aplicando su plantilla y opciones de presentación.
async function publicarAnuncio(evento, vars) {
  try {
    await ready;
    const [[cfg]] = await pool.query('SELECT * FROM anuncios_config WHERE evento = ? LIMIT 1', [evento]);
    if (!cfg || !cfg.activo) return;                 // desactivado en el mantenedor → no molesta
    const texto = aplicarVars(cfg.mensaje, vars).trim().slice(0, 200);
    if (!texto) return;
    const opts = { bg: cfg.color_fondo, fg: cfg.color_texto, ancho: cfg.ancho_pct,
                   sonido: cfg.sonido, antes: cfg.segundos_antes, dur: cfg.duracion_seg };
    const now = String(Date.now());
    await setKv('anuncio_texto', texto);
    await setKv('anuncio_opts', JSON.stringify(opts));
    await setKv('anuncio_nonce', now);   // instancia → el cliente lo muestra una vez
    await setKv('anuncio_at', now);      // marca de tiempo para la frescura
  } catch (e) { console.error('[anuncios publicar]', e.message); }
}

// Lee el anuncio vigente (o null si no hay / venció la frescura). Incluye opciones.
async function leerAnuncio() {
  try {
    const [rows] = await pool.query("SELECT clave, valor FROM mantenimiento_config WHERE clave IN ('anuncio_texto','anuncio_opts','anuncio_nonce','anuncio_at')");
    const m = {}; rows.forEach(r => { m[r.clave] = r.valor; });
    if (!m.anuncio_texto || !m.anuncio_nonce) return null;
    if (Date.now() - parseInt(m.anuncio_at || '0', 10) > FRESH_MS) return null;
    let opts = {}; try { opts = JSON.parse(m.anuncio_opts || '{}'); } catch (_) {}
    return { texto: m.anuncio_texto, nonce: m.anuncio_nonce, opts };
  } catch (e) { return null; }
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
