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
const normTxt = s => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
const SINPARQUE_ORF = '(DIRECTO / SIN PARQUE)';   // bucket de créditos sin dealer ni parque reconocible

// Defaults de la Priorización (paramétricos: el Admin los edita en el mantenedor).
// Las CLAVES (ATACAR/DEFENDER/EDUCAR/DESARROLLAR) son estructurales (cuadrante de la matriz);
// el Admin sólo cambia nombre/color/acción. Los cortes de la matriz son la mediana (auto).
const DEFAULT_SEG = {
  ATACAR:      { nombre: 'Atacar',      color: '#16a34a', accion: 'Vende mucho con crédito pero poco con AutoFácil → máxima prioridad: visita y oferta.' },
  DEFENDER:    { nombre: 'Defender',    color: '#0141A2', accion: 'Campeón (alto crédito + alta participación) → cuidar la relación y el servicio.' },
  EDUCAR:      { nombre: 'Educar',      color: '#d97706', accion: 'Vende poco con crédito → enseñarle a ofrecer crédito y entrar con AutoFácil.' },
  DESARROLLAR: { nombre: 'Desarrollar', color: '#64748b', accion: 'Ya tienes su poco crédito → ayúdalo a vender más con crédito (agrandar la torta).' },
};
const DEFAULT_CUART = {
  '1': 'Esfuerzo máximo: visita + gestor dedicado',
  '2': 'Esfuerzo alto: contacto regular y campañas dirigidas',
  '3': 'Esfuerzo medio: seguimiento digital',
  '4': 'Mantención: autoservicio / campañas masivas',
};

(async () => {
  try {
    const addCol = sql => pool.query(sql).catch(() => {});
    await addCol(`ALTER TABLE dealers ADD COLUMN posiciones         INT NULL`);
    await addCol(`ALTER TABLE dealers ADD COLUMN ventas_mensuales   INT NULL`);
    await addCol(`ALTER TABLE dealers ADD COLUMN ventas_con_credito INT NULL`);
    await pool.query(`CREATE TABLE IF NOT EXISTS dealer_potencial_config (
      clave VARCHAR(40) PRIMARY KEY, valor VARCHAR(800) NOT NULL )`);
    await pool.query(`ALTER TABLE dealer_potencial_config MODIFY valor VARCHAR(2000) NOT NULL`).catch(() => {});  // segmentos/acciones editables
    await pool.query(
      `INSERT IGNORE INTO dealer_potencial_config (clave, valor) VALUES ('factor_ventas','50'), ('diagnostico_rangos', ?)`,
      [JSON.stringify([
        { max: 0,    texto: 'En baja — cuidado',            color: '#dc2626' },
        { max: 1,    texto: 'Estable',                      color: '#64748b' },
        { max: 3,    texto: 'Mediano',                      color: '#d97706' },
        { max: null, texto: 'Oportunidad — aumentar ventas', color: '#16a34a' },
      ])]);
    await pool.query(
      `INSERT IGNORE INTO dealer_potencial_config (clave, valor) VALUES ('prioriz_segmentos', ?), ('prioriz_cuartiles', ?)`,
      [JSON.stringify(DEFAULT_SEG), JSON.stringify(DEFAULT_CUART)]);
  } catch (e) { console.error('[dealer-potencial migration]', e.message); }
})();

