const pool = require('../../../../shared/config/database');

/* ─── Migración de tabla ─────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('informacion-comercial', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS informacion_comercial (
        id                        INT AUTO_INCREMENT PRIMARY KEY,
        rut_cliente               VARCHAR(15) NOT NULL UNIQUE,
        monto_protestos           BIGINT,
        protestos_vigentes_q      INT,
        deuda_vigente_total       BIGINT,
        deuda_vigente_inst        INT,
        deuda_hipotecaria         BIGINT,
        deuda_hipotecaria_inst    INT,
        deuda_hipotecaria_carga   BIGINT,
        deuda_comercial           BIGINT,
        deuda_comercial_inst      INT,
        deuda_comercial_carga     BIGINT,
        deuda_consumo             BIGINT,
        deuda_consumo_inst        INT,
        deuda_consumo_carga       BIGINT,
        deuda_morosa              BIGINT,
        deuda_morosa_inst         INT,
        deuda_vencida             BIGINT,
        deuda_vencida_inst        INT,
        deuda_castigada           BIGINT,
        deuda_castigada_inst      INT,
        linea_disponible          BIGINT,
        linea_disponible_inst     INT,
        arriendo                  BIGINT,
        acredita_propiedad        TINYINT(1) DEFAULT 0,
        created_at                DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at                DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
  } catch (e) {
    if (e.errno !== 1050) console.error('[informacion_comercial migration]', e.message);
  }
});

const getByRut = async (req, res) => {
  try {
    const rut = req.params.rut.replace(/\./g, '').toUpperCase().trim();
    const [rows] = await pool.query(
      'SELECT * FROM informacion_comercial WHERE rut_cliente = ?', [rut]);
    res.json({ success: true, data: rows[0] || null, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const upsert = async (req, res) => {
  try {
    const rut = req.params.rut.replace(/\./g, '').toUpperCase().trim();
    const {
      monto_protestos, protestos_vigentes_q,
      deuda_vigente_total, deuda_vigente_inst,
      deuda_hipotecaria, deuda_hipotecaria_inst, deuda_hipotecaria_carga,
      deuda_comercial,  deuda_comercial_inst,  deuda_comercial_carga,
      deuda_consumo,    deuda_consumo_inst,    deuda_consumo_carga,
      deuda_morosa,     deuda_morosa_inst,
      deuda_vencida,    deuda_vencida_inst,
      deuda_castigada,  deuda_castigada_inst,
      linea_disponible, linea_disponible_inst,
      arriendo, acredita_propiedad,
    } = req.body;

    const n = v => (v != null && v !== '' ? parseInt(v) : null);
    const b = v => (v ? 1 : 0);

    await pool.query(`
      INSERT INTO informacion_comercial
        (rut_cliente,
         monto_protestos, protestos_vigentes_q,
         deuda_vigente_total, deuda_vigente_inst,
         deuda_hipotecaria, deuda_hipotecaria_inst, deuda_hipotecaria_carga,
         deuda_comercial,  deuda_comercial_inst,  deuda_comercial_carga,
         deuda_consumo,    deuda_consumo_inst,    deuda_consumo_carga,
         deuda_morosa,     deuda_morosa_inst,
         deuda_vencida,    deuda_vencida_inst,
         deuda_castigada,  deuda_castigada_inst,
         linea_disponible, linea_disponible_inst,
         arriendo, acredita_propiedad)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
        monto_protestos           = VALUES(monto_protestos),
        protestos_vigentes_q      = VALUES(protestos_vigentes_q),
        deuda_vigente_total       = VALUES(deuda_vigente_total),
        deuda_vigente_inst        = VALUES(deuda_vigente_inst),
        deuda_hipotecaria         = VALUES(deuda_hipotecaria),
        deuda_hipotecaria_inst    = VALUES(deuda_hipotecaria_inst),
        deuda_hipotecaria_carga   = VALUES(deuda_hipotecaria_carga),
        deuda_comercial           = VALUES(deuda_comercial),
        deuda_comercial_inst      = VALUES(deuda_comercial_inst),
        deuda_comercial_carga     = VALUES(deuda_comercial_carga),
        deuda_consumo             = VALUES(deuda_consumo),
        deuda_consumo_inst        = VALUES(deuda_consumo_inst),
        deuda_consumo_carga       = VALUES(deuda_consumo_carga),
        deuda_morosa              = VALUES(deuda_morosa),
        deuda_morosa_inst         = VALUES(deuda_morosa_inst),
        deuda_vencida             = VALUES(deuda_vencida),
        deuda_vencida_inst        = VALUES(deuda_vencida_inst),
        deuda_castigada           = VALUES(deuda_castigada),
        deuda_castigada_inst      = VALUES(deuda_castigada_inst),
        linea_disponible          = VALUES(linea_disponible),
        linea_disponible_inst     = VALUES(linea_disponible_inst),
        arriendo                  = VALUES(arriendo),
        acredita_propiedad        = VALUES(acredita_propiedad),
        updated_at                = CURRENT_TIMESTAMP
    `, [
      rut,
      n(monto_protestos), n(protestos_vigentes_q),
      n(deuda_vigente_total), n(deuda_vigente_inst),
      n(deuda_hipotecaria), n(deuda_hipotecaria_inst), n(deuda_hipotecaria_carga),
      n(deuda_comercial),  n(deuda_comercial_inst),  n(deuda_comercial_carga),
      n(deuda_consumo),    n(deuda_consumo_inst),    n(deuda_consumo_carga),
      n(deuda_morosa),     n(deuda_morosa_inst),
      n(deuda_vencida),    n(deuda_vencida_inst),
      n(deuda_castigada),  n(deuda_castigada_inst),
      n(linea_disponible), n(linea_disponible_inst),
      n(arriendo), b(acredita_propiedad),
    ]);

    res.json({ success: true, data: { rut_cliente: rut }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

module.exports = { getByRut, upsert };
