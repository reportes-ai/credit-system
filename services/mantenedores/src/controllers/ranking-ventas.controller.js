'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Ranking de Colocaciones — popup mensual con el podio (1°/2°/3°) de ejecutivos
   por N° de créditos OTORGADOS del mes anterior. Se muestra a todos los usuarios
   a partir del día configurado (o el hábil siguiente) durante una ventana de días,
   1 vez por mes por navegador. Config paramétrica en rank_config; el popup vive
   en /js/ranking-popup.js (música de fanfarria estilo Rocky por WebAudio).
   ──────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rank_config (
        clave  VARCHAR(50) PRIMARY KEY,
        valor  TEXT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
    const defaults = [
      ['activo', '1'],
      ['dia', '1'],                 // día del mes en que aparece
      ['habil_siguiente', '1'],     // si cae sábado/domingo corre al hábil siguiente
      ['dias_visible', '5'],        // ventana de días en que se sigue mostrando
      ['musica', '1'],
      ['melodia', 'rocky'],        // rocky | corta | olimpica | epica
      ['titulo', '🏆 RANKING DE COLOCACIONES — {mes}'],
      ['subtitulo', '¡Felicitaciones a los campeones del mes!'],
    ];
    for (const [k, v] of defaults) await pool.query('INSERT IGNORE INTO rank_config (clave, valor) VALUES (?,?)', [k, v]);
  } catch (e) { console.error('[rank_config migration]', e.message); }
  try {
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' LIMIT 1");
    if (mod) {
      const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mant_ranking_ventas' LIMIT 1");
      let idf = ex && ex.id_funcionalidad;
      if (!idf) {
        const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
          [mod.id_modulo, 'Ranking de Colocaciones', 'mant_ranking_ventas', '/mantenedores/ranking-ventas/', 'bi-trophy']);
        idf = r.insertId;
      }
      const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=1 AND id_funcionalidad=? LIMIT 1', [idf]);
      if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idf]);
    }
  } catch (e) { console.error('[ranking permisos]', e.message); }
})();

async function getConfig() {
  const [rows] = await pool.query('SELECT clave, valor FROM rank_config LIMIT 100');
  const cfg = {}; rows.forEach(r => cfg[r.clave] = r.valor);
  return cfg;
}
const tpl = (t, vars) => String(t || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
function hoyChile() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Fecha de inicio del popup para el mes de `hoy`: día configurado, corrido a hábil (L-V) si aplica
function inicioVentana(hoy, cfg) {
  const dia = Math.min(28, Math.max(1, parseInt(cfg.dia || '1', 10)));
  const d = new Date(hoy.slice(0, 7) + '-' + String(dia).padStart(2, '0') + 'T12:00:00');
  if (cfg.habil_siguiente === '1') {
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1); // domingo=0, sábado=6
  }
  return d;
}

async function top3MesAnterior(hoy) {
  const base = new Date(hoy.slice(0, 7) + '-01T12:00:00');
  base.setMonth(base.getMonth() - 1);
  const mesAnt = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-01`;
  const label = MESES[base.getMonth()] + ' ' + base.getFullYear();
  const [rows] = await pool.query(
    "SELECT ejecutivo, COUNT(*) n, SUM(COALESCE(monto_financiado,0)) monto FROM creditos WHERE mes=? AND UPPER(COALESCE(estado,''))='OTORGADO' AND ejecutivo IS NOT NULL AND ejecutivo<>'' GROUP BY ejecutivo ORDER BY n DESC, monto DESC, ejecutivo ASC LIMIT 3",
    [mesAnt]);
  return { mesAnt, label, top: rows.map(r => ({ nombre: r.ejecutivo, n: r.n, monto: Math.round(Number(r.monto) || 0) })) };
}

/* GET /api/ranking-ventas/popup — ¿corresponde mostrar el podio hoy? (cualquier usuario) */
const popup = async (req, res) => {
  try {
    const cfg = await getConfig();
    const hoy = hoyChile();
    const esTest = String(req.query.test || '') === '1';
    if (!esTest) {
      if (cfg.activo !== '1') return res.json({ success: true, data: { mostrar: false }, error: null });
      const ini = inicioVentana(hoy, cfg);
      const fin = new Date(ini); fin.setDate(fin.getDate() + Math.max(1, parseInt(cfg.dias_visible || '5', 10)) - 1);
      const hoyD = new Date(hoy + 'T12:00:00');
      if (hoyD < ini || hoyD > fin) return res.json({ success: true, data: { mostrar: false }, error: null });
    }
    const { mesAnt, label, top } = await top3MesAnterior(hoy);
    if (!top.length) return res.json({ success: true, data: { mostrar: false }, error: null });
    res.json({ success: true, data: {
      mostrar: true, clave: mesAnt.slice(0, 7), // dedup mensual en el cliente
      titulo: tpl(cfg.titulo, { mes: label.toUpperCase() }),
      subtitulo: cfg.subtitulo || '', musica: cfg.musica === '1', melodia: cfg.melodia || 'rocky', top,
    }, error: null });
  } catch (e) { console.error('[ranking popup]', e.message); res.status(500).json({ success: false, data: { mostrar: false }, error: 'Error' }); }
};

const getConfigApi = async (req, res) => {
  try { res.json({ success: true, data: await getConfig(), error: null }); }
  catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
const setConfigApi = async (req, res) => {
  try {
    const b = req.body || {};
    const PERMITIDAS = ['activo', 'dia', 'habil_siguiente', 'dias_visible', 'musica', 'melodia', 'titulo', 'subtitulo'];
    for (const [k, v] of Object.entries(b)) {
      if (!PERMITIDAS.includes(k)) continue;
      await pool.query('INSERT INTO rank_config (clave, valor) VALUES (?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)', [k, String(v == null ? '' : v)]);
    }
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'ranking_ventas', detalle: 'Actualizó ranking de colocaciones: ' + Object.keys(b).join(', ') });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { popup, getConfigApi, setConfigApi };
