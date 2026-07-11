const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

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
  // Atribución de condonación de CAPITAL (solo prepago): nace en 0 — se otorga caso a caso
  await pool.query(`ALTER TABLE caja_usuarios ADD COLUMN puede_condonar_capital TINYINT(1) NOT NULL DEFAULT 0`).catch(() => {});
  await pool.query(`ALTER TABLE caja_usuarios ADD COLUMN tope_capital DECIMAL(5,2) NOT NULL DEFAULT 0`).catch(() => {});
  // Horario de pagos paramétrico (1 fila global, id=1). Por defecto 09:00–16:00, Lun–Vie.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS caja_horario_pago (
      id           INT PRIMARY KEY,
      activo       TINYINT(1) NOT NULL DEFAULT 1,
      hora_inicio  TIME NOT NULL DEFAULT '09:00:00',
      hora_fin     TIME NOT NULL DEFAULT '16:00:00',
      dia_lun      TINYINT(1) NOT NULL DEFAULT 1,
      dia_mar      TINYINT(1) NOT NULL DEFAULT 1,
      dia_mie      TINYINT(1) NOT NULL DEFAULT 1,
      dia_jue      TINYINT(1) NOT NULL DEFAULT 1,
      dia_vie      TINYINT(1) NOT NULL DEFAULT 1,
      dia_sab      TINYINT(1) NOT NULL DEFAULT 0,
      dia_dom      TINYINT(1) NOT NULL DEFAULT 0,
      updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`INSERT IGNORE INTO caja_horario_pago (id) VALUES (1)`);
};
// Migraciones: perfil Tesorero + funcionalidad /tesoreria/caja/
require('../../../../shared/migrate').enFila('cajas', async () => {
  try {
    await pool.query(`
      INSERT INTO perfiles (nombre, descripcion)
      SELECT 'Tesorero', 'Acceso de lectura a todas las cajas'
      WHERE NOT EXISTS (SELECT 1 FROM perfiles WHERE nombre = 'Tesorero')
    `);
  } catch(e) { /* tabla puede no existir aún */ }

  try {
    // Obtener id_modulo de Tesorería
    const [[mod]] = await pool.query(
      `SELECT id_modulo FROM modulos WHERE ruta LIKE '%tesoreria%' LIMIT 1`
    );
    if (mod) {
      // Crear la funcionalidad "Caja" SOLO si no existe (evita acumular duplicados por arranque)
      let [[fila]] = await pool.query(
        `SELECT id_funcionalidad FROM funcionalidades WHERE codigo = 'teso-caja-operativa' LIMIT 1`
      );
      if (!fila) {
        const [ins] = await pool.query(
          `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
           VALUES (?, 'Caja', 'teso-caja-operativa', '/tesoreria/caja/', 'bi-cash-coin')`,
          [mod.id_modulo]
        );
        fila = { id_funcionalidad: ins.insertId };
      }
      if (fila) {
        const [perfiles] = await pool.query(
          `SELECT id_perfil FROM perfiles WHERE nombre IN ('Administrador','Gerente','Tesorero','Supervisor')`
        );
        for (const p of perfiles) {
          await pool.query(`
            INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
            VALUES (?, ?, 1)
          `, [p.id_perfil, fila.id_funcionalidad]);
        }
      }
    }
  } catch(e) { console.error('[cajas] migración funcionalidad caja:', e.message); }
});
initTablas().catch(e => console.error('[cajas] init tablas:', e.message));

/* ── helpers ─────────────────────────────────────────────────────────────── */
const ok  = (res, data) => res.json({ success: true, data, error: null });
const err = (res, e, code = 500) => res.status(code).json({ success: false, data: null, error: e.message || e });

/* ════════════════════════ CAJAS ════════════════════════════════════════════ */

/* GET /api/cajas */
const list = async (req, res) => {
  try {
    const perfil = req.usuario?.perfil_nombre;
    const soloLectura = !['Administrador', 'Gerente'].includes(perfil);
    const [rows] = await pool.query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM caja_usuarios cu WHERE cu.id_caja = c.id_caja AND cu.activo = 1) AS total_usuarios,
              (SELECT cu2.id_usuario FROM caja_usuarios cu2 WHERE cu2.id_caja = c.id_caja AND cu2.activo = 1 LIMIT 1) AS id_usuario_asignado,
              (SELECT TRIM(CONCAT(COALESCE(u2.nombre,''),' ',COALESCE(u2.apellido,'')))
               FROM caja_usuarios cu2 JOIN usuarios u2 ON u2.id_usuario = cu2.id_usuario
               WHERE cu2.id_caja = c.id_caja AND cu2.activo = 1 LIMIT 1) AS nombre_usuario_asignado
       FROM cajas c
       ORDER BY c.nombre`
    );
    rows.forEach(r => r.solo_lectura = soloLectura);
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
    auditar({ req, accion: 'CREAR', modulo: 'tesoreria', entidad: 'caja', entidad_id: r.insertId, detalle: `Creó la caja "${nombre.trim()}"` });
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
    auditar({ req, accion: 'EDITAR', modulo: 'tesoreria', entidad: 'caja', entidad_id: req.params.id, detalle: `Editó la caja "${nombre.trim()}" (#${req.params.id})` });
    ok(res, caja);
  } catch(e) { err(res, e); }
};

