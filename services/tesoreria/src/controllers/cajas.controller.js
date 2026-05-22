const pool = require('../../../../shared/config/database');

/* ── tabla cajas ─────────────────────────────────────────────────────────── */
const initTablas = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cajas (
      id_caja      INT AUTO_INCREMENT PRIMARY KEY,
      nombre       VARCHAR(80) NOT NULL,
      descripcion  VARCHAR(200) NULL,
      activo       TINYINT(1) NOT NULL DEFAULT 1,
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS caja_usuarios (
      id_asignacion           INT AUTO_INCREMENT PRIMARY KEY,
      id_caja                 INT NOT NULL,
      id_usuario              INT NOT NULL,
      puede_pagar_cuotas      TINYINT(1) NOT NULL DEFAULT 0,
      puede_reversar_pagos    TINYINT(1) NOT NULL DEFAULT 0,
      puede_condonar_intereses TINYINT(1) NOT NULL DEFAULT 0,
      tope_intereses          DECIMAL(5,2) NOT NULL DEFAULT 0,
      puede_condonar_gastos   TINYINT(1) NOT NULL DEFAULT 0,
      tope_gastos             DECIMAL(5,2) NOT NULL DEFAULT 0,
      activo                  TINYINT(1) NOT NULL DEFAULT 1,
      created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_caja_usuario (id_caja, id_usuario)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
};
initTablas().catch(e => console.error('[cajas] init tablas:', e.message));

/* ── helpers ─────────────────────────────────────────────────────────────── */
const ok  = (res, data) => res.json({ success: true, data, error: null });
const err = (res, e, code = 500) => res.status(code).json({ success: false, data: null, error: e.message || e });

/* ════════════════════════ CAJAS ════════════════════════════════════════════ */

/* GET /api/cajas */
const list = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.*,
              COUNT(cu.id_asignacion) AS total_usuarios
       FROM cajas c
       LEFT JOIN caja_usuarios cu ON cu.id_caja = c.id_caja AND cu.activo = 1
       GROUP BY c.id_caja
       ORDER BY c.nombre`
    );
    ok(res, rows);
  } catch(e) { err(res, e); }
};

/* POST /api/cajas */
const create = async (req, res) => {
  const { nombre, descripcion } = req.body;
  if (!nombre?.trim()) return err(res, 'El nombre es requerido', 400);
  try {
    const [r] = await pool.query(
      `INSERT INTO cajas (nombre, descripcion) VALUES (?,?)`,
      [nombre.trim(), descripcion?.trim() || null]
    );
    const [[caja]] = await pool.query(`SELECT * FROM cajas WHERE id_caja = ?`, [r.insertId]);
    ok(res, caja);
  } catch(e) { err(res, e); }
};

/* PUT /api/cajas/:id */
const update = async (req, res) => {
  const { nombre, descripcion, activo } = req.body;
  if (!nombre?.trim()) return err(res, 'El nombre es requerido', 400);
  try {
    await pool.query(
      `UPDATE cajas SET nombre=?, descripcion=?, activo=? WHERE id_caja=?`,
      [nombre.trim(), descripcion?.trim() || null, activo == null ? 1 : activo, req.params.id]
    );
    const [[caja]] = await pool.query(`SELECT * FROM cajas WHERE id_caja = ?`, [req.params.id]);
    ok(res, caja);
  } catch(e) { err(res, e); }
};

/* DELETE /api/cajas/:id */
const remove = async (req, res) => {
  try {
    await pool.query(`UPDATE cajas SET activo = 0 WHERE id_caja = ?`, [req.params.id]);
    ok(res, { id_caja: req.params.id });
  } catch(e) { err(res, e); }
};

/* ════════════════════════ ASIGNACIONES ════════════════════════════════════ */

/* GET /api/cajas/:id/usuarios */
const listUsuarios = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT cu.*,
              TRIM(CONCAT(COALESCE(u.nombre,''), ' ', COALESCE(u.apellido,''))) AS nombre_usuario,
              u.email,
              p.nombre AS perfil
       FROM caja_usuarios cu
       JOIN usuarios u ON cu.id_usuario = u.id_usuario
       LEFT JOIN perfiles p ON u.id_perfil = p.id_perfil
       WHERE cu.id_caja = ?
       ORDER BY nombre_usuario`,
      [req.params.id]
    );
    ok(res, rows);
  } catch(e) { err(res, e); }
};

/* POST /api/cajas/:id/usuarios  — crea o actualiza asignación */
const upsertUsuario = async (req, res) => {
  const id_caja = req.params.id;
  const {
    id_usuario,
    puede_pagar_cuotas = 0,
    puede_reversar_pagos = 0,
    puede_condonar_intereses = 0,
    tope_intereses = 0,
    puede_condonar_gastos = 0,
    tope_gastos = 0,
    activo = 1,
  } = req.body;
  if (!id_usuario) return err(res, 'id_usuario es requerido', 400);
  try {
    await pool.query(
      `INSERT INTO caja_usuarios
         (id_caja, id_usuario, puede_pagar_cuotas, puede_reversar_pagos,
          puede_condonar_intereses, tope_intereses, puede_condonar_gastos, tope_gastos, activo)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         puede_pagar_cuotas=VALUES(puede_pagar_cuotas),
         puede_reversar_pagos=VALUES(puede_reversar_pagos),
         puede_condonar_intereses=VALUES(puede_condonar_intereses),
         tope_intereses=VALUES(tope_intereses),
         puede_condonar_gastos=VALUES(puede_condonar_gastos),
         tope_gastos=VALUES(tope_gastos),
         activo=VALUES(activo)`,
      [id_caja, id_usuario,
       puede_pagar_cuotas ? 1 : 0, puede_reversar_pagos ? 1 : 0,
       puede_condonar_intereses ? 1 : 0, tope_intereses || 0,
       puede_condonar_gastos ? 1 : 0, tope_gastos || 0,
       activo ? 1 : 0]
    );
    const [[row]] = await pool.query(
      `SELECT cu.*,
              TRIM(CONCAT(COALESCE(u.nombre,''), ' ', COALESCE(u.apellido,''))) AS nombre_usuario,
              u.email, p.nombre AS perfil
       FROM caja_usuarios cu
       JOIN usuarios u ON cu.id_usuario = u.id_usuario
       LEFT JOIN perfiles p ON u.id_perfil = p.id_perfil
       WHERE cu.id_caja=? AND cu.id_usuario=?`,
      [id_caja, id_usuario]
    );
    ok(res, row);
  } catch(e) { err(res, e); }
};

/* DELETE /api/cajas/:id/usuarios/:uid */
const removeUsuario = async (req, res) => {
  try {
    await pool.query(
      `UPDATE caja_usuarios SET activo = 0 WHERE id_caja=? AND id_usuario=?`,
      [req.params.id, req.params.uid]
    );
    ok(res, { removed: true });
  } catch(e) { err(res, e); }
};

/* GET /api/cajas/todos-usuarios  — lista usuarios para el select */
const todosUsuarios = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id_usuario,
              TRIM(CONCAT(COALESCE(u.nombre,''), ' ', COALESCE(u.apellido,''))) AS nombre_usuario,
              u.email, p.nombre AS perfil
       FROM usuarios u
       LEFT JOIN perfiles p ON u.id_perfil = p.id_perfil
       WHERE u.activo = 1
       ORDER BY nombre_usuario`
    );
    ok(res, rows);
  } catch(e) { err(res, e); }
};

module.exports = { list, create, update, remove, listUsuarios, upsertUsuario, removeUsuario, todosUsuarios };
