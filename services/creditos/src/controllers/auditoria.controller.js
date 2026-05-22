const pool = require('../../../../shared/config/database');
// La tabla la crea shared/auditoria.js al arrancar

/* ─── GET /api/auditoria-credito/:id_credito ─────────────────────────────── */
const getByCredito = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id_auditoria, id_credito, fecha, usuario, id_usuario,
              perfil, accion, detalle, meta, ip
       FROM auditoria_credito
       WHERE id_credito = ?
       ORDER BY fecha ASC`,
      [req.params.id_credito]
    );
    res.json({ success: true, data: rows, error: null });
  } catch(e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { getByCredito };
