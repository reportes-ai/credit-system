const pool = require('../../../../shared/config/database');

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tipos_documento (
        id_tipo     INT AUTO_INCREMENT PRIMARY KEY,
        nombre      VARCHAR(200) NOT NULL,
        descripcion VARCHAR(500) NULL,
        obligatorio TINYINT(1)  DEFAULT 1,
        activo      TINYINT(1)  DEFAULT 1,
        orden       INT         DEFAULT 0,
        created_at  DATETIME    DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const [cnt] = await pool.query('SELECT COUNT(*) as n FROM tipos_documento');
    if (cnt[0].n === 0) {
      // Seed inicial — Carnet en un solo documento (ambos lados en un archivo)
      const defaults = [
        ['Carnet de Identidad',              'Ambos lados en un solo archivo',  1, 1,  10],
        ['Comprobante de Domicilio',          null,                              1, 1,  20],
        ['Certificado AFP',                   null,                              1, 1,  30],
        ['Certificado RNDPA',                 null,                              1, 1,  40],
        ['Certificado Anotaciones Vigentes',  null,                              1, 1,  50],
        ['Certificado Historia Vehículo',     null,                              1, 1,  60],
        ['Liquidaciones de Sueldo',           'Últimas 3 liquidaciones',         1, 1,  70],
        ['Declaración de Impuestos',          null,                              0, 1,  80],
        ['Referencias',                       null,                              0, 1,  90],
      ];
      for (const [nombre, desc, obl, act, ord] of defaults) {
        await pool.query(
          'INSERT INTO tipos_documento (nombre, descripcion, obligatorio, activo, orden) VALUES (?,?,?,?,?)',
          [nombre, desc, obl, act, ord]
        );
      }
    } else {
      // Migración: fusionar Carnet Frente + Reverso en uno solo si aún existen separados
      const [frente] = await pool.query(`SELECT id_tipo FROM tipos_documento WHERE nombre LIKE '%Carnet%Frente%' LIMIT 1`);
      const [reverso] = await pool.query(`SELECT id_tipo FROM tipos_documento WHERE nombre LIKE '%Carnet%Reverso%' LIMIT 1`);
      if (frente.length && reverso.length) {
        await pool.query(`UPDATE tipos_documento SET nombre='Carnet de Identidad', descripcion='Ambos lados en un solo archivo', orden=10 WHERE id_tipo=?`, [frente[0].id_tipo]);
        await pool.query(`DELETE FROM tipos_documento WHERE id_tipo=?`, [reverso[0].id_tipo]);
      }
    }
  } catch(e) { if (e.errno !== 1050) console.error('[tipos_documento migration]', e.message); }
})();

const getAll = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tipos_documento ORDER BY orden, id_tipo');
    res.json({ success: true, data: rows, error: null });
  } catch(e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

const getActivos = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tipos_documento WHERE activo=1 ORDER BY orden, id_tipo');
    res.json({ success: true, data: rows, error: null });
  } catch(e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

const create = async (req, res) => {
  try {
    const { nombre, descripcion, obligatorio, activo, orden } = req.body;
    if (!nombre) return res.status(400).json({ success: false, data: null, error: 'nombre es requerido' });
    const [r] = await pool.query(
      'INSERT INTO tipos_documento (nombre, descripcion, obligatorio, activo, orden) VALUES (?,?,?,?,?)',
      [nombre, descripcion || null, obligatorio ? 1 : 0, activo !== false ? 1 : 0, orden || 0]
    );
    res.status(201).json({ success: true, data: { id_tipo: r.insertId }, error: null });
  } catch(e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

const update = async (req, res) => {
  try {
    const { nombre, descripcion, obligatorio, activo, orden } = req.body;
    if (!nombre) return res.status(400).json({ success: false, data: null, error: 'nombre es requerido' });
    await pool.query(
      'UPDATE tipos_documento SET nombre=?, descripcion=?, obligatorio=?, activo=?, orden=? WHERE id_tipo=?',
      [nombre, descripcion || null, obligatorio ? 1 : 0, activo !== false ? 1 : 0, orden || 0, req.params.id]
    );
    res.json({ success: true, data: { id_tipo: req.params.id }, error: null });
  } catch(e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

const remove = async (req, res) => {
  try {
    await pool.query('DELETE FROM tipos_documento WHERE id_tipo=?', [req.params.id]);
    res.json({ success: true, data: { mensaje: 'Tipo de documento eliminado' }, error: null });
  } catch(e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

module.exports = { getAll, getActivos, create, update, remove };
