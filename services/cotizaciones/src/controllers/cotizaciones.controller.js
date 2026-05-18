const pool = require('../../../../shared/config/database');

(async () => {
  // 1. Crear tabla si no existe
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cotizaciones (
        id_cotizacion    INT AUTO_INCREMENT PRIMARY KEY,
        rut_cliente      VARCHAR(15)  NOT NULL,
        nombre_cliente   VARCHAR(300) NOT NULL,
        fecha_cotizacion DATETIME     DEFAULT CURRENT_TIMESTAMP,
        valor_vehiculo   BIGINT,
        pie              BIGINT,
        plazo            INT,
        tasa_mensual     DECIMAL(8,4),
        monto_financiado BIGINT,
        cuota            BIGINT,
        datos_json       JSON,
        id_usuario       INT,
        created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (e) {
    console.error('[cotizaciones migration create]', e.message);
  }

  // 2. Agregar columnas si la tabla existía con esquema viejo (errno 1060 = columna duplicada → ignorar)
  const cols = [
    `ALTER TABLE cotizaciones ADD COLUMN rut_cliente      VARCHAR(15)  NOT NULL DEFAULT ''`,
    `ALTER TABLE cotizaciones ADD COLUMN nombre_cliente   VARCHAR(300) NOT NULL DEFAULT ''`,
    `ALTER TABLE cotizaciones ADD COLUMN fecha_cotizacion DATETIME DEFAULT CURRENT_TIMESTAMP`,
    `ALTER TABLE cotizaciones ADD COLUMN valor_vehiculo   BIGINT`,
    `ALTER TABLE cotizaciones ADD COLUMN pie              BIGINT`,
    `ALTER TABLE cotizaciones ADD COLUMN plazo            INT`,
    `ALTER TABLE cotizaciones ADD COLUMN tasa_mensual     DECIMAL(8,4)`,
    `ALTER TABLE cotizaciones ADD COLUMN monto_financiado BIGINT`,
    `ALTER TABLE cotizaciones ADD COLUMN cuota            BIGINT`,
    `ALTER TABLE cotizaciones ADD COLUMN datos_json       JSON`,
    `ALTER TABLE cotizaciones ADD COLUMN id_usuario       INT`,
    `ALTER TABLE cotizaciones ADD COLUMN created_at       DATETIME DEFAULT CURRENT_TIMESTAMP`,
  ];
  for (const sql of cols) {
    try { await pool.query(sql); }
    catch (e) { if (e.errno !== 1060) console.error('[cotizaciones migration alter]', e.message); }
  }
})();

const create = async (req, res) => {
  try {
    const { rut_cliente, nombre_cliente, valor_vehiculo, pie, plazo,
            tasa_mensual, monto_financiado, cuota, datos_json } = req.body;

    if (!rut_cliente || !nombre_cliente)
      return res.status(400).json({ success: false, data: null,
        error: 'rut_cliente y nombre_cliente son requeridos' });

    const id_usuario = req.usuario?.id_usuario || null;

    const [r] = await pool.query(
      `INSERT INTO cotizaciones
         (rut_cliente, nombre_cliente, valor_vehiculo, pie, plazo,
          tasa_mensual, monto_financiado, cuota, datos_json, id_usuario)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        rut_cliente.toUpperCase().trim(),
        nombre_cliente.trim(),
        valor_vehiculo || null,
        pie            || null,
        plazo          || null,
        tasa_mensual   || null,
        monto_financiado || null,
        cuota          || null,
        JSON.stringify(datos_json || {}),
        id_usuario,
      ]
    );
    res.status(201).json({ success: true, data: { id_cotizacion: r.insertId }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

const getAll = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id_cotizacion, rut_cliente, nombre_cliente, fecha_cotizacion,
              valor_vehiculo, pie, plazo, tasa_mensual, monto_financiado, cuota,
              id_usuario, created_at
       FROM cotizaciones ORDER BY created_at DESC LIMIT 500`
    );
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { create, getAll };
