const pool = require('../../../../shared/config/database');

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS comisiones_seguro_plazo (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        plazo_min       INT          NOT NULL,
        plazo_max       INT          NOT NULL,
        cuotas          INT          NOT NULL,
        pct_cesantia    DECIMAL(10,6) NOT NULL DEFAULT 0,
        pct_desgravamen DECIMAL(10,6) NOT NULL DEFAULT 0,
        pct_ambos       DECIMAL(10,6) NOT NULL DEFAULT 0,
        factor          DECIMAL(16,9) NOT NULL DEFAULT 1,
        estado          ENUM('activo','inactivo') DEFAULT 'activo',
        updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    const [existing] = await pool.query('SELECT COUNT(*) AS n FROM comisiones_seguro_plazo');
    if (existing[0].n === 0) {
      const defaults = [
        [1,  12,  6,  52.636, 62.525, 115.161, -6.595018782],
        [13, 24,  12, 52.663, 62.827, 115.490, -6.455450357],
        [25, 36,  24, 53.509, 63.171, 116.680, -5.995151219],
        [37, 48,  36, 53.815, 63.539, 117.354, -5.762810228],
        [49, 60,  48,  0.000,  0.000,   0.000,  1.000000000],
      ];
      for (const [pmin, pmax, cuotas, ces, desg, ambos, factor] of defaults) {
        await pool.query(
          `INSERT INTO comisiones_seguro_plazo (plazo_min,plazo_max,cuotas,pct_cesantia,pct_desgravamen,pct_ambos,factor)
           VALUES (?,?,?,?,?,?,?)`,
          [pmin, pmax, cuotas, ces, desg, ambos, factor]
        );
      }
      console.log('✓ comisiones_seguro_plazo: datos por defecto insertados');
    }
  } catch (e) { console.error('[comisiones_seguro migration]', e.message); }
})();

const getAll = async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM comisiones_seguro_plazo ORDER BY plazo_min');
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

const update = async (req, res) => {
  try {
    const { id } = req.params;
    const { pct_cesantia, pct_desgravamen, pct_ambos, factor, estado } = req.body;
    await pool.query(
      `UPDATE comisiones_seguro_plazo
       SET pct_cesantia=?, pct_desgravamen=?, pct_ambos=?, factor=?, estado=?
       WHERE id=?`,
      [pct_cesantia, pct_desgravamen, pct_ambos, factor, estado || 'activo', id]
    );
    res.json({ success: true, data: null, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { getAll, update };
