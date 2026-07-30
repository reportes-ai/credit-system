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

module.exports = { historia };
