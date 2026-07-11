const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { recalcularMesesAbiertos } = require('../../../creditos/src/utils/recalcular-mes');
// Cambiar la comisión/arriendo de un parque dispara el recálculo de los meses
// abiertos (fire-and-forget, respeta los campos forzados).
const dispararRecalc = () => recalcularMesesAbiertos()
  .then(r => { if (r.actualizados) console.log(`[recalc auto] ${r.actualizados} ops recalculadas`); })
  .catch(e => console.error('[recalc auto]', e.message));

// Migración: crear tabla parques_comisiones con datos iniciales del Excel
require('../../../../shared/migrate').enFila('parques', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS parques_comisiones (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        arriendo DECIMAL(12,0) NOT NULL DEFAULT 0,
        comision_pct DECIMAL(6,4) NOT NULL DEFAULT 0,
        activo TINYINT(1) DEFAULT 1,
        orden INT DEFAULT 99,
        created_at DATETIME DEFAULT NOW(),
        updated_at DATETIME DEFAULT NOW() ON UPDATE NOW()
      )
    `);

    const iniciales = [
      ['PARQUE AUTOMALL',               0,      0.0300, 1,  1],
      ['PARQUE CERRILLOS',         500000,      0.0250, 1,  2],
      ['PARQUE CARMOONS',          250000,      0.0250, 1,  3],
      ['PARQUE PANAMERICANA',      250000,      0.0250, 1,  4],
      ['PARQUE OESTE',             250000,      0.0250, 1,  5],
      ['PARQUE AUTOPARK',          450000,      0.0250, 1,  6],
      ['PARQUE AUTOCENTER',              0,     0.0250, 1,  7],
      ['PARQUE AUTOCENTER MAIPU',        0,     0.0250, 1,  8],
      ['PARQUE AUTOCENTER QUILICURA',    0,     0.0000, 1,  9],
      ['PARQUE MAIPU',             250000,      0.0170, 1, 10],
      ['PARQUE LONQUEN',           250000,      0.0180, 1, 11],
    ];

    const [exists] = await pool.query('SELECT COUNT(*) AS cnt FROM parques_comisiones');
    if (exists[0].cnt === 0) {
      for (const [nombre, arriendo, comision_pct, activo, orden] of iniciales) {
        await pool.query(
          'INSERT INTO parques_comisiones (nombre, arriendo, comision_pct, activo, orden) VALUES (?,?,?,?,?)',
          [nombre, arriendo, comision_pct, activo, orden]
        );
      }
      console.log('✓ parques_comisiones: datos iniciales insertados');
    }
    // La card incorpora la comisión dealer por plazo (parque y calle) → nombre actualizado.
    await pool.query("UPDATE funcionalidades SET nombre='Arriendos y Comisiones Parque y Calle' WHERE codigo='mantenedores_parques' AND nombre<>'Arriendos y Comisiones Parque y Calle'").catch(()=>{});
  } catch (e) {
    console.error('[parques migration]', e.message);
  }
});

const getAll = async (req, res) => {
  try {
    const soloActivos = req.query.activos === '1';
    const where = soloActivos ? 'WHERE activo = 1' : '';
    const [rows] = await pool.query(
      `SELECT * FROM parques_comisiones ${where} ORDER BY orden, nombre`
    );
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const create = async (req, res) => {
  try {
    const { nombre, arriendo, comision_pct, activo = 1, orden = 99 } = req.body;
    if (!nombre?.trim()) return res.status(400).json({ success: false, data: null, error: 'Nombre requerido' });

    const [[dup]] = await pool.query(
      'SELECT id FROM parques_comisiones WHERE nombre = ?', [nombre.trim().toUpperCase()]
    );
    if (dup) return res.status(400).json({ success: false, data: null, error: 'Ya existe un parque con ese nombre' });

    const [r] = await pool.query(
      'INSERT INTO parques_comisiones (nombre, arriendo, comision_pct, activo, orden) VALUES (?,?,?,?,?)',
      [nombre.trim().toUpperCase(), arriendo || 0, comision_pct || 0, activo ? 1 : 0, orden]
    );
    const [[row]] = await pool.query('SELECT * FROM parques_comisiones WHERE id = ?', [r.insertId]);
    auditar({ req, accion: 'CREAR', modulo: 'mantenedores', entidad: 'parque', entidad_id: r.insertId, detalle: `Creó el parque "${nombre.trim().toUpperCase()}"`, meta: req.body });
    dispararRecalc();
    res.status(201).json({ success: true, data: row, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const update = async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, arriendo, comision_pct, activo, orden } = req.body;

    const [[exists]] = await pool.query('SELECT id FROM parques_comisiones WHERE id = ?', [id]);
    if (!exists) return res.status(404).json({ success: false, data: null, error: 'Parque no encontrado' });

    await pool.query(
      'UPDATE parques_comisiones SET nombre=?, arriendo=?, comision_pct=?, activo=?, orden=?, updated_at=NOW() WHERE id=?',
      [nombre?.trim().toUpperCase(), arriendo ?? 0, comision_pct ?? 0, activo ? 1 : 0, orden ?? 99, id]
    );
    const [[row]] = await pool.query('SELECT * FROM parques_comisiones WHERE id = ?', [id]);
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'parque', entidad_id: id, detalle: `Editó el parque #${id}`, meta: req.body });
    dispararRecalc();
    res.json({ success: true, data: row, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const remove = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE parques_comisiones SET activo = 0 WHERE id = ?', [id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'mantenedores', entidad: 'parque', entidad_id: id, detalle: `Desactivó el parque #${id}` });
    dispararRecalc();
    res.json({ success: true, data: { desactivado: id }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

module.exports = { getAll, create, update, remove };
