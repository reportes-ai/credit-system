const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

require('../../../../shared/migrate').enFila('cuentas-bancarias', async () => {
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
  /* Cuenta CONTABLE de cada cuenta bancaria: con ella el asiento del pago va al
     banco REAL del depósito (pedido de Pato 26-08-2026), no al genérico de la
     regla. Fuente única: esta ficha; consumidor: pagos-credito → contabilizar. */
  await pool.query("ALTER TABLE cuentas_bancarias ADD COLUMN IF NOT EXISTS cuenta_contable VARCHAR(20) NULL COMMENT 'Cuenta del plan contable donde asientan los pagos recibidos en esta cuenta'").catch(() => {});
  // Semilla una vez: la única cuenta existente (Banco de Chile) → 1101040 BANCO CHILE
  require('../../../../shared/migrate').migrar('cta-bancaria-cuenta-contable-seed', async () => {
    await pool.query("UPDATE cuentas_bancarias SET cuenta_contable='1101040' WHERE cuenta_contable IS NULL AND UPPER(COALESCE(banco,'')) LIKE '%CHILE%'");
  });
});

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

// La cuenta contable debe existir en el plan: un código inventado dejaría los
// pagos asentando contra una cuenta fantasma.
async function validarCuentaContable(cc) {
  const v = String(cc || '').trim();
  if (!v) return { valor: null };
  const [[existe]] = await pool.query('SELECT codigo, nombre FROM ctb_cuentas WHERE codigo=?', [v]);
  return existe ? { valor: v } : { error: `La cuenta contable ${v} no existe en el plan de cuentas` };
}

const create = async (req, res) => {
  try {
    const { razon_social, rut, nombre, numero_cuenta, banco, tipo_cuenta, activo, cuenta_contable } = req.body;
    if (!razon_social?.trim() || !rut?.trim() || !nombre?.trim() || !numero_cuenta?.trim())
      return err(res, 'razon_social, rut, nombre y numero_cuenta son requeridos', 400);
    const cc = await validarCuentaContable(cuenta_contable);
    if (cc.error) return err(res, cc.error, 400);
    const [r] = await pool.query(
      `INSERT INTO cuentas_bancarias (razon_social, rut, nombre, numero_cuenta, banco, tipo_cuenta, activo, cuenta_contable)
       VALUES (?,?,?,?,?,?,?,?)`,
      [razon_social.trim(), rut.trim(), nombre.trim(), numero_cuenta.trim(),
       banco?.trim()||null, tipo_cuenta?.trim()||null, activo===undefined?1:activo, cc.valor]
    );
    const [[row]] = await pool.query('SELECT * FROM cuentas_bancarias WHERE id_cuenta=?', [r.insertId]);
    auditar({ req, accion: 'CREAR', modulo: 'mantenedores', entidad: 'cuenta_bancaria', entidad_id: r.insertId, detalle: `Creó cuenta bancaria ${nombre.trim()} — ${numero_cuenta.trim()}`, rut: rut, meta: { razon_social, banco } });
    res.status(201).json({ success: true, data: row, error: null });
  } catch(e) { err(res, e); }
};

const update = async (req, res) => {
  try {
    const { razon_social, rut, nombre, numero_cuenta, banco, tipo_cuenta, activo, cuenta_contable } = req.body;
    if (!razon_social?.trim() || !rut?.trim() || !nombre?.trim() || !numero_cuenta?.trim())
      return err(res, 'razon_social, rut, nombre y numero_cuenta son requeridos', 400);
    const cc = await validarCuentaContable(cuenta_contable);
    if (cc.error) return err(res, cc.error, 400);
    await pool.query(
      `UPDATE cuentas_bancarias SET razon_social=?, rut=?, nombre=?, numero_cuenta=?,
       banco=?, tipo_cuenta=?, activo=?, cuenta_contable=? WHERE id_cuenta=?`,
      [razon_social.trim(), rut.trim(), nombre.trim(), numero_cuenta.trim(),
       banco?.trim()||null, tipo_cuenta?.trim()||null, activo===undefined?1:activo, cc.valor,
       req.params.id]
    );
    const [[row]] = await pool.query('SELECT * FROM cuentas_bancarias WHERE id_cuenta=?', [req.params.id]);
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'cuenta_bancaria', entidad_id: req.params.id, detalle: `Editó cuenta bancaria #${req.params.id} (${nombre.trim()})`, rut: rut });
    ok(res, row);
  } catch(e) { err(res, e); }
};

const remove = async (req, res) => {
  try {
    await pool.query('DELETE FROM cuentas_bancarias WHERE id_cuenta=?', [req.params.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'mantenedores', entidad: 'cuenta_bancaria', entidad_id: req.params.id, detalle: `Eliminó cuenta bancaria #${req.params.id}` });
    ok(res, null);
  } catch(e) { err(res, e); }
};

module.exports = { list, getOne, create, update, remove };