async function getConfig() {
  const [rows] = await pool.query('SELECT clave, valor FROM dealer_potencial_config');
  const m = {}; rows.forEach(r => { m[r.clave] = r.valor; });
  let rangos = [], segmentos = DEFAULT_SEG, cuartiles = DEFAULT_CUART;
  try { rangos = JSON.parse(m.diagnostico_rangos || '[]'); } catch (_) {}
  try { if (m.prioriz_segmentos) segmentos = { ...DEFAULT_SEG, ...JSON.parse(m.prioriz_segmentos) }; } catch (_) {}
  try { if (m.prioriz_cuartiles) cuartiles = { ...DEFAULT_CUART, ...JSON.parse(m.prioriz_cuartiles) }; } catch (_) {}
  return { factor: parseFloat(m.factor_ventas) || 50, rangos, segmentos, cuartiles };
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

/* Cuenta TODOS los créditos otorgados en los últimos 3 meses cerrados y los atribuye con
   prioridad: 1) por rut_dealer si calza con un dealer activo; 2) si no, por el texto 'parque'
   del crédito (carga masiva brokerage no trae el RUT del dealer, sólo el parque); 3) si el
   parque tampoco calza, al bucket DIRECTO/SIN PARQUE. Así el total por mes reconcilia con el
   total real de créditos colocados (antes se perdían los que no traían rut_dealer).
   Devuelve { byDealer: {rutNorm:{mes:n}}, orphanByParque: {parqueDisplay:{mes:n}} }. */
async function contarCreditos(activeRut, parqueCanon) {
  // Créditos OTORGADOS por el campo `mes` de cierre (fuente única con dashboard/colocaciones
  // y con el recálculo de categorías). Antes se contaba por fecha_otorgado, que subestima
  // porque una op se cierra en un mes distinto al de su fecha_otorgado.
  const [creds] = await pool.query(`
    SELECT rut_dealer, parque, DATE_FORMAT(mes,'%Y-%m') AS mes
    FROM creditos
    WHERE estado = 'OTORGADO' AND mes IS NOT NULL
      AND mes >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 3 MONTH),'%Y-%m-01')
      AND mes <  DATE_FORMAT(CURDATE(),'%Y-%m-01')`);
  const byDealer = {}, orphanByParque = {};
  const bump = (obj, key, mes) => { (obj[key] = obj[key] || {})[mes] = (obj[key][mes] || 0) + 1; };
  creds.forEach(c => {
    const rk = normRut(c.rut_dealer);
    if (rk && activeRut.has(rk)) return bump(byDealer, rk, c.mes);
    bump(orphanByParque, parqueCanon.get(normTxt(c.parque)) || SINPARQUE_ORF, c.mes);
  });
  return { byDealer, orphanByParque };
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
    const { factor, rangos, segmentos, cuartiles } = await getConfig();
    const meses = mesesUltimos3();
    const [dealers] = await pool.query(
      `SELECT id_dealer, rut, nombre_indexa, nombre_razon, ccs_parque, posiciones, ventas_mensuales, ventas_con_credito
       FROM dealers WHERE activo = 1 ORDER BY ccs_parque, nombre_indexa`);

    // Ruts de dealers activos + nombre canónico de cada parque (para atribuir huérfanos por texto)
    const activeRut = new Set();
    const parqueCanon = new Map();   // normTxt(ccs_parque) -> ccs_parque (display)
    dealers.forEach(d => {
      const k = normRut(d.rut); if (k) activeRut.add(k);
      const pq = (d.ccs_parque || '').trim();
      if (pq) parqueCanon.set(normTxt(pq), pq);
    });

    const { byDealer, orphanByParque } = await contarCreditos(activeRut, parqueCanon);

    const filas = dealers.map(d => {
      const cred = byDealer[normRut(d.rut)] || {};
      const credMeses = meses.map(m => cred[m] || 0);
      const f = calcDealer(d, credMeses, factor, rangos);
      f.parque = (d.ccs_parque || '').trim() || '(SIN PARQUE)';
      return f;
    });

    const map = {};
    filas.forEach(f => { (map[f.parque] = map[f.parque] || []).push(f); });
    // parques que sólo tienen créditos huérfanos (sin dealers registrados) también deben aparecer
    Object.keys(orphanByParque).forEach(pq => { if (!map[pq]) map[pq] = []; });

    const parques = Object.entries(map).map(([parque, ds]) => {
      const orf = orphanByParque[parque] || {};
      const orfMeses = meses.map(m => orf[m] || 0);
      const orfTotal = orfMeses.reduce((a, b) => a + b, 0);
      const sum = k => ds.reduce((a, x) => a + (Number(x[k]) || 0), 0);   // datos manuales: sólo dealers reales
      const avg = k => { const v = ds.map(x => x[k]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
      const vc = sum('ventas_con_credito');
      const cred_prom = sum('cred_prom') + orfTotal / (meses.length || 1);   // créditos del parque = dealers + huérfanos
      const ventas_potencial = vc * (factor / 100);
      const potencial = cred_prom ? (ventas_potencial / cred_prom - 1) : null;
      const diag = diagnosticar(potencial, rangos);
      const cred_meses = meses.map((_, i) => ds.reduce((a, x) => a + (x.cred_meses[i] || 0), 0) + (orfMeses[i] || 0));
      const dealersOut = ds.slice();
      if (orfTotal > 0) dealersOut.push({   // fila visible que carga los créditos sin dealer asignado → el detalle reconcilia
        id_dealer: null, rut: null, dealer: '› Sin dealer identificado (carga masiva)',
        posiciones: null, ventas_mensuales: null, ventas_con_credito: null,
        rotacion: null, pct_credito: null, cred_meses: orfMeses, cred_prom: orfTotal / (meses.length || 1),
        ventas_potencial: null, potencial: null, diagnostico: '—', diag_color: '#94a3b8', _huerfano: true,
      });
      return {
        parque, n_dealers: ds.length, dealers: dealersOut,
        posiciones: sum('posiciones'), ventas_mensuales: sum('ventas_mensuales'), ventas_con_credito: vc,
        rotacion: avg('rotacion'), pct_credito: avg('pct_credito'),
        cred_meses, cred_prom, ventas_potencial, potencial, diagnostico: diag.texto, diag_color: diag.color,
      };
    }).sort((a, b) => (b.potencial ?? -99) - (a.potencial ?? -99));

    res.json({ success: true, data: { meses, factor, rangos, segmentos, cuartiles, parques }, error: null });
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

    // Segmentos de priorización (sólo se aceptan las claves estructurales conocidas)
    if (req.body.segmentos && typeof req.body.segmentos === 'object') {
      const seg = {};
      for (const k of Object.keys(DEFAULT_SEG)) {
        const s = req.body.segmentos[k] || {};
        seg[k] = {
          nombre: String(s.nombre || DEFAULT_SEG[k].nombre).slice(0, 40),
          color: /^#[0-9a-fA-F]{6}$/.test(s.color || '') ? s.color : DEFAULT_SEG[k].color,
          accion: String(s.accion || DEFAULT_SEG[k].accion).slice(0, 300),
        };
      }
      await pool.query('INSERT INTO dealer_potencial_config (clave, valor) VALUES (?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)', ['prioriz_segmentos', JSON.stringify(seg)]);
    }
    // Acciones por cuartil
    if (req.body.cuartiles && typeof req.body.cuartiles === 'object') {
      const cu = {};
      for (const k of ['1', '2', '3', '4']) cu[k] = String(req.body.cuartiles[k] || DEFAULT_CUART[k]).slice(0, 200);
      await pool.query('INSERT INTO dealer_potencial_config (clave, valor) VALUES (?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)', ['prioriz_cuartiles', JSON.stringify(cu)]);
    }

    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'dealer_potencial_config', entidad_id: 'variables', detalle: `Factor ${factor}% · ${rangos.length} rangos · priorización`, meta: { factor, rangos } });
    res.json({ success: true, data: await getConfig(), error: null });
  } catch (e) { console.error('[dealer-potencial setConfig]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { getPotencial, savePotencialDealer, getConfigEndpoint, setConfig };
