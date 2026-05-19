const pool = require('../../../../shared/config/database');

/* ─── Migración ──────────────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS creditos (
        id_credito         INT AUTO_INCREMENT PRIMARY KEY,
        numero_credito     VARCHAR(20) UNIQUE,
        rut_cliente        VARCHAR(15)  NOT NULL,
        nombre_cliente     VARCHAR(300) NOT NULL,
        empresa            VARCHAR(50)  NULL,
        id_cotizacion      INT          NULL,
        estado             VARCHAR(30)  NOT NULL DEFAULT 'VIGENTE',
        fecha_otorgamiento DATE,
        valor_vehiculo     BIGINT,
        pie                BIGINT,
        saldo_precio       BIGINT,
        monto_financiado   BIGINT,
        plazo              INT,
        tasa_mensual       DECIMAL(8,4),
        cuota              BIGINT,
        fecha_primera_cuota DATE,
        gastos_operativos  BIGINT,
        seguros            BIGINT,
        tipo_vehiculo      VARCHAR(100),
        marca              VARCHAR(100),
        modelo             VARCHAR(100),
        anio               INT,
        patente            VARCHAR(20),
        color              VARCHAR(50),
        motor              VARCHAR(100),
        chasis             VARCHAR(100),
        dealer             VARCHAR(200),
        ejecutivo          VARCHAR(200),
        observaciones      TEXT,
        datos_json         JSON,
        id_usuario         INT,
        created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`ALTER TABLE creditos ADD COLUMN numero_credito VARCHAR(20) NULL`).catch(e => { if(e.errno!==1060) throw e; });
    await pool.query(`ALTER TABLE creditos ADD COLUMN financiera VARCHAR(100) NULL AFTER numero_credito`).catch(e => { if(e.errno!==1060) throw e; });
    await pool.query(`ALTER TABLE creditos ADD COLUMN empresa VARCHAR(50) NULL AFTER nombre_cliente`).catch(e => { if(e.errno!==1060) throw e; });
    await pool.query(`ALTER TABLE creditos ADD COLUMN transmision VARCHAR(50) NULL AFTER dealer`).catch(e => { if(e.errno!==1060) throw e; });
    await pool.query(`ALTER TABLE creditos ADD COLUMN combustible VARCHAR(50) NULL AFTER transmision`).catch(e => { if(e.errno!==1060) throw e; });
    await pool.query(`ALTER TABLE creditos ADD COLUMN tasacion BIGINT NULL AFTER combustible`).catch(e => { if(e.errno!==1060) throw e; });
    await pool.query(`ALTER TABLE creditos ADD COLUMN permiso_circulacion BIGINT NULL AFTER tasacion`).catch(e => { if(e.errno!==1060) throw e; });
    await pool.query(`ALTER TABLE creditos ADD COLUMN id_dealer INT NULL AFTER permiso_circulacion`).catch(e => { if(e.errno!==1060) throw e; });
    await pool.query(`ALTER TABLE creditos ADD COLUMN tipo_ubicacion VARCHAR(10) NULL AFTER id_dealer`).catch(e => { if(e.errno!==1060) throw e; });
    await pool.query(`ALTER TABLE creditos ADD COLUMN nombre_parque VARCHAR(100) NULL AFTER tipo_ubicacion`).catch(e => { if(e.errno!==1060) throw e; });
  } catch (e) {
    if (e.errno !== 1050) console.error('[creditos migration]', e.message);
  }
})();

/* ─── Generar número de OP ───────────────────────────────────────────────── */
// Formato: YYMMXXX  (ej: 2605001 = año 2026, mes 05, secuencia 001)
async function generarNumero() {
  const hoy = new Date();
  const yy  = String(hoy.getFullYear()).slice(-2);
  const mm  = String(hoy.getMonth() + 1).padStart(2, '0');
  const prefix = `${yy}${mm}`;
  const [rows] = await pool.query(
    `SELECT numero_credito FROM creditos WHERE numero_credito LIKE ? ORDER BY id_credito DESC LIMIT 1`,
    [prefix + '%']
  );
  const seq = rows.length ? parseInt(rows[0].numero_credito.slice(4)) + 1 : 1;
  return prefix + String(seq).padStart(3, '0');
}

