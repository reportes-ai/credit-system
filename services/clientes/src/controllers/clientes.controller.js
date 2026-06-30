const pool = require('../../../../shared/config/database');
const RUT = require('../../../../api-gateway/public/js/rut-core');  // enforcement: RUT canónico

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
    `ALTER TABLE clientes ADD COLUMN IF NOT EXISTS origen_dn JSON`,
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

  // 4. SOCIOS de la empresa (N por cliente). El cliente es identidad única; sus socios viven
  //    en esta tabla hija. Se alimenta desde la ficha de empresa (intake manual). El giro de
  //    la empresa ya está en clientes.codigo_actividad + actividad_economica (fuente: mantenedor
  //    SII actividades_economicas).
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS cliente_socios (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      id_cliente BIGINT NOT NULL,
      rut VARCHAR(15) NULL,
      nombre VARCHAR(150) NULL,
      apellido_paterno VARCHAR(100) NULL,
      apellido_materno VARCHAR(100) NULL,
      pct_participacion DECIMAL(5,2) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_cliente_socio (id_cliente, rut),
      KEY idx_id_cliente (id_cliente)
    )`);
  } catch (e) { console.error('[clientes migration socios]', e.message); }
};

ensureTable().catch(console.error);

/* ─── Helpers ───────────────────────────────────────────────────────────── */
const up      = v => (v && typeof v === 'string' ? v.toUpperCase().trim() : v ?? null);
const normRut = v => RUT.normalizar(v) || (v ? v.replace(/\./g, '').toUpperCase().trim() : null);

/* Calcula nombre_completo según tipo_cliente */
const calcNombreCompleto = (tipo, b) => {
  if (tipo === 'EMPRESA') {
    return up(b.razon_social) || null;
  }
  // PERSONA: concatenar nombres + apellido_paterno + apellido_materno
  return [up(b.nombres), up(b.apellido_paterno), up(b.apellido_materno)]
    .filter(Boolean).join(' ') || null;
};

/* ─── Datos personales desde el Perfil Comercial DealerNet (cód. 3435) ───────
   Rellena SOLO los campos vacíos del cliente y deja traza en clientes.origen_dn
   (lista de campos que vinieron de DealerNet → la ficha les pone asterisco azul). */
const _wgp  = (o, ...ks) => { for (const k of ks) { if (o == null) return undefined; o = o[k]; } return o; };
const _warr = x => x == null ? [] : (Array.isArray(x) ? x : [x]);
function extraerPersonalDN(cont) {
  const colect = _wgp(cont, 'DLNTPERCOMDLNTWS', 'ROOT', 'D', 'result', 'colect');
  if (!colect) return null;
  const titular = colect.titular || {};
  const nom  = _wgp(titular, 'nombre', 'd') || {};
  const civ  = _wgp(titular, 'det', 'detalle_rut', 'datos_civiles', 'd') || {};
  const tel  = _warr(_wgp(colect, 'telefonos',  'telefono_contacto_probable', 'd'))[0] || {};
  const dir  = _warr(_wgp(colect, 'direcciones','residencia_probable',        'd'))[0] || {};
  const mail = _warr(_wgp(colect, 'correos',    'correo_contacto_probable',   'd'))[0] || {};
  const partesAp = String(nom.apellidos || '').trim().split(/\s+/).filter(Boolean);
  const fnac = (civ.fch_nacimiento_ano && civ.fch_nacimiento_mes && civ.fch_nacimiento_dia)
    ? `${civ.fch_nacimiento_ano}-${String(civ.fch_nacimiento_mes).padStart(2, '0')}-${String(civ.fch_nacimiento_dia).padStart(2, '0')}` : null;
  const out = {
    apellido_paterno: partesAp[0] || null,
    apellido_materno: partesAp.slice(1).join(' ') || null,
    nombres: String(nom.nombres || '').trim() || null,
    fecha_nacimiento: fnac,
    estado_civil: civ.matrimonio_estado_civil || null,
    sexo: civ.sexo || null,
    nacionalidad: civ.nacionalidad || null,
    cargas: (civ.asignacion_familiar && civ.asignacion_familiar.hijos != null) ? Number(civ.asignacion_familiar.hijos) : null,
    telefono_movil: tel.telefono || null,
    email: mail.correo || null,
    direccion: dir.direccion || null,
  };
  Object.keys(out).forEach(k => { if (out[k] == null || out[k] === '') delete out[k]; });
  return Object.keys(out).length ? out : null;
}
async function sincronizarPersonalDealernet(rutDash) {
  try {
    const dig = rutDash.replace(/[.\s-]/g, '').toUpperCase();
    const rutDN = dig.length > 1 ? dig.slice(0, -1) : dig;     // dealernet_informes guarda el RUT sin DV
    const [[inf]] = await pool.query(
      "SELECT contenido FROM dealernet_informes WHERE rut=? AND codigo_producto='3435' AND retcode='0' ORDER BY created_at DESC LIMIT 1", [rutDN]);
    if (!inf) return false;
    let cont = inf.contenido; if (typeof cont === 'string') { try { cont = JSON.parse(cont); } catch { return false; } }
    const d = extraerPersonalDN(cont);
    if (!d) return false;
    const [[cli]] = await pool.query('SELECT * FROM clientes WHERE rut=? LIMIT 1', [rutDash]);
    if (!cli) return false;
    let origen = [];
    try { origen = Array.isArray(cli.origen_dn) ? cli.origen_dn : JSON.parse(cli.origen_dn || '[]'); } catch { origen = []; }
    const origenSet = new Set(origen);
    const set = {};
    for (const [k, v] of Object.entries(d)) {
      const actual = cli[k];
      const vacio = actual == null || actual === '' || (k === 'cargas' && Number(actual) === 0);
      if (vacio && v != null && v !== '') { set[k] = v; origenSet.add(k); }
    }
    const cols = Object.keys(set);
    if (!cols.length) return false;
    await pool.query(
      `UPDATE clientes SET ${cols.map(c => `${c}=?`).join(', ')}, origen_dn=? WHERE rut=?`,
      [...cols.map(c => set[c]), JSON.stringify([...origenSet]), rutDash]);
    return true;
  } catch (e) { console.error('[sincronizarPersonalDealernet]', e.message); return false; }
}

/* ─── GET /rut/:rut ─────────────────────────────────────────────────────── */
const getByRut = async (req, res) => {
  try {
    const rut = normRut(decodeURIComponent(req.params.rut));

    // 1. Buscar en tabla clientes (datos completos)
    const [rows] = await pool.query('SELECT * FROM clientes WHERE rut = ?', [rut]);
    if (rows.length) {
      const cli = rows[0];
      // Completa datos personales vacíos desde el Perfil Comercial DealerNet
      if (cli.tipo_cliente === 'PERSONA' && (!cli.nombres || !cli.apellido_paterno || !cli.fecha_nacimiento)) {
        const cambio = await sincronizarPersonalDealernet(rut);
        if (cambio) {
          const [r2] = await pool.query('SELECT * FROM clientes WHERE rut = ?', [rut]);
          return res.json({ success: true, data: r2[0] || cli, error: null });
        }
      }
      return res.json({ success: true, data: cli, error: null });
    }

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

/* ─── GET /reporteria — JOIN clientes + antecedentes + info_comercial ─────── */
const getReporteria = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        c.rut, c.tipo_cliente, c.nombre_completo,
        c.nombres, c.apellido_paterno, c.apellido_materno,
        c.fecha_nacimiento, c.estado_civil, c.sexo, c.regimen, c.cargas,
        c.telefono_movil, c.nacionalidad, c.email, c.direccion,
        c.actividad_economica, c.fecha_creacion,
        -- Antecedentes Laborales
        al.tipo_trabajador, al.empleador, al.rut_empresa, al.giro_empresa,
        al.ciudad_comercial, al.telefono_comercial, al.antiguedad_meses,
        al.renta_fija_liquida,
        al.renta_var_mes1, al.renta_var_mes2, al.renta_var_mes3,
        -- Información Comercial
        ic.monto_protestos, ic.protestos_vigentes_q,
        ic.deuda_vigente_total, ic.deuda_vigente_inst,
        ic.deuda_hipotecaria, ic.deuda_hipotecaria_carga,
        ic.deuda_comercial, ic.deuda_comercial_carga,
        ic.deuda_consumo, ic.deuda_consumo_carga,
        ic.deuda_morosa, ic.deuda_morosa_inst,
        ic.deuda_vencida, ic.deuda_castigada,
        ic.linea_disponible, ic.arriendo, ic.acredita_propiedad
      FROM clientes c
      LEFT JOIN antecedentes_laborales al ON al.rut_cliente = c.rut
      LEFT JOIN informacion_comercial   ic ON ic.rut_cliente = c.rut
      ORDER BY c.fecha_creacion DESC
    `);
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { getByRut, getAll, getById, create, update, getReporteria };