/* DELETE /api/cajas/:id */
const remove = async (req, res) => {
  try {
    await pool.query(`UPDATE cajas SET activo = 0 WHERE id_caja = ?`, [req.params.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'tesoreria', entidad: 'caja', entidad_id: req.params.id, detalle: `Desactivó la caja #${req.params.id}` });
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
    puede_condonar_capital = 0,
    tope_capital = 0,
    activo = 1,
  } = req.body;
  if (!id_usuario) return err(res, 'id_usuario es requerido', 400);
  try {
    await pool.query(
      `INSERT INTO caja_usuarios
         (id_caja, id_usuario, puede_pagar_cuotas, puede_reversar_pagos,
          puede_condonar_intereses, tope_intereses, puede_condonar_gastos, tope_gastos,
          puede_condonar_capital, tope_capital, activo)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         puede_pagar_cuotas=VALUES(puede_pagar_cuotas),
         puede_reversar_pagos=VALUES(puede_reversar_pagos),
         puede_condonar_intereses=VALUES(puede_condonar_intereses),
         tope_intereses=VALUES(tope_intereses),
         puede_condonar_gastos=VALUES(puede_condonar_gastos),
         tope_gastos=VALUES(tope_gastos),
         puede_condonar_capital=VALUES(puede_condonar_capital),
         tope_capital=VALUES(tope_capital),
         activo=VALUES(activo)`,
      [id_caja, id_usuario,
       puede_pagar_cuotas ? 1 : 0, puede_reversar_pagos ? 1 : 0,
       puede_condonar_intereses ? 1 : 0, tope_intereses || 0,
       puede_condonar_gastos ? 1 : 0, tope_gastos || 0,
       puede_condonar_capital ? 1 : 0, tope_capital || 0,
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
       WHERE u.estado = 'activo'
       ORDER BY nombre_usuario`
    );
    ok(res, rows);
  } catch(e) { err(res, e); }
};

/* GET /api/cajas/mi-caja  — devuelve la caja y permisos del usuario autenticado */
const miCaja = async (req, res) => {
  try {
    const id_usuario = req.usuario?.id_usuario;
    if (!id_usuario) return err(res, 'Sin usuario autenticado', 401);
    const [[row]] = await pool.query(
      `SELECT cu.*, cj.nombre AS nombre_caja, cj.descripcion
       FROM caja_usuarios cu
       JOIN cajas cj ON cu.id_caja = cj.id_caja
       WHERE cu.id_usuario = ? AND cu.activo = 1 AND cj.activo = 1
       LIMIT 1`,
      [id_usuario]
    );
    ok(res, row || null);
  } catch(e) { err(res, e); }
};

/* ════════════════════════ HORARIO DE PAGOS (paramétrico) ═══════════════════ */
const DIAS_COL = ['dia_lun', 'dia_mar', 'dia_mie', 'dia_jue', 'dia_vie', 'dia_sab', 'dia_dom'];
// MySQL DAYOFWEEK(): 1=domingo … 7=sábado.
const DOW_COL = { 1: 'dia_dom', 2: 'dia_lun', 3: 'dia_mar', 4: 'dia_mie', 5: 'dia_jue', 6: 'dia_vie', 7: 'dia_sab' };

/* GET /api/cajas/horario — config del horario + si AHORA está permitido (hora de Chile del server) */
const getHorario = async (req, res) => {
  try {
    const [[h]] = await pool.query(`
      SELECT h.*, (CURTIME() >= h.hora_inicio AND CURTIME() < h.hora_fin) AS hora_ok,
             DAYOFWEEK(NOW()) AS dow, DATE_FORMAT(NOW(),'%H:%i') AS ahora
      FROM caja_horario_pago h WHERE h.id = 1`);
    if (!h) return ok(res, null);
    const diaOk = !!h[DOW_COL[h.dow]];
    h.permitido_ahora = !h.activo || (!!h.hora_ok && diaOk);
    ok(res, h);
  } catch (e) { err(res, e); }
};

/* PUT /api/cajas/horario — actualiza el horario (permiso tesoreria_cajas) */
const putHorario = async (req, res) => {
  const b = req.body || {};
  const hhmm = s => { const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/); if (!m) return null; const H = +m[1], M = +m[2]; if (H > 23 || M > 59) return null; return String(H).padStart(2, '0') + ':' + m[2] + ':00'; };
  const ini = hhmm(b.hora_inicio), fin = hhmm(b.hora_fin);
  if (!ini || !fin) return err(res, 'Horas inválidas (use formato HH:MM)', 400);
  if (ini >= fin) return err(res, 'La hora de inicio debe ser anterior a la de término', 400);
  try {
    const dias = DIAS_COL.map(d => (b[d] ? 1 : 0));
    const activo = b.activo ? 1 : 0;
    await pool.query(
      `INSERT INTO caja_horario_pago (id, activo, hora_inicio, hora_fin, dia_lun,dia_mar,dia_mie,dia_jue,dia_vie,dia_sab,dia_dom)
       VALUES (1,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE activo=VALUES(activo), hora_inicio=VALUES(hora_inicio), hora_fin=VALUES(hora_fin),
         dia_lun=VALUES(dia_lun), dia_mar=VALUES(dia_mar), dia_mie=VALUES(dia_mie), dia_jue=VALUES(dia_jue),
         dia_vie=VALUES(dia_vie), dia_sab=VALUES(dia_sab), dia_dom=VALUES(dia_dom)`,
      [activo, ini, fin, ...dias]);
    auditar({ req, accion: 'EDITAR', modulo: 'tesoreria', entidad: 'caja_horario', entidad_id: 1, detalle: `Actualizó horario de pagos: ${activo ? 'activo' : 'sin restricción'} ${ini.slice(0, 5)}-${fin.slice(0, 5)}` });
    ok(res, { saved: true });
  } catch (e) { err(res, e); }
};

module.exports = { list, create, update, remove, listUsuarios, upsertUsuario, removeUsuario, todosUsuarios, miCaja, getHorario, putHorario };