/* ─── CREATE ─────────────────────────────────────────────────────────────── */
const create = async (req, res) => {
  try {
    const {
      rut_cliente, nombre_cliente, empresa, financiera, id_cotizacion, estado,
      fecha_otorgamiento, valor_vehiculo, pie, saldo_precio, monto_financiado,
      plazo, tasa_mensual, cuota, fecha_primera_cuota,
      gastos_operativos, seguros,
      tipo_vehiculo, marca, modelo, anio, patente, color, motor, chasis,
      transmision, combustible, tasacion, permiso_circulacion,
      dealer, id_dealer, tipo_ubicacion, nombre_parque,
      ejecutivo, observaciones, datos_json,
    } = req.body;

    if (!rut_cliente || !nombre_cliente)
      return res.status(400).json({ success: false, data: null, error: 'rut_cliente y nombre_cliente son requeridos' });

    const numero_credito = await generarNumero();
    const id_usuario = req.usuario?.id_usuario || null;

    const [r] = await pool.query(
      `INSERT INTO creditos
         (numero_credito, rut_cliente, nombre_cliente, empresa, financiera, id_cotizacion, estado,
          fecha_otorgamiento, valor_vehiculo, pie, saldo_precio, monto_financiado,
          plazo, tasa_mensual, cuota, fecha_primera_cuota,
          gastos_operativos, seguros,
          tipo_vehiculo, marca, modelo, anio, patente, color, motor, chasis,
          transmision, combustible, tasacion, permiso_circulacion,
          dealer, id_dealer, tipo_ubicacion, nombre_parque,
          ejecutivo, observaciones, datos_json, id_usuario)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        numero_credito, rut_cliente.toUpperCase().trim(), nombre_cliente.trim(),
        empresa || null, financiera || 'AUTOFACIL', id_cotizacion || null, estado || 'VIGENTE',
        fecha_otorgamiento || null, valor_vehiculo || null, pie || null,
        saldo_precio || null, monto_financiado || null,
        plazo || null, tasa_mensual || null, cuota || null, fecha_primera_cuota || null,
        gastos_operativos || null, seguros || null,
        tipo_vehiculo || null, marca || null, modelo || null, anio || null,
        patente ? patente.toUpperCase().trim() : null, color || null,
        motor || null, chasis || null,
        transmision || null, combustible || null,
        tasacion || null, permiso_circulacion || null,
        dealer || null, id_dealer || null, tipo_ubicacion || null, nombre_parque || null,
        ejecutivo || null, observaciones || null,
        JSON.stringify(datos_json || {}), id_usuario,
      ]
    );
    res.status(201).json({ success: true, data: { id_credito: r.insertId, numero_credito }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ─── GET ALL ────────────────────────────────────────────────────────────── */
const getAll = async (req, res) => {
  try {
    const { q, estado } = req.query;
    let sql = `SELECT id_credito, numero_credito, rut_cliente, nombre_cliente,
                      estado, fecha_otorgamiento, valor_vehiculo, pie,
                      monto_financiado, plazo, tasa_mensual, cuota,
                      fecha_primera_cuota, tipo_vehiculo, marca, modelo,
                      anio, patente, dealer, ejecutivo, created_at
               FROM creditos WHERE 1=1`;
    const params = [];
    if (q && q.trim()) {
      const like = `%${q.trim().toUpperCase()}%`;
      sql += ` AND (UPPER(rut_cliente) LIKE ? OR UPPER(nombre_cliente) LIKE ? OR UPPER(numero_credito) LIKE ?)`;
      params.push(like, like, like);
    }
    if (estado) { sql += ` AND estado = ?`; params.push(estado); }
    sql += ` ORDER BY created_at DESC LIMIT 500`;
    const [rows] = await pool.query(sql, params);
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ─── GET BY ID ──────────────────────────────────────────────────────────── */
const getById = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM creditos WHERE id_credito = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, data: null, error: 'Crédito no encontrado' });
    res.json({ success: true, data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ─── UPDATE ─────────────────────────────────────────────────────────────── */
const update = async (req, res) => {
  try {
    const { estado, observaciones, ejecutivo, dealer, patente, color, motor, chasis } = req.body;
    await pool.query(
      `UPDATE creditos SET estado=?, observaciones=?, ejecutivo=?, dealer=?,
              patente=?, color=?, motor=?, chasis=?, updated_at=CURRENT_TIMESTAMP
       WHERE id_credito=?`,
      [estado, observaciones || null, ejecutivo || null, dealer || null,
       patente ? patente.toUpperCase().trim() : null,
       color || null, motor || null, chasis || null, req.params.id]
    );
    res.json({ success: true, data: { id_credito: req.params.id }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { create, getAll, getById, update };
