const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

/* ─────────────────────────────────────────────────────────────────────────────
   Potencial Parque/Dealer. Mide cuánto más podría crecer AutoFácil con cada dealer.
   Fórmula (de la maqueta POTENCIAL DEALER.xlsx):
     rotación        = ventas_mensuales / posiciones
     % con crédito   = ventas_con_credito / ventas_mensuales
     créditos prom.  = promedio de créditos AutoFácil de los últimos 3 meses (del sistema)
     ventas potencial= ventas_con_credito × FACTOR%        (FACTOR configurable, default 50)
     POTENCIAL       = ventas_potencial / créditos_prom − 1
     diagnóstico     = por rangos del POTENCIAL (configurables)
   Datos manuales (posiciones, ventas_mensuales, ventas_con_credito) → columnas en dealers.
   Créditos por mes → de la tabla creditos por rut_dealer. Parque = suma/promedio de dealers.
   ───────────────────────────────────────────────────────────────────────────── */

const normRut = s => String(s || '').toUpperCase().replace(/[^0-9K]/g, '');

(async () => {
  try {
    const addCol = sql => pool.query(sql).catch(() => {});
    await addCol(`ALTER TABLE dealers ADD COLUMN posiciones         INT NULL`);
    await addCol(`ALTER TABLE dealers ADD COLUMN ventas_mensuales   INT NULL`);
    await addCol(`ALTER TABLE dealers ADD COLUMN ventas_con_credito INT NULL`);
    await pool.query(`CREATE TABLE IF NOT EXISTS dealer_potencial_config (
      clave VARCHAR(40) PRIMARY KEY, valor VARCHAR(800) NOT NULL )`);
    await pool.query(
      `INSERT IGNORE INTO dealer_potencial_config (clave, valor) VALUES ('factor_ventas','50'), ('diagnostico_rangos', ?)`,
      [JSON.stringify([
        { max: 0,    texto: 'En baja — cuidado',            color: '#dc2626' },
        { max: 1,    texto: 'Estable',                      color: '#64748b' },
        { max: 3,    texto: 'Mediano',                      color: '#d97706' },
        { max: null, texto: 'Oportunidad — aumentar ventas', color: '#16a34a' },
      ])]);
  } catch (e) { console.error('[dealer-potencial migration]', e.message); }
})();

async function getConfig() {
  const [rows] = await pool.query('SELECT clave, valor FROM dealer_potencial_config');
  const m = {}; rows.forEach(r => { m[r.clave] = r.valor; });
  let rangos = [];
  try { rangos = JSON.parse(m.diagnostico_rangos || '[]'); } catch (_) {}
  return { factor: parseFloat(m.factor_ventas) || 50, rangos };
}

function diagnosticar(pot, rangos) {
  if (pot == null || !isFinite(pot)) return { texto: '—', color: '#94a3b8' };
  for (const r of rangos) { if (r.max == null || pot < Number(r.max)) return { texto: r.texto, color: r.color }; }
  return { texto: '—', color: '#94a3b8' };
}

