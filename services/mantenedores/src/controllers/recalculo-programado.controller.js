'use strict';
/**
 * Recálculo Programado — corre recalcularMesesAbiertos() (todos los motores:
 * comisiones, ingresos, comisión dealer/parque, seguros de los meses ABIERTOS)
 * de forma automática según tramos por día de semana + horario, con su intervalo.
 * On/off global. Red de seguridad para que los cálculos nunca queden viejos.
 */
const pool = require('../../../../shared/config/database');
const { recalcularMesesAbiertos } = require('../../../creditos/src/utils/recalcular-mes');
const { auditar } = require('../../../../shared/audit');

let _busy = false;
let _ultimaMs = 0;   // epoch de la última corrida (en memoria, para el intervalo)

// Partes de fecha/hora en zona horaria de Chile (independiente del TZ del servidor)
function chileParts(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit', weekday: 'long', hour12: false,
  }).formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
  const iso = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7 }[p.weekday];
  return { hhmm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`, dow: iso };
}

const DEFAULT_TRAMOS = [
  { nombre: 'Horario laboral', dias: [1, 2, 3, 4, 5], desde: '09:00', hasta: '19:00', intervalo: 30 },
  { nombre: 'Fin de semana',   dias: [6, 7],          desde: '00:00', hasta: '23:59', intervalo: 180 },
];

function parseTramos(raw) {
  try { const a = typeof raw === 'string' ? JSON.parse(raw) : raw; return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function enRango(hhmm, desde, hasta) {
  desde = String(desde || '00:00').slice(0, 5); hasta = String(hasta || '23:59').slice(0, 5);
  if (desde <= hasta) return hhmm >= desde && hhmm < hasta;
  return hhmm >= desde || hhmm < hasta;   // tramo que cruza medianoche
}
// Devuelve el intervalo (min) que aplica AHORA. 0 = no correr en esta ventana.
function intervaloActual(tramos, defaultInt, ch) {
  for (const t of tramos) {
    if (!Array.isArray(t.dias) || !t.dias.includes(ch.dow)) continue;
    if (enRango(ch.hhmm, t.desde, t.hasta)) return { intervalo: +t.intervalo || 0, nombre: t.nombre || 'Tramo' };
  }
  return { intervalo: +defaultInt || 0, nombre: 'Fuera de tramos (por defecto)' };
}

/* ── Migración + registro del mantenedor ── */
require('../../../../shared/migrate').enFila('recalculo-programado', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS recalc_programado (
        id                   TINYINT       NOT NULL DEFAULT 1,
        activo               TINYINT(1)    NOT NULL DEFAULT 0,
        tramos               JSON          NULL,
        intervalo_default    INT           NOT NULL DEFAULT 120,
        ultima_corrida       DATETIME      NULL,
        ultima_duracion_seg  INT           NULL,
        ultima_ops           INT           NULL,
        ultimo_tramo         VARCHAR(80)   NULL,
        ultimo_error         VARCHAR(500)  NULL,
        PRIMARY KEY (id)
      )`);
    await pool.query(
      `INSERT IGNORE INTO recalc_programado (id, activo, tramos, intervalo_default) VALUES (1, 0, ?, 120)`,
      [JSON.stringify(DEFAULT_TRAMOS)]);
    // Cargar última corrida a memoria para no re-disparar al reiniciar
    const [[row]] = await pool.query('SELECT UNIX_TIMESTAMP(ultima_corrida) ts FROM recalc_programado WHERE id=1');
    if (row && row.ts) _ultimaMs = row.ts * 1000;

    // Registro en el menú (bajo Mantenedores)
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' AND estado='activo' LIMIT 1");
    if (mod) {
      const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mant_recalculo_prog' LIMIT 1");
      let idf = ex && ex.id_funcionalidad;
      if (!idf) {
        const [r] = await pool.query(
          `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
           VALUES (?, 'Recálculo Programado', 'mant_recalculo_prog', '/mantenedores/recalculo-programado/', 'bi-arrow-repeat')`, [mod.id_modulo]);
        idf = r.insertId;
      }
      const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=1 AND id_funcionalidad=? LIMIT 1', [idf]);
      if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idf]);
    }
    console.log('[recalc-programado] listo');
  } catch (e) { console.error('[recalc-programado migration]', e.message); }
});

