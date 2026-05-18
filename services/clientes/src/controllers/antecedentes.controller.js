const pool = require('../../../../shared/config/database');

/* ─── Migración de tabla ─────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS antecedentes_laborales (
        id                   INT AUTO_INCREMENT PRIMARY KEY,
        rut_cliente          VARCHAR(15) NOT NULL UNIQUE,
        tipo_trabajador      VARCHAR(60),
        empleador            VARCHAR(300),
        rut_empresa          VARCHAR(15),
        giro_empresa         VARCHAR(200),
        direccion_comercial  VARCHAR(300),
        numero_comercial     VARCHAR(20),
        oficina_comercial    VARCHAR(20),
        id_comuna_comercial  INT,
        ciudad_comercial     VARCHAR(100),
        telefono_comercial   VARCHAR(50),
        antiguedad_meses     INT,
        renta_fija_liquida   BIGINT,
        renta_var_mes1       BIGINT,
        renta_var_mes2       BIGINT,
        renta_var_mes3       BIGINT,
        renta_var_mes4       BIGINT,
        renta_var_mes5       BIGINT,
        renta_var_mes6       BIGINT,
        created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
  } catch (e) {
    if (e.errno !== 1050) console.error('[antecedentes_laborales migration]', e.message);
  }
})();

const getByRut = async (req, res) => {
  try {
    const rut = req.params.rut.toUpperCase().trim();
    const [rows] = await pool.query(
      'SELECT * FROM antecedentes_laborales WHERE rut_cliente = ?', [rut]);
    res.json({ success: true, data: rows[0] || null, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

const upsert = async (req, res) => {
  try {
    const rut = req.params.rut.toUpperCase().trim();
    const {
      tipo_trabajador, empleador, rut_empresa, giro_empresa,
      direccion_comercial, numero_comercial, oficina_comercial,
      id_comuna_comercial, ciudad_comercial, telefono_comercial,
      antiguedad_meses,
      renta_fija_liquida,
      renta_var_mes1, renta_var_mes2, renta_var_mes3,
      renta_var_mes4, renta_var_mes5, renta_var_mes6,
    } = req.body;

    await pool.query(`
      INSERT INTO antecedentes_laborales
        (rut_cliente, tipo_trabajador, empleador, rut_empresa, giro_empresa,
         direccion_comercial, numero_comercial, oficina_comercial,
         id_comuna_comercial, ciudad_comercial, telefono_comercial,
         antiguedad_meses, renta_fija_liquida,
         renta_var_mes1, renta_var_mes2, renta_var_mes3,
         renta_var_mes4, renta_var_mes5, renta_var_mes6)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
        tipo_trabajador     = VALUES(tipo_trabajador),
        empleador           = VALUES(empleador),
        rut_empresa         = VALUES(rut_empresa),
        giro_empresa        = VALUES(giro_empresa),
        direccion_comercial = VALUES(direccion_comercial),
        numero_comercial    = VALUES(numero_comercial),
        oficina_comercial   = VALUES(oficina_comercial),
        id_comuna_comercial = VALUES(id_comuna_comercial),
        ciudad_comercial    = VALUES(ciudad_comercial),
        telefono_comercial  = VALUES(telefono_comercial),
        antiguedad_meses    = VALUES(antiguedad_meses),
        renta_fija_liquida  = VALUES(renta_fija_liquida),
        renta_var_mes1      = VALUES(renta_var_mes1),
        renta_var_mes2      = VALUES(renta_var_mes2),
        renta_var_mes3      = VALUES(renta_var_mes3),
        renta_var_mes4      = VALUES(renta_var_mes4),
        renta_var_mes5      = VALUES(renta_var_mes5),
        renta_var_mes6      = VALUES(renta_var_mes6),
        updated_at          = CURRENT_TIMESTAMP
    `, [
      rut,
      tipo_trabajador    || null,
      empleador          || null,
      rut_empresa        ? rut_empresa.toUpperCase().trim() : null,
      giro_empresa       || null,
      direccion_comercial|| null,
      numero_comercial   || null,
      oficina_comercial  || null,
      id_comuna_comercial|| null,
      ciudad_comercial   || null,
      telefono_comercial || null,
      antiguedad_meses   != null ? parseInt(antiguedad_meses) : null,
      renta_fija_liquida != null ? parseInt(renta_fija_liquida) : null,
      renta_var_mes1     != null ? parseInt(renta_var_mes1) : null,
      renta_var_mes2     != null ? parseInt(renta_var_mes2) : null,
      renta_var_mes3     != null ? parseInt(renta_var_mes3) : null,
      renta_var_mes4     != null ? parseInt(renta_var_mes4) : null,
      renta_var_mes5     != null ? parseInt(renta_var_mes5) : null,
      renta_var_mes6     != null ? parseInt(renta_var_mes6) : null,
    ]);

    res.json({ success: true, data: { rut_cliente: rut }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { getByRut, upsert };
