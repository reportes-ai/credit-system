const pool = require('../../../../shared/config/database');

/* ─── Crear / migrar tabla ──────────────────────────────────────────────── */
const ensureTable = async () => {
  // 1. Crear tabla base si no existe (esquema completo)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clientes (
      id_cliente          INT AUTO_INCREMENT PRIMARY KEY,
      rut                 VARCHAR(15)  NOT NULL UNIQUE,
      tipo_cliente        ENUM('PERSONA','EMPRESA') NOT NULL DEFAULT 'PERSONA',
      apellido_paterno    VARCHAR(100),
      apellido_materno    VARCHAR(100),
      nombres             VARCHAR(150),
      fecha_nacimiento    DATE,
      estado_civil        VARCHAR(60),
      sexo                VARCHAR(20),
      regimen             VARCHAR(60),
      cargas              TINYINT UNSIGNED DEFAULT 0,
      telefono_movil      VARCHAR(20),
      fecha_visa          DATE,
      tipo_visa           VARCHAR(100),
      nacionalidad        VARCHAR(100),
      nombre_fantasia     VARCHAR(200),
      razon_social        VARCHAR(200),
      codigo_actividad    VARCHAR(20),
      actividad_economica VARCHAR(300),
      fecha_inicio_actividad DATE,
      rep1_rut            VARCHAR(15),
      rep1_nombre         VARCHAR(150),
      rep1_ap_paterno     VARCHAR(100),
      rep1_ap_materno     VARCHAR(100),
      rep2_rut            VARCHAR(15),
      rep2_nombre         VARCHAR(150),
      rep2_ap_paterno     VARCHAR(100),
      rep2_ap_materno     VARCHAR(100),
      rep3_rut            VARCHAR(15),
      rep3_nombre         VARCHAR(150),
      rep3_ap_paterno     VARCHAR(100),
      rep3_ap_materno     VARCHAR(100),
      email              VARCHAR(200),
      direccion           VARCHAR(300),
      id_comuna           INT,
      id_provincia        INT,
      id_region           INT,
      fecha_creacion      DATETIME DEFAULT CURRENT_TIMESTAMP,
      fecha_actualizacion DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  // 2. Migración: agregar columnas nuevas si la tabla existía con esquema viejo
  //    TiDB soporta ADD COLUMN IF NOT EXISTS; usamos catch por si no lo soporta.
  const migraciones = [
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS tipo_cliente ENUM('PERSONA','EMPRESA') NOT NULL DEFAULT 'PERSONA'`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS apellido_paterno VARCHAR(100)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS apellido_materno VARCHAR(100)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS nombres VARCHAR(150)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS fecha_nacimiento DATE`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS estado_civil VARCHAR(60)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS sexo VARCHAR(20)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS regimen VARCHAR(60)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS cargas TINYINT UNSIGNED DEFAULT 0`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS telefono_movil VARCHAR(20)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS fecha_visa DATE`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS tipo_visa VARCHAR(100)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS nacionalidad VARCHAR(100)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS nombre_fantasia VARCHAR(200)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS razon_social VARCHAR(200)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS codigo_actividad VARCHAR(20)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS actividad_economica VARCHAR(300)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS fecha_inicio_actividad DATE`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS rep1_rut VARCHAR(15)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS rep1_nombre VARCHAR(150)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS rep1_ap_paterno VARCHAR(100)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS rep1_ap_materno VARCHAR(100)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS rep2_rut VARCHAR(15)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS rep2_nombre VARCHAR(150)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS rep2_ap_paterno VARCHAR(100)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS rep2_ap_materno VARCHAR(100)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS rep3_rut VARCHAR(15)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS rep3_nombre VARCHAR(150)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS rep3_ap_paterno VARCHAR(100)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS rep3_ap_materno VARCHAR(100)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS email VARCHAR(200)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS direccion VARCHAR(300)`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS id_comuna INT`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS id_provincia INT`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS id_region INT`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP`,
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS fecha_actualizacion DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`,
  ];

  // Quitar IF NOT EXISTS y capturar sólo el error "Duplicate column" (1060)
  // para máxima compatibilidad con distintas versiones de TiDB/MySQL
  const alters = migraciones.map(s => s.replace(' IF NOT EXISTS', ''));
  for (const sql of alters) {
    try {
      await pool.query(sql);
    } catch (e) {
      if (e.errno !== 1060) console.error('[clientes migration]', e.message);
      // errno 1060 = "Duplicate column name" → columna ya existía, ignorar
    }
  }

  // 3. Columnas del esquema viejo que eran NOT NULL → hacerlas nullable
  //    para que no rompan el INSERT del esquema nuevo.
  const fixes = [
    `ALTER TABLE clientes MODIFY COLUMN nombre     VARCHAR(200) NULL DEFAULT NULL`,
    `ALTER TABLE clientes MODIFY COLUMN email      VARCHAR(200) NULL DEFAULT NULL`,
    `ALTER TABLE clientes MODIFY COLUMN telefono   VARCHAR(20)  NULL DEFAULT NULL`,
    `ALTER TABLE clientes MODIFY COLUMN ciudad_id  INT          NULL DEFAULT NULL`,
    `ALTER TABLE clientes MODIFY COLUMN estado     VARCHAR(50)  NULL DEFAULT NULL`,
  ];
  for (const sql of fixes) {
    try {
      await pool.query(sql);
    } catch (e) {
      // errno 1054 = "Unknown column" → la columna no existe en esta instalación, ignorar
      if (e.errno !== 1054) console.error('[clientes migration fix]', e.message);
    }
  }
};

ensureTable().catch(console.error);

/* ─── Helpers ───────────────────────────────────────────────────────────── */
const up      = v => (v && typeof v === 'string' ? v.toUpperCase().trim() : v ?? null);
const normRut = v => v ? v.replace(/\./g, '').toUpperCase().trim() : null;

/* Calcula nombre_completo según tipo_cliente */
const calcNombreCompleto = (tipo, b) => {
  if (tipo === 'EMPRESA') {
    return up(b.razon_social) || null;
  }
  // PERSONA: concatenar nombres + apellido_paterno + apellido_materno
  return [up(b.nombres), up(b.apellido_paterno), up(b.apellido_materno)]
    .filter(Boolean).join(' ') || null;
};

/* ─── GET /rut/:rut ─────────────────────────────────────────────────────── */
const getByRut = async (req, res) => {
  try {
    const rut = normRut(decodeURIComponent(req.params.rut));

    // 1. Buscar en tabla clientes (datos completos)
    const [rows] = await pool.query('SELECT * FROM clientes WHERE rut = ?', [rut]);
    if (rows.length) return res.json({ success: true, data: rows[0], error: null });

    // 2. Fallback: buscar en creditos (datos básicos del Excel)
    const [ops] = await pool.query(`
      SELECT cl.rut,
             COALESCE(cl.nombre_completo, '') AS nombre_cliente,
             MAX(ob.fecha_otorgado) AS ultima_op,
             COUNT(*) AS total_ops
      FROM creditos ob
      LEFT JOIN clientes cl ON cl.id_cliente = ob.id_cliente
      WHERE cl.rut = ?
      GROUP BY cl.rut
      LIMIT 1
    `, [rut]);

    if (!ops.length) return res.json({ success: true, data: null, error: null });

    // Armar nombre desde nombre_cliente (viene como "APELLIDO1 APELLIDO2 NOMBRES")
    const nombreCompleto = ops[0].nombre_cliente || '';
    const partes = nombreCompleto.trim().split(/\s+/);

    return res.json({
      success: true,
      data: {
        id_cliente:       null,
        rut:              ops[0].rut,
        tipo_cliente:     'PERSONA',
        nombres:          partes.slice(2).join(' ') || partes[0] || '',
        apellido_paterno: partes[0] || '',
        apellido_materno: partes[1] || '',
        nombre_fantasia:  null,
        razon_social:     null,
        email:           null,
        telefono_movil:   null,
        direccion:        null,
        _desde_brokerage: true,   // indica que viene del Excel, sin perfil completo
        _total_ops:       ops[0].total_ops,
        _ultima_op:       ops[0].ultima_op,
      },
      error: null,
    });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── GET / ─────────────────────────────────────────────────────────────── */
const getAll = async (req, res) => {
  try {
    const { q } = req.query;
    let sql = 'SELECT * FROM clientes';
    const params = [];
    if (q) {
      sql += ` WHERE rut LIKE ? OR nombres LIKE ? OR apellido_paterno LIKE ?
               OR razon_social LIKE ? OR nombre_fantasia LIKE ?`;
      const like = `%${q.toUpperCase()}%`;
      params.push(like, like, like, like, like);
    }
    sql += ' ORDER BY fecha_actualizacion DESC LIMIT 200';
    const [rows] = await pool.query(sql, params);
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── GET /:id ──────────────────────────────────────────────────────────── */
const getById = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM clientes WHERE id_cliente = ?', [req.params.id]);
    if (!rows.length)
      return res.status(404).json({ success: false, data: null, error: 'Cliente no encontrado' });
    res.json({ success: true, data: rows[0], error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── POST / ────────────────────────────────────────────────────────────── */
const create = async (req, res) => {
  try {
    const b = req.body;
    if (!b.rut || !b.tipo_cliente)
      return res.status(400).json({ success: false, data: null, error: 'RUT y tipo_cliente son requeridos' });
    if (b.tipo_cliente === 'NATURAL' && (!b.nombres || !b.apellido_paterno))
      return res.status(400).json({ success: false, data: null, error: 'Nombres y apellido paterno son requeridos para persona natural' });
    if (b.tipo_cliente === 'JURIDICA' && !b.razon_social)
      return res.status(400).json({ success: false, data: null, error: 'Razón social es requerida para persona jurídica' });

    const rut = normRut(b.rut);
    // Verificar duplicado
    const [[{ cnt }]] = await pool.query('SELECT COUNT(*) AS cnt FROM clientes WHERE rut=?', [rut]);
    if (cnt > 0)
      return res.status(409).json({ success: false, data: null, error: 'El RUT ya existe' });

    const tipoCliente = up(b.tipo_cliente);
    const nombreCompleto = calcNombreCompleto(tipoCliente, b);

    const [r] = await pool.query(`
      INSERT INTO clientes
        (rut, tipo_cliente, nombre_completo,
         apellido_paterno, apellido_materno, nombres, fecha_nacimiento,
         estado_civil, sexo, regimen, cargas, telefono_movil,
         fecha_visa, tipo_visa, nacionalidad,
         nombre_fantasia, razon_social, codigo_actividad, actividad_economica, fecha_inicio_actividad,
         rep1_rut, rep1_nombre, rep1_ap_paterno, rep1_ap_materno,
         rep2_rut, rep2_nombre, rep2_ap_paterno, rep2_ap_materno,
         rep3_rut, rep3_nombre, rep3_ap_paterno, rep3_ap_materno,
         email, direccion, id_comuna, id_provincia, id_region)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        rut, tipoCliente, nombreCompleto,
        up(b.apellido_paterno), up(b.apellido_materno), up(b.nombres),
        b.fecha_nacimiento || null,
        up(b.estado_civil), up(b.sexo), up(b.regimen),
        b.cargas != null ? parseInt(b.cargas) : 0,
        up(b.telefono_movil),
        b.fecha_visa || null, up(b.tipo_visa), up(b.nacionalidad),
        up(b.nombre_fantasia), up(b.razon_social),
        up(b.codigo_actividad), up(b.actividad_economica),
        b.fecha_inicio_actividad || null,
        up(b.rep1_rut), up(b.rep1_nombre), up(b.rep1_ap_paterno), up(b.rep1_ap_materno),
        up(b.rep2_rut), up(b.rep2_nombre), up(b.rep2_ap_paterno), up(b.rep2_ap_materno),
        up(b.rep3_rut), up(b.rep3_nombre), up(b.rep3_ap_paterno), up(b.rep3_ap_materno),
        up(b.email), up(b.direccion),
        b.id_comuna || null, b.id_provincia || null, b.id_region || null
      ]
    );
    res.status(201).json({ success: true, data: { id_cliente: r.insertId }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── PUT /:id ──────────────────────────────────────────────────────────── */
const update = async (req, res) => {
  try {
    const b = req.body;
    if (!b.tipo_cliente)
      return res.status(400).json({ success: false, data: null, error: 'tipo_cliente es requerido' });
    if (b.tipo_cliente === 'NATURAL' && (!b.nombres || !b.apellido_paterno))
      return res.status(400).json({ success: false, data: null, error: 'Nombres y apellido paterno son requeridos para persona natural' });
    if (b.tipo_cliente === 'JURIDICA' && !b.razon_social)
      return res.status(400).json({ success: false, data: null, error: 'Razón social es requerida para persona jurídica' });

    const tipoCliente = up(b.tipo_cliente);
    const nombreCompleto = calcNombreCompleto(tipoCliente, b);

    await pool.query(`
      UPDATE clientes SET
        tipo_cliente=?, nombre_completo=?,
        apellido_paterno=?, apellido_materno=?, nombres=?, fecha_nacimiento=?,
        estado_civil=?, sexo=?, regimen=?, cargas=?, telefono_movil=?,
        fecha_visa=?, tipo_visa=?, nacionalidad=?,
        nombre_fantasia=?, razon_social=?, codigo_actividad=?, actividad_economica=?, fecha_inicio_actividad=?,
        rep1_rut=?, rep1_nombre=?, rep1_ap_paterno=?, rep1_ap_materno=?,
        rep2_rut=?, rep2_nombre=?, rep2_ap_paterno=?, rep2_ap_materno=?,
        rep3_rut=?, rep3_nombre=?, rep3_ap_paterno=?, rep3_ap_materno=?,
        email=?, direccion=?, id_comuna=?, id_provincia=?, id_region=?
      WHERE id_cliente=?`,
      [
        tipoCliente, nombreCompleto,
        up(b.apellido_paterno), up(b.apellido_materno), up(b.nombres),
        b.fecha_nacimiento || null,
        up(b.estado_civil), up(b.sexo), up(b.regimen),
        b.cargas != null ? parseInt(b.cargas) : 0,
        up(b.telefono_movil),
        b.fecha_visa || null, up(b.tipo_visa), up(b.nacionalidad),
        up(b.nombre_fantasia), up(b.razon_social),
        up(b.codigo_actividad), up(b.actividad_economica),
        b.fecha_inicio_actividad || null,
        up(b.rep1_rut), up(b.rep1_nombre), up(b.rep1_ap_paterno), up(b.rep1_ap_materno),
        up(b.rep2_rut), up(b.rep2_nombre), up(b.rep2_ap_paterno), up(b.rep2_ap_materno),
        up(b.rep3_rut), up(b.rep3_nombre), up(b.rep3_ap_paterno), up(b.rep3_ap_materno),
        up(b.email), up(b.direccion),
        b.id_comuna || null, b.id_provincia || null, b.id_region || null,
        req.params.id
      ]
    );
    res.json({ success: true, data: { id_cliente: req.params.id }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

module.exports = { getByRut, getAll, getById, create, update };
