const pool = require('../../../../shared/config/database');

const ensureTable = () => pool.query(`CREATE TABLE IF NOT EXISTS vehiculos (
    id_vehiculo  INT AUTO_INCREMENT PRIMARY KEY,
    codigo_sii   VARCHAR(20),
    anio         SMALLINT,
    tipo         VARCHAR(60),
    marca        VARCHAR(60),
    modelo       VARCHAR(100),
    version      VARCHAR(200),
    puertas      TINYINT,
    cilindrada   INT,
    potencia     INT,
    combustible  VARCHAR(30),
    transmision  VARCHAR(30),
    marchas      TINYINT,
    traccion     VARCHAR(20),
    pais         VARCHAR(60),
    equipamiento TEXT,
    tasacion     BIGINT,
    permiso      BIGINT,
    beneficio_ley VARCHAR(10),
    UNIQUE KEY uk_vehiculo (codigo_sii, anio)
  )`);

// Create table on module load
ensureTable().catch(e => console.error('vehiculos table init error:', e.message));

const getVehiculos = async (req, res) => {
  try {
    const { marca, tipo, anio, q, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = [];
    const params = [];

    if (marca) { conditions.push('marca = ?'); params.push(marca); }
    if (tipo)  { conditions.push('tipo = ?'); params.push(tipo); }
    if (anio)  { conditions.push('anio = ?'); params.push(parseInt(anio)); }
    if (q) {
      const qLow = `%${q.toLowerCase()}%`;
      conditions.push(
        `(LOWER(marca) LIKE ? OR LOWER(modelo) LIKE ? OR LOWER(version) LIKE ?
          OR LOWER(tipo) LIKE ? OR LOWER(codigo_sii) LIKE ? OR LOWER(combustible) LIKE ?
          OR LOWER(transmision) LIKE ? OR LOWER(traccion) LIKE ? OR LOWER(pais) LIKE ?
          OR CAST(anio AS CHAR) LIKE ?)`
      );
      params.push(qLow, qLow, qLow, qLow, qLow, qLow, qLow, qLow, qLow, qLow);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM vehiculos ${where}`, params);
    const [rows] = await pool.query(
      `SELECT * FROM vehiculos ${where} ORDER BY marca, modelo, anio DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    res.json({ success: true, data: { rows, total, page: parseInt(page), limit: parseInt(limit) }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

const getFiltros = async (req, res) => {
  try {
    const [[marcas], [tipos], [anios]] = await Promise.all([
      pool.query('SELECT DISTINCT marca FROM vehiculos ORDER BY marca'),
      pool.query('SELECT DISTINCT tipo FROM vehiculos ORDER BY tipo'),
      pool.query('SELECT DISTINCT anio FROM vehiculos ORDER BY anio DESC'),
    ]);
    res.json({
      success: true,
      data: {
        marcas: marcas.map(r => r.marca),
        tipos: tipos.map(r => r.tipo),
        anios: anios.map(r => r.anio),
      },
      error: null,
    });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

const importar = async (req, res) => {
  try {
    await ensureTable();
    const { registros } = req.body;
    if (!Array.isArray(registros) || registros.length === 0)
      return res.status(400).json({ success: false, data: null, error: 'Sin registros' });

    const toInsert = [];
    for (const r of registros) {
      toInsert.push([
        r.codigo_sii, r.anio, r.tipo, r.marca, r.modelo, r.version,
        r.puertas, r.cilindrada, r.potencia, r.combustible,
        r.transmision, r.marchas, r.traccion, r.pais,
        r.equipamiento, r.tasacion, r.permiso, r.beneficio_ley,
      ]);
      if (r.anio === 2025) {
        toInsert.push([
          r.codigo_sii, 2026, r.tipo, r.marca, r.modelo, r.version,
          r.puertas, r.cilindrada, r.potencia, r.combustible,
          r.transmision, r.marchas, r.traccion, r.pais,
          r.equipamiento, r.tasacion, r.permiso, r.beneficio_ley,
        ]);
      }
    }

    const sql = `INSERT IGNORE INTO vehiculos
      (codigo_sii,anio,tipo,marca,modelo,version,puertas,cilindrada,potencia,
       combustible,transmision,marchas,traccion,pais,equipamiento,tasacion,permiso,beneficio_ley)
      VALUES ?`;
    const [result] = await pool.query(sql, [toInsert]);
    res.json({ success: true, data: { insertados: result.affectedRows }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

const createVehiculo = async (req, res) => {
  try {
    const { codigo_sii, anio, tipo, marca, modelo, version, puertas, cilindrada,
      potencia, combustible, transmision, marchas, traccion, pais,
      equipamiento, tasacion, permiso, beneficio_ley } = req.body;
    const [r] = await pool.query(
      `INSERT INTO vehiculos (codigo_sii,anio,tipo,marca,modelo,version,puertas,cilindrada,
       potencia,combustible,transmision,marchas,traccion,pais,equipamiento,tasacion,permiso,beneficio_ley)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [codigo_sii, anio, tipo, marca, modelo, version, puertas, cilindrada,
       potencia, combustible, transmision, marchas, traccion, pais,
       equipamiento, tasacion, permiso, beneficio_ley]
    );
    res.status(201).json({ success: true, data: { id_vehiculo: r.insertId }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

const updateVehiculo = async (req, res) => {
  try {
    const { tipo, marca, modelo, version, puertas, cilindrada,
      potencia, combustible, transmision, marchas, traccion, pais,
      equipamiento, tasacion, permiso, beneficio_ley } = req.body;
    await pool.query(
      `UPDATE vehiculos SET tipo=?,marca=?,modelo=?,version=?,puertas=?,cilindrada=?,
       potencia=?,combustible=?,transmision=?,marchas=?,traccion=?,pais=?,
       equipamiento=?,tasacion=?,permiso=?,beneficio_ley=?
       WHERE id_vehiculo=?`,
      [tipo, marca, modelo, version, puertas, cilindrada,
       potencia, combustible, transmision, marchas, traccion, pais,
       equipamiento, tasacion, permiso, beneficio_ley, req.params.id]
    );
    res.json({ success: true, data: { id_vehiculo: req.params.id }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

const deleteVehiculo = async (req, res) => {
  try {
    await pool.query('DELETE FROM vehiculos WHERE id_vehiculo=?', [req.params.id]);
    res.json({ success: true, data: { mensaje: 'Vehículo eliminado' }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

module.exports = { getVehiculos, getFiltros, importar, createVehiculo, updateVehiculo, deleteVehiculo };
