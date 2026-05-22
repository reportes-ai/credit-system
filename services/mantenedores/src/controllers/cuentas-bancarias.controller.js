const pool = require('../../../../shared/config/database');

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cuentas_bancarias (
        id_cuenta     INT AUTO_INCREMENT PRIMARY KEY,
        razon_social  VARCHAR(200) NOT NULL,
        rut           VARCHAR(20)  NOT NULL,
        nombre        VARCHAR(200) NOT NULL,
        numero_cuenta VARCHAR(50)  NOT NULL,
        banco         VARCHAR(100) NULL,
        tipo_cuenta   VARCHAR(50)  NULL,
        activo        TINYINT(1)   NOT NULL DEFAULT 1,
        created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
  } catch(e) { if (e.errno !== 1050) console.error('[cuentas_bancarias migration]', e.message); }
})();

const ok  = (res, data) => res.json({ success: true,  data, error: null });
const err = (res, e, s=500) => res.status(s).json({ success: false, data: null, error: e?.message||e });

const list = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM cuentas_bancarias ORDER BY razon_social, nombre`
    );
    ok(res, rows);
  } catch(e) { err(res, e); }
};

const getOne = async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT * FROM cuentas_bancarias WHERE id_cuenta=?', [req.params.id]);
    if (!row) return err(res, 'No encontrado', 404);
    ok(res, row);
  } catch(e) { err(res, e); }
};

const create = async (req, res) => {
  try {
    const { razon_social, rut, nombre, numero_cuenta, banco, tipo_cuenta, activo } = req.body;
    if (!razon_social?.trim() || !rut?.trim() || !nombre?.trim() || !numero_cuenta?.trim())
      return err(res, 'razon_social, rut, nombre y numero_cuenta son requeridos', 400);
    const [r] = await pool.query(
      `INSERT INTO cuentas_bancarias (razon_social, rut, nombre, numero_cuenta, banco, tipo_cuenta, activo)
       VALUES (?,?,?,?,?,?,?)`,
      [razon_social.trim(), rut.trim(), nombre.trim(), numero_cuenta.trim(),
       banco?.trim()||null, tipo_cuenta?.trim()||null, activo===undefined?1:activo]
    );
    const [[row]] = await pool.query('SELECT * FROM cuentas_bancarias WHERE id_cuenta=?', [r.insertId]);
    res.status(201).json({ success: true, data: row, error: null });
  } catch(e) { err(res, e); }
};

const update = async (req, res) => {
  try {
    const { razon_social, rut, nombre, numero_cuenta, banco, tipo_cuenta, activo } = req.body;
    if (!razon_social?.trim() || !rut?.trim() || !nombre?.trim() || !numero_cuenta?.trim())
      return err(res, 'razon_social, rut, nombre y numero_cuenta son requeridos', 400);
    await pool.query(
      `UPDATE cuentas_bancarias SET razon_social=?, rut=?, nombre=?, numero_cuenta=?,
       banco=?, tipo_cuenta=?, activo=? WHERE id_cuenta=?`,
      [razon_social.trim(), rut.trim(), nombre.trim(), numero_cuenta.trim(),
       banco?.trim()||null, tipo_cuenta?.trim()||null, activo===undefined?1:activo,
       req.params.id]
    );
    const [[row]] = await pool.query('SELECT * FROM cuentas_bancarias WHERE id_cuenta=?', [req.params.id]);
    ok(res, row);
  } catch(e) { err(res, e); }
};

const remove = async (req, res) => {
  try {
    await pool.query('DELETE FROM cuentas_bancarias WHERE id_cuenta=?', [req.params.id]);
    ok(res, null);
  } catch(e) { err(res, e); }
};

module.exports = { list, getOne, create, update, remove };
