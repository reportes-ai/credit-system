'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Carrera de Colocaciones — popup DIARIO con la pista de atletismo (vista desde
   arriba): un carril por Ejecutivo Comercial vigente, el corredor avanza según
   sus créditos OTORGADOS del mes vs la meta. Se muestra 1 vez al día por
   navegador, desde la hora configurada. Config en carrera_config; el visual
   vive en /js/carrera-popup.js.
   ──────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS carrera_config (
        clave  VARCHAR(50) PRIMARY KEY,
        valor  TEXT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
    const defaults = [
      ['activo', '0'],              // nace desactivado: se enciende en el mantenedor
      ['hora_desde', '08:00'],      // hora (Chile) desde la que aparece cada día
      ['meta_ops', '15'],           // meta mensual de créditos por ejecutivo (línea de meta)
      ['titulo', '🏃 CARRERA DE COLOCACIONES — {mes}'],
      ['subtitulo', 'Créditos otorgados del mes · la meta es {meta} por ejecutivo'],
    ];
    for (const [k, v] of defaults) await pool.query('INSERT IGNORE INTO carrera_config (clave, valor) VALUES (?,?)', [k, v]);
  } catch (e) { console.error('[carrera_config migration]', e.message); }
  try {
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' LIMIT 1");
    if (mod) {
      const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mant_carrera' LIMIT 1");
      let idf = ex && ex.id_funcionalidad;
      if (!idf) {
        const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
          [mod.id_modulo, 'Carrera de Colocaciones', 'mant_carrera', '/mantenedores/carrera/', 'bi-flag']);
        idf = r.insertId;
      }
      const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=1 AND id_funcionalidad=? LIMIT 1', [idf]);
      if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idf]);
    }
  } catch (e) { console.error('[carrera permisos]', e.message); }
})();

async function getConfig() {
  const [rows] = await pool.query('SELECT clave, valor FROM carrera_config LIMIT 100');
  const cfg = {}; rows.forEach(r => cfg[r.clave] = r.valor);
  return cfg;
}
const tpl = (t, vars) => String(t || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const keyEj = s => norm(s).split(' ').filter(Boolean).sort().join(' ');
const titulo = s => String(s || '').toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
function chileNow() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date()).reduce((o, x) => (o[x.type] = x.value, o), {});
  return { fecha: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`, year: +p.year, month: +p.month };
}
const MESES = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];

/* GET /api/carrera/popup — pista del día (cualquier usuario logueado) */
const popup = async (req, res) => {
  try {
    const cfg = await getConfig();
    const ch = chileNow();
    const esTest = String(req.query.test || '') === '1';
    if (!esTest) {
      if (cfg.activo !== '1') return res.json({ success: true, data: { mostrar: false }, error: null });
      const desde = /^\d{2}:\d{2}$/.test(cfg.hora_desde || '') ? cfg.hora_desde : '08:00';
      if (ch.hhmm < desde) return res.json({ success: true, data: { mostrar: false }, error: null });
    }
    const mesStr = `${ch.year}-${String(ch.month).padStart(2, '0')}`;
    // Carriles: Ejecutivos Comerciales activos; avance: otorgados del mes (mismo criterio del informe diario)
    const [usr] = await pool.query(
      `SELECT CONCAT(u.nombre,' ',u.apellido) nombre FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
        WHERE p.nombre='Ejecutivo Comercial' AND u.estado='activo' ORDER BY nombre LIMIT 20`);
    const [ops] = await pool.query(
      `SELECT ejecutivo, COUNT(*) n, COALESCE(SUM(monto_financiado),0) monto FROM creditos
        WHERE estado_credito='OTORGADO' AND DATE_FORMAT(fecha_otorgado,'%Y-%m')=? AND ejecutivo<>'' GROUP BY ejecutivo`, [mesStr]);
    const mapOps = new Map(ops.map(r => [keyEj(r.ejecutivo), { n: Number(r.n), monto: Number(r.monto) }]));
    const meta = Math.max(1, parseInt(cfg.meta_ops || '15', 10));
    const corredores = usr.map(u => {
      const o = mapOps.get(keyEj(u.nombre)) || { n: 0, monto: 0 };
      return { nombre: titulo(u.nombre), ops: o.n, monto: o.monto };
    }).sort((a, b) => b.ops - a.ops || b.monto - a.monto || a.nombre.localeCompare(b.nombre));
    if (!corredores.length) return res.json({ success: true, data: { mostrar: false }, error: null });
    const mesLabel = MESES[ch.month - 1] + ' ' + ch.year;
    res.json({ success: true, data: {
      mostrar: true, fecha: ch.fecha, meta,
      titulo: tpl(cfg.titulo, { mes: mesLabel, meta }),
      subtitulo: tpl(cfg.subtitulo, { mes: mesLabel, meta }),
      corredores,
    }, error: null });
  } catch (e) { console.error('[carrera popup]', e.message); res.status(500).json({ success: false, data: { mostrar: false }, error: 'Error' }); }
};

const getConfigApi = async (req, res) => {
  try { res.json({ success: true, data: await getConfig(), error: null }); }
  catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
const setConfigApi = async (req, res) => {
  try {
    const b = req.body || {};
    const PERMITIDAS = ['activo', 'hora_desde', 'meta_ops', 'titulo', 'subtitulo'];
    for (const [k, v] of Object.entries(b)) {
      if (!PERMITIDAS.includes(k)) continue;
      await pool.query('INSERT INTO carrera_config (clave, valor) VALUES (?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)', [k, String(v == null ? '' : v)]);
    }
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'carrera', detalle: 'Actualizó carrera de colocaciones: ' + Object.keys(b).join(', ') });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { popup, getConfigApi, setConfigApi };
