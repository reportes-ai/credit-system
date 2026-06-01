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
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
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
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
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
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
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
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
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
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const deleteVehiculo = async (req, res) => {
  try {
    await pool.query('DELETE FROM vehiculos WHERE id_vehiculo=?', [req.params.id]);
    res.json({ success: true, data: { mensaje: 'Vehículo eliminado' }, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

/* Cascada marca → modelo → año → detalle (transmisión, combustible, tasación, permiso) */
const getCascada = async (req, res) => {
  try {
    const { marca, modelo, anio } = req.query;

    if (marca && modelo && anio) {
      // Registro completo para la combinación exacta
      const [rows] = await pool.query(
        `SELECT * FROM vehiculos WHERE marca=? AND modelo=? AND anio=? ORDER BY version LIMIT 20`,
        [marca, modelo, parseInt(anio)]
      );
      const transmisiones = [...new Set(rows.map(r => r.transmision).filter(Boolean))];
      const combustibles  = [...new Set(rows.map(r => r.combustible).filter(Boolean))];
      // Tasación y permiso (tomar el primero disponible)
      const tasacion = rows.find(r => r.tasacion)?.tasacion ?? null;
      const permiso  = rows.find(r => r.permiso)?.permiso   ?? null;
      res.json({ success: true, data: { tipo: 'detalle', transmisiones, combustibles, tasacion, permiso, rows }, error: null });

    } else if (marca && modelo) {
      // Años disponibles para marca+modelo
      const [rows] = await pool.query(
        `SELECT DISTINCT anio FROM vehiculos WHERE marca=? AND modelo=? ORDER BY anio DESC`,
        [marca, modelo]
      );
      res.json({ success: true, data: { tipo: 'anios', anios: rows.map(r => r.anio) }, error: null });

    } else if (marca) {
      // Modelos distintos para la marca
      const [rows] = await pool.query(
        `SELECT DISTINCT modelo FROM vehiculos WHERE marca=? ORDER BY modelo`,
        [marca]
      );
      res.json({ success: true, data: { tipo: 'modelos', modelos: rows.map(r => r.modelo) }, error: null });

    } else {
      // Todas las marcas
      const [rows] = await pool.query(`SELECT DISTINCT marca FROM vehiculos ORDER BY marca`);
      res.json({ success: true, data: { tipo: 'marcas', marcas: rows.map(r => r.marca) }, error: null });
    }
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

module.exports = { getVehiculos, getFiltros, getCascada, importar, createVehiculo, updateVehiculo, deleteVehiculo };
