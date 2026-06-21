'use strict';
/**
 * CRUD genérico para indicadores tipo (fecha, valor): dólar, IPC, etc.
 * Crea la tabla y devuelve los handlers REST. Reusa el patrón de UF/UTM.
 */
const pool = require('../../../shared/config/database');
const { auditar } = require('../../../shared/audit');

function crear(tabla, idCol, label) {
  (async () => {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS ${tabla} (
        ${idCol}   INT AUTO_INCREMENT PRIMARY KEY,
        fecha      DATE NOT NULL UNIQUE,
        valor      DECIMAL(14,4) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP )`);
    } catch (e) { if (e.errno !== 1050) console.error(`[${tabla} migration]`, e.message); }
  })();

  const err = (res, e) => { console.error(`[${tabla}]`, e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); };

  return {
    getAll:     async (req, res) => { try { const [r] = await pool.query(`SELECT * FROM ${tabla} ORDER BY fecha DESC LIMIT 400`); res.json({ success: true, data: r, error: null }); } catch (e) { err(res, e); } },
    getVigente: async (req, res) => { try { const [r] = await pool.query(`SELECT * FROM ${tabla} WHERE fecha<=CURDATE() ORDER BY fecha DESC LIMIT 1`); res.json({ success: true, data: r[0] || null, error: null }); } catch (e) { err(res, e); } },
    getEnFecha: async (req, res) => { try { const [r] = await pool.query(`SELECT * FROM ${tabla} WHERE fecha<=? ORDER BY fecha DESC LIMIT 1`, [req.params.fecha]); res.json({ success: true, data: r[0] || null, error: null }); } catch (e) { err(res, e); } },
    create: async (req, res) => {
      try {
        const { fecha, valor } = req.body;
        if (!fecha || valor === undefined) return res.status(400).json({ success: false, data: null, error: 'Fecha y valor son requeridos' });
        const [r] = await pool.query(`INSERT INTO ${tabla} (fecha, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)`, [fecha, valor]);
        auditar({ req, accion: 'CREAR', modulo: 'mantenedores', entidad: tabla, entidad_id: r.insertId, detalle: `Registró ${label} ${fecha} = ${valor}`, meta: { fecha, valor } });
        res.status(201).json({ success: true, data: { [idCol]: r.insertId, fecha, valor }, error: null });
      } catch (e) { err(res, e); }
    },
    update: async (req, res) => {
      try {
        const { fecha, valor } = req.body;
        await pool.query(`UPDATE ${tabla} SET fecha=?, valor=? WHERE ${idCol}=?`, [fecha, valor, req.params.id]);
        auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: tabla, entidad_id: req.params.id, detalle: `Editó ${label} #${req.params.id} → ${fecha} = ${valor}`, meta: { fecha, valor } });
        res.json({ success: true, data: { [idCol]: req.params.id, fecha, valor }, error: null });
      } catch (e) { err(res, e); }
    },
    remove: async (req, res) => {
      try {
        await pool.query(`DELETE FROM ${tabla} WHERE ${idCol}=?`, [req.params.id]);
        auditar({ req, accion: 'ELIMINAR', modulo: 'mantenedores', entidad: tabla, entidad_id: req.params.id, detalle: `Eliminó ${label} #${req.params.id}` });
        res.json({ success: true, data: { mensaje: `${label} eliminado` }, error: null });
      } catch (e) { err(res, e); }
    },
  };
}

module.exports = { crear };
