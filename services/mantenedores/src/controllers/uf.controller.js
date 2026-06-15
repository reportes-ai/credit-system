const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

const getAll = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM uf ORDER BY fecha DESC LIMIT 400');
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const getVigente = async (req, res) => {
  try {
    // Fallback: si no hay valor exacto de hoy, usa el último disponible
    const [rows] = await pool.query(
      'SELECT * FROM uf WHERE fecha <= CURDATE() ORDER BY fecha DESC LIMIT 1'
    );
    res.json({ success: true, data: rows[0] || null, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

// UF vigente en una fecha específica (o la más reciente anterior a esa fecha)
const getEnFecha = async (req, res) => {
  try {
    const { fecha } = req.params;
    const [rows] = await pool.query(
      'SELECT * FROM uf WHERE fecha <= ? ORDER BY fecha DESC LIMIT 1',
      [fecha]
    );
    res.json({ success: true, data: rows[0] || null, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const create = async (req, res) => {
  try {
    const { fecha, valor } = req.body;
    if (!fecha || valor === undefined)
      return res.status(400).json({ success: false, data: null, error: 'Fecha y valor son requeridos' });

    const [r] = await pool.query(
      'INSERT INTO uf (fecha, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)',
      [fecha, valor]
    );
    auditar({ req, accion: 'CREAR', modulo: 'mantenedores', entidad: 'uf', entidad_id: r.insertId, detalle: `Registró UF ${fecha} = ${valor}`, meta: { fecha, valor } });
    res.status(201).json({ success: true, data: { id_uf: r.insertId, fecha, valor }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const update = async (req, res) => {
  try {
    const { fecha, valor } = req.body;
    await pool.query('UPDATE uf SET fecha=?, valor=? WHERE id_uf=?', [fecha, valor, req.params.id]);
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'uf', entidad_id: req.params.id, detalle: `Editó UF #${req.params.id} → ${fecha} = ${valor}`, meta: { fecha, valor } });
    res.json({ success: true, data: { id_uf: req.params.id, fecha, valor }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const remove = async (req, res) => {
  try {
    await pool.query('DELETE FROM uf WHERE id_uf=?', [req.params.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'mantenedores', entidad: 'uf', entidad_id: req.params.id, detalle: `Eliminó registro UF #${req.params.id}` });
    res.json({ success: true, data: { mensaje: 'Registro UF eliminado' }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const importarCSV = async (req, res) => {
  try {
    const { registros } = req.body;
    if (!Array.isArray(registros) || registros.length === 0)
      return res.status(400).json({ success: false, data: null, error: 'Sin registros para importar' });

    let insertados = 0, omitidos = 0;
    for (const r of registros) {
      if (!r.fecha || r.valor === undefined) { omitidos++; continue; }
      const [exist] = await pool.query('SELECT id_uf FROM uf WHERE fecha = ?', [r.fecha]);
      if (exist.length > 0) { omitidos++; continue; }
      await pool.query('INSERT INTO uf (fecha, valor) VALUES (?, ?)', [r.fecha, r.valor]);
      insertados++;
    }
    auditar({ req, accion: 'CARGA_MASIVA', modulo: 'mantenedores', entidad: 'uf', detalle: `Importó UF por CSV: ${insertados} insertado(s), ${omitidos} omitido(s)`, meta: { insertados, omitidos } });
    res.json({ success: true, data: { insertados, omitidos }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

module.exports = { getAll, getVigente, getEnFecha, create, update, remove, importarCSV };
