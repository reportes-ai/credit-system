'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Regla de negocio (Pato, 2026-07-02): un crédito APROBADO que no se cursa en
   N días corridos (parámetro `aprobado_desiste_dias`, default 6) pasa a
   DESISTIDO automáticamente. La fecha de estado queda en el día que VENCIÓ el
   plazo (fecha_estado + N), no en el día que corrió el motor.
   Corre al arrancar y luego cada 12 h. Paramétrico vía Parámetros Crédito.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

async function getDias() {
  try {
    const [[r]] = await pool.query("SELECT valor FROM parametros_credito WHERE clave='aprobado_desiste_dias'");
    const n = r ? parseInt(r.valor, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 6;
  } catch { return 6; }
}

async function desistirAprobadosVencidos() {
  const dias = await getDias();
  const [r] = await pool.query(
    `UPDATE creditos
        SET estado_credito='DESISTIDO', estado_eval='DESISTIDO',
            fecha_estado = DATE_ADD(fecha_estado, INTERVAL ? DAY)
      WHERE estado_credito='APROBADO'
        AND COALESCE(estado,'') NOT IN ('OTORGADO','VIGENTE','EN MORA','VENCIDO','PREPAGADO','CASTIGADO')
        AND fecha_estado IS NOT NULL
        AND fecha_estado <= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
    [dias, dias]);
  if (r.affectedRows > 0) {
    console.log(`[desistir-aprobados] ${r.affectedRows} aprobados > ${dias} días → DESISTIDO`);
    try { auditar({ accion: 'EDITAR', modulo: 'creditos', entidad: 'desistimiento_auto', entidad_id: new Date().toISOString().slice(0, 10),
      detalle: `Desistimiento automático: ${r.affectedRows} créditos APROBADOS con más de ${dias} días sin cursar pasaron a DESISTIDO` }); } catch (_) {}
  }
  return { dias, desistidos: r.affectedRows };
}

(async () => {
  try {
    await pool.query(`INSERT IGNORE INTO parametros_credito (clave, valor, descripcion)
      VALUES ('aprobado_desiste_dias', '6', 'Días corridos para que un crédito APROBADO sin cursar pase a DESISTIDO automáticamente')`);
    setTimeout(() => desistirAprobadosVencidos().catch(e => console.error('[desistir-aprobados]', e.message)), 20000);
    setInterval(() => desistirAprobadosVencidos().catch(e => console.error('[desistir-aprobados]', e.message)), 12 * 60 * 60 * 1000);
  } catch (e) { console.error('[desistir-aprobados init]', e.message); }
})();

module.exports = { desistirAprobadosVencidos };