/* ── Ejecuta el recálculo de todos los meses abiertos y persiste el resultado ── */
async function ejecutar(nombreTramo, req) {
  const t0 = Date.now();
  let ops = 0, err = null;
  try { const r = await recalcularMesesAbiertos(); ops = r.actualizados || 0; }
  catch (e) { err = String(e.message || e).slice(0, 490); }
  const dur = Math.round((Date.now() - t0) / 1000);
  _ultimaMs = Date.now();
  await pool.query(
    'UPDATE recalc_programado SET ultima_corrida=NOW(), ultima_duracion_seg=?, ultima_ops=?, ultimo_tramo=?, ultimo_error=? WHERE id=1',
    [dur, ops, nombreTramo, err]);
  if (req) auditar({ req, accion: 'RECALCULO', modulo: 'recalculo-programado', entidad: 'recalculo',
    detalle: `Recálculo ${nombreTramo}: ${ops} ops en ${dur}s${err ? ' · ERROR ' + err : ''}` });
  return { ops, dur, err };
}

/* ── Scheduler: cada 60s revisa si toca correr ── */
async function tick() {
  if (_busy) return; _busy = true;
  try {
    const [[cfg]] = await pool.query('SELECT * FROM recalc_programado WHERE id=1');
    if (!cfg || !cfg.activo) return;
    const ch = chileParts();
    const { intervalo, nombre } = intervaloActual(parseTramos(cfg.tramos), cfg.intervalo_default, ch);
    if (!intervalo || intervalo <= 0) return;
    if (_ultimaMs && (Date.now() - _ultimaMs) < intervalo * 60000) return;
    console.log(`[recalc-programado] disparando (${nombre}, cada ${intervalo}min)`);
    const r = await ejecutar(nombre, null);
    console.log(`[recalc-programado] ${r.ops} ops, ${r.dur}s${r.err ? ' ERROR ' + r.err : ''}`);
  } catch (e) { console.error('[recalc-programado tick]', e.message); }
  finally { _busy = false; }
}
setTimeout(tick, 20000);
setInterval(tick, 60000);

/* ── Endpoints ── */
exports.get = async (req, res) => {
  try {
    const [[cfg]] = await pool.query('SELECT * FROM recalc_programado WHERE id=1');
    const tramos = parseTramos(cfg.tramos);
    const ch = chileParts();
    const actual = intervaloActual(tramos, cfg.intervalo_default, ch);
    const proximaMs = cfg.activo && actual.intervalo > 0 && _ultimaMs
      ? _ultimaMs + actual.intervalo * 60000 : null;
    res.json({ success: true, error: null, data: {
      activo: !!cfg.activo, tramos, intervalo_default: cfg.intervalo_default,
      ultima_corrida: cfg.ultima_corrida, ultima_duracion_seg: cfg.ultima_duracion_seg,
      ultima_ops: cfg.ultima_ops, ultimo_tramo: cfg.ultimo_tramo, ultimo_error: cfg.ultimo_error,
      ahora: { dow: ch.dow, hhmm: ch.hhmm, intervalo: actual.intervalo, tramo: actual.nombre },
      proxima_estimada: proximaMs ? new Date(proximaMs).toISOString() : null,
      corriendo: _busy,
    }});
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

exports.set = async (req, res) => {
  try {
    const { activo, tramos, intervalo_default } = req.body || {};
    if (tramos && !Array.isArray(tramos)) return res.status(400).json({ success: false, data: null, error: 'tramos debe ser un arreglo' });
    // Validar tramos
    const clean = (tramos || []).map(t => ({
      nombre: String(t.nombre || 'Tramo').slice(0, 60),
      dias: (Array.isArray(t.dias) ? t.dias : []).map(Number).filter(d => d >= 1 && d <= 7),
      desde: String(t.desde || '00:00').slice(0, 5),
      hasta: String(t.hasta || '23:59').slice(0, 5),
      intervalo: Math.max(0, Math.min(1440, parseInt(t.intervalo) || 0)),
    }));
    const def = Math.max(0, Math.min(1440, parseInt(intervalo_default) || 0));
    await pool.query('UPDATE recalc_programado SET activo=?, tramos=?, intervalo_default=? WHERE id=1',
      [activo ? 1 : 0, JSON.stringify(clean), def]);
    auditar({ req, accion: 'CONFIG', modulo: 'recalculo-programado', entidad: 'config',
      detalle: `Recálculo programado ${activo ? 'ACTIVADO' : 'apagado'} · ${clean.length} tramo(s) · default ${def}min` });
    res.json({ success: true, error: null, data: { ok: true } });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

exports.runNow = async (req, res) => {
  try {
    if (_busy) return res.json({ success: false, data: null, error: 'Ya hay un recálculo en curso, espera a que termine.' });
    _busy = true;
    let r;
    try { r = await ejecutar('Manual (botón)', req); } finally { _busy = false; }
    res.json({ success: true, error: null, data: r });
  } catch (e) { _busy = false; res.status(500).json({ success: false, data: null, error: e.message }); }
};
