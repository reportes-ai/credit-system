'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   UPTIME POR SERVICIO — historia para la card de Mantenedores
   Los datos los produce el motor único shared/uptime.js (checks cada 5 min en
   `uptime_checks`); acá solo se LEEN: resumen + serie diaria para los gráficos
   estilo status-page (evidencia de disponibilidad para la casa matriz).
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const uptime = require('../../../../shared/uptime');

const DIAS = 90;          // ventana de la serie diaria (calza con la retención del motor)
const BUCKETS_DIA = 288;  // checks esperados por día (cada 5 min)

/* ── Card en Mantenedores ── */
require('../../../../shared/migrate').enFila('uptime-card', async () => {
  try {
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' LIMIT 1");
    if (!mod) return;
    let [[f]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='uptime_mant' LIMIT 1");
    if (!f) {
      const [r] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?, 'Salud y Uptime', 'uptime_mant', '/mantenedores/uptime/', 'bi-activity')",
        [mod.id_modulo]);
      f = { id_funcionalidad: r.insertId };
    }
    await pool.query("UPDATE funcionalidades SET nombre='Salud y Uptime' WHERE codigo='uptime_mant' AND nombre<>'Salud y Uptime'");

    // Gastos mensuales por servicio (paramétrico; NO inventar montos: lo no medido nace NULL "por confirmar")
    await pool.query(`CREATE TABLE IF NOT EXISTS servicios_costos (
      codigo VARCHAR(30) PRIMARY KEY,
      nombre VARCHAR(120) NOT NULL,
      costo_mensual DECIMAL(12,2) NULL,
      moneda VARCHAR(5) NOT NULL DEFAULT 'USD',
      variable TINYINT NOT NULL DEFAULT 0,          -- 1 = depende del uso (IA, WhatsApp)
      nota VARCHAR(300) NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
    const COSTOS_SEED = [
      // [codigo, nombre, costo, moneda, variable, nota]  — solo montos ya medidos; el resto por confirmar en su panel
      ['render',    'Render (hosting de la app)',            null, 'USD', 0, 'Confirmar plan en dashboard.render.com'],
      ['tidb',      'TiDB Cloud (base de datos)',            null, 'USD', 0, 'Confirmar plan en tidbcloud.com'],
      ['cloudsql',  'Google Cloud SQL (contingencia BD)',    2.40, 'USD', 0, 'Instancia DETENIDA; encendida ≈ US$4,8/día'],
      ['gcs',       'Bucket GCS (respaldos)',                0.05, 'USD', 0, 'Storage de respaldos'],
      ['ia',        'Claude / Anthropic (IA)',               null, 'USD', 1, 'Se calcula EN VIVO desde ia_uso (mes en curso)'],
      ['meta',      'Meta WhatsApp (Facilito)',              null, 'USD', 1, 'Por conversación; confirmar en Business Manager'],
      ['brevo',     'Brevo (correo transaccional)',          null, 'USD', 0, 'Confirmar plan en app.brevo.com'],
      ['dealernet', 'DealerNet (central de información)',    null, 'CLP', 1, 'Por consulta; confirmar con proveedor'],
      ['simpleapi', 'SimpleAPI (RCV SII)',                   0.00, 'CLP', 0, 'Plan gratis (libro cada 2 días)'],
      ['workera',   'Workera (reloj control)',               null, 'CLP', 0, 'Confirmar plan contratado'],
      ['dominio',   'Dominio NIC Chile',                     null, 'CLP', 0, 'Renovación anual; prorratear mensual'],
    ];
    for (const c of COSTOS_SEED)
      await pool.query('INSERT IGNORE INTO servicios_costos (codigo, nombre, costo_mensual, moneda, variable, nota) VALUES (?,?,?,?,?,?)', c);
    await pool.query(`INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
                      SELECT p.id_perfil, ?, 1 FROM perfiles p
                      WHERE (p.nombre = 'Administrador' OR p.nombre LIKE 'Gerente%' OR p.nombre LIKE 'Director%')
                        AND NOT EXISTS (SELECT 1 FROM permisos_perfil pp WHERE pp.id_perfil=p.id_perfil AND pp.id_funcionalidad=?)`,
                     [f.id_funcionalidad, f.id_funcionalidad]);
  } catch (e) { console.error('[uptime card migration]', e.message); }
});

/* GET /api/uptime/historia → resumen por servicio + serie diaria (90 días) */
const historia = async (req, res) => {
  try {
    const resumen = await uptime.resumen();   // motor único: % 24h/7d/30d, latencia, última falla

    // Semáforo de salud EN VIVO — mismo motor que el correo Salud del Sistema (Máxima 1)
    let salud = [];
    try { salud = await require('../../../correos-programados/src/controllers/correos.controller')._saludChecks(); }
    catch (e) { console.error('[uptime saludChecks]', e.message); }

    // Serie diaria por servicio
    const [dias] = await pool.query(`
      SELECT codigo, DATE_FORMAT(fecha, '%Y-%m-%d') dia,
             ROUND(100*AVG(ok), 2) pct, COUNT(*) checks,
             ROUND(AVG(CASE WHEN ok=1 THEN ms END)) ms
      FROM uptime_checks WHERE fecha >= CURDATE() - INTERVAL ? DAY
      GROUP BY codigo, DATE_FORMAT(fecha, '%Y-%m-%d') ORDER BY dia`, [DIAS - 1]);
    const seriePor = {};
    dias.forEach(d => (seriePor[d.codigo] = seriePor[d.codigo] || []).push(d));

    // % 90 días por servicio (la ventana completa de retención)
    const [p90s] = await pool.query(
      'SELECT codigo, ROUND(100*AVG(ok),2) p90 FROM uptime_checks GROUP BY codigo');
    const p90Por = Object.fromEntries(p90s.map(x => [x.codigo, x.p90]));

    // Serie diaria de la APP (Render), medida por omisión: buckets de 5 min con
    // al menos un check vs los 288 esperados del día (el día de hoy se escala
    // a los buckets transcurridos para no castigar el día en curso).
    const [appDias] = await pool.query(`
      SELECT DATE_FORMAT(fecha, '%Y-%m-%d') dia,
             COUNT(DISTINCT FLOOR(UNIX_TIMESTAMP(fecha)/300)) hechos
      FROM uptime_checks WHERE fecha >= CURDATE() - INTERVAL ? DAY
      GROUP BY DATE_FORMAT(fecha, '%Y-%m-%d') ORDER BY dia`, [DIAS - 1]);
    const hoy = new Date().toISOString().slice(0, 10);
    const buckHoy = Math.max(1, Math.floor((Date.now() - new Date(hoy + 'T00:00:00').getTime()) / 300000));
    const appSerie = appDias.map(d => ({
      dia: d.dia,
      pct: Math.min(100, Math.round(10000 * d.hechos / (d.dia === hoy ? buckHoy : BUCKETS_DIA)) / 100),
    }));

    res.json({
      success: true, error: null,
      data: {
        cada_min: resumen.cada_min, dias: DIAS, salud,
        app: { ...resumen.app, serie: appSerie },
        servicios: resumen.servicios.map(s => ({ ...s, p90: p90Por[s.codigo] != null ? p90Por[s.codigo] : null, serie: seriePor[s.codigo] || [] })),
      },
    });
  } catch (e) { console.error('[uptime historia]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* GET /api/uptime/costos → gastos mensuales por servicio (IA en vivo desde ia_uso) */
const costosGet = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM servicios_costos ORDER BY nombre');
    // Gasto IA del mes EN VIVO (misma fuente que Salud del Sistema: ia_uso)
    let iaVivo = null;
    try {
      const [[ia]] = await pool.query("SELECT ROUND(COALESCE(SUM(costo_usd),0),2) usd, COUNT(*) n FROM ia_uso WHERE fecha>=DATE_FORMAT(CURDATE(),'%Y-%m-01')");
      iaVivo = { usd: Number(ia.usd), n: ia.n };
    } catch (_) {}
    const data = rows.map(r => r.codigo === 'ia' && iaVivo
      ? { ...r, costo_mensual: iaVivo.usd, en_vivo: true, nota: `${iaVivo.n} análisis del mes en curso (ia_uso) — se actualiza solo` }
      : { ...r, en_vivo: false });
    const totales = {};
    for (const r of data) if (r.costo_mensual != null)
      totales[r.moneda] = Math.round(((totales[r.moneda] || 0) + Number(r.costo_mensual)) * 100) / 100;
    const por_confirmar = data.filter(r => r.costo_mensual == null).length;
    res.json({ success: true, data: { items: data, totales, por_confirmar }, error: null });
  } catch (e) { console.error('[uptime costos]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* PUT /api/uptime/costos/:codigo { costo_mensual, moneda, nota } */
const costosSet = async (req, res) => {
  try {
    const [[r]] = await pool.query('SELECT codigo, nombre FROM servicios_costos WHERE codigo=?', [req.params.codigo]);
    if (!r) return res.status(404).json({ success: false, data: null, error: 'Servicio desconocido' });
    if (r.codigo === 'ia') return res.status(400).json({ success: false, data: null, error: 'El gasto IA se calcula en vivo desde ia_uso — no se digita.' });
    const costo = req.body.costo_mensual === null || req.body.costo_mensual === '' ? null : Number(req.body.costo_mensual);
    if (costo != null && !(costo >= 0)) return res.status(400).json({ success: false, data: null, error: 'Costo inválido' });
    const moneda = ['USD', 'CLP'].includes(req.body.moneda) ? req.body.moneda : 'USD';
    const nota = String(req.body.nota || '').slice(0, 300) || null;
    await pool.query('UPDATE servicios_costos SET costo_mensual=?, moneda=?, nota=? WHERE codigo=?', [costo, moneda, nota, r.codigo]);
    require('../../../../shared/audit').auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'servicio_costo',
      entidad_id: r.codigo, detalle: `Costo mensual de "${r.nombre}": ${costo == null ? 'por confirmar' : costo + ' ' + moneda}` });
    res.json({ success: true, data: { codigo: r.codigo }, error: null });
  } catch (e) { console.error('[uptime costosSet]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { historia, costosGet, costosSet };