// Las 3 etiquetas YYYY-MM de los últimos 3 meses cerrados (antes del mes actual).
function mesesUltimos3() {
  const out = []; const d = new Date();
  for (let i = 3; i >= 1; i--) { const m = new Date(d.getFullYear(), d.getMonth() - i, 1); out.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`); }
  return out;
}

// Créditos AutoFácil por rut_dealer y mes (últimos 3 meses cerrados).
async function creditosPorDealer() {
  const [rows] = await pool.query(`
    SELECT rut_dealer, DATE_FORMAT(fecha_otorgado,'%Y-%m') AS mes, COUNT(*) AS n
    FROM creditos
    WHERE fecha_otorgado IS NOT NULL
      AND fecha_otorgado >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 3 MONTH),'%Y-%m-01')
      AND fecha_otorgado <  DATE_FORMAT(CURDATE(),'%Y-%m-01')
    GROUP BY rut_dealer, DATE_FORMAT(fecha_otorgado,'%Y-%m')`);
  const map = {};
  rows.forEach(r => { const k = normRut(r.rut_dealer); if (!k) return; (map[k] = map[k] || {})[r.mes] = Number(r.n); });
  return map;
}

function calcDealer(d, credMeses, factor, rangos) {
  const credProm = credMeses.reduce((a, b) => a + b, 0) / (credMeses.length || 1);
  const pos = Number(d.posiciones) || 0, vm = Number(d.ventas_mensuales) || 0, vc = Number(d.ventas_con_credito) || 0;
  const rotacion = pos ? vm / pos : null;
  const pct_credito = vm ? vc / vm : null;
  const ventas_potencial = vc * (factor / 100);
  const potencial = credProm ? (ventas_potencial / credProm - 1) : null;
  const diag = diagnosticar(potencial, rangos);
  return {
    id_dealer: d.id_dealer, rut: d.rut, dealer: d.nombre_indexa || d.nombre_razon || d.rut,
    posiciones: pos, ventas_mensuales: vm, ventas_con_credito: vc,
    rotacion, pct_credito, cred_meses: credMeses, cred_prom: credProm,
    ventas_potencial, potencial, diagnostico: diag.texto, diag_color: diag.color,
  };
}

/* GET /api/dealer-potencial → parques (con dealers) + métricas calculadas */
const getPotencial = async (req, res) => {
  try {
    const { factor, rangos } = await getConfig();
    const credMap = await creditosPorDealer();
    const meses = mesesUltimos3();
    const [dealers] = await pool.query(
      `SELECT id_dealer, rut, nombre_indexa, nombre_razon, ccs_parque, posiciones, ventas_mensuales, ventas_con_credito
       FROM dealers WHERE activo = 1 ORDER BY ccs_parque, nombre_indexa`);

    const filas = dealers.map(d => {
      const cred = credMap[normRut(d.rut)] || {};
      const credMeses = meses.map(m => cred[m] || 0);
      const f = calcDealer(d, credMeses, factor, rangos);
      f.parque = (d.ccs_parque || '').trim() || '(SIN PARQUE)';
      return f;
    });

    const map = {};
    filas.forEach(f => { (map[f.parque] = map[f.parque] || []).push(f); });
    const parques = Object.entries(map).map(([parque, ds]) => {
      const sum = k => ds.reduce((a, x) => a + (Number(x[k]) || 0), 0);
      const avg = k => { const v = ds.map(x => x[k]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
      const vc = sum('ventas_con_credito');
      const cred_prom = sum('cred_prom');
      const ventas_potencial = vc * (factor / 100);
      const potencial = cred_prom ? (ventas_potencial / cred_prom - 1) : null;
      const diag = diagnosticar(potencial, rangos);
      const cred_meses = meses.map((_, i) => ds.reduce((a, x) => a + (x.cred_meses[i] || 0), 0));
      return {
        parque, n_dealers: ds.length, dealers: ds,
        posiciones: sum('posiciones'), ventas_mensuales: sum('ventas_mensuales'), ventas_con_credito: vc,
        rotacion: avg('rotacion'), pct_credito: avg('pct_credito'),
        cred_meses, cred_prom, ventas_potencial, potencial, diagnostico: diag.texto, diag_color: diag.color,
      };
    }).sort((a, b) => (b.potencial ?? -99) - (a.potencial ?? -99));

    res.json({ success: true, data: { meses, factor, rangos, parques }, error: null });
  } catch (e) { console.error('[dealer-potencial getPotencial]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* PUT /api/dealer-potencial/:id → guarda los datos manuales de un dealer */
const savePotencialDealer = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const num = v => (v === '' || v == null) ? null : (Number.isFinite(+v) ? Math.round(+v) : null);
    const posiciones = num(req.body.posiciones);
    const ventas_mensuales = num(req.body.ventas_mensuales);
    const ventas_con_credito = num(req.body.ventas_con_credito);
    const [r] = await pool.query(
      'UPDATE dealers SET posiciones=?, ventas_mensuales=?, ventas_con_credito=? WHERE id_dealer=?',
      [posiciones, ventas_mensuales, ventas_con_credito, id]);
    if (!r.affectedRows) return res.status(404).json({ success: false, data: null, error: 'Dealer no encontrado' });
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'dealer_potencial', entidad_id: id, detalle: `Datos de potencial dealer ${id}`, meta: { posiciones, ventas_mensuales, ventas_con_credito } });
    res.json({ success: true, data: { id_dealer: id }, error: null });
  } catch (e) { console.error('[dealer-potencial save]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* GET /api/dealer-potencial/config → variables (factor + rangos de diagnóstico) */
const getConfigEndpoint = async (req, res) => {
  try { res.json({ success: true, data: await getConfig(), error: null }); }
  catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* PUT /api/dealer-potencial/config → guarda factor + rangos */
const setConfig = async (req, res) => {
  try {
    const factor = parseFloat(req.body.factor);
    if (!Number.isFinite(factor) || factor < 0) return res.status(400).json({ success: false, data: null, error: 'Factor inválido' });
    let rangos = Array.isArray(req.body.rangos) ? req.body.rangos : [];
    rangos = rangos.map(r => ({ max: (r.max === '' || r.max == null) ? null : Number(r.max), texto: String(r.texto || '').slice(0, 80), color: /^#[0-9a-fA-F]{6}$/.test(r.color || '') ? r.color : '#64748b' }))
      .filter(r => r.texto);
    await pool.query('INSERT INTO dealer_potencial_config (clave, valor) VALUES (?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)', ['factor_ventas', String(factor)]);
    await pool.query('INSERT INTO dealer_potencial_config (clave, valor) VALUES (?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)', ['diagnostico_rangos', JSON.stringify(rangos)]);
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'dealer_potencial_config', entidad_id: 'variables', detalle: `Factor ${factor}% · ${rangos.length} rangos`, meta: { factor, rangos } });
    res.json({ success: true, data: { factor, rangos }, error: null });
  } catch (e) { console.error('[dealer-potencial setConfig]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { getPotencial, savePotencialDealer, getConfigEndpoint, setConfig };
