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

  // Corregir columnas que puedan existir como NOT NULL sin default (bloquean el INSERT)
  const fixes = [
    `ALTER TABLE cotizaciones MODIFY COLUMN id_cliente   INT          NULL DEFAULT NULL`,
    `ALTER TABLE cotizaciones MODIFY COLUMN id_usuario   INT          NULL DEFAULT NULL`,
    `ALTER TABLE cotizaciones MODIFY COLUMN valor_vehiculo BIGINT     NULL DEFAULT NULL`,
    `ALTER TABLE cotizaciones MODIFY COLUMN pie            BIGINT     NULL DEFAULT NULL`,
    `ALTER TABLE cotizaciones MODIFY COLUMN plazo          INT        NULL DEFAULT NULL`,
    `ALTER TABLE cotizaciones MODIFY COLUMN tasa_mensual   DECIMAL(8,4) NULL DEFAULT NULL`,
    `ALTER TABLE cotizaciones MODIFY COLUMN monto_financiado BIGINT   NULL DEFAULT NULL`,
    `ALTER TABLE cotizaciones MODIFY COLUMN cuota           BIGINT    NULL DEFAULT NULL`,
  ];
  for (const sql of fixes) {
    try { await pool.query(sql); }
    catch (e) { if (e.errno !== 1054) console.error('[cotizaciones migration fix]', e.message); }
  }
})();

const create = async (req, res) => {
  try {
    const { rut_cliente, nombre_cliente, fecha_cotizacion, valor_vehiculo, pie, plazo,
            tasa_mensual, monto_financiado, cuota, datos_json } = req.body;

    if (!rut_cliente || !nombre_cliente)
      return res.status(400).json({ success: false, data: null,
        error: 'rut_cliente y nombre_cliente son requeridos' });

    const id_usuario = req.usuario?.id_usuario || null;

    const [r] = await pool.query(
      `INSERT INTO cotizaciones
         (rut_cliente, nombre_cliente, fecha_cotizacion, valor_vehiculo, pie, plazo,
          tasa_mensual, monto_financiado, cuota, datos_json, id_usuario)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        rut_cliente.toUpperCase().trim(),
        nombre_cliente.trim(),
        fecha_cotizacion || null,
        valor_vehiculo   || null,
        pie              || null,
        plazo            || null,
        tasa_mensual     || null,
        monto_financiado || null,
        cuota            || null,
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
    const { q } = req.query;
    let sql = `SELECT id_cotizacion, rut_cliente, nombre_cliente, fecha_cotizacion,
                      valor_vehiculo, pie, plazo, tasa_mensual, monto_financiado, cuota,
                      id_usuario, created_at
               FROM cotizaciones`;
    const params = [];
    if (q && q.trim()) {
      const like = `%${q.trim().toUpperCase()}%`;
      sql += ` WHERE UPPER(rut_cliente) LIKE ? OR UPPER(nombre_cliente) LIKE ?`;
      params.push(like, like);
    }
    sql += ` ORDER BY created_at DESC LIMIT 500`;
    const [rows] = await pool.query(sql, params);
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { create, getAll };
